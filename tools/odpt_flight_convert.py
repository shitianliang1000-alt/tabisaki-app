#!/usr/bin/env python3
"""ODPT odpt:FlightSchedule (JSON) → GTFS zip 変換の試作。

入力は ODPT API v4 から取得した FlightSchedule オブジェクト群、
空港マスタ (odpt:Airport)、空港座標 (Wikidata 由来) の JSON。
出力は通常の GTFS zip で、tools/own_convert.py にそのまま渡せる。

モデリング:
- 空港 = stops (座標は ODPT に無いため Wikidata の P238/P625 を使用)
- (事業者, 出発空港, 到着空港) = routes
- 便エントリ1件 = trips 1件。運航日は「曜日カレンダー × 有効期間
  (isValidFrom/isValidTo)」を calendar.txt の service として表す
  (曜日マスク + start/end で期間内の該当曜日と厳密に一致する)
- stop_times は出発・到着の2点のみ。到着時刻が出発以下なら翌日 (+24h)
- 運賃は元データに無いため fare_* は出力しない
"""
import argparse
import csv
import io
import json
import zipfile
from datetime import date

DOW = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
       "Friday": 4, "Saturday": 5, "Sunday": 6}
AGENCY = {"odpt.Operator:ANA": ("ANA", "全日本空輸"),
          "odpt.Operator:JAL": ("JAL", "日本航空")}


def d(s):
    return date.fromisoformat(s[:10])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("schedules")
    ap.add_argument("airports")
    ap.add_argument("coords")
    ap.add_argument("out_zip")
    ap.add_argument("--from-date", default="2026-11-16",
                    help="この日より前に終了する便を除外 (YYYY-MM-DD)")
    args = ap.parse_args()
    cutoff = date.fromisoformat(args.from_date)

    schedules = json.load(open(args.schedules))
    airports = {a["owl:sameAs"].split(":")[-1]: a.get("dc:title", "")
                for a in json.load(open(args.airports))}
    coords = json.load(open(args.coords))

    services = {}   # (dow_idx, from, to) -> service_id
    routes = {}     # (op, org, dst) -> route_id
    trips = []      # (trip_id, route_id, service_id, headsign)
    stop_times = []  # (trip_id, arr, dep, stop_id, seq)
    used_stops = set()
    stats = {"entries": 0, "kept": 0, "past": 0, "no_time": 0,
             "multi_number": 0, "overnight": 0}

    for obj in schedules:
        op = obj["odpt:operator"]
        org = obj["odpt:originAirport"].split(":")[-1]
        dst = obj["odpt:destinationAirport"].split(":")[-1]
        cal_name = obj["odpt:calendar"].split(":")[-1]
        dow = DOW[cal_name]
        for e in obj.get("odpt:flightScheduleObject", []):
            stats["entries"] += 1
            vf, vt = d(e["odpt:isValidFrom"]), d(e["odpt:isValidTo"])
            if vt < cutoff:
                stats["past"] += 1
                continue
            ot, dt = e.get("odpt:originTime"), e.get("odpt:destinationTime")
            if not ot or not dt:
                stats["no_time"] += 1
                continue
            numbers = e.get("odpt:flightNumber") or []
            if len(numbers) > 1:
                stats["multi_number"] += 1
            number = numbers[0] if numbers else "?"
            skey = (dow, vf.isoformat(), vt.isoformat())
            if skey not in services:
                services[skey] = f"S{len(services) + 1}"
            sid = services[skey]
            rkey = (op, org, dst)
            if rkey not in routes:
                routes[rkey] = f"{AGENCY[op][0]}-{org}-{dst}"
            rid = routes[rkey]
            tid = (f"{AGENCY[op][0]}{number}-{org}-{dst}-{cal_name[:3]}"
                   f"-{vf.strftime('%Y%m%d')}-{len(trips)}")
            headsign = f"{number} {airports.get(dst, dst)}"
            trips.append((tid, rid, sid, headsign))
            arr = dt
            if dt <= ot:
                h, m = map(int, dt.split(":"))
                arr = f"{h + 24:02d}:{m:02d}"
                stats["overnight"] += 1
            # own_convert の parse_hms は HH:MM:SS 前提のため秒を付ける
            stop_times.append((tid, ot + ":00", ot + ":00", org, 1))
            stop_times.append((tid, arr + ":00", arr + ":00", dst, 2))
            used_stops.add(org)
            used_stops.add(dst)
            stats["kept"] += 1

    def table(header, rows):
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)
        return buf.getvalue()

    cal_rows = []
    for (dow, vf, vt), sid in sorted(services.items(), key=lambda kv: kv[1]):
        mask = ["0"] * 7
        mask[dow] = "1"
        cal_rows.append([sid] + mask + [vf.replace("-", ""), vt.replace("-", "")])

    starts = [k[1] for k in services]
    ends = [k[2] for k in services]
    files = {
        "agency.txt": table(
            ["agency_id", "agency_name", "agency_url", "agency_timezone",
             "agency_lang"],
            [[aid, name, "", "Asia/Tokyo", "ja"]
             for aid, name in AGENCY.values()]),
        "stops.txt": table(
            ["stop_id", "stop_name", "stop_lat", "stop_lon"],
            [[c, airports.get(c, c), coords[c]["lat"], coords[c]["lon"]]
             for c in sorted(used_stops)]),
        "routes.txt": table(
            ["route_id", "agency_id", "route_short_name", "route_long_name",
             "route_type"],
            [[rid, AGENCY[op][0], f"{org}-{dst}",
              f"{airports.get(org, org)} → {airports.get(dst, dst)}", 1100]
             for (op, org, dst), rid in sorted(routes.items())]),
        "calendar.txt": table(
            ["service_id", "monday", "tuesday", "wednesday", "thursday",
             "friday", "saturday", "sunday", "start_date", "end_date"],
            cal_rows),
        "trips.txt": table(
            ["route_id", "service_id", "trip_id", "trip_headsign"],
            [[rid, sid, tid, hs] for tid, rid, sid, hs in trips]),
        "stop_times.txt": table(
            ["trip_id", "arrival_time", "departure_time", "stop_id",
             "stop_sequence"],
            stop_times),
        "feed_info.txt": table(
            ["feed_publisher_name", "feed_publisher_url", "feed_lang",
             "feed_start_date", "feed_end_date", "feed_version"],
            [["Tabisaki flight prototype (source: ODPT)", "", "ja",
              min(starts).replace("-", ""), max(ends).replace("-", ""),
              "proto-2026-11-16"]]),
    }
    with zipfile.ZipFile(args.out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    print(json.dumps({"stats": stats, "services": len(services),
                      "routes": len(routes), "trips": len(trips),
                      "stops": len(used_stops)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
