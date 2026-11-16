# -*- coding: utf-8 -*-
"""GTFS-JP の時刻表を、一覧から集めて、検査して、カバー範囲を記録する（Issue #430）。

    python3 tools/gtfs_feeds.py catalog                 一覧を取る（data/gtfs/catalog.json）
    python3 tools/gtfs_feeds.py fetch [--pref 43,16]    落として検査する（変わったものだけ落とす）
    python3 tools/gtfs_feeds.py check FILE.zip          1つを検査する
    python3 tools/gtfs_feeds.py coverage [--md]         収録のスポットと突き合わせる
    python3 tools/gtfs_feeds.py expiry [--days 30]      有効期間が切れた・切れそうなもの（一覧だけ見る）

共通のオプション: --today YYYY-MM-DD（期限の判定に使う日。既定は今日）

置き場所（.gitignore 済み）:
    data/gtfs/catalog.json         GTFS データリポジトリ（gtfs-data.jp）の一覧の写し
    data/gtfs/feeds/<org>/<feed>.zip
    data/gtfs/index.json           時刻表ごとの検査の結果と中身の要約（停留所の位置と1日の便数も）

時刻表は、それぞれの事業者が公開したものです（ライセンスは一覧の feed_license。
多くは CC BY 4.0 で、表示には事業者の名前が要ります）。リポジトリには入れません。
"""
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
DATA = os.path.join(WEB, "data", "gtfs")
UA = "Tabisaki/1.0 (+https://github.com/shitianliang1000-alt/tabisaki-app)"
API = "https://api.gtfs-data.jp/v2"
FEED_URL = API + "/organizations/{org}/feeds/{feed}/files/feed.zip"

# 検査の決まり ---------------------------------------------------------------

REQUIRED = {
    "agency.txt": ["agency_name"],
    "stops.txt": ["stop_id", "stop_name", "stop_lat", "stop_lon"],
    "routes.txt": ["route_id", "route_type"],
    "trips.txt": ["route_id", "service_id", "trip_id"],
    "stop_times.txt": ["trip_id", "stop_id", "stop_sequence"],
}
CALENDAR_COLS = {
    "calendar.txt": ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday",
                     "saturday", "sunday", "start_date", "end_date"],
    "calendar_dates.txt": ["service_id", "date", "exception_type"],
}
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
# 日本と、そのまわりの島（範囲の外の停留所は、緯度と経度の取り違えが多い）
JAPAN = (122.0, 20.0, 154.0, 46.0)
SOON_DAYS = 30


def mode_of(route_type):
    """route_type を乗り物の種類に。拡張の型（100〜1700）は百の位で見ます。"""
    try:
        t = int(route_type)
    except (TypeError, ValueError):
        return "不明"
    basic = {0: "路面電車", 1: "地下鉄", 2: "鉄道", 3: "バス", 4: "船", 5: "ケーブルカー",
             6: "ロープウェイ", 7: "ケーブルカー", 11: "バス", 12: "モノレール"}
    if t in basic:
        return basic[t]
    ext = {1: "鉄道", 2: "バス", 4: "地下鉄", 7: "バス", 8: "バス", 9: "路面電車", 10: "船",
           11: "飛行機", 12: "船", 13: "ロープウェイ", 14: "ケーブルカー", 15: "タクシー"}
    return ext.get(t // 100, "不明")


def ymd(s):
    s = (s or "").strip()
    if len(s) != 8 or not s.isdigit():
        return None
    try:
        return dt.date(int(s[:4]), int(s[4:6]), int(s[6:]))
    except ValueError:
        return None


def seconds(t):
    """'25:10:00' を秒に。読めなければ None。"""
    parts = (t or "").strip().split(":")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    h, m, s = (int(p) for p in parts)
    if m > 59 or s > 59 or h > 47:
        return None
    return h * 3600 + m * 60 + s


class Rows:
    """zip の中の CSV を、1行ずつ辞書で読みます（大きな stop_times.txt も、全部を持ちません）。"""

    def __init__(self, z, names):
        self.z = z
        self.names = {os.path.basename(n): n for n in names if not n.endswith("/")}

    def has(self, name):
        return name in self.names

    def header(self, name):
        with self.z.open(self.names[name]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
            return [c.strip() for c in next(csv.reader(text), [])]

    def __call__(self, name):
        with self.z.open(self.names[name]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
            reader = csv.reader(text)
            head = [c.strip() for c in next(reader, [])]
            for row in reader:
                if not row or (len(row) == 1 and not row[0].strip()):
                    continue
                yield dict(zip(head, (v.strip() for v in row)))


def active_services(cal, cal_dates, day):
    """その日に走る service_id の集合。"""
    out = set()
    wd = WEEKDAYS[day.weekday()]
    for sid, c in cal.items():
        if c["start"] and c["end"] and c["start"] <= day <= c["end"] and c[wd]:
            out.add(sid)
    for sid, d, kind in cal_dates:
        if d == day:
            if kind == "1":
                out.add(sid)
            elif kind == "2":
                out.discard(sid)
    return out


def reference_day(start, end, today):
    """便数を数える日: 今日から先の最初の水曜（有効期間の中）。期間の外なら期間の中の水曜。"""
    day = max(today, start) if start else today
    for _ in range(14):
        if day.weekday() == 2:
            break
        day += dt.timedelta(days=1)
    if end and day > end:
        day = end
        while day.weekday() != 2 and start and day > start:
            day -= dt.timedelta(days=1)
    return day


def check_feed(path, today=None):
    """時刻表の zip を検査して、結果と要約を返します。

    errors があると OTP に読ませません（ファイルや列が足りない、便が無い、など）。
    warnings は読ませますが、数を記録します（つながらない参照、範囲の外の停留所、など）。
    """
    today = today or dt.date.today()
    rep = {"errors": [], "warnings": [], "files": []}
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        rep["errors"].append(f"zip として読めない（{e.__class__.__name__}）")
        return rep
    with z:
        rows = Rows(z, z.namelist())
        rep["files"] = sorted(rows.names)
        for name, cols in REQUIRED.items():
            if not rows.has(name):
                rep["errors"].append(f"{name} が無い")
                continue
            try:
                head = rows.header(name)
            except UnicodeDecodeError:
                rep["errors"].append(f"{name} が UTF-8 で読めない")
                continue
            missing = [c for c in cols if c not in head]
            if missing:
                rep["errors"].append(f"{name} に列 {', '.join(missing)} が無い")
        cal_files = [n for n in CALENDAR_COLS if rows.has(n)]
        if not cal_files:
            rep["errors"].append("calendar.txt も calendar_dates.txt も無い")
        for name in cal_files:
            missing = [c for c in CALENDAR_COLS[name] if c not in rows.header(name)]
            if missing:
                rep["errors"].append(f"{name} に列 {', '.join(missing)} が無い")
        if rep["errors"]:
            return rep
        try:
            summarize(rows, rep, today)
        except UnicodeDecodeError as e:
            rep["errors"].append(f"UTF-8 で読めない行がある（{e.reason}）")
        except (csv.Error, KeyError, ValueError) as e:
            rep["errors"].append(f"読めない行がある（{e.__class__.__name__}: {e}）")
    return rep


def summarize(rows, rep, today):
    warn = rep["warnings"]
    agencies = sorted({r.get("agency_name", "") for r in rows("agency.txt")} - {""})

    stops, stations, outside, bad_pos = {}, set(), 0, 0
    for r in rows("stops.txt"):
        if r.get("location_type", "") not in ("", "0"):
            stations.add(r["stop_id"])
            continue
        try:
            lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        except ValueError:
            bad_pos += 1
            continue
        if not (JAPAN[0] <= lon <= JAPAN[2] and JAPAN[1] <= lat <= JAPAN[3]):
            outside += 1
            continue
        stops[r["stop_id"]] = [round(lat, 6), round(lon, 6), r.get("stop_name", ""), 0]
    if bad_pos:
        warn.append(f"位置が読めない停留所 {bad_pos}")
    if outside:
        warn.append(f"日本の範囲の外にある停留所 {outside}（緯度と経度の取り違えか）")

    routes = {}
    for r in rows("routes.txt"):
        routes[r["route_id"]] = mode_of(r.get("route_type"))

    cal = {}
    if rows.has("calendar.txt"):
        for r in rows("calendar.txt"):
            c = {"start": ymd(r.get("start_date")), "end": ymd(r.get("end_date"))}
            for wd in WEEKDAYS:
                c[wd] = r.get(wd) == "1"
            cal[r["service_id"]] = c
    cal_dates = []
    if rows.has("calendar_dates.txt"):
        for r in rows("calendar_dates.txt"):
            d = ymd(r.get("date"))
            if d:
                cal_dates.append((r["service_id"], d, r.get("exception_type", "")))
    services = set(cal) | {s for s, _, _ in cal_dates}

    starts = [c["start"] for c in cal.values() if c["start"]] + [d for _, d, k in cal_dates if k == "1"]
    ends = [c["end"] for c in cal.values() if c["end"]] + [d for _, d, k in cal_dates if k == "1"]
    start, end = (min(starts) if starts else None), (max(ends) if ends else None)

    trips, bad_route, bad_service = {}, 0, 0
    for r in rows("trips.txt"):
        if r["route_id"] not in routes:
            bad_route += 1
        if r["service_id"] not in services:
            bad_service += 1
        trips[r["trip_id"]] = (r["route_id"], r["service_id"])
    if not trips:
        rep["errors"].append("便（trips.txt の行）が1つも無い")
        return
    if bad_route:
        warn.append(f"路線がつながらない便 {bad_route}")
    if bad_service:
        warn.append(f"運行日がつながらない便 {bad_service}")

    ref = reference_day(start, end, today)
    running = active_services(cal, cal_dates, ref)
    count, bad_trip, bad_stop, bad_time, last_trip = {}, 0, 0, 0, None
    for r in rows("stop_times.txt"):
        tid = r["trip_id"]
        trip = trips.get(tid)
        if trip is None:
            bad_trip += 1
            continue
        count[tid] = count.get(tid, 0) + 1
        sid = r["stop_id"]
        stop = stops.get(sid)
        if stop is None:
            if sid not in stations:
                bad_stop += 1
            continue
        for col in ("arrival_time", "departure_time"):
            v = r.get(col, "")
            if v and seconds(v) is None:
                bad_time += 1
        if trip[1] in running:
            stop[3] += 1
        last_trip = tid
    if bad_trip:
        warn.append(f"便がつながらない時刻 {bad_trip}")
    if bad_stop:
        warn.append(f"停留所がつながらない時刻 {bad_stop}")
    if bad_time:
        warn.append(f"読めない時刻 {bad_time}")
    short = sum(1 for t in trips if count.get(t, 0) < 2)
    if short:
        warn.append(f"停まるところが2つ未満の便 {short}")
    if last_trip is None:
        rep["errors"].append("停留所につながる時刻が1つも無い")
        return
    if rows.has("fare_rules.txt"):
        fares = {r.get("fare_id") for r in rows("fare_attributes.txt")} if rows.has("fare_attributes.txt") else set()
        bad_fare = sum(1 for r in rows("fare_rules.txt") if r.get("fare_id") not in fares)
        if bad_fare:
            warn.append(f"運賃がつながらない運賃のルール {bad_fare}")

    modes = {}
    for rid, mode in routes.items():
        modes[mode] = modes.get(mode, 0) + 1
    used = [s for s in stops.values()]
    lats = [s[0] for s in used]
    lons = [s[1] for s in used]
    runs_today = sum(1 for t in trips.values() if t[1] in running)

    if end and end < today:
        status = "期限切れ"
    elif start and start > today:
        status = "これから"
    elif end and (end - today).days < SOON_DAYS:
        status = "まもなく切れる"
    else:
        status = "有効"
    rep.update({
        "agencies": agencies,
        "modes": modes,
        "routes": len(routes),
        "trips": len(trips),
        "stops_count": len(stops),
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "status": status,
        "reference_day": ref.isoformat(),
        "trips_on_reference_day": runs_today,
        "bbox": [min(lons), min(lats), max(lons), max(lats)] if used else None,
        # [緯度, 経度, 名前, 基準の日の発車数]
        "stops": sorted(used, key=lambda s: (s[0], s[1])),
    })


# 一覧 ----------------------------------------------------------------------

def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as res:
        doc = json.load(res)
    if doc.get("code") != 200:
        raise RuntimeError(f"{url}: {doc.get('message')}")
    return doc["body"]


def load_catalog(refresh=False):
    path = os.path.join(DATA, "catalog.json")
    if refresh or not os.path.exists(path):
        body = get_json(API + "/feeds")
        os.makedirs(DATA, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                       "feeds": body}, f, ensure_ascii=False, indent=1)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def feed_key(f):
    return f"{f['organization_id']}/{f['feed_id']}"


def select(feeds, prefs=None, include_discontinued=False):
    out = []
    for f in feeds:
        if f.get("feed_is_discontinued") and not include_discontinued:
            continue
        if prefs and f.get("feed_pref_id") not in prefs:
            continue
        out.append(f)
    return sorted(out, key=feed_key)


def expiry(feeds, today, days=SOON_DAYS):
    """一覧の有効期間だけを見て、切れた・切れそうなものを返します（落としません）。"""
    rows = []
    for f in feeds:
        end = f.get("latest_feed_end_date") or ""
        try:
            d = dt.date.fromisoformat(end)
        except ValueError:
            rows.append((f, "期間が無い", None))
            continue
        left = (d - today).days
        if left < 0:
            rows.append((f, "期限切れ", left))
        elif left < days:
            rows.append((f, "まもなく切れる", left))
    return rows


# 落とす --------------------------------------------------------------------

def download(url, path):
    tmp = path + ".part"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as res, open(tmp, "wb") as out:
        shutil.copyfileobj(res, out, 1 << 20)
    os.replace(tmp, path)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_index():
    path = os.path.join(DATA, "index.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_index(index):
    path = os.path.join(DATA, "index.json")
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def source_url(f, env=None):
    """落とす先の URL。一覧に無い時刻表は "download_url" を使い、{ODPT_KEY} のような
    差し込みは環境変数から入れます（鍵はファイルにもログにも書きません）。足りなければ None と理由。"""
    url = f.get("download_url") or FEED_URL.format(org=f["organization_id"], feed=f["feed_id"])
    env = os.environ if env is None else env
    for name in re.findall(r"\{([A-Z][A-Z0-9_]*)\}", url):
        if not env.get(name):
            return None, f"環境変数 {name} が無い"
        url = url.replace("{" + name + "}", env[name])
    return url, None


def fetch(feeds, today, offline=False, pause=0.5, workers=4, log=print):
    """一覧の時刻表を落として検査し、index.json に書きます。

    一覧の last_published_at が前と同じなら、落とし直さずに前の結果を使います（検査は日が
    変われば、期限の判定のためにやり直します）。落とすのは同時に workers 本まで（1本ごとに
    pause 秒あけます）。検査はこのスレッドで1本ずつ行い、index.json もここだけが書きます。
    """
    index = load_index()

    def path_of(f):
        return os.path.join(DATA, "feeds", f["organization_id"], f["feed_id"] + ".zip")

    def get(f):
        url, why = source_url(f)
        try:
            if url is None:
                raise LookupError(why)
            download(url, path_of(f))
            return None
        except Exception as e:  # 1つ落とせなくても、ほかは続けます
            # 鍵が URL に入っていることがあるので、エラーの文は種類と理由だけにします
            return why or getattr(e, "reason", None) or getattr(e, "code", None) or e.__class__.__name__
        finally:
            time.sleep(pause)

    jobs = []
    for f in feeds:
        key, path = feed_key(f), path_of(f)
        old = index.get(key, {})
        published = f.get("last_published_at") or ""
        if old.get("published") == published and os.path.exists(path) and old.get("today") == today.isoformat():
            continue
        stale = old.get("published") != published or not os.path.exists(path)
        jobs.append((f, stale and not offline))

    def checked(i, f, failure):
        key, path = feed_key(f), path_of(f)
        if failure is not None:
            index[key] = {"published": "", "errors": [f"落とせない（{failure}）"], "warnings": [],
                          "name": f["feed_name"], "pref": f.get("feed_pref_id")}
            log(f"  [{i}/{len(jobs)}] × {key}: 落とせない（{failure}）")
            return
        if not os.path.exists(path):
            return
        rep = check_feed(path, today)
        rep.update({
            "name": f["feed_name"], "organization": f.get("organization_name"),
            "pref": f.get("feed_pref_id"), "license": f.get("feed_license"),
            "license_url": f.get("feed_license_url"), "published": f.get("last_published_at") or "",
            "size": os.path.getsize(path), "sha256": sha256(path), "today": today.isoformat(),
        })
        index[key] = rep
        mark = "×" if rep["errors"] else ("△" if rep["warnings"] else "○")
        log(f"  [{i}/{len(jobs)}] {mark} {key} {f['feed_name']} "
            f"{rep.get('status', '')} 停留所 {rep.get('stops_count', 0)}"
            + (f"  {'; '.join(rep['errors'])}" if rep["errors"] else ""))

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        pending = [(f, pool.submit(get, f) if need else None) for f, need in jobs]
        for i, (f, fut) in enumerate(pending, 1):
            checked(i, f, fut.result() if fut else None)
            if i % 20 == 0:
                save_index(index)
    save_index(index)
    return index


# カバー範囲 ----------------------------------------------------------------

def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class StopGrid:
    """停留所を 0.01度の升に分けて、近い停留所を速く探します。"""

    def __init__(self, stops):
        self.cells = {}
        for s in stops:
            self.cells.setdefault((int(s[0] * 100), int(s[1] * 100)), []).append(s)

    def nearest(self, lat, lon, limit_m, min_departures=1):
        """limit_m 以内で、基準の日に min_departures 本以上出る停留所への最短の距離（無ければ None）。"""
        best = None
        r = int(limit_m / 1000) + 1
        cy, cx = int(lat * 100), int(lon * 100)
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                for s in self.cells.get((cy + dy, cx + dx), ()):
                    if s[3] < min_departures:
                        continue
                    d = haversine_m(lat, lon, s[0], s[1])
                    if d <= limit_m and (best is None or d < best):
                        best = d
        return best


PREF_NAMES = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県",
              "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県",
              "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府",
              "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県",
              "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県",
              "鹿児島県", "沖縄県"]
WALK_M = 800      # 歩いて10分ほど
OFTEN = 10        # 1日10本以上（だいたい1時間に1本）


def load_spots(bbox=None):
    kb = os.path.join(WEB, "kb")
    out = []
    for name in sorted(os.listdir(kb)):
        if not (name.startswith("spots-jp") and name.endswith(".json")):
            continue
        pref = int(name[8:10])
        with open(os.path.join(kb, name), encoding="utf-8") as f:
            doc = json.load(f)
        for s in doc.get("spots", doc) if isinstance(doc, dict) else doc:
            lat, lng = s.get("lat"), s.get("lng")
            if lat is None or lng is None:
                continue
            if bbox and not (bbox[0] <= lng <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                continue
            out.append({"id": s.get("id"), "name": s.get("name"), "lat": lat, "lng": lng,
                        "pref": pref, "category": s.get("category")})
    return out


def coverage(index, spots, usable_only=True):
    """スポットごとに、歩いて行ける停留所があるか（基準の日に便があるもの）を数えます。"""
    stops = []
    feeds_by_pref = {}
    for key, rep in index.items():
        if usable_only and (rep.get("errors") or rep.get("status") == "期限切れ"):
            continue
        stops.extend(rep.get("stops", []))
        feeds_by_pref.setdefault(rep.get("pref"), []).append(key)
    grid = StopGrid(stops)
    per = {}
    far = []
    for s in spots:
        p = per.setdefault(s["pref"], {"spots": 0, "walk": 0, "often": 0})
        p["spots"] += 1
        d = grid.nearest(s["lat"], s["lng"], WALK_M, 1)
        if d is not None:
            p["walk"] += 1
            if grid.nearest(s["lat"], s["lng"], WALK_M, OFTEN) is not None:
                p["often"] += 1
        else:
            far.append(s)
    return {"stops": len(stops), "per_pref": per, "feeds_by_pref": feeds_by_pref, "far": far}


def pct(a, b):
    return f"{100 * a / b:.1f}%" if b else "-"


def coverage_md(index, cov, today):
    usable = [r for r in index.values() if not r.get("errors") and r.get("status") != "期限切れ"]
    modes = {}
    for r in usable:
        for m, n in (r.get("modes") or {}).items():
            modes[m] = modes.get(m, 0) + n
    total = {"spots": 0, "walk": 0, "often": 0}
    for p in cov["per_pref"].values():
        for k in total:
            total[k] += p[k]
    lines = [
        f"判定の日: {today.isoformat()}。停留所の便数は、各時刻表の有効期間の中で、この日から先の最初の水曜に数えています。",
        "",
        "| | |",
        "| --- | ---: |",
        f"| 一覧の時刻表 | {len(index)} |",
        f"| 使える（検査を通り、期限内） | {len(usable)} |",
        f"| 停留所・駅 | {cov['stops']:,} |",
        f"| 路線（乗り物ごと） | {', '.join(f'{m} {n:,}' for m, n in sorted(modes.items(), key=lambda x: -x[1]))} |",
        f"| 収録のスポット | {total['spots']:,} |",
        f"| {WALK_M}m 以内に便のある停留所 | {total['walk']:,}（{pct(total['walk'], total['spots'])}） |",
        f"| {WALK_M}m 以内に1日{OFTEN}本以上の停留所 | {total['often']:,}（{pct(total['often'], total['spots'])}） |",
        "",
        f"| 都道府県 | 時刻表 | スポット | {WALK_M}m 以内に便 | 1日{OFTEN}本以上 |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for pref in range(1, 48):
        p = cov["per_pref"].get(pref, {"spots": 0, "walk": 0, "often": 0})
        n = len(cov["feeds_by_pref"].get(pref, []))
        if not n and not p["spots"]:
            continue
        lines.append(f"| {PREF_NAMES[pref - 1]} | {n} | {p['spots']:,} | {pct(p['walk'], p['spots'])} | {pct(p['often'], p['spots'])} |")
    return "\n".join(lines)


def check_md(index):
    bad = sorted((k, r) for k, r in index.items() if r.get("errors"))
    old = sorted((k, r) for k, r in index.items() if not r.get("errors") and r.get("status") == "期限切れ")
    lines = []
    if bad:
        lines += ["検査を通らず、使わない時刻表:", "", "| 時刻表 | 使わない理由 |", "| --- | --- |"]
        lines += [f"| {r.get('name', k)}（`{k}`） | {'; '.join(r['errors'])} |" for k, r in bad]
    if old:
        lines += ["", "有効期間が切れていて、使わない時刻表（一覧では運行中のまま）:", "", "| 時刻表 | 有効期間 |", "| --- | --- |"]
        lines += [f"| {r.get('name', k)}（`{k}`） | {r.get('start')} 〜 {r.get('end')} |" for k, r in old]
    return "\n".join(lines)


# 入口 ----------------------------------------------------------------------

def opt(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd = argv[0]
    today = dt.date.fromisoformat(opt(argv, "--today", dt.date.today().isoformat()))
    prefs = opt(argv, "--pref")
    prefs = {int(p) for p in prefs.split(",")} if prefs else None

    if cmd == "check":
        rep = check_feed(argv[1], today)
        rep.pop("stops", None)
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return 1 if rep["errors"] else 0
    if cmd == "catalog":
        cat = load_catalog(refresh=True)
        print(f"{len(cat['feeds'])} 件（{cat['fetched']}）→ data/gtfs/catalog.json")
        return 0
    if cmd == "expiry":
        cat = load_catalog(refresh="--offline" not in argv)
        days = int(opt(argv, "--days", SOON_DAYS))
        rows = expiry(select(cat["feeds"], prefs), today, days)
        for f, why, left in rows:
            print(f"{why}\t{left if left is not None else ''}\t{feed_key(f)}\t{f['feed_name']}\t{f.get('latest_feed_end_date')}")
        print(f"{len(rows)} 件")
        return 0
    if cmd == "fetch":
        cat = load_catalog(refresh="--offline" not in argv)
        feeds = select(cat["feeds"], prefs)
        print(f"{len(feeds)} 件を見ます")
        index = fetch(feeds, today, offline="--offline" in argv)
        bad = sum(1 for k in index if index[k].get("errors"))
        print(f"index.json: {len(index)} 件（使えない {bad}）")
        return 0
    if cmd == "coverage":
        index = load_index()
        if prefs:
            index = {k: r for k, r in index.items() if r.get("pref") in prefs}
        cov = coverage(index, [s for s in load_spots() if not prefs or s["pref"] in prefs])
        if "--md" in argv:
            print(coverage_md(index, cov, today))
            extra = check_md(index)
            if extra:
                print("\n" + extra)
        else:
            print(json.dumps({k: v for k, v in cov.items() if k != "far"}, ensure_ascii=False, indent=1))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
