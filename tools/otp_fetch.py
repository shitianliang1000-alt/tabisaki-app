# -*- coding: utf-8 -*-
"""OpenTripPlanner（OTP）に読ませる時刻表と地図を集めて、組み立てられる形に整える（Issue #429・#430）。

    python3 tools/otp_fetch.py                  熊本（otp/regions/kumamoto.json）
    python3 tools/otp_fetch.py otp/regions/X.json
    python3 tools/otp_fetch.py --offline        落とさずに、手元のファイルで整え直すだけ
    python3 tools/otp_fetch.py --if-changed     時刻表が前の組み立てと同じなら 3 で終わる
    python3 tools/otp_fetch.py --refresh-osm    地図も落とし直す（ふだんは前のものを使い回す）

ふつうは tools/otp_pipeline.sh から呼びます（取得 → 検査 → 組み立て → 試しの検索。docs/gtfs-pipeline.md）。

時刻表は、地域のファイルの "feeds"（決め打ち）か "select"（県の一覧から、範囲に停留所があるものを
自動で）で決め、tools/gtfs_feeds.py で落として検査します（落とした zip は data/gtfs/feeds/ に
置いて地域どうしで使い回し、一覧の公開日が変わったものだけ落とし直します）。検査を通らないものと
期限切れは読ませず、理由を COVERAGE.md に書きます。

できるもの: data/otp/<地域>/（.gitignore 済み）
    *.gtfs.zip           読ませる時刻表（GTFS データリポジトリ gtfs-data.jp から）
    <地域>.osm.pbf       道路と歩道（OpenStreetMap。OSM France の地方ごとの配布ファイルを、範囲で切る）
    build-config.json    OTP に「どのファイルを、どの名前で読むか」を伝える
    router-config.json   歩く速さなど（otp/router-config.json の写し）
    otp-config.json      使う機能（otp/otp-config.json の写し）
    SOURCES.md           出典とライセンス（一覧の事業者名とライセンスから）
    COVERAGE.md          時刻表ごとの中身・外したものと理由・歩いて行ける停留所の無いスポット
    feeds.json           読ませた時刻表の指紋（組み立て直しが要るかの判定に使う）

## 整えること

GTFS-JP の古い版（第2版まで）の translations.txt は、列が trans_id・lang・translation
です。いまの GTFS（table_name・field_name…）と形が違い、OTP はここで止まります。
読み仮名と英語名だけのファイルなので、古い形のときは外します（経路には効きません）。

地図は、範囲（bbox）で切ると組み立てが速く、メモリも少なくて済みます。
osmium（osmium-tool）が無ければ、切らずに地方のファイルをそのまま使います。

出典: 時刻表はそれぞれの事業者（ライセンスは SOURCES.md）、
地図は © OpenStreetMap contributors（ODbL 1.0）。どちらもリポジトリには入れません。
"""
import csv
import datetime as dt
import io
import json
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gtfs_feeds as G  # noqa: E402  時刻表の一覧・取得・検査・カバー範囲（Issue #430）

WEB = os.path.dirname(HERE)
OTP = os.path.join(WEB, "otp")
download = G.download


def old_translations(data):
    """GTFS-JP 第2版までの translations.txt（trans_id・lang・translation）か。"""
    head = data[:200].decode("utf-8-sig", "replace").splitlines()[0] if data else ""
    cols = [c.strip().strip('"') for c in head.split(",")]
    return "table_name" not in cols


# 子のファイルの列 → 親のファイルの列。OTP（onebusaway の読み込み）は、親の無い参照が
# 1行でもあると組み立てを止めます。経路に要らない行なので、その行だけ外して読ませます。
# 最後の欄は「空でもよいか」（fare_rules の route_id は、空なら全部の路線に効く）。
REFS = [
    ("trips.txt", "route_id", "routes.txt", "route_id", False),
    ("fare_rules.txt", "fare_id", "fare_attributes.txt", "fare_id", False),
    ("fare_rules.txt", "route_id", "routes.txt", "route_id", True),
    ("stop_times.txt", "trip_id", "trips.txt", "trip_id", False),
    ("stop_times.txt", "stop_id", "stops.txt", "stop_id", False),
    ("transfers.txt", "from_stop_id", "stops.txt", "stop_id", False),
    ("transfers.txt", "to_stop_id", "stops.txt", "stop_id", False),
    ("frequencies.txt", "trip_id", "trips.txt", "trip_id", False),
]


def read_csv(data):
    text = data.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    head = [c.strip() for c in rows[0]] if rows else []
    return head, [r for r in rows[1:] if r and any(c.strip() for c in r)]


def write_csv(head, rows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(head)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def normalize(path):
    """OTP が読めない部分を外した zip に書き直します。外したもののリストを返します。

    - GTFS-JP 第2版までの translations.txt（古い形）
    - 親の無い参照の行（運賃のルールが無い運賃を指す、時刻が無い停留所を指す、など）
    - 停留所の親（parent_station）が無いときは、親の欄だけ空にする
    """
    dropped = []
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        files = {n: z.read(n) for n in names}
    by_base = {os.path.basename(n): n for n in names}
    for base, n in list(by_base.items()):
        if base == "translations.txt" and old_translations(files[n]):
            dropped.append(base + "（古い形）")
            del files[n]
            del by_base[base]

    tables = {}

    def table(base):
        if base not in tables and base in by_base:
            tables[base] = read_csv(files[by_base[base]])
        return tables.get(base)

    changed = set()
    stops = table("stops.txt")
    if stops and "parent_station" in stops[0]:
        ids = {r[stops[0].index("stop_id")] for r in stops[1] if len(r) > stops[0].index("stop_id")}
        pi = stops[0].index("parent_station")
        fixed = 0
        for r in stops[1]:
            if len(r) > pi and r[pi].strip() and r[pi].strip() not in ids:
                r[pi] = ""
                fixed += 1
        if fixed:
            dropped.append(f"stops.txt の無い親を指す欄 {fixed}")
            changed.add("stops.txt")
    for child, col, parent, pcol, optional in REFS:
        c, p = table(child), table(parent)
        if not c or col not in c[0]:
            continue
        ci = c[0].index(col)
        if p and pcol in p[0]:
            pi = p[0].index(pcol)
            ids = {r[pi].strip() for r in p[1] if len(r) > pi}
        else:
            ids = set()
        def ok(r):
            v = r[ci].strip() if len(r) > ci else ""
            return v in ids or (optional and not v)
        keep = [r for r in c[1] if ok(r)]
        if len(keep) != len(c[1]):
            dropped.append(f"{child} の無い {col} を指す行 {len(c[1]) - len(keep)}")
            tables[child] = (c[0], keep)
            changed.add(child)
    if not dropped:
        return dropped
    for base in changed:
        files[by_base[base]] = write_csv(*tables[base])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in files.items():
            z.writestr(n, data)
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return dropped


def crop(src, dst, bbox):
    """osmium で範囲を切ります。osmium が無ければ、そのまま写します。"""
    if shutil.which("osmium"):
        box = ",".join(str(x) for x in bbox)
        subprocess.run(["osmium", "extract", "-b", box, src, "-o", dst, "--overwrite"], check=True)
        return "切った（" + box + "）"
    shutil.copyfile(src, dst)
    return "切らずに使う（osmium がありません）"


def stops_inside(rep, bbox):
    return sum(1 for s in rep.get("stops", ()) if bbox[0] <= s[1] <= bbox[2] and bbox[1] <= s[0] <= bbox[3])


def candidates(region, catalog):
    """地域のファイルから、見る時刻表を決めます。

    "feeds": [...]            事業者と時刻表の ID を並べる（決め打ち）。一覧に無いものは
                              "url"・"license" も書く（ODPT など。鍵は {ODPT_KEY} と書いて環境変数から）
    "select": {"prefectures": [43], "min_stops": 3, "exclude": ["org/feed"]}
                              県の時刻表を一覧から全部見て、範囲（osm.bbox）に停留所が
                              min_stops 以上あるものを使う（新しい事業者が載れば自動で入る）
    """
    by_key = {G.feed_key(f): f for f in catalog}
    if "select" in region:
        sel = region["select"]
        skip = set(sel.get("exclude", []))
        return [f for f in G.select(catalog, set(sel["prefectures"])) if G.feed_key(f) not in skip]
    out = []
    for f in region["feeds"]:
        key = f"{f['org']}/{f['feed']}"
        if key in by_key:
            out.append(by_key[key])
        else:  # 一覧に無い（手で足した）時刻表。"url" に {ODPT_KEY} のような差し込みを書ける
            out.append({"organization_id": f["org"], "feed_id": f["feed"], "feed_name": f["name"],
                        "organization_name": f.get("publisher", f["name"]), "feed_license": f.get("license", ""),
                        "feed_license_url": f.get("license_url", ""), "download_url": f.get("url"),
                        "last_published_at": f.get("version", ""), "feed_pref_id": None})
    return out


def choose(region, feeds, index, log=print):
    """検査の結果で、OTP に読ませるものと外すもの（理由つき）に分けます。"""
    bbox = region["osm"]["bbox"]
    min_stops = region.get("select", {}).get("min_stops", 1)
    use, skipped = [], []
    for f in feeds:
        key = G.feed_key(f)
        rep = index.get(key)
        if rep is None:
            skipped.append((f, "検査の結果が無い（落とせていない）"))
        elif rep.get("errors"):
            skipped.append((f, "; ".join(rep["errors"])))
        elif rep.get("status") == "期限切れ":
            skipped.append((f, f"有効期間が切れている（{rep.get('end')} まで）"))
        elif stops_inside(rep, bbox) < min_stops:
            skipped.append((f, f"範囲の中の停留所が {stops_inside(rep, bbox)}"))
        else:
            use.append((f, rep))
    for f, why in skipped:
        log(f"  外す: {f['feed_name']}（{G.feed_key(f)}）{why}")
    return use, skipped


def fingerprint(use):
    return sorted([G.feed_key(f), rep.get("sha256", "")] for f, rep in use)


def region_coverage_md(region, use, skipped, today):
    index = {G.feed_key(f): rep for f, rep in use}
    spots = G.load_spots(region["osm"]["bbox"])
    cov = G.coverage(index, spots)
    total = {"spots": 0, "walk": 0, "often": 0}
    for p in cov["per_pref"].values():
        for k in total:
            total[k] += p[k]
    lines = [f"# {region['name']} のカバー範囲", "",
             f"判定の日: {today.isoformat()}（tools/otp_fetch.py が書きました）", "",
             "| 時刻表 | 事業者 | 乗り物 | 停留所 | 有効期間 | 基準の日の便 | 状態 |",
             "| --- | --- | --- | ---: | --- | ---: | --- |"]
    for f, rep in use:
        modes = "・".join(sorted(rep.get("modes", {})))
        lines.append(f"| {f['feed_name']} | {f.get('organization_name', '')} | {modes} | {rep.get('stops_count', 0):,} | "
                     f"{rep.get('start')} 〜 {rep.get('end')} | {rep.get('trips_on_reference_day', 0):,} | {rep.get('status')} |")
    if skipped:
        lines += ["", "外したもの:", ""]
        lines += [f"- {f['feed_name']}（`{G.feed_key(f)}`）: {why}" for f, why in skipped]
    lines += ["", "| 範囲の中のスポット | |", "| --- | ---: |",
              f"| スポット | {total['spots']:,} |",
              f"| {G.WALK_M}m 以内に便のある停留所 | {total['walk']:,}（{G.pct(total['walk'], total['spots'])}） |",
              f"| {G.WALK_M}m 以内に1日{G.OFTEN}本以上の停留所 | {total['often']:,}（{G.pct(total['often'], total['spots'])}） |"]
    far = cov["far"]
    if far:
        lines += ["", f"歩いて行ける停留所が無いスポット（{len(far)}件。この時刻表の範囲では、車かタクシーの区間になります）:", ""]
        for s in sorted(far, key=lambda s: (s.get("category") or "", s["name"] or ""))[:40]:
            lines.append(f"- {s['name']}（{s.get('category') or '-'}）")
        if len(far) > 40:
            lines.append(f"- ほか {len(far) - 40}件")
    return "\n".join(lines) + "\n", total


def main(argv):
    offline = "--offline" in argv
    if_changed = "--if-changed" in argv
    today = dt.date.fromisoformat(G.opt(argv, "--today", dt.date.today().isoformat()))
    args = [a for a in argv if not a.startswith("--") and a != G.opt(argv, "--today")]
    region_path = args[0] if args else os.path.join(OTP, "regions", "kumamoto.json")
    region = json.load(open(region_path, encoding="utf-8"))
    key = os.path.splitext(os.path.basename(region_path))[0]
    out = os.path.join(WEB, "data", "otp", key)
    os.makedirs(out, exist_ok=True)
    print(f"{region['name']} → {os.path.relpath(out, WEB)}")

    # 1. 一覧から見る時刻表を決め、落として（変わったものだけ）検査する
    catalog = G.load_catalog(refresh=not offline)["feeds"]
    feeds = candidates(region, catalog)
    index = G.fetch(feeds, today, offline=offline, log=lambda m: print("  " + m.strip()))
    use, skipped = choose(region, feeds, index)
    if not use:
        print("使える時刻表がありません", file=sys.stderr)
        return 1

    # 2. 地域のフォルダに写して、OTP が読めない部分を外す（前の残りは消す。OTP はフォルダの zip を全部読むため）
    names = set()
    transit = []
    for f, rep in use:
        name = f"{f['feed_id']}.gtfs.zip"
        names.add(name)
        shutil.copyfile(os.path.join(G.DATA, "feeds", f["organization_id"], f["feed_id"] + ".zip"),
                        os.path.join(out, name))
        dropped = normalize(os.path.join(out, name))
        if dropped:
            print(f"  {f['feed_name']}: 外した {', '.join(dropped)}")
        transit.append({"type": "gtfs", "feedId": f["feed_id"], "source": name})
    for old in os.listdir(out):
        if old.endswith(".gtfs.zip") and old not in names:
            os.remove(os.path.join(out, old))
            print(f"  消した（もう使わない）: {old}")

    # 3. 地図（地方のファイルは大きいので、前に落としたものがあれば使い回す）
    osm = region["osm"]
    raw = os.path.join(WEB, "data", "otp", f"_{key}-extract.osm.pbf")
    pbf = f"{key}.osm.pbf"
    if not offline and (not os.path.exists(raw) or "--refresh-osm" in argv):
        download(osm["extract"], raw)
        print(f"  地図: {os.path.getsize(raw) / 1e6:.0f}MB")
    if not os.path.exists(os.path.join(out, pbf)) or "--refresh-osm" in argv:
        print(f"  地図を{crop(raw, os.path.join(out, pbf), osm['bbox'])}")

    build = {"dataImportReport": False, "transitFeeds": transit,
             "osm": [{"source": pbf, "timeZone": "Asia/Tokyo"}]}
    with open(os.path.join(out, "build-config.json"), "w", encoding="utf-8") as fp:
        json.dump(build, fp, ensure_ascii=False, indent=2)
    for name in ("router-config.json", "otp-config.json"):
        shutil.copyfile(os.path.join(OTP, name), os.path.join(out, name))

    # 4. 出典・カバー範囲・指紋
    lines = [f"# {region['name']} の出典", "",
             "OpenTripPlanner に読ませるデータです。リポジトリには入れていません（tools/otp_fetch.py で作り直せます）。", "",
             "| データ | 提供元 | ライセンス |", "| --- | --- | --- |"]
    for f, rep in use:
        lic = f.get("feed_license") or ""
        if f.get("feed_license_url"):
            lic = f"[{lic}]({f['feed_license_url']})"
        lines.append(f"| 時刻表 {f['feed_name']} | {f.get('organization_name', '')}（GTFS データリポジトリ `{G.feed_key(f)}`） | {lic} |")
    lines.append("| 道路・歩道 | © OpenStreetMap contributors | ODbL 1.0 |")
    with open(os.path.join(out, "SOURCES.md"), "w", encoding="utf-8") as fp:
        fp.write("\n".join(lines) + "\n")
    md, total = region_coverage_md(region, use, skipped, today)
    with open(os.path.join(out, "COVERAGE.md"), "w", encoding="utf-8") as fp:
        fp.write(md)
    feeds_doc = {"region": key, "today": today.isoformat(), "feeds": fingerprint(use),
                 "skipped": [[G.feed_key(f), why] for f, why in skipped]}
    with open(os.path.join(out, "feeds.json"), "w", encoding="utf-8") as fp:
        json.dump(feeds_doc, fp, ensure_ascii=False, indent=1)
    print(f"  時刻表 {len(use)}本（外した {len(skipped)}）。範囲のスポット {total['spots']}件のうち "
          f"{G.pct(total['walk'], total['spots'])} が {G.WALK_M}m 以内に便のある停留所")
    print("  build-config.json・SOURCES.md・COVERAGE.md・feeds.json を書きました")

    # 5. 組み立て直しが要るか（前に組み立てたときの指紋と比べる）
    built = os.path.join(out, "graph-feeds.json")
    if if_changed and os.path.exists(built) and os.path.exists(os.path.join(out, "graph.obj")):
        with open(built, encoding="utf-8") as fp:
            if json.load(fp).get("feeds") == feeds_doc["feeds"]:
                print("  時刻表は前の組み立てから変わっていません")
                return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
