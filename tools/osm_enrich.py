# -*- coding: utf-8 -*-
"""収録にある場所へ、OpenStreetMap から営業時間・電話・公式サイト・
車いすの可否・料金の有無を足す。（Overpass API は使いません）

    python3 tools/fetch_osm_extracts.py         配布ファイルを落とす
    python3 tools/osm_enrich.py                 確認するだけ（数を出す）
    python3 tools/osm_enrich.py --write         kb/ に書き戻す
    python3 tools/osm_enrich.py --write a.osm.pbf b.osm.pbf   ファイルを指定
    python3 tools/osm_enrich.py --kb kb-private --write       別の収録に

なぜ配布ファイルなのか
----------------------
Overpass API に 4万件ぶん聞くと、レート制限に当たり、IP ごと止められます。
配布ファイル（日本全体で約2.9GB、地域ごとなら8本）を手元で1回なめれば、
何件でも突き合わせられます。走査は数分、突き合わせは数秒です。

何を足すか
----------
1件ごとに `osmInfo` という入れ物を足します。**収録のほかの項目には
触りません**（名前・座標・分類・説明は元のまま）。出どころごとに項目を
分けておけば、条件の違うデータが混ざりません（OSM は ODbL、説明文は
CC BY-SA）。まとめて外すときは `osmInfo` を消すだけです。

    "osmInfo": {
      "ref": "way/123",                 元の OSM の番号
      "opening_hours": "09:00-17:00",   OSM の書式のまま
      "phone": "+81 75-123-4567",
      "website": "https://example.jp/",
      "wheelchair": "yes",              yes / limited / no / designated
      "toiletsWheelchair": "yes",
      "fee": "yes", "charge": "500 JPY",
      "via": "wikidata",                どう突き合わせたか（wikidata / name）
      "m": 42                           収録の座標からの距離（m）
    }

営業時間は **OSM の書式のまま**持ちます。旅程で使う形への読み替えは、
アプリの側（packages/core/src/osm_hours.js）がします。読み替えの決まりを
直したとき、ここを走らせ直さなくても効くようにするためです。

どう突き合わせるか
------------------
  1. **Wikidata の番号が同じ**（収録の id が wd-Q123、OSM に wikidata=Q123）
     … 名前の表記が違っても同じ場所です。3km 以内なら採ります
  2. **名前が同じで、近い** … 400m 以内（公園・山・湖・温泉地のように
     広い場所は 1.5km 以内）。名前の比べかたは収録の重複判定と同じです
     （tools/dedupe_spots.py の same_place）

**同じ名前の別のもの**を採りません。「嵐山」という名前の駅、「東京タワー」
という名前の売店・バス停は、場所としては別物です。駅・停留所・駐車場・
トイレ・店・飲食店・宿は候補から外します（収録の側が店や市場のときは、
店も候補にします）。

出典と利用条件（重要）
----------------------
OpenStreetMap のデータは **ODbL 1.0** です。

  ・**「© OpenStreetMap contributors」の表示が必須です。** 収録の出典
    （kb/index.json の sources と kb/attribution.json）に足します
  ・**同じ条件で共有する義務があります**（share-alike）。`osmInfo` を含む
    収録（kb/）は ODbL の派生データベースにあたります
  ・1件ごとに `ref`（元の番号）を持たせます。誰でも元を確かめられます

値は OSM に書かれているものだけです。**ここでは何も作りません**（電話番号
を推し量ったり、営業時間を分類から埋めたりしません）。
"""
import collections
import glob
import hashlib
import json
import os
import re
import sys
import time
import unicodedata

from dedupe_spots import same_place

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OSM = os.path.join(WEB, "data", "osm")

OSM_SOURCE = {"name": "© OpenStreetMap contributors (ODbL)",
              "url": "https://www.openstreetmap.org/copyright"}

# 足す値を持っているタグ。これが1つも無いものは、読みません。
ENRICH_KEYS = ("opening_hours", "phone", "contact:phone", "website",
               "contact:website", "url", "wheelchair", "toilets:wheelchair",
               "fee", "charge")
# 走査で通すもの。wikidata は突き合わせの鍵です（値が無くても、同じ番号の
# 別の物＝点と面＝を1つにまとめるのに使います）。
SCAN_KEYS = ENRICH_KEYS
NAME_KEYS = ("name", "name:ja", "official_name", "alt_name", "old_name",
             "short_name", "name:ja-Hira", "name:ja_kana")

# 突き合わせる距離（km）。
NEAR_KM = 0.4
WIDE_KM = 1.5
WIKIDATA_KM = 3.0
# 広い場所。名前の付いた点（重心・入口）が、収録の座標から離れがちです。
WIDE_CATEGORIES = {
    "公園", "国立公園", "国定公園", "自然", "山", "登山", "丘", "高原", "峠",
    "渓谷", "川", "湖", "島", "岬", "海岸", "海水浴場", "ダム", "温泉地",
    "スキー場", "テーマパーク", "遊園地", "動物園", "牧場", "町並み", "商店街",
    "庭園", "城", "史跡", "世界遺産", "名勝",
}
# 店や食事どころを、そのまま行き先として収録している分類。
SHOP_CATEGORIES = {"飲食店", "グルメ", "商業施設", "市場", "商店街", "道の駅",
                   "酒蔵"}
RIDE_CATEGORIES = {"ロープウェイ", "乗り物"}

# 同じ名前でも、場所としては別物（駅・停留所・駐車場・トイレ…）。
NOT_THE_PLACE_AMENITY = {
    "parking", "parking_entrance", "bicycle_parking", "toilets", "bus_station",
    "taxi", "atm", "bank", "vending_machine", "post_box", "post_office",
    "bench", "shelter", "drinking_water", "telephone", "fuel",
    "charging_station", "police", "fire_station", "waste_basket",
    "information", "bicycle_rental", "car_rental", "ferry_terminal",
}
FOOD_AMENITY = {"restaurant", "cafe", "fast_food", "bar", "pub", "izakaya",
                "food_court", "ice_cream", "biergarten"}
LODGING_TOURISM = {"hotel", "guest_house", "hostel", "motel", "apartment",
                   "chalet", "camp_pitch"}

VALUES = {
    "wheelchair": {"yes", "limited", "no", "designated"},
    "toilets:wheelchair": {"yes", "no", "limited"},
    "fee": {"yes", "no"},
}
PHONE = re.compile(r"^\+?[0-9][0-9\-\s()]{7,24}$")


def n(text):
    """比べるための形。全角半角・空白・中黒を畳みます。"""
    return re.sub(r"[\s　・]", "", unicodedata.normalize("NFKC", text or ""))


def km(a_lat, a_lng, b_lat, b_lng):
    import math
    dy = (a_lat - b_lat) * 111.0
    dx = (a_lng - b_lng) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


def names_of(tags):
    out = []
    for k in NAME_KEYS:
        v = tags.get(k)
        if not v:
            continue
        out.extend(x.strip() for x in v.split(";") if x.strip())
    return out


def clean_values(tags):
    """OSM のタグから、足す値だけを取り出します。**おかしな値は捨てます。**

    OSM は誰でも書けます。電話の欄に「あり」、wheelchair に「unknown」の
    ような値が入っていることがあります。画面に出せる形のものだけ通します。
    """
    out = {}
    oh = (tags.get("opening_hours") or "").strip()
    if oh and len(oh) <= 255:
        out["opening_hours"] = oh
    phone = (tags.get("phone") or tags.get("contact:phone") or "").strip()
    # 複数あるとき（; 区切り）は先頭の1つ。
    phone = unicodedata.normalize("NFKC", phone.split(";")[0].strip())
    if phone and PHONE.match(phone):
        out["phone"] = phone
    site = (tags.get("website") or tags.get("contact:website")
            or tags.get("url") or "").strip().split(";")[0].strip()
    if re.match(r"^https?://[^\s]+$", site) and len(site) <= 300:
        out["website"] = site
    wc = (tags.get("wheelchair") or "").strip()
    if wc in VALUES["wheelchair"]:
        out["wheelchair"] = wc
    twc = (tags.get("toilets:wheelchair") or "").strip()
    if twc in VALUES["toilets:wheelchair"]:
        out["toiletsWheelchair"] = twc
    fee = (tags.get("fee") or "").strip()
    if fee in VALUES["fee"]:
        out["fee"] = fee
    charge = (tags.get("charge") or "").strip()
    if charge and len(charge) <= 120:
        out["charge"] = charge
    return out


def feature_class(tags):
    """その OSM の物が何か。突き合わせてよい相手かどうかを決めるのに使います。

    "transport"（駅・停留所・道）/ "utility"（駐車場・トイレ…）/ "shop" /
    "food" / "lodging" / "place"（それ以外＝行き先でありうるもの）
    """
    if (tags.get("public_transport") or tags.get("highway")
            or tags.get("railway") in {"station", "halt", "stop",
                                       "tram_stop", "subway_entrance",
                                       "platform"}):
        return "transport"
    amenity = tags.get("amenity")
    if amenity in NOT_THE_PLACE_AMENITY:
        return "utility"
    if tags.get("shop") or tags.get("office") or tags.get("craft"):
        return "shop"
    if amenity in FOOD_AMENITY:
        return "food"
    if tags.get("tourism") in LODGING_TOURISM:
        return "lodging"
    return "place"


def allowed(spot, cls):
    """収録の分類から見て、その種類の物を同じ場所と見てよいか。"""
    if cls == "place":
        return True
    cat = spot.get("category")
    if cls in ("shop", "food"):
        return cat in SHOP_CATEGORIES
    if cls == "transport":
        # ロープウェイ・遊覧船の「駅」は、その乗り物そのものです。
        return cat in RIDE_CATEGORIES
    if cls == "lodging":
        return cat in {"温泉", "温泉地"}
    return False


# --- 配布ファイルの走査 ------------------------------------------------------

def scan(path):
    """配布ファイルから、足す値を持つ名前つきの物を全部拾います。

    点（node）と面（閉じた線と、関係で組んだ多角形）を見ます。寺の境内や
    公園は、面に営業時間が付いていることが多いからです。
    """
    import osmium

    out = []
    idx = "flex_mem"
    tmp = None
    if os.path.getsize(path) > 1_000_000_000:
        os.makedirs(OSM, exist_ok=True)
        tmp = os.path.join(OSM, ".enrich-nodes.idx")
        idx = f"sparse_file_array,{tmp}"
    keyf = osmium.filter.KeyFilter(*SCAN_KEYS)
    proc = (osmium.FileProcessor(path)
            .with_locations(idx)
            .with_areas(keyf)
            .with_filter(keyf))
    for o in proc:
        if o.is_node():
            ref = f"node/{o.id}"
            if not o.location.valid():
                continue
            lat, lng = o.location.lat, o.location.lon
        elif o.is_area():
            ref = ("way/" if o.from_way() else "relation/") + str(o.orig_id())
            pts = []
            for ring in o.outer_rings():
                ring = list(ring)
                # 輪は始点と終点が同じ点です。そのまま平均すると始点のほうへ
                # 寄るので、終点は数えません。
                if len(ring) > 1 and ring[0].ref == ring[-1].ref:
                    ring = ring[:-1]
                for nd in ring:
                    if nd.location.valid():
                        pts.append((nd.location.lat, nd.location.lon))
            if not pts:
                continue
            lat = sum(p[0] for p in pts) / len(pts)
            lng = sum(p[1] for p in pts) / len(pts)
        else:
            continue            # 開いた線・関係そのものは見ません（面で見ます）
        tags = {t.k: t.v for t in o.tags}
        names = names_of(tags)
        if not names and not tags.get("wikidata"):
            continue
        values = clean_values(tags)
        if not values:
            continue
        out.append({"ref": ref, "lat": round(lat, 6), "lng": round(lng, 6),
                    "names": names, "wikidata": tags.get("wikidata") or "",
                    "cls": feature_class(tags), "values": values})
    if tmp and os.path.exists(tmp):
        os.remove(tmp)
    return out


def scan_cached(path):
    """scan() の結果を控えます（配布ファイルが同じなら、同じ結果です）。"""
    st = os.stat(path)
    # 小さなファイル（試験用の作り物）は、走査が一瞬なので控えません。
    if st.st_size < 20_000_000:
        return scan(path), False
    key = f"v3:{os.path.basename(path)}:{st.st_size}:{int(st.st_mtime)}"
    os.makedirs(OSM, exist_ok=True)
    name = hashlib.sha1(os.path.abspath(path).encode("utf-8")).hexdigest()[:12]
    cache = os.path.join(OSM, f".enrich-{name}.json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            doc = json.load(f)
        if doc.get("key") == key:
            return doc["pois"], True
    pois = scan(path)
    with open(cache, "w", encoding="utf-8") as f:
        json.dump({"key": key, "pois": pois}, f, ensure_ascii=False)
    return pois, False


def data_date(path):
    """配布ファイルが、いつの時点のデータか（YYYY-MM-DD）。"""
    try:
        import osmium
        h = osmium.io.Reader(path, osmium.osm.osm_entity_bits.NOTHING).header()
        ts = h.get("osmosis_replication_timestamp") or h.get("timestamp") or ""
        if re.match(r"^\d{4}-\d{2}-\d{2}", ts):
            return ts[:10]
    except Exception:            # noqa: BLE001  日付が読めなくても、続けます
        pass
    return time.strftime("%Y-%m-%d", time.gmtime(os.path.getmtime(path)))


# --- 突き合わせ --------------------------------------------------------------

CELL = 0.02      # 約2km のます目


def cell_of(lat, lng):
    return (int(lat / CELL), int(lng / CELL))


def build_index(pois):
    grid = collections.defaultdict(list)
    by_wd = collections.defaultdict(list)
    for p in pois:
        grid[cell_of(p["lat"], p["lng"])].append(p)
        if p["wikidata"]:
            by_wd[p["wikidata"]].append(p)
    return grid, by_wd


def near(grid, lat, lng, reach_km):
    span = int(reach_km / (CELL * 111.0 * 0.8)) + 1
    cy, cx = cell_of(lat, lng)
    for dy in range(-span, span + 1):
        for dx in range(-span, span + 1):
            for p in grid.get((cy + dy, cx + dx), ()):
                d = km(lat, lng, p["lat"], p["lng"])
                if d <= reach_km:
                    yield d, p


def wikidata_of(spot):
    """収録が持っている Wikidata の番号（Q123）。無ければ ""。"""
    if isinstance(spot.get("wikidata"), str) and spot["wikidata"].startswith("Q"):
        return spot["wikidata"]
    m = re.match(r"^wd-(Q\d+)$", spot.get("id", ""))
    return m.group(1) if m else ""


def name_match(spot, poi, d):
    mine = [spot["name"]] + ([spot["listedAs"]] if spot.get("listedAs") else [])
    for a in mine:
        for b in poi["names"]:
            if n(a) == n(b):
                return True
            if same_place({"name": a}, {"name": b}, d):
                return True
    return False


def match_spot(spot, grid, by_wd):
    """1件ぶん。合った物の一覧を、採る順（確かな順・近い順）で返します。"""
    lat, lng = spot["lat"], spot["lng"]
    found = {}
    q = wikidata_of(spot)
    if q:
        for p in by_wd.get(q, ()):
            d = km(lat, lng, p["lat"], p["lng"])
            # 番号が同じなら、種類は問いません（番号を付けた人が同じ物だと
            # 言っています）。ただし駅・停留所だけは外します。施設と駅に
            # 同じ番号が付いていることがあるからです。
            if d <= WIKIDATA_KM and (p["cls"] != "transport"
                                     or allowed(spot, "transport")):
                found[p["ref"]] = (0, d, p, "wikidata")
    reach = WIDE_KM if spot.get("category") in WIDE_CATEGORIES else NEAR_KM
    for d, p in near(grid, lat, lng, reach):
        if p["ref"] in found or not p["names"]:
            continue
        if not allowed(spot, p["cls"]):
            continue
        # 別の Wikidata の番号が付いているなら、名前が同じでも別の物です。
        if q and p["wikidata"] and p["wikidata"] != q:
            continue
        if name_match(spot, p, d):
            found[p["ref"]] = (1, d, p, "name")
    return sorted(found.values(), key=lambda x: (x[0], x[1]))


def merge(hits):
    """合った物の値を1つにまとめます。**先頭（いちばん確かな物）が勝ちます。**

    同じ場所が点と面の両方で描かれていて、営業時間は面に、電話は点に、
    ということがあります。足りない値だけを、後ろの物から足します。
    """
    rank, d, first, via = hits[0]
    info = {"ref": first["ref"]}
    info.update(first["values"])
    extra = []
    for _, _, p, _ in hits[1:]:
        added = False
        for k, v in p["values"].items():
            if k not in info:
                info[k] = v
                added = True
        if added:
            extra.append(p["ref"])
    if extra:
        info["refs"] = extra
    info["via"] = via
    info["m"] = int(round(d * 1000))
    return info


def enrich(spots, pois):
    """収録の全件に当てます。{spot id: osmInfo} と、数の内訳を返します。"""
    grid, by_wd = build_index(pois)
    out = {}
    stats = collections.Counter()
    for s in spots:
        if not isinstance(s.get("lat"), (int, float)):
            continue
        hits = match_spot(s, grid, by_wd)
        if not hits:
            continue
        info = merge(hits)
        out[s["id"]] = info
        stats["matched"] += 1
        stats["via:" + info["via"]] += 1
        for k in ("opening_hours", "phone", "website", "wheelchair",
                  "toiletsWheelchair", "fee", "charge"):
            if k in info:
                stats[k] += 1
    return out, stats


# --- 収録の読み書き ----------------------------------------------------------

def load_kb(kb_dir):
    shards = {}
    for p in sorted(glob.glob(os.path.join(kb_dir, "spots-*.json"))):
        with open(p, encoding="utf-8") as f:
            shards[p] = json.load(f)
    return shards


def apply(shards, infos):
    """osmInfo を付け替えます。**前回のぶんは、まず全部外します。**

    OSM から消えた値（閉業して営業時間が消された、など）を残さないためです。
    """
    changed = set()
    for p, doc in shards.items():
        for s in doc["spots"]:
            new = infos.get(s["id"])
            if s.get("osmInfo") != new:
                changed.add(p)
            if new is None:
                s.pop("osmInfo", None)
            else:
                s["osmInfo"] = new
    return changed


def write_kb(shards, changed):
    for p in sorted(changed):
        with open(p, "w", encoding="utf-8") as f:
            json.dump(shards[p], f, ensure_ascii=False, separators=(",", ":"))


def register(kb_dir, stats, total, as_of):
    """索引（index.json）に、出典と数を書きます。"""
    p = os.path.join(kb_dir, "index.json")
    if not os.path.exists(p):
        return
    with open(p, encoding="utf-8") as f:
        index = json.load(f)
    # 出典。すでに OpenStreetMap が入っていれば（座標の取り込みで入ります）、
    # 足しません。**消しもしません。**
    sources = index.setdefault("sources", [])
    names = [x.get("name", "") if isinstance(x, dict) else str(x)
             for x in sources]
    if not any("OpenStreetMap" in x for x in names):
        sources.append(dict(OSM_SOURCE))
    index["osmEnrich"] = {
        "asOf": as_of,
        "tool": "tools/osm_enrich.py",
        "license": "ODbL 1.0",
        "attribution": "© OpenStreetMap contributors",
        "spots": total,
        "matched": stats["matched"],
        "fields": {k: stats[k] for k in (
            "opening_hours", "phone", "website", "wheelchair",
            "toiletsWheelchair", "fee", "charge") if stats[k]},
    }
    with open(p, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))


def default_files():
    """data/osm/ にある配布ファイル。日本全体の1本があれば、それだけを使います
    （地域ごとのファイルと両方読むと、同じ物を2回数えます）。"""
    whole = os.path.join(OSM, "japan.osm.pbf")
    if os.path.exists(whole):
        return [whole]
    return sorted(glob.glob(os.path.join(OSM, "*.osm.pbf")))


def main(argv):
    write = "--write" in argv
    kb_dir = os.path.join(WEB, "kb")
    if "--kb" in argv:
        kb_dir = os.path.abspath(argv[argv.index("--kb") + 1])
    skip = {argv[argv.index("--kb") + 1]} if "--kb" in argv else set()
    files = [a for a in argv if not a.startswith("--") and a not in skip]
    files = files or default_files()
    if not files:
        print("配布ファイルがありません。先に python3 tools/fetch_osm_extracts.py "
              "を走らせてください。")
        return 1

    t0 = time.time()
    pois = []
    seen = set()
    for path in files:
        t = time.time()
        got, cached = scan_cached(path)
        for p in got:
            if p["ref"] not in seen:        # 地域の境で重なる物は1回だけ
                seen.add(p["ref"])
                pois.append(p)
        print(f"  {os.path.basename(path)}: {len(got)}件"
              f"（{'控えから' if cached else '走査'} {time.time() - t:.0f}秒）")
    t_scan = time.time() - t0
    as_of = max(data_date(p) for p in files)

    t1 = time.time()
    shards = load_kb(kb_dir)
    spots = [s for doc in shards.values() for s in doc["spots"]]
    infos, stats = enrich(spots, pois)
    t_match = time.time() - t1

    print(f"\nOSM の物 {len(pois)}件（{as_of} 時点）／収録 {len(spots)}件")
    print(f"  合った場所        {stats['matched']}件"
          f"（Wikidata の番号 {stats['via:wikidata']}・名前 {stats['via:name']}）")
    for k, label in (("opening_hours", "営業時間"), ("phone", "電話"),
                     ("website", "公式サイト"), ("wheelchair", "車いす"),
                     ("toiletsWheelchair", "車いす用トイレ"),
                     ("fee", "料金の有無"), ("charge", "料金")):
        print(f"  {label:<14}{stats[k]}件")
    print(f"  走査 {t_scan:.0f}秒・突き合わせ {t_match:.1f}秒")

    if not write:
        print("\n確認だけです。書き戻すには --write を付けてください。")
        return 0
    changed = apply(shards, infos)
    write_kb(shards, changed)
    register(kb_dir, stats, len(spots), as_of)
    print(f"\n{len(changed)}本のファイルを書き戻しました。"
          "続けて node tools/build_attribution.mjs を走らせてください。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
