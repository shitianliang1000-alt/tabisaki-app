#!/usr/bin/env python3
"""自前のバス時刻表（server/bus.js）が読むデータを、GTFS-JP から作ります。

    python3 tools/build_bus_timetable.py              # data/bus-feeds.json の全部を落として作る
    python3 tools/build_bus_timetable.py --only ryobi,okaden
    python3 tools/build_bus_timetable.py --cache /tmp/gtfs   # 落としたものを置く場所（既定 data/gtfs-bus/）

出力は data/bus/ です（docs/bus-timetable.md）。

  data/bus/index.json            時刻表の一覧（出典・ライセンス・有効期間）と、区切りの大きさ
  data/bus/tiles/<y>_<x>.json    0.02 度四方の停留所（Worker が地点の近くだけ読む）
  data/bus/<feed>/cal.json       運行日（曜日・期間・足す日・抜く日）
  data/bus/<feed>/stops.json     停留所の名前と位置（乗り換えを探すとき）
  data/bus/<feed>/p<n>.json      停まる順（パターン）と、その便の発車時刻

Workers の無料枠は1回 CPU 10ms なので、1回の検索で読むのは、地点まわりの
区切りと、そこを通るパターンの入ったファイルだけにしています。
同じ停まる順・同じ所要時間の便は、出発時刻だけを並べます（全部の時刻を
持たないので、元の stop_times の 1/20 ほどになります）。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import shutil
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TILE = 50  # 1度を50に切る = 0.02度（南北 約2.2km）
CHUNK_BYTES = 120_000
UA = "Tabisaki/1.0 (+https://github.com/shitianliang1000-alt/tabisaki-app)"

# GTFS の route_type → 中継の乗り物の名前（server/transit.js の vehicle）
VEHICLE = {0: "tram", 1: "rail", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "ropeway", 7: "cable", 11: "bus", 12: "monorail"}


def today_jst() -> date:
    return datetime.now(timezone(timedelta(hours=9))).date()


def secs(t: str) -> int | None:
    t = (t or "").strip()
    if not t:
        return None
    h, m, *s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + (int(s[0]) if s else 0)


def ymd(s: str) -> int:
    return int(str(s).strip() or 0)


def read_csv(z: zipfile.ZipFile, name: str) -> list[dict]:
    names = {n.split("/")[-1]: n for n in z.namelist()}
    if name not in names:
        return []
    raw = z.read(names[name])
    for enc in ("utf-8-sig", "cp932"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.DictReader(io.StringIO(text)))
    return [{(k or "").strip(): (v or "").strip() for k, v in r.items()} for r in rows]


def source_url(feed: dict, env=os.environ) -> str:
    url = feed["url"]
    if "{ODPT_KEY}" in url:
        key = env.get("ODPT_KEY", "").strip()
        if not key:
            raise SystemExit(f"{feed['id']}: 環境変数 ODPT_KEY が無い")
        url = url.replace("{ODPT_KEY}", key)
    return url


def fetch(feed: dict, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{feed['id']}.zip"
    if out.exists() and out.stat().st_size > 0:
        return out
    req = urllib.request.Request(source_url(feed), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(out, "wb") as f:
        shutil.copyfileobj(r, f)
    if not zipfile.is_zipfile(out):
        out.unlink()
        raise RuntimeError(f"{feed['id']}: zip ではありませんでした")
    return out


def services(z: zipfile.ZipFile, since: int) -> tuple[dict[str, dict], int, int]:
    """service_id → {d: 曜日の旗（月=1…日=64）, s, e, add, rm}。有効期間の端も返す。"""
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    out: dict[str, dict] = {}
    for r in read_csv(z, "calendar.txt"):
        mask = sum(1 << i for i, d in enumerate(days) if r.get(d) == "1")
        out[r["service_id"]] = {"d": mask, "s": ymd(r["start_date"]), "e": ymd(r["end_date"]), "add": [], "rm": []}
    for r in read_csv(z, "calendar_dates.txt"):
        sid, dt = r["service_id"], ymd(r["date"])
        s = out.setdefault(sid, {"d": 0, "s": 0, "e": 0, "add": [], "rm": []})
        if dt < since:
            continue
        (s["add"] if r.get("exception_type") == "1" else s["rm"]).append(dt)
    starts = [s["s"] for s in out.values() if s["d"]] + [min(s["add"]) for s in out.values() if s["add"]]
    ends = [s["e"] for s in out.values() if s["d"]] + [max(s["add"]) for s in out.values() if s["add"]]
    return out, (min(starts) if starts else 0), (max(ends) if ends else 0)


def interpolate(times: list[list]) -> None:
    """時刻の空いた停留所（通過の目安だけのもの）を、前後から割り振ります。"""
    known = [i for i, t in enumerate(times) if t[0] is not None]
    if not known:
        return
    for a, b in zip(known, known[1:]):
        for i in range(a + 1, b):
            v = times[a][1] + (times[b][0] - times[a][1]) * (i - a) / (b - a)
            times[i] = [int(v), int(v)]


def build_feed(feed: dict, zpath: Path, out: Path, since: int) -> dict:
    z = zipfile.ZipFile(zpath)
    svc, start, end = services(z, since)
    if end and end < since:
        raise RuntimeError(f"{feed['id']}: 時刻表の期限が切れています（{end}）")
    agencies = {a.get("agency_id", ""): a.get("agency_name", "") for a in read_csv(z, "agency.txt")}
    routes = {r["route_id"]: r for r in read_csv(z, "routes.txt")}
    trips = {t["trip_id"]: t for t in read_csv(z, "trips.txt")}

    # 停留所。標柱（location_type 0）だけを使い、番号を振り直します。
    stop_rows = [s for s in read_csv(z, "stops.txt") if s.get("location_type", "0") in ("", "0")]
    stop_idx: dict[str, int] = {}
    stops: list[list] = []
    for s in stop_rows:
        try:
            lat, lng = float(s["stop_lat"]), float(s["stop_lon"])
        except (KeyError, ValueError):
            continue
        stop_idx[s["stop_id"]] = len(stops)
        stops.append([s.get("stop_name", ""), round(lat, 6), round(lng, 6)])

    by_trip: dict[str, list] = defaultdict(list)
    for r in read_csv(z, "stop_times.txt"):
        if r["stop_id"] not in stop_idx or r["trip_id"] not in trips:
            continue
        by_trip[r["trip_id"]].append((int(r["stop_sequence"]), stop_idx[r["stop_id"]], secs(r.get("arrival_time")), secs(r.get("departure_time"))))

    svc_ids = sorted(svc)
    svc_no = {s: i for i, s in enumerate(svc_ids)}

    # (route, 停まる順) ごとにまとめ、その中を (所要の並び, 行き先) でまとめます。
    patterns: dict[tuple, dict] = {}
    for tid, rows in by_trip.items():
        t = trips[tid]
        if t["service_id"] not in svc_no or len(rows) < 2:
            continue
        rows.sort()
        times = [[a if a is not None else d, d if d is not None else a] for _, _, a, d in rows]
        interpolate(times)
        if times[0][1] is None or times[-1][0] is None:
            continue
        seq = tuple(st for _, st, _, _ in rows)
        t0 = times[0][1]
        offs = tuple((int(a) - t0, int(d) - t0) for a, d in times)
        key = (t["route_id"], seq)
        p = patterns.setdefault(key, {"groups": {}})
        g = p["groups"].setdefault((offs, t.get("trip_headsign", "")), [])
        g.append([t0, svc_no[t["service_id"]]])

    # パターンに番号を振り、ファイル（チャンク）に詰めます。
    chunks: list[list] = [[]]
    size = 0
    stop_refs: dict[int, list] = defaultdict(list)
    for (route_id, seq), p in sorted(patterns.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        r = routes.get(route_id, {})
        name = r.get("route_short_name") or r.get("route_long_name") or route_id
        long = r.get("route_long_name", "")
        if long and long != name:
            name = f"{name} {long}" if len(name) <= 6 else name
        tt = []
        for (offs, head), runs in sorted(p["groups"].items(), key=lambda kv: kv[0][0]):
            a = [o[0] for o in offs]
            d = [o[1] for o in offs]
            g = {"a": a, "t": sorted(runs)}
            if a != d:
                g["d"] = d
            if head:
                g["h"] = head
            tt.append(g)
        rec = {"r": name, "ag": agencies.get(r.get("agency_id", ""), "") if len(agencies) > 1 else "",
               "v": VEHICLE.get(int(r.get("route_type", "3") or 3), "bus"), "s": list(seq), "tt": tt}
        if not rec["ag"]:
            del rec["ag"]
        blob = len(json.dumps(rec, ensure_ascii=False, separators=(",", ":")).encode())
        if size + blob > CHUNK_BYTES and chunks[-1]:
            chunks.append([])
            size = 0
        ci, pi = len(chunks) - 1, len(chunks[-1])
        chunks[-1].append(rec)
        size += blob
        for pos, st in enumerate(seq[:]):
            stop_refs[st].append([ci, pi, pos])

    fdir = out / feed["id"]
    fdir.mkdir(parents=True, exist_ok=True)
    dump = lambda path, obj: path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    dump(fdir / "cal.json", [{k: v for k, v in svc[s].items() if v or k == "d"} for s in svc_ids])
    dump(fdir / "stops.json", stops)
    for i, c in enumerate(chunks):
        dump(fdir / f"p{i}.json", c)

    tiles: dict[str, list] = defaultdict(list)
    for st, refs in stop_refs.items():
        name, lat, lng = stops[st]
        tiles[f"{math.floor(lat * TILE)}_{math.floor(lng * TILE)}"].append([feed["id"], st, name, lat, lng, refs])
    n_trips = sum(len(g) for p in patterns.values() for g in p["groups"].values())
    return {
        "tiles": tiles,
        "meta": {
            "id": feed["id"], "name": feed["name"], "license": feed["license"],
            "publisher": feed.get("publisher", ""), "source": feed.get("source", ""), "url": feed["url"].split("?acl:")[0],
            "agencies": sorted(set(a for a in agencies.values() if a)),
            "start": start, "end": end, "stops": len(stop_refs), "patterns": len(patterns), "trips": n_trips, "files": len(chunks),
        },
    }


LICENSE_URL = {
    "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/deed.ja",
    "CC0 1.0": "https://creativecommons.org/publicdomain/zero/1.0/deed.ja",
    "公共交通オープンデータ基本ライセンス": "https://developer.odpt.org/terms",
}
CREDITS_START = "<!-- bus-timetable:start"
CREDITS_END = "<!-- bus-timetable:end -->"


def credit_line(m: dict) -> str:
    """credits.html の1行。CC BY は出典の表記が義務なので、提供元と出典とライセンスを書きます。"""
    from html import escape
    lic = escape(m["license"])
    url = LICENSE_URL.get(m["license"])
    lic_html = f'<a href="{url}">{lic}</a>' if url else lic
    src = "・".join(x for x in (m.get("publisher"), m.get("source")) if x)
    return f"<li>{escape(m['name'])}: {escape(src)}「GTFS-JP」（{lic_html}）を加工して作成</li>"


def write_credits(path: Path, metas: list[dict]) -> bool:
    """credits.html の印の間を、いまの一覧で書き直します。変わったら True。"""
    text = path.read_text(encoding="utf-8")
    a = text.find(CREDITS_START)
    b = text.find(CREDITS_END)
    if a < 0 or b < 0:
        raise SystemExit(f"{path}: {CREDITS_START} と {CREDITS_END} の印がありません")
    head = text[:text.index("-->", a) + 3]
    body = "\n    <ul class=\"bus-credits\">\n" + "".join(f"      {credit_line(m)}\n" for m in metas) + "    </ul>\n    "
    new = head + body + text[b:]
    if new != text:
        path.write_text(new, encoding="utf-8")
        return True
    return False


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--feeds", default=str(ROOT / "data/bus-feeds.json"))
    ap.add_argument("--out", default=str(ROOT / "data/bus"))
    ap.add_argument("--cache", default=str(ROOT / "data/gtfs-bus"))
    ap.add_argument("--only", default="")
    ap.add_argument("--today", default="", help="YYYYMMDD（試験用）")
    ap.add_argument("--credits", default=str(ROOT / "credits.html"), help="出典の一覧を書き直すページ（空なら書かない）")
    args = ap.parse_args(argv)

    catalog = json.loads(Path(args.feeds).read_text(encoding="utf-8"))
    only = {s for s in args.only.split(",") if s}
    feeds = [f for f in catalog["feeds"] if not f.get("skip") and (not only or f["id"] in only)]
    since = int(args.today) if args.today else int(today_jst().strftime("%Y%m%d"))
    out = Path(args.out)
    if out.exists() and not only:
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    old_index = out / "index.json"
    metas = {m["id"]: m for m in json.loads(old_index.read_text())["feeds"]} if only and old_index.exists() else {}
    tiles: dict[str, list] = defaultdict(list)
    if only:  # 一部だけ作り直すときは、ほかの時刻表の停留所を残します
        for p in (out / "tiles").glob("*.json"):
            tiles[p.stem] = [s for s in json.loads(p.read_text()) if s[0] not in only]
    failed = []
    for f in feeds:
        try:
            res = build_feed(f, fetch(f, Path(args.cache)), out, since)
        except Exception as e:  # noqa: BLE001 — 1本だめでも、ほかは作ります
            failed.append(f"{f['id']}: {e}")
            continue
        metas[f["id"]] = res["meta"]
        for k, v in res["tiles"].items():
            tiles[k].extend(v)
        m = res["meta"]
        print(f"{f['id']:<18} 停留所 {m['stops']:>5}  パターン {m['patterns']:>5}  便 {m['trips']:>6}  {m['start']}–{m['end']}")
    tdir = out / "tiles"
    if tdir.exists():
        shutil.rmtree(tdir)
    tdir.mkdir()
    for k, v in tiles.items():
        if v:
            (tdir / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    index = {"version": 1, "tile": TILE, "built": since, "feeds": sorted(metas.values(), key=lambda m: m["id"])}
    old_index.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.credits:
        write_credits(Path(args.credits), index["feeds"])
    total = sum(p.stat().st_size for p in out.rglob("*.json"))
    print(f"時刻表 {len(metas)} 本・区切り {sum(1 for _ in tdir.glob('*.json'))} 個・{total / 1e6:.1f} MB → {out}")
    for line in failed:
        print("作れなかった:", line, file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
