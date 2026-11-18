"""tools/build_bus_timetable.py の試験。小さな GTFS-JP を作って通し、元の時刻に戻るかを見ます。

    python3 -m unittest discover -s tools -p 'test_gtfs*.py'
"""
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_bus_timetable as B  # noqa: E402

FILES = {
    "agency.txt": "agency_id,agency_name\nA,テストバス\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type\n"
                 "P,駅前,34.0,133.0,1\ns1,駅前,34.0001,133.0001,0\ns2,市役所前,34.01,133.01,0\ns3,城下,34.02,133.02,0\n",
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,城下線,3\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign\nR1,WD,t1,城下\nR1,WD,t2,城下\nR1,SA,t3,城下\nR1,WD,t4,城下\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                      "t1,08:00:00,08:00:00,s1,1\nt1,08:10:00,08:10:00,s2,2\nt1,08:20:00,08:20:00,s3,3\n"
                      "t2,09:00:00,09:00:00,s1,1\nt2,09:10:00,09:10:00,s2,2\nt2,09:20:00,09:20:00,s3,3\n"
                      "t3,10:00:00,10:00:00,s1,1\nt3,,,s2,2\nt3,10:30:00,10:30:00,s3,3\n"
                      "t4,24:30:00,24:30:00,s1,1\nt4,24:45:00,24:46:00,s2,2\nt4,25:00:00,25:00:00,s3,3\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                    "WD,1,1,1,1,1,0,0,20260101,20271231\nSA,0,0,0,0,0,1,0,20260101,20271231\n",
    "calendar_dates.txt": "service_id,date,exception_type\nWD,20261123,2\nSA,20261123,1\nWD,20200101,2\n",
}


def make_zip(path: Path, files=FILES):
    with zipfile.ZipFile(path, "w") as z:
        for n, t in files.items():
            z.writestr(n, ("﻿" if n == "stops.txt" else "") + t)


def expand(out: Path, feed: str):
    """data/bus/<feed>/ から、便ごとの (停留所名の並び, 到着秒の並び, 出発秒の並び, 運行日) を戻します。"""
    stops = json.loads((out / feed / "stops.json").read_text())
    cal = json.loads((out / feed / "cal.json").read_text())
    trips = []
    for p in sorted((out / feed).glob("p*.json")):
        for pat in json.loads(p.read_text()):
            names = [stops[s][0] for s in pat["s"]]
            for g in pat["tt"]:
                d = g.get("d", g["a"])
                for t0, svc in g["t"]:
                    trips.append((tuple(names), tuple(t0 + x for x in g["a"]), tuple(t0 + x for x in d), cal[svc]))
    return trips


class BuildTest(unittest.TestCase):
    def build(self, files=FILES, today=20261118):
        tmp = Path(tempfile.mkdtemp())
        make_zip(tmp / "f.zip", files)
        feed = {"id": "t", "name": "テストバス", "url": "https://example.test/f.zip", "license": "CC BY 4.0"}
        res = B.build_feed(feed, tmp / "f.zip", tmp / "out", today)
        return tmp / "out", res

    def test_times_round_trip(self):
        out, res = self.build()
        trips = expand(out, "t")
        self.assertEqual(len(trips), 4)
        by_dep = {t[2][0]: t for t in trips}
        self.assertEqual(by_dep[8 * 3600][1], (8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200))
        # 空いた時刻は前後から割り振る
        self.assertEqual(by_dep[10 * 3600][1][1], 10 * 3600 + 900)
        # 24 時を超える便と、着と発が違う停留所
        late = by_dep[24 * 3600 + 1800]
        self.assertEqual(late[1][1], 24 * 3600 + 2700)
        self.assertEqual(late[2][1], 24 * 3600 + 2760)
        self.assertEqual(res["meta"]["trips"], 4)

    def test_same_pattern_shares_offsets(self):
        out, _ = self.build()
        pats = json.loads((out / "t" / "p0.json").read_text())
        self.assertEqual(len(pats), 1)  # 停まる順は1つ
        # 8時と9時の便は所要が同じなので1つの組に入る
        self.assertIn([28800, 1], [r for g in pats[0]["tt"] for r in g["t"]])
        self.assertEqual(pats[0]["v"], "bus")

    def test_calendar_and_old_exceptions(self):
        out, _ = self.build()
        cal = json.loads((out / "t" / "cal.json").read_text())
        wd = cal[1]  # service_id を名前順に並べる: SA, WD
        self.assertEqual(wd["d"], 0b11111)
        self.assertEqual(wd["rm"], [20261123])  # 2020 年の例外は捨てる
        self.assertEqual(cal[0]["add"], [20261123])

    def test_station_parent_is_not_a_stop(self):
        out, res = self.build()
        names = [s[0] for s in json.loads((out / "t" / "stops.json").read_text())]
        self.assertEqual(names, ["駅前", "市役所前", "城下"])
        tiles = res["tiles"]
        self.assertEqual(sum(len(v) for v in tiles.values()), 3)

    def test_expired_feed_is_refused(self):
        with self.assertRaises(RuntimeError):
            self.build(today=20290101)

    def test_odpt_key_comes_from_env(self):
        f = {"id": "x", "url": "https://example.test/a.zip?acl:consumerKey={ODPT_KEY}"}
        self.assertEqual(B.source_url(f, env={"ODPT_KEY": "k"}), "https://example.test/a.zip?acl:consumerKey=k")
        with self.assertRaises(SystemExit):
            B.source_url(f, env={})


class CatalogTest(unittest.TestCase):
    def test_catalog_licenses(self):
        cat = json.loads((B.ROOT / "data/bus-feeds.json").read_text(encoding="utf-8"))
        ok = {"CC BY 4.0", "CC0 1.0", "公共交通オープンデータ基本ライセンス"}
        ids = set()
        for f in cat["feeds"]:
            self.assertNotIn(f["id"], ids)
            ids.add(f["id"])
            if not f.get("skip"):
                self.assertIn(f["license"], ok, f["id"])
            self.assertNotIn("チャレンジ", f.get("license", ""))
            self.assertNotIn("非商用", f.get("license", ""))


if __name__ == "__main__":
    unittest.main()
