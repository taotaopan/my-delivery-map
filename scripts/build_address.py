"""国土地理院「住居表示住所」(基礎番号) → 本 App 用的地址索引 JSON。
用法: python scripts/build_address.py <zip> <out.json>
列名不固定时会自动识别，并把表头打印到日志里，方便排查。"""
import csv, io, json, re, sys, zipfile, datetime

KN = dict(zip("一二三四五六七八九", range(1, 10)))
def k2n(s):
    if s == "十": return 10
    m = re.fullmatch(r"([一二三四五六七八九])?十([一二三四五六七八九])?", s)
    if m: return (KN[m[1]] if m[1] else 1) * 10 + (KN[m[2]] if m[2] else 0)
    return KN.get(s) if len(s) == 1 else None

def z2h(s):
    return "".join(chr(ord(c) - 0xFEE0) if "０" <= c <= "９" else c for c in s)

def town_key(name):
    s = z2h(name).replace("東京都", "").replace("大田区", "").replace(" ", "").replace("　", "")
    s = re.sub(r"([一二三四五六七八九十]+)丁目", lambda m: f"{k2n(m[1]) or m[1]}丁目", s)
    return s.replace("丁目", "")

def num(s):
    s = z2h(str(s)).strip()
    m = re.match(r"\d+", s)
    return m[0] if m else None

def read_rows(raw):
    for enc in ("utf-8-sig", "cp932"):
        try: text = raw.decode(enc); break
        except UnicodeDecodeError: continue
    return list(csv.reader(io.StringIO(text)))

def find(header, *keys, exclude=()):
    for i, h in enumerate(header):
        if all(k in h for k in keys) and not any(x in h for x in exclude): return i
    return None

def main(zpath, out):
    zf = zipfile.ZipFile(zpath)
    names = [n for n in zf.namelist() if n.lower().endswith((".csv", ".txt"))]
    print("files in zip:", zf.namelist()[:20])
    towns, total = {}, 0
    transformer = None
    for n in names:
        rows = read_rows(zf.read(n))
        if not rows: continue
        header = [h.strip() for h in rows[0]]
        print(f"--- {n}: {len(rows)} rows\nheader: {header}\nsample: {rows[1:3]}")
        ti = find(header, "町", "名")
        if ti is None: ti = find(header, "町", exclude=("コード",))
        bi = find(header, "街区")
        gi = find(header, "基礎番号")
        if gi is None: gi = find(header, "住居番号")
        lat, lon = find(header, "緯度"), find(header, "経度")
        xi, yi = find(header, "X"), find(header, "Y")
        ki = find(header, "系")
        ci = find(header, "住所コード")
        print("cols town/block/gou/lat/lon/x/y/kei/code:", ti, bi, gi, lat, lon, xi, yi, ki, ci)
        data = rows[1:]
        if ti is None and re.fullmatch(r"\d{5}", header[0]) and len(header) >= 8:
            # 无表头格式: 市区町村コード,町名,街区符号,基礎番号,URI,(空),経度,緯度,精度
            ti, bi, gi, lon, lat = 1, 2, 3, 6, 7
            data = rows
            print("无表头，按固定列解析: 町名=1 街区=2 基礎番号=3 経度=6 緯度=7")
        for r in data:
            if not r or len(r) < len(header) - 2: continue
            town, blk, gou = (r[ti] if ti is not None else None), (num(r[bi]) if bi is not None else None), (num(r[gi]) if gi is not None else None)
            if ci is not None and (not town or not blk or not gou):
                parts = [p for p in r[ci].split("/") if p]
                if len(parts) >= 3: town, blk, gou = parts[-3], num(parts[-2]), num(parts[-1])
            if not (town and blk and gou): continue
            try:
                if lat is not None and lon is not None:
                    la, lo = float(r[lat]), float(r[lon])
                else:
                    from pyproj import Transformer
                    kei = int(num(r[ki])) if ki is not None else 9
                    if transformer is None or transformer[0] != kei:
                        transformer = (kei, Transformer.from_crs(f"EPSG:{6668 + kei}", "EPSG:4326", always_xy=True))
                    lo, la = transformer[1].transform(float(r[yi]), float(r[xi]))  # X=北, Y=东
            except (ValueError, TypeError, IndexError):
                continue
            if not (20 < la < 46 and 122 < lo < 154): continue
            tk = town_key(town)
            t = towns.setdefault(tk, {"n": town, "b": {}})
            t["b"].setdefault(blk, []).append([int(gou), round(lo, 6), round(la, 6)])
            total += 1
    if not total:
        sys.exit("没有解析出任何点，请看上面的表头输出")
    for t in towns.values():
        for b in t["b"].values(): b.sort()
    json.dump({"v": 1, "built": datetime.date.today().isoformat(),
               "src": "国土地理院 電子国土基本図(地名情報)「住居表示住所」", "towns": towns},
              open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"OK: {len(towns)} 町丁目, {total} 基礎番号 → {out}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
