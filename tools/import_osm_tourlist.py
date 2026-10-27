# -*- coding: utf-8 -*-
"""座標が引けなかった観光地の名前に、OpenStreetMap から座標を付けて足す。

    python3 tools/fetch_osm_extracts.py            地域ごとの配布ファイルを落とす
    python3 tools/import_osm_tourlist.py --check   確認するだけ
    python3 tools/import_osm_tourlist.py --write   足して書き戻す

前提
----
tools/import_tourism_list.py が、県ごとの観光地の一覧（xlsx）の名前を
ウィキペディアの座標で突き合わせ、**引けなかったもの**を
data/wikipedia/tourlist-unplaced.json に残します（およそ4万2千件）。
この道具は、その残りを OpenStreetMap の配布ファイルと突き合わせます。

なぜ配布ファイルなのか
----------------------
1件ずつ聞く道はどれも駄目でした。

  ・国土地理院の住所検索 … 施設名では引けません。0件か、別の県の同名の
    地名が返ります（「新田神社」→ 北海道月形町新田）
  ・Nominatim           … 大量の問い合わせを禁じています
  ・ウィキペディアの API … 断られます（この出口から）

配布ファイルなら、地域ごとに1回落とせば、何件でも手元で突き合わせられ
ます（ウィキペディアの座標のときと同じやり方です）。

県が合っているものだけを採ります
--------------------------------
「新田神社」「八幡宮」「大師堂」は、どの県にもあります。OpenStreetMap
にも、同じ名前が何十件も入っています。

  ・座標が、一覧の県の中にあるものだけを候補にします
  ・**その県の中で、1か所に決まるときだけ**足します。800m以内の候補は
    同じ場所と見なして1つに数え、それ以上離れた候補が2か所以上あるときは
    どちらか決められないので足しません

行き先らしいものだけを採ります
------------------------------
名前が一致しても、タグが行き先らしくなければ採りません。同じ名前の
店・飲食店・宿があるからです。

  採る   tourism=（attraction・viewpoint・museum・zoo…）／historic=*／
        natural=（peak・cape・beach・hot_spring…）／waterway=waterfall／
        leisure=（park・garden・nature_reserve）／
        amenity=place_of_worship・public_bath／man_made=lighthouse
  採らない  shop=* ／飲食（restaurant・cafe…）／宿（hotel・guest_house…）

分類は**タグから決めます**（名前の終わりからではなく）。神社か寺かは
religion=shinto / buddhist で分かります。決められないものは「観光名所」に
します。

出典と利用条件（重要）
----------------------
OpenStreetMap のデータは **ODbL 1.0** です。

  ・**「© OpenStreetMap contributors」の表示が必須です。** 収録の出典に
    足します（画面の下の「データ: …」に出ます）。
  ・**同じ条件で共有する義務があります**（share-alike）。この道具が入れた
    座標を含む収録（kb/）は、ODbL の派生データベースにあたります。
    収録は公開リポジトリにあるので、docs/data-licenses.md に条件を書きます。
  ・まとめて外したくなったときのために、src="osm-tourlist" の印と、
    osm="node/123" の元の番号を1件ごとに持たせます。

名前・座標は OpenStreetMap のものです。この一覧の名前は写していません
（一覧は「観光地として挙がっている」ことの確認にだけ使います）。
"""
import collections
import glob
import hashlib
import json
import os
import re
import sys
import unicodedata

from dedupe_spots import same_place
from place_match import CLUSTER_KM, cluster, pick, select
import place_match
from import_tourism_list import (
    LODGING, PrefectureLocator, clean_name, n, variants, split_variants,
)
from import_wikipedia_lists import (
    NOT_A_DESTINATION, describe, km, load_shards, looks_unusable, register,
)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
RAW = os.path.join(WEB, "data", "wikipedia")
OSM = os.path.join(WEB, "data", "osm")

# 前回このファイルが入れたぶんを取り除くための印。
# ウィキペディアの取り込み（wikipedia / wikipedia-tourlist）とは別にして
# あります。同じ印にすると、あちらを走らせたときにこちらのぶんが消えます。
SRC = "osm-tourlist"

# 画面の下の「データ: …」に出る名前。**ODbL は表示が必須です。**
OSM_SOURCE = {"name": "© OpenStreetMap contributors (ODbL)",
              "url": "https://www.openstreetmap.org/copyright"}
PREF_SOURCE = {"name": "各都道府県の公式観光サイト", "url": ""}

# エリアの代表点からこれ以上離れた場所は、置きません。
MAX_PLACE_KM = 100.0

# 名前として拾うタグ。alt_name は「;」区切りで複数入ります。
NAME_KEYS = ("name", "name:ja", "official_name", "alt_name")


def category_of(tags):
    """OSM のタグから、収録の分類を決めます。行き先らしくなければ None。

    **決められないものは None です（黙って観光名所にしません）。**
    宿・店・飲食は、名前が一致しても行き先ではないので None にします。
    """
    t = tags
    if t.get("shop") or t.get("amenity") in (
            "restaurant", "cafe", "fast_food", "bar", "pub", "food_court",
            "ice_cream", "biergarten"):
        return None
    if t.get("tourism") in ("hotel", "hostel", "guest_house", "motel",
                            "apartment", "chalet", "alpine_hut",
                            "wilderness_hut"):
        return None
    # ロープウェイ・ゴンドラ・リフト。線（way）にも乗り場（station）にも
    # aerialway が付いています。一覧の名前が「〇〇ロープウェイ」のとき、
    # 名前の一致した線か乗り場の座標を採ります。
    if t.get("aerialway"):
        return "ロープウェイ"
    # キャンプ場・ゴルフ場は、名前が一覧と一致したときだけ入ります。
    # 一覧に行き先として載っているためで、宿ではありません。
    if t.get("tourism") in ("camp_site", "caravan_site") or t.get(
            "leisure") == "golf_course":
        return "観光名所"

    # 神社か寺か。religion で分かります。
    if t.get("amenity") == "place_of_worship" or t.get("building") in (
            "shrine", "temple", "church", "cathedral"):
        rel = t.get("religion")
        if rel == "shinto" or t.get("building") == "shrine":
            return "神社"
        if rel == "buddhist" or t.get("building") == "temple":
            return "寺院"
        if rel == "christian" or t.get("building") in ("church", "cathedral"):
            return "教会"
        return "観光名所"

    # **決まりの順番が、分類を決めます。** 1つの物に複数のタグが付いて
    # いることが多いためです。実物で見つかりました。
    #
    #   奈良町にぎわいの家   tourism=museum + historic=building
    #   眉山治山祈念公苑     leisure=park   + historic=memorial
    #
    # はじめは historic を先に見ていたので、どちらも「史跡」になりました。
    # 博物館・公園と分かる物は、その分類を先にします。「史跡」は、ほかに
    # 決め手が無い historic の物の受け皿です。
    hist = t.get("historic")
    if hist == "castle":
        return "城"

    tour = t.get("tourism")
    if tour == "museum":
        return "博物館"
    if tour == "gallery":
        return "美術館"
    if tour == "zoo":
        return "動物園"
    if tour == "aquarium":
        return "水族館"
    if tour == "theme_park":
        return "テーマパーク"

    if t.get("leisure") == "park":
        return "公園"
    if t.get("leisure") == "garden":
        return "庭園"

    if hist:
        return "史跡"

    if tour == "viewpoint":
        return "展望台"
    if tour in ("attraction", "artwork"):
        return "観光名所"

    nat = t.get("natural")
    if t.get("waterway") == "waterfall" or nat == "waterfall":
        return "滝"
    if nat in ("peak", "volcano"):
        return "山"
    if nat == "cape":
        return "岬"
    if nat == "beach" or t.get("leisure") == "beach_resort":
        return "海岸"
    if nat == "hot_spring":
        return "温泉"
    if nat == "cave_entrance":
        return "自然"
    if nat == "water" and t.get("water") in ("lake", "pond", "reservoir"):
        return "湖"

    if t.get("amenity") == "public_bath":
        return "温泉"
    if t.get("leisure") == "nature_reserve":
        return "自然"
    if t.get("man_made") == "lighthouse":
        return "灯台"
    return None


def names_of(tags):
    """タグから、突き合わせに使う名前を全部拾います。"""
    out = []
    for k in NAME_KEYS:
        v = tags.get(k)
        if not v:
            continue
        out.extend(x.strip() for x in v.split(";") if x.strip())
    return out


def centroid(nodes):
    """線（way）の重心。**閉じた線は、終点を数えません。**

    閉じた線は始点と終点が同じ点なので、そのまま平均すると始点のほうへ
    偏ります。
    """
    pts = [(nd.lat, nd.lon) for nd in nodes]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts))


def scan(path, wanted):
    """配布ファイルから、名前が一覧にあるものの候補を拾います。

    candidates[正規化した名前] = [{lat, lng, osm, tags, name}, ...]

    **一覧にある名前だけを覚えます。** 日本の地域ファイルには名前つきの
    物が数十万件あり、全部を持つ必要はありません。
    """
    import osmium

    found = collections.defaultdict(list)
    # 場所の索引（線の重心を出すのに、点の座標が要ります）。
    #
    # 日本全体のファイル（約2.7GB）は、記憶に載せると数GBになります。
    # 大きいものは、**ディスクに置く索引**にします（遅くなりますが、記憶を
    # 食いません）。地域ごとの小さなファイルは、記憶のままで足ります。
    idx = "flex_mem"
    tmp = None
    if os.path.getsize(path) > 1_000_000_000:
        tmp = os.path.join(OSM, ".nodes.idx")
        idx = f"sparse_file_array,{tmp}"
    proc = (osmium.FileProcessor(path, osmium.osm.NODE | osmium.osm.WAY)
            .with_locations(idx)
            .with_filter(osmium.filter.KeyFilter("name")))
    for o in proc:
        tags = {t.k: t.v for t in o.tags}
        keys = [n(x) for x in names_of(tags)]
        keys = [k for k in keys if k in wanted]
        if not keys:
            continue
        # **ここでは行き先かどうかを決めません。** タグをそのまま控えます。
        # 決まり（category_of）は控えの後で当てるので、直した結果がすぐ
        # 効きます（日本全体の走査は数分かかります）。
        if o.is_node():
            lat, lng = o.location.lat, o.location.lon
            osm = f"node/{o.id}"
        else:
            c = centroid(o.nodes)
            if c is None:
                continue
            lat, lng = c
            osm = f"way/{o.id}"
        cand = {"lat": lat, "lng": lng, "osm": osm, "key": osm, "tags": tags,
                "name": tags.get("name") or names_of(tags)[0]}
        for k in set(keys):
            found[k].append(cand)
    if tmp and os.path.exists(tmp):
        os.remove(tmp)      # 索引は使い捨てです（数GBあります）
    return found


def scan_cached(path, wanted):
    """scan() の結果を控えます。日本全体の走査は数分かかります。

    確かめながら決まりを直すたびに走査し直すと、一回ごとに待たされます。
    **配布ファイルと一覧の名前が同じなら、同じ結果**なので、控えを使います
    （大きさ・更新時刻・一覧の名前の指紋が変わったら、読み直します）。
    決まり（category_of など）は控えの**後**で当てるので、直した結果は
    すぐに効きます。
    """
    st = os.stat(path)
    fp = hashlib.sha1("\n".join(sorted(wanted)).encode("utf-8")).hexdigest()
    # 版：控えの形が変わったら上げます。**上げ忘れると、古い形の控えを新しい
    # 規則が読んで落ちます**（候補に key が無く、実物のデータで初めて
    # 落ちました。合成データの試験は控えを使わないので通っていました）。
    key = f"v3:{os.path.basename(path)}:{st.st_size}:{int(st.st_mtime)}:{fp}"
    cache = os.path.join(OSM, ".scan-cache.json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            doc = json.load(f)
        if doc.get("key") == key:
            print("    （控えを使います）")
            return doc["found"]
    found = scan(path, wanted)
    with open(cache, "w", encoding="utf-8") as f:
        json.dump({"key": key, "found": found}, f, ensure_ascii=False)
    return found


def display_name(cand, name):
    """OSM の名前から、**一覧の名前に当たった部分**を表示に使います。

    OSM の name には、複数の名前が「;」でつながっていることがあります。

        網張温泉館;薬師の湯
        麻績村福祉センター;みたらし温泉      ← 一覧は「みたらし温泉」
        荒神山温泉;湯にいくセンター          ← 一覧は「湯にいくセンター」

    そのまま出すと、画面に「麻績村福祉センター;みたらし温泉」と並びます。
    一覧の名前に当たった部分を採ります。当たる部分が無ければ（通称の
    alt_name で当たったときなど）最初の名前です。
    全角スペースは半角にし、続く空白は1つにします。
    """
    want = {n(v) for v in variants(name)}
    parts = [x.strip() for x in cand["tags"].get("name", "").split(";")
             if x.strip()] or [cand["name"]]
    # name の中に、一覧の名前に当たる部分があれば、それを採ります。
    # **alt_name（通称）で当たったときは、name の最初の名前**を採ります。
    # alt_name は別名で、表示する名前ではありません（正式な名前が name に
    # あります）。
    pick_ = next((x for x in parts if n(x) in want), parts[0])
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", pick_)).strip()


def spot_id(pref, name):
    h = hashlib.sha1(f"osm:{pref}/{name}".encode("utf-8")).hexdigest()[:10]
    return f"os-{h}"


def match(unplaced, found, locator):
    """一覧の名前ごとに、OSM の候補から1つに決めます（県の決め方は共通）。

    候補は「行き先らしい」ものだけです（店・宿・ただの建物は採りません）。
    県が合うものを先に、無ければ全国から（ご指示で、県の食い違いを許し
    ます。決め方は tools/place_match.py の select に書きました）。

    返り値: (決まったもの, 内訳の数)
    """
    hits, why = [], collections.Counter()
    for pref, raw in unplaced:
        name = clean_name(raw)
        if not name:
            why["閉店・店・宿・体験・催し"] += 1
            continue
        cands, weak = [], False
        weak_set = set(split_variants(name)[1])
        for v in variants(name):
            for c in found.get(n(v), []):
                cat = category_of(c["tags"])
                if cat is None:
                    continue
                cands.append({**c, "category": cat})
            if cands:
                weak = v in weak_set
                break
        chosen, reason, mismatch = place_match.select_for(
            cands, pref, locator, weak)
        if chosen is None:
            why["OSM に無い" if reason == "候補が無い" else reason] += 1
            continue
        hits.append((pref, raw, {**chosen, "name": display_name(chosen, name),
                                 "mismatch": mismatch}))
        why["決まった（県の食い違い）" if mismatch else "決まった"] += 1
    return hits, why


def resolve_shared(hits):
    """同じ OSM の物に一覧の名前が複数当たったときの決め方（共通の規則）。"""
    return place_match.resolve_shared(
        hits, lambda c: {n(x) for x in names_of(c["tags"])},
        lambda raw: n(clean_name(raw) or ""))


def main(write, only=None):
    upath = os.path.join(RAW, "tourlist-unplaced.json")
    if not os.path.exists(upath):
        raise SystemExit(
            "座標が引けなかった名前の一覧がありません。先に\n"
            "  python3 tools/import_tourism_list.py 一覧.xlsx --write\n"
            "を走らせてください。")
    with open(upath, encoding="utf-8") as f:
        unplaced = json.load(f)

    files = sorted(glob.glob(os.path.join(OSM, "*.osm.pbf")))
    if only:
        files = [p for p in files if any(o in os.path.basename(p) for o in only)]
    if not files:
        raise SystemExit(
            "OpenStreetMap の配布ファイルがありません（data/osm/）。\n"
            "  python3 tools/fetch_osm_extracts.py\n"
            "で落としてください。")
    print(f"座標が引けなかった名前 {len(unplaced)}件 / 配布ファイル {len(files)}本")

    # 一覧の名前（の候補）を、正規化した形で全部集めます。
    wanted = set()
    for pref, raw in unplaced:
        name = clean_name(raw)
        if name:
            wanted.update(n(v) for v in variants(name))

    found = collections.defaultdict(list)
    for p in files:
        print(f"  {os.path.basename(p)} を読んでいます…")
        for k, v in scan_cached(p, wanted).items():
            found[k].extend(v)
    print(f"  名前が一致した OSM の物 {sum(len(v) for v in found.values())}件")

    with open(os.path.join(WEB, "kb", "regions.json"), encoding="utf-8") as f:
        regions_doc = json.load(f)
    regions = regions_doc["regions"]
    locator = PrefectureLocator(regions)

    hits, why = match(unplaced, found, locator)
    # 「足す」は、あとで足せたものを実際に数えて出します。引き算を積み重ねる
    # と、外す理由が増えるたびに数が合わなくなります。
    for k in [k for k in why if k.startswith("決まった")]:
        del why[k]
    hits, shared = resolve_shared(hits)
    if shared:
        why["同じ OSM の物に複数の名前が当たった（決められない／注だけ違う）"] += shared

    shards = load_shards()
    # 前回ここが入れたぶんは、数え直します（2回走らせても二重にならない）。
    existing = [s for doc in shards.values() for s in doc["spots"]
                if s.get("src") != SRC]
    grid = collections.defaultdict(list)
    for s in existing:
        grid[(round(s["lat"] / 0.05), round(s["lng"] / 0.05))].append(s)

    named_here = {(s["regionId"], n(s["name"])) for s in existing}
    add, used = [], set()
    for pref, raw, c in hits:
        name = re.sub(r"\s*[（(][^）)]*[）)]\s*$", "", c["name"]).strip() or c["name"]
        # 表示する名前でも、行き先かを確かめます（括弧を外した後）。
        if (looks_unusable(name, c["lat"], c["lng"])
                or name.endswith(NOT_A_DESTINATION) or LODGING.search(name)):
            why["行き先にならない名前"] += 1
            continue
        if c["osm"] in used:
            why["同じ OSM の物に2つの名前が当たった"] += 1
            continue
        gx, gy = round(c["lat"] / 0.05), round(c["lng"] / 0.05)
        near = [x for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for x in grid[(gx + dx, gy + dy)]]
        probe = {"name": name, "lat": c["lat"], "lng": c["lng"]}
        if any(same_place(probe, s, km(c["lat"], c["lng"], s["lat"], s["lng"]))
               for s in near):
            why["すでに収録にある"] += 1
            continue
        region = locator.region_near(c["lat"], c["lng"])
        # 同じエリアに同じ名前があるときは、足しません。座標が離れていても
        # 同じ旅程に同じ名前が2回出るためです（別の段が、同じ一覧の名前に
        # 別の場所を当てたことがありました：伊勢山公園、月屋山）。
        if (region["id"], n(name)) in named_here:
            why["同じエリアに同名がすでにある"] += 1
            continue
        named_here.add((region["id"], n(name)))
        # エリアから遠すぎる場所は置きません（県の食い違いは許しますが、どの
        # エリアの近くでもない場所に、そのエリアの県を付けると、県の表示が
        # 実際と食い違います）。
        if km(c["lat"], c["lng"], region["lat"], region["lng"]) > MAX_PLACE_KM:
            why["エリアから遠すぎて置けない"] += 1
            continue
        spot = {
            "id": spot_id(pref, name),
            "regionId": region["id"],
            "name": name,
            "category": c["category"],
            "lat": round(c["lat"], 5),
            "lng": round(c["lng"], 5),
            # 一覧は1つだけです。定番かどうかを決める材料がありません。
            "fame_tier": "hidden",
            "osm": c["osm"],
            "src": SRC,
        }
        if c.get("mismatch"):
            # 一覧の県と、座標の県が違うもの。あとで数えたり、外したりできる
            # ように、一覧の県を残します。
            spot["listedIn"] = pref
        add.append(spot)
        used.add(c["osm"])
        grid[(gx, gy)].append(spot)

    why["足す"] = len(add)
    why["  うち県の食い違い"] = sum(1 for x in add if x.get("listedIn"))
    print("\n内訳:")
    for k, v in why.most_common():
        print(f"  {k}: {v}件")
    if "--show" in sys.argv:
        import random
        random.seed(int(os.environ.get("SEED", "3")))
        cat = os.environ.get("CAT")
        pool = [(p, r, c) for p, r, c in hits if not cat or c["category"] == cat]
        print(f"\n無作為に30件{'（' + cat + '）' if cat else ''}"
              "（一覧の名前 → OSM の名前 / 分類 / 番号 / 主なタグ）:")
        for p, r, c in random.sample(pool, min(30, len(pool))):
            t = c["tags"]
            keys = {k: t[k] for k in ("amenity", "leisure", "tourism", "historic",
                                       "natural", "religion", "bath:type", "building")
                    if k in t}
            print(f"  {p} {r!r} → {c['name']!r} [{c['category']}] {c['osm']} {keys}")

    print(f"\n足す {len(add)}件")
    for cat, cnt in collections.Counter(s["category"] for s in add).most_common():
        print(f"  {cat} {cnt}件")

    if not write:
        print("\n--write を付けると書き戻します。")
        return

    # 前回のぶんを、収録ぜんぶから印（src）で取り除きます。
    removed = 0
    for p, doc in shards.items():
        keep = [x for x in doc["spots"] if x.get("src") != SRC]
        removed += len(doc["spots"]) - len(keep)
        if len(keep) != len(doc["spots"]):
            doc["spots"] = keep
            with open(p, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    for p in glob.glob(os.path.join(WEB, "kb", "spots-os*.json")):
        os.remove(p)
        shards.pop(p, None)
    if removed:
        print(f"  前回のぶん {removed}件 を取り除きました")

    per_file = 2500
    for i in range(0, len(add), per_file):
        chunk = add[i:i + per_file]
        p = os.path.join(WEB, "kb", f"spots-os{i // per_file:02d}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"spots": chunk}, f, ensure_ascii=False,
                      separators=(",", ":"))
        shards[p] = {"spots": chunk}

    # **索引に登録します。** 登録しないと reshard_kb.py が読まずに消します。
    total = register(shards, regions_doc, [OSM_SOURCE, PREF_SOURCE])
    print(f"\n収録 {total}件になりました。")
    print("このあと tools/reshard_kb.py を走らせて、県ごとに並べ直します。")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main("--write" in sys.argv, only=args or None)
