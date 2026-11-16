# -*- coding: utf-8 -*-
"""tools/gtfs_feeds.py と tools/otp_fetch.py の選び方の試験（Issue #430）。

    python3 -m unittest discover -s tools -p 'test_gtfs*.py'
"""
import datetime as dt
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtfs_feeds as G  # noqa: E402
import otp_fetch as O  # noqa: E402

TODAY = dt.date(2026, 11, 17)  # 火曜

BASE = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nA,試験バス,https://example.test,Asia/Tokyo\n",
    "stops.txt": ("stop_id,stop_name,stop_lat,stop_lon,location_type\n"
                  "S1,駅前,32.8000,130.7000,0\nS2,城前,32.8060,130.7058,\nS3,山の上,32.9000,130.9000,0\n"
                  "ST,駅,32.8001,130.7001,1\n"),
    "routes.txt": "route_id,agency_id,route_short_name,route_type\nR1,A,1,3\nR2,A,電,0\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,WD,T1\nR1,WD,T2\nR2,SUN,T3\n",
    "stop_times.txt": ("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                       "T1,09:00:00,09:00:00,S1,1\nT1,09:10:00,09:10:00,S2,2\n"
                       "T2,25:00:00,25:00:00,S1,1\nT2,25:10:00,25:10:00,S2,2\n"
                       "T3,10:00:00,10:00:00,S1,1\nT3,10:20:00,10:20:00,S3,2\n"),
    "calendar.txt": ("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                     "WD,1,1,1,1,1,0,0,20261001,20270331\nSUN,0,0,0,0,0,0,1,20261001,20270331\n"),
}


def make_zip(files, folder=""):
    fd, path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(path, "w") as z:
        for name, text in files.items():
            if text is not None:
                z.writestr(folder + name, text)
    return path


def feed(**changes):
    files = dict(BASE)
    files.update(changes)
    return make_zip(files)


class CheckFeed(unittest.TestCase):
    def tearDown(self):
        for p in getattr(self, "paths", []):
            os.remove(p)

    def check(self, path):
        self.paths = getattr(self, "paths", []) + [path]
        return G.check_feed(path, TODAY)

    def test_good_feed(self):
        rep = self.check(feed())
        self.assertEqual(rep["errors"], [])
        self.assertEqual(rep["warnings"], [])
        self.assertEqual(rep["status"], "有効")
        self.assertEqual(rep["agencies"], ["試験バス"])
        self.assertEqual(rep["modes"], {"バス": 1, "路面電車": 1})
        self.assertEqual(rep["stops_count"], 3)  # 駅（location_type=1）は数えない
        self.assertEqual(rep["start"], "2026-10-01")
        self.assertEqual(rep["end"], "2027-03-31")
        # 基準の日は今日から先の最初の水曜。平日の便 T1・T2 だけが走る
        self.assertEqual(rep["reference_day"], "2026-11-18")
        self.assertEqual(rep["trips_on_reference_day"], 2)
        dep = {s[2]: s[3] for s in rep["stops"]}
        self.assertEqual(dep, {"駅前": 2, "城前": 2, "山の上": 0})
        self.assertEqual(rep["bbox"], [130.7, 32.8, 130.9, 32.9])

    def test_bom_crlf_and_folder(self):
        files = {k: ("﻿" + v).replace("\n", "\r\n") for k, v in BASE.items()}
        rep = self.check(make_zip(files, folder="gtfs/"))
        self.assertEqual(rep["errors"], [])
        self.assertEqual(rep["stops_count"], 3)

    def test_missing_file_and_column(self):
        rep = self.check(feed(**{"stops.txt": None}))
        self.assertIn("stops.txt が無い", rep["errors"])
        rep = self.check(feed(**{"trips.txt": "route_id,trip_id\nR1,T1\n"}))
        self.assertIn("trips.txt に列 service_id が無い", rep["errors"])
        rep = self.check(feed(**{"calendar.txt": None}))
        self.assertIn("calendar.txt も calendar_dates.txt も無い", rep["errors"])

    def test_not_a_zip(self):
        fd, path = tempfile.mkstemp(suffix=".zip")
        os.write(fd, b"<html>not found</html>")
        os.close(fd)
        rep = self.check(path)
        self.assertTrue(rep["errors"][0].startswith("zip として読めない"))

    def test_no_trips_is_an_error(self):
        rep = self.check(feed(**{"trips.txt": "route_id,service_id,trip_id\n",
                                 "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"}))
        self.assertIn("便（trips.txt の行）が1つも無い", rep["errors"])

    def test_dangling_references_are_counted(self):
        trips = BASE["trips.txt"] + "RX,WD,T4\nR1,NOPE,T5\n"
        times = BASE["stop_times.txt"] + "T9,09:00:00,09:00:00,S1,1\nT1,09:20:00,09:20:00,SX,3\nT1,9:7,9:7,S3,4\n"
        stops = BASE["stops.txt"] + "S4,海の上,0,0,0\nS5,読めない,x,y,0\n"
        rep = self.check(feed(**{"trips.txt": trips, "stop_times.txt": times, "stops.txt": stops}))
        self.assertEqual(rep["errors"], [])
        w = "\n".join(rep["warnings"])
        for part in ("路線がつながらない便 1", "運行日がつながらない便 1", "便がつながらない時刻 1",
                     "停留所がつながらない時刻 1", "読めない時刻 2", "停まるところが2つ未満の便 2",
                     "日本の範囲の外にある停留所 1", "位置が読めない停留所 1"):
            self.assertIn(part, w)

    def test_status_by_period(self):
        def cal(start, end):
            return {"calendar.txt": ("service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                                     f"WD,1,1,1,1,1,0,0,{start},{end}\nSUN,0,0,0,0,0,0,1,{start},{end}\n")}
        self.assertEqual(self.check(feed(**cal("20260101", "20261031")))["status"], "期限切れ")
        self.assertEqual(self.check(feed(**cal("20260101", "20261130")))["status"], "まもなく切れる")
        rep = self.check(feed(**cal("20270101", "20271231")))
        self.assertEqual(rep["status"], "これから")
        self.assertEqual(rep["reference_day"], "2027-01-06")  # 期間の中の最初の水曜

    def test_calendar_dates_only(self):
        dates = "service_id,date,exception_type\nWD,20261118,1\nWD,20261119,1\nSUN,20261122,1\n"
        rep = self.check(feed(**{"calendar.txt": None, "calendar_dates.txt": dates}))
        self.assertEqual(rep["errors"], [])
        self.assertEqual((rep["start"], rep["end"]), ("2026-11-18", "2026-11-22"))
        self.assertEqual(rep["status"], "これから")  # 明日から
        self.assertEqual(rep["trips_on_reference_day"], 2)

    def test_removed_dates(self):
        dates = "service_id,date,exception_type\nWD,20261118,2\n"
        rep = self.check(feed(**{"calendar_dates.txt": dates}))
        self.assertEqual(rep["trips_on_reference_day"], 0)


class Normalize(unittest.TestCase):
    """OTP が組み立ての途中で止まる形を、otp_fetch.normalize が外すこと。"""

    def test_drops_dangling_rows(self):
        path = feed(**{
            "stop_times.txt": BASE["stop_times.txt"] + "T1,09:20:00,09:20:00,SX,3\nT9,09:00:00,09:00:00,S1,1\n",
            "trips.txt": BASE["trips.txt"] + "RX,WD,T7\n",
            "fare_attributes.txt": "fare_id,price,currency_type,payment_method,transfers\nF1,200,JPY,0,0\n",
            "fare_rules.txt": "fare_id,route_id,origin_id\nF1,R1,\nF0,R1,\nF1,,\n",
            "translations.txt": "trans_id,lang,translation\n駅前,ja-Hrkt,えきまえ\n",
        })
        self.addCleanup(os.remove, path)
        dropped = O.normalize(path)
        text = "\n".join(dropped)
        self.assertIn("translations.txt（古い形）", text)
        self.assertIn("fare_rules.txt の無い fare_id を指す行 1", text)
        self.assertIn("trips.txt の無い route_id を指す行 1", text)
        self.assertIn("stop_times.txt の無い trip_id を指す行 1", text)
        self.assertIn("stop_times.txt の無い stop_id を指す行 1", text)
        with zipfile.ZipFile(path) as z:
            self.assertNotIn("translations.txt", z.namelist())
            rules = z.read("fare_rules.txt").decode()
        self.assertEqual(rules.splitlines(), ["fare_id,route_id,origin_id", "F1,R1,", "F1,,"])
        rep = G.check_feed(path, TODAY)
        self.assertEqual(rep["errors"], [])
        self.assertEqual([w for w in rep["warnings"] if "つながらない" in w], [])

    def test_blank_missing_parent(self):
        stops = "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,駅前,32.8,130.7,0,ST\nS2,城前,32.806,130.7058,0,\nS3,山,32.9,130.9,0,\n"
        path = feed(**{"stops.txt": stops})
        self.addCleanup(os.remove, path)
        self.assertEqual(O.normalize(path), ["stops.txt の無い親を指す欄 1"])

    def test_clean_feed_untouched(self):
        path = feed()
        self.addCleanup(os.remove, path)
        with open(path, "rb") as f:
            before = f.read()
        self.assertEqual(O.normalize(path), [])
        with open(path, "rb") as f:
            self.assertEqual(f.read(), before)


class Helpers(unittest.TestCase):
    def test_modes(self):
        self.assertEqual(G.mode_of("3"), "バス")
        self.assertEqual(G.mode_of("2"), "鉄道")
        self.assertEqual(G.mode_of("715"), "バス")
        self.assertEqual(G.mode_of("109"), "鉄道")
        self.assertEqual(G.mode_of("1000"), "船")
        self.assertEqual(G.mode_of("x"), "不明")

    def test_seconds(self):
        self.assertEqual(G.seconds("25:10:00"), 25 * 3600 + 600)
        self.assertIsNone(G.seconds("9:7"))
        self.assertIsNone(G.seconds("09:60:00"))

    def test_expiry_from_catalog(self):
        cat = [
            {"organization_id": "a", "feed_id": "old", "feed_name": "古い", "latest_feed_end_date": "2026-11-01"},
            {"organization_id": "a", "feed_id": "soon", "feed_name": "もうすぐ", "latest_feed_end_date": "2026-12-01"},
            {"organization_id": "a", "feed_id": "ok", "feed_name": "長い", "latest_feed_end_date": "2027-12-01"},
            {"organization_id": "a", "feed_id": "none", "feed_name": "無い", "latest_feed_end_date": ""},
        ]
        got = {G.feed_key(f): why for f, why, _ in G.expiry(cat, TODAY)}
        self.assertEqual(got, {"a/old": "期限切れ", "a/soon": "まもなく切れる", "a/none": "期間が無い"})

    def test_select_skips_discontinued(self):
        cat = [{"organization_id": "a", "feed_id": "x", "feed_pref_id": 43, "feed_is_discontinued": False},
               {"organization_id": "a", "feed_id": "y", "feed_pref_id": 43, "feed_is_discontinued": True},
               {"organization_id": "b", "feed_id": "z", "feed_pref_id": 16, "feed_is_discontinued": False}]
        self.assertEqual([G.feed_key(f) for f in G.select(cat, {43})], ["a/x"])
        self.assertEqual(len(G.select(cat)), 2)


class SourceUrl(unittest.TestCase):
    def test_catalog_feed(self):
        url, why = G.source_url({"organization_id": "kuma-bus", "feed_id": "kuma-bus"}, env={})
        self.assertEqual(url, "https://api.gtfs-data.jp/v2/organizations/kuma-bus/feeds/kuma-bus/files/feed.zip")
        self.assertIsNone(why)

    def test_key_from_env_only(self):
        f = {"organization_id": "odpt", "feed_id": "x", "download_url": "https://example.test/a.zip?acl:consumerKey={ODPT_KEY}"}
        self.assertEqual(G.source_url(f, env={}), (None, "環境変数 ODPT_KEY が無い"))
        self.assertEqual(G.source_url(f, env={"ODPT_KEY": "k"})[0], "https://example.test/a.zip?acl:consumerKey=k")


class Coverage(unittest.TestCase):
    def test_walk_and_often(self):
        index = {
            "a/bus": {"errors": [], "status": "有効", "pref": 43,
                      "stops": [[32.8000, 130.7000, "駅前", 12], [32.9000, 130.9000, "山の上", 0]]},
            "a/old": {"errors": [], "status": "期限切れ", "pref": 43, "stops": [[33.0, 131.0, "古い", 50]]},
            "a/bad": {"errors": ["stops.txt が無い"], "pref": 43, "stops": [[33.1, 131.1, "壊れ", 50]]},
        }
        spots = [
            {"name": "近い", "lat": 32.8040, "lng": 130.7000, "pref": 43},   # 約450m・12本
            {"name": "山", "lat": 32.9001, "lng": 130.9001, "pref": 43},     # 停留所はあるが便が無い
            {"name": "古い停留所の前", "lat": 33.0, "lng": 131.0, "pref": 43},  # 期限切れの時刻表は数えない
            {"name": "壊れた停留所の前", "lat": 33.1, "lng": 131.1, "pref": 43},
        ]
        cov = G.coverage(index, spots)
        self.assertEqual(cov["stops"], 2)
        self.assertEqual(cov["per_pref"][43], {"spots": 4, "walk": 1, "often": 1})
        self.assertEqual(sorted(s["name"] for s in cov["far"]), sorted(["壊れた停留所の前", "古い停留所の前", "山"]))

    def test_grid_crosses_cells(self):
        grid = G.StopGrid([[35.00995, 139.00995, "升の角", 1]])
        self.assertIsNotNone(grid.nearest(35.0101, 139.0101, 800))
        self.assertIsNone(grid.nearest(35.03, 139.03, 800))


class Choose(unittest.TestCase):
    def test_reasons(self):
        region = {"osm": {"bbox": [130.6, 32.7, 130.8, 32.9]}, "select": {"prefectures": [43], "min_stops": 2}}
        feeds = [{"organization_id": "a", "feed_id": k, "feed_name": k} for k in ("ok", "bad", "old", "out", "few", "none")]
        inside = [[32.80, 130.70, "a", 1], [32.81, 130.71, "b", 1]]
        index = {
            "a/ok": {"errors": [], "status": "有効", "stops": inside},
            "a/bad": {"errors": ["stops.txt が無い"], "stops": []},
            "a/old": {"errors": [], "status": "期限切れ", "end": "2026-01-01", "stops": inside},
            "a/out": {"errors": [], "status": "有効", "stops": [[35.0, 139.0, "x", 1]]},
            "a/few": {"errors": [], "status": "有効", "stops": inside[:1]},
        }
        use, skipped = O.choose(region, feeds, index, log=lambda m: None)
        self.assertEqual([f["feed_id"] for f, _ in use], ["ok"])
        why = {f["feed_id"]: w for f, w in skipped}
        self.assertEqual(why["bad"], "stops.txt が無い")
        self.assertIn("有効期間が切れている", why["old"])
        self.assertEqual(why["out"], "範囲の中の停留所が 0")
        self.assertEqual(why["few"], "範囲の中の停留所が 1")
        self.assertIn("検査の結果が無い", why["none"])

    def test_candidates_select_and_explicit(self):
        cat = [{"organization_id": "a", "feed_id": "x", "feed_name": "X", "feed_pref_id": 43},
               {"organization_id": "a", "feed_id": "y", "feed_name": "Y", "feed_pref_id": 43},
               {"organization_id": "b", "feed_id": "z", "feed_name": "Z", "feed_pref_id": 16}]
        sel = {"select": {"prefectures": [43], "exclude": ["a/y"]}}
        self.assertEqual([G.feed_key(f) for f in O.candidates(sel, cat)], ["a/x"])
        explicit = {"feeds": [{"org": "b", "feed": "z", "name": "Z"},
                              {"org": "c", "feed": "w", "name": "手で足した", "license": "CC0 1.0"}]}
        got = O.candidates(explicit, cat)
        self.assertEqual([G.feed_key(f) for f in got], ["b/z", "c/w"])
        self.assertEqual(got[1]["feed_license"], "CC0 1.0")


if __name__ == "__main__":
    unittest.main()
