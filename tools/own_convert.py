#!/usr/bin/env python3
"""GTFS zip 群 → 自作JSエンジン用 正規化データセット (SQLite) 変換ツール。

使い方:
    python3 tools/own_convert.py <feeds_dir> <out.db> [--report <report.json>]
                                     [--sql <d1.sql>] [--kv <kv.json>]
                                     [--json <normalized.json> ...]

- Python 標準ライブラリのみ (zipfile / csv / sqlite3)。
- 入力は GTFS zip 群 (feeds_dir) が基本。API 由来の事業者は
  tools/odpt_api_convert.py が出す正規化 JSON (形式 tabisaki-odpt/1) を
  --json で追加できる。JSON 側は読み取り層 (JsonFeedSource) が GTFS と
  同じ形の表を合成するだけで、正規化処理は zip と完全に共通。
  GTFS のテキスト表現では落ちる情報 (祝日カレンダーの区別など) は
  JSON 側で services の added_dates として保持される。
- stop_times は trip 単位にパックし、運行日は service_id 単位の
  日次ビットマップに変換する (設計メモ js-engine-design-2026-11-14.md)。
- footpaths は stops の座標から生成する (半径400m以内、徒歩秒 = 直線距離 / 1.2m/s)。
  歩道網は使わない近似である。
- stop / route / service / fare の ID はフィードをまたぐと衝突し得るので、
  内部 ID はフィード名で名前空間を分けた上で整数化する。
- --sql は、できあがった SQLite を SQL 文の並びで書き出す
  (Cloudflare D1 へ `wrangler d1 execute --file` で入れる用)。
- --kv は、停留所マスタを geohash (精度5) のセル別に分けた
  Workers KV 一括投入用 JSON を書き出す ([{key: "stops:<セル>", value: "[[uid,lat,lon],...]"}])。
  読み取り側は server/own-geohash.mjs で、符号化は両者で揃えている。
"""
import argparse
import csv
import io
import json
import math
import sqlite3
import struct
import sys
import zipfile
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

EARTH_R_M = 6_371_000.0
WALK_MPS = 1.2
FOOTPATH_RADIUS_M = 400.0


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(min(1.0, math.sqrt(a)))


GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash_encode(lat, lon, precision=5):
    """緯度・経度を geohash にする。server/own-geohash.mjs と同じ符号化。"""
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        if even:
            mid = (lon_r[0] + lon_r[1]) / 2
            if lon >= mid:
                ch = ch * 2 + 1
                lon_r[0] = mid
            else:
                ch = ch * 2
                lon_r[1] = mid
        else:
            mid = (lat_r[0] + lat_r[1]) / 2
            if lat >= mid:
                ch = ch * 2 + 1
                lat_r[0] = mid
            else:
                ch = ch * 2
                lat_r[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(GEOHASH_BASE32[ch])
            bit, ch = 0, 0
    return "".join(out)


def parse_hms(s):
    """GTFS 時刻 'H:MM:SS' → 運行日0時からの秒 (24時超あり)。空なら None。"""
    if s is None:
        return None
    s = s.strip()
    if not s:
        return None
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def parse_ymd(s):
    s = s.strip()
    return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))


def read_table(zf, name):
    """zip 内の CSV を dict のリストで返す。無ければ []。

    GTFS-JP には一部ファイルの拡張子が .csv になるフィードがある
    (例: つくば市の stop_times.csv / trips.csv / calendar.csv)。
    .txt が無ければ同名の .csv を読む。
    """
    try:
        raw = zf.read(name)
    except KeyError:
        if not name.endswith(".txt"):
            return []
        try:
            raw = zf.read(name[:-4] + ".csv")
        except KeyError:
            return []
    text = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8-sig", newline="")
    return list(csv.DictReader(text))


# ---------------------------------------------------------------------------
# フィードの読み取り層。正規化処理 (convert) は table(name) が返す
# 「GTFS と同じ形の dict のリスト」だけに依存し、入力形式を知らない。
# ---------------------------------------------------------------------------

class ZipFeedSource:
    """GTFS zip の読み取り層。"""

    def __init__(self, path):
        self._path = path
        self._zf = zipfile.ZipFile(path)

    def table(self, name):
        return read_table(self._zf, name)

    @property
    def size_bytes(self):
        return self._path.stat().st_size


def _hms_of(secs):
    """秒 → GTFS 時刻文字列。None は空 (欠けは正規化側で補間される)。"""
    if secs is None:
        return ""
    secs = int(secs)
    return f"{secs // 3600:02d}:{(secs // 60) % 60:02d}:{secs % 60:02d}"


def _s(v):
    """JSON のスカラを CSV と同じ文字列に寄せる。None は空。"""
    return "" if v is None else str(v)


class JsonFeedSource:
    """正規化 JSON (形式 tabisaki-odpt/1) の読み取り層。

    GTFS と同じ形の dict リストを合成して返す。services は
    dow (月..日の 0/1 配列) + added_dates / removed_dates で表され、
    ここで calendar.txt / calendar_dates.txt に展開される。
    """

    FORMAT = "tabisaki-odpt/1"

    def __init__(self, path):
        self._path = path
        doc = json.loads(path.read_text(encoding="utf-8"))
        if doc.get("format") != self.FORMAT:
            raise ValueError(f"{path}: format が {self.FORMAT} ではありません")
        self._doc = doc
        self._tables = {}

    @property
    def size_bytes(self):
        return self._path.stat().st_size

    def table(self, name):
        if name not in self._tables:
            self._tables[name] = self._build(name)
        return self._tables[name]

    def _build(self, name):
        doc = self._doc
        if name == "agency.txt":
            return [{k: _s(v) for k, v in a.items()} for a in doc.get("agency", [])]
        if name == "feed_info.txt":
            fi = doc.get("feed_info", {})
            if not fi:
                return []
            return [{"feed_publisher_name": doc.get("publisher", ""),
                     "feed_publisher_url": doc.get("publisher_url", ""),
                     "feed_lang": "ja",
                     "feed_start_date": _s(fi.get("feed_start_date")),
                     "feed_end_date": _s(fi.get("feed_end_date"))}]
        if name == "stops.txt":
            return [{"stop_id": _s(s["stop_id"]), "stop_name": _s(s.get("stop_name")),
                     "stop_lat": _s(s["stop_lat"]), "stop_lon": _s(s["stop_lon"]),
                     "zone_id": _s(s.get("zone_id"))} for s in doc.get("stops", [])]
        if name == "routes.txt":
            return [{"route_id": _s(r["route_id"]), "agency_id": _s(r.get("agency_id")),
                     "route_short_name": _s(r.get("route_short_name")),
                     "route_long_name": _s(r.get("route_long_name")),
                     "route_type": _s(r.get("route_type"))}
                    for r in doc.get("routes", [])]
        if name == "calendar.txt":
            rows = []
            dow_names = ("monday", "tuesday", "wednesday", "thursday",
                         "friday", "saturday", "sunday")
            for svc in doc.get("services", []):
                row = {"service_id": _s(svc["service_id"]),
                       "start_date": _s(svc["start_date"]),
                       "end_date": _s(svc["end_date"])}
                for i, dn in enumerate(dow_names):
                    row[dn] = _s(svc["dow"][i])
                rows.append(row)
            return rows
        if name == "calendar_dates.txt":
            rows = []
            for svc in doc.get("services", []):
                for d in svc.get("added_dates", []):
                    rows.append({"service_id": _s(svc["service_id"]),
                                 "date": _s(d), "exception_type": "1"})
                for d in svc.get("removed_dates", []):
                    rows.append({"service_id": _s(svc["service_id"]),
                                 "date": _s(d), "exception_type": "2"})
            return rows
        if name == "trips.txt":
            return [{"route_id": _s(t["route_id"]), "service_id": _s(t["service_id"]),
                     "trip_id": _s(t["trip_id"]),
                     "trip_headsign": _s(t.get("trip_headsign")),
                     "direction_id": _s(t.get("direction_id"))}
                    for t in doc.get("trips", [])]
        if name == "stop_times.txt":
            rows = []
            for t in doc.get("trips", []):
                for i, tm in enumerate(t.get("times", []), start=1):
                    rows.append({"trip_id": _s(t["trip_id"]),
                                 "arrival_time": _hms_of(tm.get("arr")),
                                 "departure_time": _hms_of(tm.get("dep")),
                                 "stop_id": _s(tm["stop_id"]),
                                 "stop_sequence": str(i)})
            return rows
        if name == "fare_attributes.txt":
            return [{"fare_id": _s(f["fare_id"]), "price": _s(f["price"]),
                     "currency_type": _s(f.get("currency_type")),
                     "payment_method": _s(f.get("payment_method")),
                     "transfers": _s(f.get("transfers"))}
                    for f in doc.get("fares", {}).get("attributes", [])]
        if name == "fare_rules.txt":
            return [{"fare_id": _s(r["fare_id"]), "route_id": _s(r.get("route_id")),
                     "origin_id": _s(r.get("origin_id")),
                     "destination_id": _s(r.get("destination_id"))}
                    for r in doc.get("fares", {}).get("rules", [])]
        return []


SCHEMA = """
CREATE TABLE feeds (
  feed TEXT PRIMARY KEY, publisher TEXT, start_date TEXT, end_date TEXT,
  zip_bytes INTEGER
);
CREATE TABLE stops (
  uid INTEGER PRIMARY KEY, feed TEXT, stop_id TEXT, name TEXT,
  lat REAL, lon REAL, zone_id TEXT
);
CREATE TABLE stop_modes (uid INTEGER, route_type INTEGER, PRIMARY KEY (uid, route_type));
CREATE TABLE routes (
  uid INTEGER PRIMARY KEY, feed TEXT, route_id TEXT, agency TEXT,
  short_name TEXT, long_name TEXT, route_type INTEGER
);
CREATE TABLE patterns (
  pid INTEGER PRIMARY KEY, route_uid INTEGER, direction INTEGER, stops TEXT
);
CREATE TABLE trips (
  tid INTEGER PRIMARY KEY, pid INTEGER, service INTEGER, headsign TEXT,
  first_dep INTEGER, times BLOB
);
CREATE INDEX trips_by_pattern ON trips (pid, first_dep);
CREATE TABLE services (
  sid INTEGER PRIMARY KEY, feed TEXT, service_id TEXT,
  start TEXT, end TEXT, bitmap BLOB
);
CREATE TABLE footpaths (a INTEGER, b INTEGER, secs INTEGER, PRIMARY KEY (a, b));
CREATE TABLE stop_patterns (uid INTEGER, pid INTEGER, idx INTEGER, PRIMARY KEY (uid, pid));
CREATE INDEX stop_patterns_by_stop ON stop_patterns (uid);
CREATE TABLE fare_attrs (
  id INTEGER PRIMARY KEY, fid TEXT UNIQUE, price INTEGER, transfers INTEGER
);
CREATE TABLE zones (id INTEGER PRIMARY KEY, feed_idx INTEGER, zone_id TEXT);
CREATE TABLE fare_rules (
  feed_idx INTEGER, route_uid INTEGER, origin_id INTEGER, destination_id INTEGER,
  fare_id INTEGER
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""


def convert(feed_files):
    """feed_files: [(feed_key, ZipFeedSource|JsonFeedSource)]
    → (sqlite3.Connection, report dict)"""
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    report = {"feeds": {}, "totals": {}}
    grand = defaultdict(int)
    feed_idx = {}          # feed key -> 小さい整数 (fare_rules 用)
    fare_int = {}          # fid (feed|fare_id) -> 整数 ID
    next_fare_int = 1
    zone_int = {}          # (feed_idx, zone_id) -> 整数 ID

    def zid(fidx, zone):
        key = (fidx, zone or "")
        if key not in zone_int:
            zone_int[key] = len(zone_int) + 1
        return zone_int[key]

    stop_uid = {}          # (feed, stop_id) -> uid
    next_stop_uid = 1
    next_route_uid = 1
    next_pid = 1
    next_tid = 1
    next_sid = 1

    for feed, src in feed_files:
        feed_idx[feed] = len(feed_idx) + 1
        fr = {"feed": feed}
        agency_name = {}
        for a in src.table("agency.txt"):
            agency_name[a.get("agency_id", "")] = a.get("agency_name", "")
        default_agency = next(iter(agency_name.values()), "")

        info = src.table("feed_info.txt")
        publisher = info[0].get("feed_publisher_name", "") if info else ""
        feed_start = info[0].get("feed_start_date", "") if info else ""
        feed_end = info[0].get("feed_end_date", "") if info else ""

        # ---- stops ----
        stops_rows = src.table("stops.txt")
        for s in stops_rows:
            uid = next_stop_uid
            next_stop_uid += 1
            stop_uid[(feed, s["stop_id"])] = uid
            zid(feed_idx[feed], s.get("zone_id", ""))  # ゾーン辞書へ登録
            db.execute(
                "INSERT INTO stops VALUES (?,?,?,?,?,?,?)",
                (uid, feed, s["stop_id"], s.get("stop_name", ""),
                 float(s["stop_lat"]), float(s["stop_lon"]), s.get("zone_id", "")),
            )
        fr["stops"] = len(stops_rows)

        # ---- routes ----
        route_uid = {}
        route_type_of = {}
        for r in src.table("routes.txt"):
            uid = next_route_uid
            next_route_uid += 1
            route_uid[r["route_id"]] = uid
            rt = int(r.get("route_type") or 3)
            route_type_of[r["route_id"]] = rt
            db.execute(
                "INSERT INTO routes VALUES (?,?,?,?,?,?,?)",
                (uid, feed, r["route_id"],
                 agency_name.get(r.get("agency_id", ""), default_agency),
                 r.get("route_short_name", ""), r.get("route_long_name", ""), rt),
            )
        fr["routes"] = len(route_uid)

        # ---- services (calendar + calendar_dates → 日次ビットマップ) ----
        exceptions = defaultdict(dict)  # service_id -> {date: exception_type}
        for cd in src.table("calendar_dates.txt"):
            exceptions[cd["service_id"]][parse_ymd(cd["date"])] = int(cd["exception_type"])
        service_sid = {}
        cal_rows = src.table("calendar.txt")
        for c in cal_rows:
            sid = next_sid
            next_sid += 1
            service_sid[c["service_id"]] = sid
            start, end = parse_ymd(c["start_date"]), parse_ymd(c["end_date"])
            exc = exceptions.get(c["service_id"], {})
            if exc:
                start = min(start, min(exc))
                end = max(end, max(exc))
            dow = [int(c[k]) for k in ("monday", "tuesday", "wednesday",
                                       "thursday", "friday", "saturday", "sunday")]
            ndays = (end - start).days + 1
            bits = bytearray((ndays + 7) // 8)
            for i in range(ndays):
                d = start + timedelta(days=i)
                on = dow[d.weekday()] == 1
                if d in exc:
                    on = exc[d] == 1
                if on:
                    bits[i // 8] |= 1 << (i % 8)
            db.execute(
                "INSERT INTO services VALUES (?,?,?,?,?,?)",
                (sid, feed, c["service_id"], start.isoformat(), end.isoformat(),
                 bytes(bits)),
            )
        fr["calendar"] = len(cal_rows)

        # calendar に無い service_id が calendar_dates だけで現れる場合
        for sid_name, exc in exceptions.items():
            if sid_name in service_sid or not exc:
                continue
            sid = next_sid
            next_sid += 1
            service_sid[sid_name] = sid
            start, end = min(exc), max(exc)
            ndays = (end - start).days + 1
            bits = bytearray((ndays + 7) // 8)
            for d, etype in exc.items():
                if etype == 1:
                    i = (d - start).days
                    bits[i // 8] |= 1 << (i % 8)
            db.execute(
                "INSERT INTO services VALUES (?,?,?,?,?,?)",
                (sid, feed, sid_name, start.isoformat(), end.isoformat(), bytes(bits)),
            )

        db.execute(
            "INSERT INTO feeds VALUES (?,?,?,?,?)",
            (feed, publisher,
             f"{feed_start[0:4]}-{feed_start[4:6]}-{feed_start[6:8]}" if feed_start else "",
             f"{feed_end[0:4]}-{feed_end[4:6]}-{feed_end[6:8]}" if feed_end else "",
             src.size_bytes),
        )

        # ---- trips + stop_times → patterns / パック済み trips ----
        trip_info = {}
        for t in src.table("trips.txt"):
            trip_info[t["trip_id"]] = t
        st_by_trip = defaultdict(list)
        raw_stop_times = 0
        interpolated = 0
        for st in src.table("stop_times.txt"):
            raw_stop_times += 1
            st_by_trip[st["trip_id"]].append(st)
        fr["stop_times"] = raw_stop_times

        patterns = {}  # (route_id, direction, stop_uid tuple) -> pid
        packed_elements = 0
        used_modes = defaultdict(set)  # stop uid -> {route_type}
        n_trips = 0
        for trip_id, t in trip_info.items():
            rows = st_by_trip.get(trip_id)
            if not rows:
                continue
            rows.sort(key=lambda r: int(r["stop_sequence"]))
            uids = tuple(stop_uid[(feed, r["stop_id"])] for r in rows)
            direction = t.get("direction_id") or "0"
            key = (t["route_id"], direction, uids)
            pid = patterns.get(key)
            if pid is None:
                pid = next_pid
                next_pid += 1
                patterns[key] = pid
                db.execute(
                    "INSERT INTO patterns VALUES (?,?,?,?)",
                    (pid, route_uid[t["route_id"]], int(direction),
                     ",".join(str(u) for u in uids)),
                )
                for sidx, su in enumerate(uids):
                    # 環状路線などで同一停留所が1パターンに複数回現れる場合は
                    # 最初の出現だけを索引に入れる (patterns 側に全順序は残る)
                    db.execute("INSERT OR IGNORE INTO stop_patterns VALUES (?,?,?)",
                               (su, pid, sidx))
            # 時刻: (到着, 発車) の対。欠けは前後から線形補間する。
            pairs = [[parse_hms(r.get("arrival_time")), parse_hms(r.get("departure_time"))]
                     for r in rows]
            for i, (arr, dep) in enumerate(pairs):
                if arr is None and dep is not None:
                    pairs[i][0] = dep
                elif dep is None and arr is not None:
                    pairs[i][1] = arr
            known = [i for i, p in enumerate(pairs) if p[0] is not None]
            for i in range(len(pairs)):
                if pairs[i][0] is None:
                    interpolated += 1
                    prev = max([k for k in known if k < i], default=None)
                    nxt = min([k for k in known if k > i], default=None)
                    if prev is not None and nxt is not None:
                        v = pairs[prev][0] + (pairs[nxt][0] - pairs[prev][0]) * (i - prev) // (nxt - prev)
                    elif prev is not None:
                        v = pairs[prev][0]
                    elif nxt is not None:
                        v = pairs[nxt][0]
                    else:
                        v = 0
                    pairs[i] = [v, v]
            flat = []
            for arr, dep in pairs:
                flat += [arr, dep]
            packed_elements += len(flat) // 2
            db.execute(
                "INSERT INTO trips VALUES (?,?,?,?,?,?)",
                (next_tid, pid, service_sid[t["service_id"]],
                 t.get("trip_headsign", ""), flat[1],
                 struct.pack(f"<{len(flat)}i", *flat)),
            )
            next_tid += 1
            n_trips += 1
            rt = route_type_of[t["route_id"]]
            for u in uids:
                used_modes[u].add(rt)
        fr["trips"] = n_trips
        fr["patterns"] = len(patterns)
        fr["packed_stop_times"] = packed_elements
        fr["interpolated_times"] = interpolated
        for u, modes in used_modes.items():
            for m in modes:
                db.execute("INSERT OR IGNORE INTO stop_modes VALUES (?,?)", (u, m))

        # ---- fares ----
        fare_price = {}
        for fa in src.table("fare_attributes.txt"):
            fid = f"{feed}|{fa['fare_id']}"
            fare_price[fid] = int(float(fa["price"]))
            if fid not in fare_int:
                fare_int[fid] = next_fare_int
                next_fare_int += 1
            db.execute(
                "INSERT OR REPLACE INTO fare_attrs VALUES (?,?,?,?)",
                (fare_int[fid], fid, fare_price[fid],
                 int(fa["transfers"]) if fa.get("transfers") else -1),
            )
        n_rules = 0
        for rule in src.table("fare_rules.txt"):
            fid = f"{feed}|{rule['fare_id']}"
            if fid not in fare_price:
                continue
            ruid = route_uid.get(rule["route_id"]) if rule.get("route_id") else None
            db.execute(
                "INSERT INTO fare_rules VALUES (?,?,?,?,?)",
                (feed_idx[feed], ruid, zid(feed_idx[feed], rule.get("origin_id", "")),
                 zid(feed_idx[feed], rule.get("destination_id", "")), fare_int[fid]),
            )
            n_rules += 1
        fr["fare_attrs"] = len(fare_price)
        fr["fare_rules"] = n_rules

        report["feeds"][feed] = fr
        for k in ("stops", "routes", "trips", "stop_times", "calendar",
                  "patterns", "fare_attrs", "fare_rules"):
            grand[k] += fr.get(k, 0)

    # ---- footpaths (全フィード横断、座標グリッドで近傍探索) ----
    stops = db.execute("SELECT uid, lat, lon FROM stops").fetchall()
    cell = 0.006  # 約 670m (緯度方向)
    grid = defaultdict(list)
    for uid, lat, lon in stops:
        grid[(int(lat / cell), int(lon / cell))].append((uid, lat, lon))
    pairs = 0
    rows_fp = []
    for uid, lat, lon in stops:
        gx, gy = int(lat / cell), int(lon / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for uid2, lat2, lon2 in grid.get((gx + dx, gy + dy), []):
                    if uid2 <= uid:
                        continue
                    d = haversine_m(lat, lon, lat2, lon2)
                    if d <= FOOTPATH_RADIUS_M:
                        rows_fp.append((uid, uid2, math.ceil(d / WALK_MPS)))
                        pairs += 1
    db.executemany("INSERT INTO footpaths VALUES (?,?,?)", rows_fp)
    grand["footpaths"] = pairs
    grand["stops"] = len(stops)

    for (fidx, zone), i in zone_int.items():
        db.execute("INSERT INTO zones VALUES (?,?,?)", (i, fidx, zone))
    grand["zones"] = len(zone_int)
    db.execute("INSERT INTO meta VALUES ('format', 'tabisaki-own/1')")
    db.execute("INSERT INTO meta VALUES ('feed_idx', ?)",
               (json.dumps(feed_idx),))
    db.commit()
    report["totals"] = dict(grand)
    return db, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("feeds_dir")
    ap.add_argument("out_db")
    ap.add_argument("--report", default="")
    ap.add_argument("--sql", default="")
    ap.add_argument("--kv", default="")
    ap.add_argument("--json", action="append", default=[], metavar="JSON",
                    help="正規化 JSON (tabisaki-odpt/1) のフィードを追加する (複数可)")
    args = ap.parse_args()

    feed_files = []
    for p in sorted(Path(args.feeds_dir).glob("*.zip")):
        feed_files.append((p.stem, ZipFeedSource(p)))
    for j in args.json:
        jp = Path(j)
        feed_files.append((jp.stem, JsonFeedSource(jp)))
    if not feed_files:
        print("入力フィードがありません", file=sys.stderr)
        return 1

    db, report = convert(feed_files)

    if args.kv:
        cells = defaultdict(list)
        for uid, lat, lon in db.execute("SELECT uid, lat, lon FROM stops ORDER BY uid"):
            cells[geohash_encode(lat, lon)].append([uid, round(lat, 6), round(lon, 6)])
        payload = [{"key": f"stops:{gh}",
                    "value": json.dumps(v, separators=(",", ":"))}
                   for gh, v in sorted(cells.items())]
        Path(args.kv).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        report["kv_cells"] = len(payload)

    out = Path(args.out_db)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    filedb = sqlite3.connect(out)
    db.backup(filedb)
    filedb.execute("VACUUM")
    if args.sql:
        dump = "\n".join(filedb.iterdump())
        Path(args.sql).write_text(dump + "\n", encoding="utf-8")
        report["sql_bytes"] = Path(args.sql).stat().st_size
    filedb.close()
    db.close()

    report["db_bytes"] = out.stat().st_size
    t = report["totals"]
    assert t["stop_times"] == t.get("packed_stop_times", -1) or True
    total_in = sum(f["stop_times"] for f in report["feeds"].values())
    total_packed = sum(f["packed_stop_times"] for f in report["feeds"].values())
    report["check_stop_times"] = {"input": total_in, "packed": total_packed,
                                  "match": total_in == total_packed}
    text = json.dumps(report, ensure_ascii=False, indent=1)
    print(text)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
    return 0 if total_in == total_packed else 2


if __name__ == "__main__":
    sys.exit(main())
