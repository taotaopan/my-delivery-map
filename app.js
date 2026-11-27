/* 配達マップ — 自建住宅地图（地理院地图 + 自己的表札标注）
 * 数据只存在本机 IndexedDB；地图来自国土地理院。 */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const OTA = [139.7162, 35.5613];           // 大田区・蒲田附近
const OLD_DAYS = 180;
const EMPTY = { type: 'FeatureCollection', features: [] };

/* ---------------- 工具 ---------------- */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const daysSince = s => s ? Math.floor((Date.now() - new Date(s + 'T00:00:00').getTime()) / 864e5) : 9999;
const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const r7 = n => Math.round(n * 1e7) / 1e7;
const z2h = s => String(s || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[－ー―‐−‑]/g, '-').replace(/　/g, ' ');
const KN = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
function k2n(s) {
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? KN[m[1]] : 1) * 10 + (m[2] ? KN[m[2]] : 0);
  return s.length === 1 && KN[s] ? KN[s] : null;
}
const kanjiChome = s => s.replace(/([一二三四五六七八九十]+)丁目/g, (all, k) => { const n = k2n(k); return n ? n + '丁目' : all; });
function norm(s) {
  return kanjiChome(z2h(s)).replace(/東京都|大田区|\s/g, '')
    .replace(/[ヶケヵ]/g, 'が').replace(/(\d)[のノ](?=\d)/g, '$1-').replace(/丁目|番地|番/g, '-').replace(/号/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}
const chome = n => (n.match(/^\D+\d+/) || [''])[0];
function pip(pt, ring) {                     // 点是否在多边形内
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms);
}
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('delivery-map', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recs', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all() {
    return new Promise((res, rej) => {
      const q = this.db.transaction('recs').objectStore('recs').getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  write(fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('recs', 'readwrite');
      fn(t.objectStore('recs')); t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
  put(o) { return this.write(s => s.put(o)); },
  putMany(a) { return this.write(s => a.forEach(o => s.put(o))); },
  del(id) { return this.write(s => s.delete(id)); }
};

let recs = [];
const byId = id => recs.find(r => r.id === id);

/* ---------------- 地图 ---------------- */
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const GSI = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>';
const view = ls.get('view', null);
const map = new maplibregl.Map({
  container: 'map',
  center: view ? view.c : OTA, zoom: view ? view.z : 15, maxZoom: 20,
  attributionControl: false, dragRotate: false, pitchWithRotate: false,
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      pale:  { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 18, attribution: GSI },
      photo: { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'], tileSize: 256, maxzoom: 18, attribution: GSI },
      gsivt: { type: 'vector', url: 'pmtiles://https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles', attribution: '国土地理院最適化ベクトルタイル' },
      mine: { type: 'geojson', data: EMPTY },
      entries: { type: 'geojson', data: EMPTY },
      sel: { type: 'geojson', data: EMPTY },
      blk: { type: 'geojson', data: EMPTY },
      gou: { type: 'geojson', data: EMPTY }
    },
    layers: [
      { id: 'pale', type: 'raster', source: 'pale' },
      { id: 'photo', type: 'raster', source: 'photo', layout: { visibility: 'none' } },
      { id: 'bld-fill', type: 'fill', source: 'gsivt', 'source-layer': 'BldA', minzoom: 14, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.01 } },
      { id: 'bld-line', type: 'line', source: 'gsivt', 'source-layer': 'BldA', minzoom: 16, paint: { 'line-color': '#7d7d7d', 'line-width': 0.8 } },
      { id: 'blk-lbl', type: 'symbol', source: 'blk', minzoom: 15.5, layout: { 'text-field': ['get', 'b'], 'text-font': ['Open Sans Semibold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 13, 18, 20] }, paint: { 'text-color': '#2456b3', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
      { id: 'gou-dot', type: 'circle', source: 'gou', minzoom: 17.3, paint: { 'circle-radius': 2, 'circle-color': '#888' } },
      { id: 'gou-lbl', type: 'symbol', source: 'gou', minzoom: 17.3, layout: { 'text-field': ['get', 'g'], 'text-font': ['Open Sans Regular'], 'text-size': 11, 'text-offset': [0, -0.8], 'text-padding': 1 }, paint: { 'text-color': '#444', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } },
      { id: 'mine-fill', type: 'fill', source: 'mine', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['case', ['get', 'old'], '#f3c9bd', '#ffab85'], 'fill-opacity': 0.6 } },
      { id: 'mine-line', type: 'line', source: 'mine', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#e2401c', 'line-width': 1.5 } },
      { id: 'mine-pt', type: 'circle', source: 'mine', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#e2401c', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
      { id: 'entries', type: 'circle', source: 'entries', minzoom: 16, paint: { 'circle-radius': 5, 'circle-color': '#1d6b45', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
      { id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#1a56db', 'line-width': 3 } },
      { id: 'sel-pt', type: 'circle', source: 'sel', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#1a56db', 'circle-stroke-width': 3 } }
    ]
  }
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showAccuracyCircle: true });
map.addControl(geo, 'bottom-right');
map.on('moveend', () => { const c = map.getCenter(); ls.set('view', { c: [c.lng, c.lat], z: map.getZoom() }); drawNames(); });
map.on('error', e => { if (String(e?.error?.message || '').includes('pmtiles')) toast('建筑轮廓加载失败，可长按空地放点代替'); });

function recFeatures() {
  const mine = [], ent = [];
  for (const r of recs) {
    const props = { id: r.id, old: daysSince(r.updated) > OLD_DAYS };
    if (r.poly && r.poly.length > 3) mine.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [r.poly] } });
    else mine.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } });
    if (r.entry) ent.push({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'Point', coordinates: [r.entry.lng, r.entry.lat] } });
  }
  return { mine: { type: 'FeatureCollection', features: mine }, ent: { type: 'FeatureCollection', features: ent } };
}
function refresh() {
  if (!map.isStyleLoaded() && !map.getSource('mine')) return;
  const f = recFeatures();
  map.getSource('mine')?.setData(f.mine);
  map.getSource('entries')?.setData(f.ent);
  drawNames(true);
}

/* 名字标签：只在放大到 16 级以上时显示可视范围内的 */
const nameMarkers = new Map();
function drawNames(force) {
  const want = new Set();
  if (map.getZoom() >= 16) {
    const b = map.getBounds();
    for (const r of recs) {
      if (!r.name || !b.contains([r.lng, r.lat])) continue;
      want.add(r.id);
      if (want.size >= 300) break;
    }
  }
  for (const [id, m] of nameMarkers) {
    if (!want.has(id) || force) { m.remove(); nameMarkers.delete(id); }
  }
  for (const id of want) {
    if (nameMarkers.has(id)) continue;
    const r = byId(id), el = document.createElement('div');
    el.className = 'nm' + (daysSince(r.updated) > OLD_DAYS ? ' old' : '');
    el.textContent = r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name;
    nameMarkers.set(id, new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -4] }).setLngLat([r.lng, r.lat]).addTo(map));
  }
}
function setSel(r) {
  const s = map.getSource('sel'); if (!s) return;
  if (!r) return s.setData(EMPTY);
  const g = r.poly && r.poly.length > 3 ? { type: 'Polygon', coordinates: [r.poly] } : { type: 'Point', coordinates: [r.lng, r.lat] };
  s.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: g }] });
}

/* ---------------- 住居表示（番・号）索引 ---------------- */
const ADDR = { ok: false, towns: {}, grid: new Map() };
const cellKey = (lng, lat) => Math.floor(lng / 0.001) + ':' + Math.floor(lat / 0.001);
async function loadAddr() {
  try {
    const res = await fetch('data/addr-13111.json');
    if (!res.ok) return;
    const j = await res.json();
    ADDR.towns = j.towns;
    const gouF = [], blkF = [];
    for (const [tk, t] of Object.entries(j.towns)) {
      for (const [b, pts] of Object.entries(t.b)) {
        let sx = 0, sy = 0;
        for (const [g, lng, lat] of pts) {
          sx += lng; sy += lat;
          gouF.push({ type: 'Feature', properties: { g: String(g) }, geometry: { type: 'Point', coordinates: [lng, lat] } });
          const k = cellKey(lng, lat);
          if (!ADDR.grid.has(k)) ADDR.grid.set(k, []);
          ADDR.grid.get(k).push([lng, lat, tk, b, g]);
        }
        t.c = t.c || {}; t.c[b] = [sx / pts.length, sy / pts.length];
        blkF.push({ type: 'Feature', properties: { b }, geometry: { type: 'Point', coordinates: t.c[b] } });
      }
    }
    ADDR.ok = true;
    const put = () => { map.getSource('gou').setData({ type: 'FeatureCollection', features: gouF }); map.getSource('blk').setData({ type: 'FeatureCollection', features: blkF }); };
    if (map.getSource('gou')) put(); else map.once('load', put);
  } catch {}
}
const fmtAddr = (town, b, g) => town + (/\d$/.test(town) ? '-' : '') + b + (g ? '-' + g : '');
const dist2 = (a, b, c, d) => { const dx = (a - c) * Math.cos(d * Math.PI / 180); return dx * dx + (b - d) * (b - d); };
function nearestAddr(lng, lat, maxM = 45) {
  if (!ADDR.ok) return null;
  const cx = Math.floor(lng / 0.001), cy = Math.floor(lat / 0.001);
  let best = null, bd = Infinity;
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
    for (const p of ADDR.grid.get(x + ':' + y) || []) { const d = dist2(p[0], p[1], lng, lat); if (d < bd) { bd = d; best = p; } }
  }
  if (!best || Math.sqrt(bd) * 111000 > maxM) return null;
  return { lng: best[0], lat: best[1], label: fmtAddr(best[2], best[3], best[4]) };
}
/* 在一段文字里找「町丁目-番-号」，返回位置 */
function lookupAddr(text) {
  if (!ADDR.ok) return null;
  const n = norm(text);
  const findTown = name => { let t = name; while (t.length > 1 && !ADDR.towns[t]) t = t.slice(1); return ADDR.towns[t] ? t : null; };
  for (const m of n.matchAll(/([^\d-]+)(\d+)(?:-(\d+))?(?:-(\d+))?/g)) {
    // 两种读法：「町名+丁目-番-号」或「町名(无丁目)-番-号」
    const tries = [[m[1] + m[2], m[3], m[4]], [m[1], m[2], m[3]]];
    for (const [tn, blk, gou] of tries) {
      if (!blk) continue;
      const town = findTown(tn); if (!town) continue;
      const t = ADDR.towns[town], pts = t.b[blk]; if (!pts) continue;
      if (gou) {
        const hit = pts.find(p => p[0] === +gou);
        if (hit) return { lng: hit[1], lat: hit[2], level: '号', label: fmtAddr(town, blk, gou) };
      }
      const c = t.c[blk];
      return { lng: c[0], lat: c[1], level: '番', label: fmtAddr(town, blk) + (gou ? `（${gou}号无数据，显示到番）` : '') };
    }
  }
  return null;
}
let pinMarker = null;
function dropPin(p) {
  pinMarker?.remove();
  const el = document.createElement('div'); el.className = 'pin';
  pinMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
  map.flyTo({ center: [p.lng, p.lat], zoom: p.level === '号' ? 19 : 18 });
}

/* ---------------- 点击 / 长按 ---------------- */
let mode = null, suppressUntil = 0;
function pickRing(geom, ll) {
  const pt = [ll.lng, ll.lat];
  let rings = [];
  if (geom.type === 'Polygon') rings = [geom.coordinates[0]];
  else if (geom.type === 'MultiPolygon') rings = geom.coordinates.map(p => p[0]);
  const ring = rings.find(r => pip(pt, r)) || rings[0];
  return ring ? ring.map(([x, y]) => [r7(x), r7(y)]) : null;
}
function hitMine(point) {
  const f = map.queryRenderedFeatures(point, { layers: ['mine-fill', 'mine-pt'] });
  return f.length ? byId(f[0].properties.id) : null;
}
map.on('click', e => {
  if (Date.now() < suppressUntil) return;
  if (mode === 'entry') {
    cur.entry = { lat: r7(e.lngLat.lat), lng: r7(e.lngLat.lng) };
    mode = null; entryBtnState(); $('sheet').hidden = false; toast('入口已设置，记得保存');
    return;
  }
  hideResults();
  const mine = hitMine(e.point);
  if (mine) return openRec(mine);
  const b = map.queryRenderedFeatures(e.point, { layers: ['bld-fill'] });
  if (b.length) return newRec(e.lngLat, pickRing(b[0].geometry, e.lngLat));
  if (!$('sheet').hidden) closeSheet();
  else if (map.getZoom() < 16) toast('放大到能看清房子再点');
});
let lpTimer = null, lpStart = null;
function longPress(ll, point) {
  suppressUntil = Date.now() + 900;
  if (navigator.vibrate) navigator.vibrate(20);
  const mine = hitMine(point);
  if (mine) return openRec(mine);
  newRec(ll, null);
}
map.on('touchstart', e => {
  if (e.originalEvent.touches.length !== 1) { clearTimeout(lpTimer); lpTimer = null; return; }
  lpStart = e.point; const ll = e.lngLat, p = e.point;
  clearTimeout(lpTimer); lpTimer = setTimeout(() => { lpTimer = null; longPress(ll, p); }, 600);
});
map.on('touchmove', e => { if (lpTimer && lpStart && Math.hypot(e.point.x - lpStart.x, e.point.y - lpStart.y) > 10) { clearTimeout(lpTimer); lpTimer = null; } });
map.on('touchend', () => { clearTimeout(lpTimer); lpTimer = null; });
map.on('contextmenu', e => longPress(e.lngLat, e.point));

/* ---------------- 编辑面板 ---------------- */
let cur = null, delArm = false;
const FIELDS = ['name', 'addr', 'units', 'oki', 'note'];
function fillSheet() {
  for (const k of FIELDS) $('f_' + k).value = cur[k] || '';
  const exists = !!byId(cur.id);
  $('sheetTitle').textContent = exists ? (cur.name || '标注') : (cur.poly ? '新标注（建筑）' : '新标注（点）');
  $('delBtn').hidden = !exists; $('delBtn').textContent = '删除'; delArm = false;
  $('meta').textContent = exists ? `上次确认 ${cur.updated || '—'}　·　保存即更新确认日期` : '';
  entryBtnState();
  $('sheet').hidden = false;
  setSel(cur);
}
function entryBtnState() { const b = $('entryBtn'); b.textContent = cur?.entry ? '已设置 · 重设' : '点地图设置'; b.classList.toggle('set', !!cur?.entry); }
function openRec(r) { cur = JSON.parse(JSON.stringify(r)); fillSheet(); }
function newRec(ll, ring) {
  cur = { id: newId(), lat: r7(ll.lat), lng: r7(ll.lng), poly: ring, name: '', addr: '', units: '', oki: '', note: '', entry: null, created: today(), updated: today() };
  fillSheet();
  setTimeout(() => $('f_name').focus(), 50);
  guessAddr(cur);
}
function closeSheet() { $('sheet').hidden = true; cur = null; mode = null; setSel(null); }
async function guessAddr(r) {
  const near = nearestAddr(r.lng, r.lat);
  if (near) { if (cur === r && !$('f_addr').value) $('f_addr').value = '大田区' + near.label; return; }
  try {
    const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${r.lat}&lon=${r.lng}`);
    const j = await res.json(); const nm = j?.results?.lv01Nm;
    if (!nm || cur !== r || $('f_addr').value) return;
    const v = kanjiChome(nm).replace(/(\d+)丁目$/, '$1-');
    $('f_addr').value = (j.results.muniCd === '13111' ? '大田区' : '') + v;
  } catch {}
}
$('sheetClose').onclick = closeSheet;
$('entryBtn').onclick = () => { if (!cur) return; mode = 'entry'; $('sheet').hidden = true; toast('点一下地图上的入口位置', 4000); };
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  for (const k of FIELDS) cur[k] = $('f_' + k).value.trim();
  cur.addr = z2h(cur.addr);
  if (!cur.name && !cur.addr && !cur.note) { toast('至少填表札或住所'); return; }
  cur.updated = today();
  try {
    await DB.put(cur);
    const i = recs.findIndex(r => r.id === cur.id);
    if (i >= 0) recs[i] = cur; else recs.push(cur);
    toast('已保存：' + (cur.name || cur.addr));
    closeSheet(); refresh(); renderToday();
  } catch (err) { toast('保存失败：' + err); }
});
$('delBtn').onclick = async () => {
  if (!delArm) { delArm = true; $('delBtn').textContent = '再点一次删除'; return; }
  const id = cur.id;
  await DB.del(id); recs = recs.filter(r => r.id !== id);
  toast('已删除'); closeSheet(); refresh(); renderToday();
};
function navTo(p) {
  const a = document.createElement('a');
  a.href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
  a.target = '_blank'; a.rel = 'noopener'; a.click();
}
$('navBtn').onclick = () => { if (cur) navTo(cur.entry || cur); };

/* ---------------- 搜索 ---------------- */
function search(q) {
  const n = norm(q), raw = q.trim();
  if (!raw) return [];
  return recs.filter(r => (r.name && r.name.includes(raw)) || (r.units && r.units.includes(raw)) || (n && norm(r.addr).includes(n)) || (r.note && r.note.includes(raw))).slice(0, 40);
}
function hideResults() { $('results').hidden = true; }
let addrHit = null;
$('q').addEventListener('input', () => {
  const list = search($('q').value), box = $('results');
  if (!$('q').value.trim()) return hideResults();
  addrHit = lookupAddr($('q').value);
  const top = addrHit ? `<button data-addr="1"><b>📍 ${esc(addrHit.label)}</b><small>住居表示・定位到${addrHit.level}</small></button>` : '';
  box.innerHTML = top + (list.length ? list.map(r => `<button data-id="${esc(r.id)}"><b>${esc(r.name || '（无名）')}</b><small>${esc([r.addr, r.units].filter(Boolean).join(' · '))}</small></button>`).join('')
    : (top ? '' : '<button disabled><small>没有找到</small></button>'));
  box.hidden = false;
});
$('results').addEventListener('click', e => {
  if (e.target.closest('button[data-addr]') && addrHit) { hideResults(); $('q').blur(); closeSheet(); dropPin(addrHit); return; }
  const b = e.target.closest('button[data-id]'); if (!b) return;
  const r = byId(b.dataset.id); hideResults(); $('q').blur();
  map.flyTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 18.3) });
  openRec(r);
});

/* ---------------- 今日配送 ---------------- */
let todayData = ls.get('today', { date: today(), items: [] });
const todayMarkers = [];
function matchLine(line) {
  const n = norm(line);
  const nameHit = r => r.name && r.name.split(/[・,、\s]+/).some(x => x && line.includes(x));
  const toks = [n, ...z2h(line).split(/\s+/).map(norm)];
  const starts = (t, a) => t.startsWith(a) && !/\d/.test(t[a.length] || '');
  const addrHit = r => { const a = norm(r.addr); return a.length > 2 && /\d+-\d+/.test(a) && toks.some(t => starts(t, a)); };
  let c = recs.filter(r => addrHit(r) && nameHit(r));
  if (!c.length) c = recs.filter(addrHit);
  if (!c.length) { const ch = chome(n); c = recs.filter(r => nameHit(r) && ch && chome(norm(r.addr)) === ch); }
  if (!c.length) { const named = recs.filter(nameHit); if (named.length === 1) c = named; }
  return c.slice(0, 5).map(r => r.id);
}
function addrPart(line) {
  const t = z2h(line).split(/\s+/).find(x => /\d/.test(x)) || line;
  return /大田区/.test(t) ? t : '大田区' + t;
}
async function geocode(q) {
  try {
    const res = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
    const j = await res.json();
    if (Array.isArray(j) && j.length) { const [lng, lat] = j[0].geometry.coordinates; return { lat, lng, title: j[0].properties.title }; }
  } catch {}
  return null;
}
$('todayGo').onclick = async () => {
  const lines = $('todayText').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return toast('先粘贴配送单');
  todayData = { date: today(), items: lines.map(line => ({ line, ids: matchLine(line), geo: null, done: false })) };
  ls.set('today', todayData); renderToday();
  const miss = todayData.items.filter(it => !it.ids.length);
  if (miss.length) toast(`有 ${miss.length} 件没有标注，正在按住所大致定位…`, 3000);
  for (const it of miss) {
    const a = lookupAddr(it.line);
    it.geo = a ? { lat: a.lat, lng: a.lng, title: a.label, level: a.level } : await geocode(addrPart(it.line));
    ls.set('today', todayData); renderToday();
  }
  fitToday();
};
$('todayClear').onclick = () => { todayData = { date: today(), items: [] }; ls.set('today', todayData); $('todayText').value = ''; renderToday(); };
function itemPoint(it) {
  const r = it.ids.length ? byId(it.ids[0]) : null;
  if (r) return { lat: r.lat, lng: r.lng, nav: r.entry || r, rec: r };
  if (it.geo) return { lat: it.geo.lat, lng: it.geo.lng, nav: it.geo, rec: null };
  return null;
}
function fitToday() {
  const pts = todayData.items.map(itemPoint).filter(Boolean);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds();
  pts.forEach(p => b.extend([p.lng, p.lat]));
  $('today').hidden = true;
  map.fitBounds(b, { padding: 70, maxZoom: 18 });
}
function renderToday() {
  todayMarkers.splice(0).forEach(m => m.remove());
  const left = todayData.items.filter(it => !it.done).length;
  $('todayCnt').textContent = todayData.items.length ? left : '';
  const list = $('todayList'); list.innerHTML = '';
  todayData.items.forEach((it, i) => {
    const p = itemPoint(it), r = p?.rec;
    const row = document.createElement('div');
    row.className = 'ti' + (it.done ? ' done' : '') + (r ? '' : ' none');
    const st = r ? (it.ids.length > 1 ? `候选 ${it.ids.length} 个 · 显示第一个` : `✓ ${r.name || ''} ${r.units || ''}`) : (p ? (it.geo?.level ? `未标注 · 住居表示定位到${it.geo.level}` : '未标注 · 只定位到大致位置') : '未标注 · 找不到位置');
    row.innerHTML = `<div class="no">${i + 1}</div><div><div class="t"></div><div class="s"></div></div><div class="b"></div>`;
    row.querySelector('.t').textContent = it.line;
    row.querySelector('.s').textContent = st + (r?.note ? ' · ' + r.note : '');
    const bx = row.querySelector('.b');
    const mk = (txt, fn) => { const b = document.createElement('button'); b.className = 'mini'; b.textContent = txt; b.onclick = fn; bx.append(b); };
    if (p) mk('看', () => { $('today').hidden = true; map.flyTo({ center: [p.lng, p.lat], zoom: 18.3 }); if (r) openRec(r); });
    if (p) mk('导航', () => navTo(p.nav));
    mk(it.done ? '撤销' : '✓', () => { it.done = !it.done; ls.set('today', todayData); renderToday(); });
    list.append(row);
    if (p) {
      const el = document.createElement('div');
      el.className = 'dv' + (it.done ? ' done' : r ? '' : ' none');
      el.innerHTML = `<span>${i + 1}</span>`;
      el.onclick = ev => { ev.stopPropagation(); if (r) openRec(r); else toast(it.line); };
      todayMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom-left' }).setLngLat([p.lng, p.lat]).addTo(map));
    }
  });
}
$('todayBtn').onclick = () => { closeSheet(); $('menu').hidden = true; $('today').hidden = false; };
$('todayClose').onclick = () => { $('today').hidden = true; };

/* ---------------- 菜单 / 备份 ---------------- */
function renderStats() {
  const week = recs.filter(r => daysSince(r.created) <= 7).length;
  const old = recs.filter(r => daysSince(r.updated) > OLD_DAYS).length;
  const lastBk = ls.get('lastBackup', null);
  $('stats').innerHTML = `<div><b>${recs.length}</b><small>标注总数</small></div><div><b>${week}</b><small>7 天内新增</small></div><div><b>${old}</b><small>待复查</small></div>`;
  $('expJson').textContent = '导出备份（JSON）' + (lastBk ? ` · 上次 ${daysSince(lastBk)} 天前` : ' · 还没备份过');
}
$('menuBtn').onclick = () => { closeSheet(); $('today').hidden = true; renderStats(); $('menu').hidden = false; };
$('menuClose').onclick = () => { $('menu').hidden = true; };
async function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
$('expJson').onclick = async () => {
  const ok = await saveFile(`delivery-map-${today()}.json`, JSON.stringify({ app: 'my-delivery-map', version: 1, exported: new Date().toISOString(), recs }), 'application/json');
  if (ok) { ls.set('lastBackup', today()); renderStats(); }
};
$('expCsv').onclick = () => {
  const H = ['表札', '住所', '世帯/部屋', '置き配', '备注', '纬度', '经度', '入口纬度', '入口经度', '最后确认', '创建'];
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [...recs].sort((a, b) => norm(a.addr).localeCompare(norm(b.addr), 'ja', { numeric: true }))
    .map(r => [r.name, r.addr, r.units, r.oki, r.note, r.lat, r.lng, r.entry?.lat, r.entry?.lng, r.updated, r.created]);
  saveFile(`delivery-map-${today()}.csv`, '﻿' + [H, ...rows].map(r => r.map(cell).join(',')).join('\n'), 'text/csv');
};
$('impJson').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const arr = Array.isArray(j) ? j : j.recs;
    if (!Array.isArray(arr)) throw new Error('格式不对');
    const valid = arr.filter(r => r && typeof r.id === 'string' && typeof r.lat === 'number' && typeof r.lng === 'number');
    const merged = [];
    for (const r of valid) { const ex = byId(r.id); if (!ex || (r.updated || '') >= (ex.updated || '')) merged.push(r); }
    await DB.putMany(merged);
    recs = await DB.all(); refresh(); renderToday(); renderStats();
    toast(`已导入 ${merged.length} 条（共读取 ${valid.length} 条）`);
  } catch (err) { toast('导入失败：' + err.message); }
  e.target.value = '';
};

/* ---------------- 其它按钮 ---------------- */
let photo = false;
$('layerBtn').onclick = () => {
  photo = !photo;
  map.setLayoutProperty('photo', 'visibility', photo ? 'visible' : 'none');
  map.setLayoutProperty('pale', 'visibility', photo ? 'none' : 'visible');
  $('layerBtn').textContent = photo ? '地图' : '航拍';
};
$('locBtn').onclick = () => { try { geo.trigger(); } catch { toast('无法获取定位'); } };

/* ---------------- 启动 ---------------- */
(async () => {
  loadAddr();
  try { await DB.open(); recs = await DB.all(); }
  catch (err) { toast('本地数据库打开失败：' + err, 6000); }
  if (map.loaded()) { refresh(); renderToday(); }
  else map.on('load', () => { refresh(); renderToday(); });
  navigator.storage?.persist?.();
  if (!window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone && !ls.get('tipShown', false)) {
    toast('建议先「添加到主屏幕」再使用，数据更不容易丢', 5000); ls.set('tipShown', true);
  }
})();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
