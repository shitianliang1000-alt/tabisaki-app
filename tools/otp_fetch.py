# -*- coding: utf-8 -*-
"""OpenTripPlanner（OTP）に読ませる時刻表と地図を集めて、組み立てられる形に整える（Issue #429）。

    python3 tools/otp_fetch.py                  熊本（otp/regions/kumamoto.json）
    python3 tools/otp_fetch.py otp/regions/X.json
    python3 tools/otp_fetch.py --offline        落とさずに、手元のファイルを整え直すだけ

できるもの: data/otp/<地域>/（.gitignore 済み）
    *.gtfs.zip           GTFS-JP の時刻表（GTFS データリポジトリ gtfs-data.jp から）
    <地域>.osm.pbf       道路と歩道（OpenStreetMap。OSM France の地方ごとの配布ファイルを、範囲で切る）
    build-config.json    OTP に「どのファイルを、どの名前で読むか」を伝える
    router-config.json   歩く速さなど（otp/router-config.json の写し）
    otp-config.json      使う機能（otp/otp-config.json の写し）
    SOURCES.md           出典とライセンス

そのあと:
    docker compose --profile otp run --rm otp-build   # 経路網を組み立てる（熊本で1分ほど）
    docker compose --profile otp up -d otp            # http://127.0.0.1:8080 で答える

## 整えること

GTFS-JP の古い版（第2版まで）の translations.txt は、列が trans_id・lang・translation
です。いまの GTFS（table_name・field_name…）と形が違い、OTP はここで止まります。
読み仮名と英語名だけのファイルなので、古い形のときは外します（経路には効きません）。

地図は、範囲（bbox）で切ると組み立てが速く、メモリも少なくて済みます。
osmium（osmium-tool）が無ければ、切らずに地方のファイルをそのまま使います。

出典: 時刻表はそれぞれの事業者（ライセンスは地域のファイルと SOURCES.md）、
地図は © OpenStreetMap contributors（ODbL 1.0）。どちらもリポジトリには入れません。
"""
import io
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OTP = os.path.join(WEB, "otp")
UA = "Tabisaki/1.0 (+https://github.com/shitianliang1000-alt/tabisaki-app)"
FEED_URL = "https://api.gtfs-data.jp/v2/organizations/{org}/feeds/{feed}/files/feed.zip"


def download(url, path):
    """url を path に落とします。途中で切れても半端なファイルを残しません。"""
    tmp = path + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as res, open(tmp, "wb") as out:
        shutil.copyfileobj(res, out, 1 << 20)
    os.replace(tmp, path)
    return os.path.getsize(path)


def old_translations(data):
    """GTFS-JP 第2版までの translations.txt（trans_id・lang・translation）か。"""
    head = data[:200].decode("utf-8-sig", "replace").splitlines()[0] if data else ""
    cols = [c.strip().strip('"') for c in head.split(",")]
    return "table_name" not in cols


def normalize(path):
    """OTP が読めない部分を外した zip に書き直します。外したもののリストを返します。"""
    dropped = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        files = {n: z.read(n) for n in names}
    for n in names:
        base = os.path.basename(n)
        if base == "translations.txt" and old_translations(files[n]):
            dropped.append(base + "（古い形）")
            del files[n]
    if not dropped:
        return dropped
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


def main(argv):
    offline = "--offline" in argv
    args = [a for a in argv if not a.startswith("--")]
    region_path = args[0] if args else os.path.join(OTP, "regions", "kumamoto.json")
    region = json.load(open(region_path, encoding="utf-8"))
    key = os.path.splitext(os.path.basename(region_path))[0]
    out = os.path.join(WEB, "data", "otp", key)
    os.makedirs(out, exist_ok=True)
    print(f"{region['name']} → {os.path.relpath(out, WEB)}")

    feeds = []
    for f in region["feeds"]:
        name = f"{f['feed']}.gtfs.zip"
        path = os.path.join(out, name)
        if not offline:
            size = download(FEED_URL.format(org=f["org"], feed=f["feed"]), path)
            print(f"  時刻表 {f['name']}: {size / 1e3:,.0f}KB")
        dropped = normalize(path)
        if dropped:
            print(f"    外した: {', '.join(dropped)}")
        feeds.append({"type": "gtfs", "feedId": f["feed"], "source": name})

    osm = region["osm"]
    # 切る前の地図は、地域のフォルダの外に置きます（OTP は、フォルダにある .pbf を全部読みます）。
    raw = os.path.join(WEB, "data", "otp", f"_{key}-extract.osm.pbf")
    pbf = f"{key}.osm.pbf"
    if not offline:
        size = download(osm["extract"], raw)
        print(f"  地図: {size / 1e6:.0f}MB")
    print(f"  地図を{crop(raw, os.path.join(out, pbf), osm['bbox'])}")

    build = {
        "dataImportReport": False,
        "transitFeeds": feeds,
        "osm": [{"source": pbf, "timeZone": "Asia/Tokyo"}],
    }
    with open(os.path.join(out, "build-config.json"), "w", encoding="utf-8") as fp:
        json.dump(build, fp, ensure_ascii=False, indent=2)
    for name in ("router-config.json", "otp-config.json"):
        shutil.copyfile(os.path.join(OTP, name), os.path.join(out, name))

    lines = [f"# {region['name']} の出典", "",
             "OpenTripPlanner に読ませるデータです。リポジトリには入れていません（tools/otp_fetch.py で作り直せます）。", "",
             "| データ | 提供元 | ライセンス |", "| --- | --- | --- |"]
    for f in region["feeds"]:
        lines.append(f"| 時刻表 {f['name']} | GTFS データリポジトリ（gtfs-data.jp） `{f['org']}/{f['feed']}` | {f['license']} |")
    lines.append("| 道路・歩道 | © OpenStreetMap contributors | ODbL 1.0 |")
    with open(os.path.join(out, "SOURCES.md"), "w", encoding="utf-8") as fp:
        fp.write("\n".join(lines) + "\n")
    print("  build-config.json・router-config.json・otp-config.json・SOURCES.md を書きました")


if __name__ == "__main__":
    main(sys.argv[1:])
