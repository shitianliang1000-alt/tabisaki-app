#!/usr/bin/env python3
"""ODPT API のみで提供される事業者 (GTFS ファイル無し) → 正規化 JSON 変換アダプタ。

対象: 東急バス、ゆりかもめ (2026-11-14 時点)。
GTFS ファイルが公開されていない事業者は、ファイル取得に固執せず
ODPT (公共交通オープンデータセンター) の JSON API からデータを引く。
出力は GTFS zip の合成ではなく、正規化 JSON (形式 tabisaki-odpt/1) で、
tools/own_convert.py の --json 入力が読み取り層でそのまま取り込む。
GTFS テキストでは落ちる情報 (祝日カレンダーの区別など) を JSON 側で
保持できるのが、この形にする理由。

使い方:
    ODPT_TOKEN=<アクセストークン> python3 tools/odpt_api_convert.py <out_dir> \
        [--report <report.json>] [--cache-dir <dir>] [--offline]

- トークンは環境変数 ODPT_TOKEN からだけ読む。ファイル・JSON・レポートには
  一切残さない (デプロイ時は Worker のシークレットに入る想定)。
- 東急バスの時刻表は odpt:BusTimetable (1オブジェクト = 1便、停留所順の
  全時刻入り。終点の到着時刻を含む) から直接組み立てる。便の再構成
  (FIFO つなぎ) や終点到着の中央値補完はしない。
  中間停留所は到着時刻しか無いため、発車時刻も同じ値で代用する
  (バスは停留所での停車時間が短く、エンジン側の扱いも到着=発車が前提)。
- ゆりかもめには便単位の時刻表 (odpt:TrainTimetable) が無い (0件) ため、
  従来どおり駅別発車時刻表から便を再構成する (系統パターンの停留所順に
  発車時刻を FIFO でつなぐ。バス・列車は追い越さない前提)。
  発車時刻表には終点への到着レグが無いので、そこだけ逆方向を含む全便から
  観測した同一区間の所要時間の中央値で補完する (推定値。レポートに件数)。
- 運行日種別と GTFS 側サービスへの写像:
  * 東急バス: 平日 / 土曜 / 日祝 (odpt.Calendar:Holiday) の3種。
    Holiday は「日曜 + 国民の祝日」であり、曜日パターンだけでは表せない。
    そこで holiday サービスは曜日=日曜とし、祝日を services の
    added_dates (calendar_dates の追加例外) として列挙する。あわせて
    平日サービスは祝日に日祝ダイヤへ置き換わるため、平日の祝日を
    removed_dates で落とす。祝日が土曜の場合は土曜ダイヤが優先される
    ので、土曜の祝日は holiday の added_dates に入れない。
    祝日は日本の祝日規則 (振替休日・国民の休日を含む) で算出し、
    内閣府の公式一覧 (2026・2027年) と全件一致を検証済み。
  * ゆりかもめ: 平日 / 土休日 (odpt.Calendar:SaturdayHoliday) の2種。
    土休日も土曜・日曜に平日の祝日を含むため、saturday_holiday サービスは
    曜日=土日 + 平日祝日の added_dates とし、平日サービスは平日の祝日を
    removed_dates で落とす (従来の土日のみへの近似から改善)。
  * BusTimetable の時刻は深夜フラグ無しで書かれ、日付をまたぐ便の到着が
    0 時台のままになる (実測 6便)。便内の時刻列が単調になるよう
    24 時間を繰り上げて取り込む。
- 有効期間は、取得データの dc:date が属する月の初日から1年間とする。
- 運賃: ゆりかもめは odpt:RailwayFare に全駅ペアの運賃 (券売機運賃) が
  あるため fares に変換する。東急バスは運賃データが API に無い
  (odpt:BusroutePatternFare は東急バス分が0件) ため運賃なし。
- ロゴ・駅構内図などの画像データは扱わない (特定利用条件で加工が
  制限されるため。本アダプタの対象は時刻表・停留所・駅・運賃のみ)。

ライセンス (公共交通オープンデータ基本ライセンス、2026-11-14 条文確認):
- 東急バス・ゆりかもめの特定利用条件は画像データの加工制限のみで、
  時刻表・停留所データへの追加制約はない。API からの取得と成果物での
  利用は第4条 (成果物での利用許諾、営利可) の枠内。
- ただし変換後データは元の大部分を復元できる「派生データ」に当たるため、
  第8条第4項(1)により第三者が再利用可能な形での公開・配布は禁止。
  生成 JSON / 変換後データは GitHub へ入れず、KV / D1 の内部データとして
  扱うこと (このツールはリポジトリ外の out_dir に書く前提)。
- 第4条第2項(4): データが更新されたら成果物を直ちに更新する義務がある。
  したがって本アダプタは「定期リフレッシュ前提」の設計であり、生成データ
  には生成時点のデータ版 (dc:date) を feed_info とレポートに残す。
"""
import argparse
import json
import math
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

API_BASE = "https://api.odpt.org/api/v4/"
USER_AGENT = "Tabisaki/1.0 (+https://github.com/shitianliang1000-alt/tabisaki-app)"
RESULT_CAP = 1000  # ODPT API は 1 クエリ最大 1000 件しか返さない

RAIL_MAX_GAP_SECS = 20 * 60   # 鉄道: 駅間の最大つなぎ間隔
RAIL_FALLBACK_SEG_SECS = 90   # 鉄道の終点補完で区間実績が無い場合の仮置き


# ---------------------------------------------------------------------------
# ODPT API アクセス (トークンは環境変数からのみ)
# ---------------------------------------------------------------------------

def api_get(token, rtype, cache_dir=None, cache_key=None, **params):
    """ODPT API の1クエリを取得する。cache_dir があれば JSON を保存・再利用。"""
    cache_path = None
    if cache_dir and cache_key:
        cache_path = Path(cache_dir) / (cache_key + ".json")
        if cache_path.exists():
            return json.loads(cache_path.read_text(encoding="utf-8"))
    params["acl:consumerKey"] = token
    url = API_BASE + rtype + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = json.loads(r.read())
            break
        except Exception as e:  # noqa: BLE001 - リトライして最後に上げる
            last_err = e
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
    else:
        raise last_err
    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def short_id(same_as):
    """'odpt.BusstopPole:TokyuBus.X.00241242.b' → 'TokyuBus.X.00241242.b'"""
    return same_as.split(":", 1)[1] if ":" in same_as else same_as


def parse_hm(s, is_midnight=False):
    """'HH:MM' → 運行日0時からの秒。深夜便フラグ時は 0 時台を 24 時台に寄せる。"""
    h, m = s.split(":")
    secs = int(h) * 3600 + int(m) * 60
    if is_midnight and secs < 12 * 3600:
        secs += 24 * 3600
    return secs


# ---------------------------------------------------------------------------
# 日本の祝日 (国民の祝日 + 振替休日 + 国民の休日)
# 内閣府の公式一覧 (syukujitsu.csv) と 2026・2027 年で全件一致を検証済み。
# ---------------------------------------------------------------------------

def _vernal_equinox_day(year):
    return math.floor(20.8431 + 0.242194 * (year - 1980)) - math.floor((year - 1980) / 4)


def _autumnal_equinox_day(year):
    return math.floor(23.2488 + 0.242194 * (year - 1980)) - math.floor((year - 1980) / 4)


def jp_holidays(year):
    """その年の祝日を {date: 名称} で返す。"""
    h = {}

    def add(d, name):
        if d.year == year:
            h[d] = name

    def nth_monday(m, n):
        d = date(year, m, 1)
        return d + timedelta(days=(7 - d.weekday()) % 7 + 7 * (n - 1))

    add(date(year, 1, 1), "元日")
    add(nth_monday(1, 2), "成人の日")
    add(date(year, 2, 11), "建国記念の日")
    add(date(year, 2, 23), "天皇誕生日")
    add(date(year, 3, _vernal_equinox_day(year)), "春分の日")
    add(date(year, 4, 29), "昭和の日")
    add(date(year, 5, 3), "憲法記念日")
    add(date(year, 5, 4), "みどりの日")
    add(date(year, 5, 5), "こどもの日")
    add(nth_monday(7, 3), "海の日")
    add(date(year, 8, 11), "山の日")
    add(nth_monday(9, 3), "敬老の日")
    add(date(year, 9, _autumnal_equinox_day(year)), "秋分の日")
    add(nth_monday(10, 2), "スポーツの日")
    add(date(year, 11, 3), "文化の日")
    add(date(year, 11, 23), "勤労感謝の日")
    # 振替休日: 祝日が日曜なら、祝日でない最初の平日まで進める
    for d in sorted(dict(h)):
        if d.weekday() == 6:
            nd = d + timedelta(days=1)
            while nd in h:
                nd += timedelta(days=1)
            add(nd, "振替休日")
    # 国民の休日: 祝日に挟まれた平日
    d = date(year, 1, 1)
    while d.year == year:
        if d not in h and d.weekday() < 5:
            if (d - timedelta(days=1)) in h and (d + timedelta(days=1)) in h:
                h[d] = "国民の休日"
        d += timedelta(days=1)
    return h


def holiday_dates_in_window(start_ymd, end_ymd):
    """[start, end] (YYYYMMDD) に含まれる祝日を YYYYMMDD のリストで返す。"""
    start = date(int(start_ymd[0:4]), int(start_ymd[4:6]), int(start_ymd[6:8]))
    end = date(int(end_ymd[0:4]), int(end_ymd[4:6]), int(end_ymd[6:8]))
    out = []
    for year in range(start.year, end.year + 1):
        for d in jp_holidays(year):
            if start <= d <= end:
                out.append(d.strftime("%Y%m%d"))
    return sorted(out)


# ---------------------------------------------------------------------------
# サービス (カレンダー) の表現。正規化 JSON では曜日パターン + 日付例外で持つ。
# ---------------------------------------------------------------------------

CALENDAR_DEFS = {
    # service_id: (曜日の並び Mon..Sun, ODPT カレンダー名)
    "weekday": ((1, 1, 1, 1, 1, 0, 0), "odpt.Calendar:Weekday"),
    "saturday": ((0, 0, 0, 0, 0, 1, 0), "odpt.Calendar:Saturday"),
    "sunday": ((0, 0, 0, 0, 0, 0, 1), "odpt.Calendar:Sunday"),
    "holiday": ((0, 0, 0, 0, 0, 0, 1), "odpt.Calendar:Holiday"),
    "saturday_holiday": ((0, 0, 0, 0, 0, 1, 1), "odpt.Calendar:SaturdayHoliday"),
}
SERVICE_BY_CALENDAR = {v[1]: k for k, v in CALENDAR_DEFS.items()}
def services_doc(service_ids, start, end):
    """サービスの曜日パターン + 日付例外を組む。

    祝日の扱い (日本のバス・鉄道の一般的な運行規則):
    - holiday (日祝): 日曜 + 祝日。ただし祝日が土曜の場合は土曜ダイヤが
      優先されるため、土曜の祝日は added_dates に入れない。
    - saturday_holiday (土休日): 土曜・日曜 + 平日の祝日。
    - weekday (平日): 祝日は日祝/土休日ダイヤに置き換わるため、
      平日の祝日を removed_dates で落とす。
    """
    holidays = holiday_dates_in_window(start, end)

    def wday(ymd):
        return date(int(ymd[0:4]), int(ymd[4:6]), int(ymd[6:8])).weekday()

    rules = {
        "holiday": ([d for d in holidays if wday(d) != 5], []),
        "saturday_holiday": ([d for d in holidays if wday(d) < 5], []),
        "weekday": ([], [d for d in holidays if wday(d) < 5]),
        "saturday": ([], []),
        "sunday": ([], []),
    }
    rows = []
    for sid in service_ids:
        added, removed = rules.get(sid, ([], []))
        rows.append({"service_id": sid, "dow": list(CALENDAR_DEFS[sid][0]),
                     "start_date": start, "end_date": end,
                     "added_dates": added, "removed_dates": removed})
    return rows


def service_window(resources):
    """dc:date の最新日が属する月の初日から1年を運行期間にする。"""
    dates = []
    for r in resources:
        d = (r.get("dc:date") or "")[:10]
        if d:
            dates.append(d)
    if not dates:
        today = date.today()
        start = date(today.year, today.month, 1)
    else:
        y, m, _dd = max(dates).split("-")
        start = date(int(y), int(m), 1)
    end = date(start.year + 1, start.month, 1) - timedelta(days=1)
    return start.strftime("%Y%m%d"), end.strftime("%Y%m%d")


def base_doc(agency_row, start, end):
    return {
        "format": "tabisaki-odpt/1",
        "publisher": "公共交通オープンデータセンター",
        "publisher_url": "https://www.odpt.org/",
        "agency": [agency_row],
        "feed_info": {"feed_start_date": start, "feed_end_date": end},
        "stops": [], "routes": [], "services": [], "trips": [],
        "fares": {"attributes": [], "rules": []},
    }


# ---------------------------------------------------------------------------
# 便の再構成 (ゆりかもめ用): 停留所別発車時刻 → trip (FIFO つなぎ)
# ---------------------------------------------------------------------------

def chain_trips(stop_ids, deps_by_idx, max_gap_secs, seg_durations):
    """stop_ids: パターンの停留所順。deps_by_idx: {停留所index: [(秒, 行先stop_id)]}

    seg_durations: {(stop_idA, stop_idB) ソート済みタプル: [所要秒]} を
    観測のたびに更新する共有辞書 (終点到着の補完に使う)。
    戻り値: (trips, stats)。trips は [([(stop_index, 秒)], 行先index)] のリスト。
    発車時刻表には行先停留所での発車が無いので、つなぎは行先の手前までで
    止まる。行先への到着は extend_trips で補完する。
    """
    by_dest = defaultdict(lambda: defaultdict(list))
    for idx, deps in deps_by_idx.items():
        for secs, dest in deps:
            by_dest[dest][idx].append(secs)
    trips = []
    stats = Counter()
    idx_of_stop = {sid: i for i, sid in enumerate(stop_ids)}
    for dest, per_idx in by_dest.items():
        dest_idx = idx_of_stop.get(dest)
        if dest_idx is None:
            stats["dest_not_in_pattern"] += sum(len(v) for v in per_idx.values())
            continue
        open_trips = []  # [(最終index, 最終時刻, [(index, 時刻)])]
        for idx in range(dest_idx):
            deps = sorted(per_idx.get(idx, []))
            used = [False] * len(open_trips)
            new_trips = []
            for secs in deps:
                hit = None
                for j, (lidx, lsecs, seq) in enumerate(open_trips):
                    if used[j] or lidx != idx - 1:
                        continue
                    if lsecs <= secs and secs - lsecs <= max_gap_secs:
                        hit = j
                        break
                if hit is not None:
                    used[hit] = True
                    _, lsecs, seq = open_trips[hit]
                    key = tuple(sorted((stop_ids[idx - 1], stop_ids[idx])))
                    seg_durations[key].append(secs - lsecs)
                    seq.append((idx, secs))
                    new_trips.append((idx, secs, seq))
                else:
                    stats["trip_starts_midway"] += 1 if idx > 0 else 0
                    new_trips.append((idx, secs, [(idx, secs)]))
            for j, t in enumerate(open_trips):
                if not used[j]:
                    trips.append((t[2], dest_idx))
                    stats["trips_ended_early"] += 1
            open_trips = new_trips
        for _, _, seq in open_trips:
            trips.append((seq, dest_idx))
    good = [(t, d) for t, d in trips if len(t) >= 2 or (len(t) == 1 and d == 1)]
    stats["trips_total"] = len(good)
    stats["trips_dropped_short"] = len(trips) - len(good)
    return good, stats


def extend_trips(trips, stop_ids, seg_durations, fallback_secs):
    """行先の手前までつながった便に、行先への到着レグを補完する。

    区間所要時間は seg_durations の中央値 (逆方向の観測も含む)。
    実績が無い区間は fallback_secs。戻り値: 補完した便数。
    """
    n = 0
    for seq, dest_idx in trips:
        if not seq or seq[-1][0] != dest_idx - 1:
            continue
        prev_stop = stop_ids[seq[-1][0]]
        dest_stop = stop_ids[dest_idx]
        key = tuple(sorted((prev_stop, dest_stop)))
        obs = seg_durations.get(key)
        dur = int(statistics.median(obs)) if obs else fallback_secs
        seq.append((dest_idx, seq[-1][1] + dur))
        n += 1
    return n


# ---------------------------------------------------------------------------
# 東急バス (odpt:BusTimetable 主体)
# ---------------------------------------------------------------------------

def fetch_bus_timetables(token, cache_dir, pat_ids):
    """パターン単位で odpt:BusTimetable を全件取得する。

    1クエリ最大 RESULT_CAP 件のため、パターンで分割する。パターン単独で
    上限に達した場合はカレンダーでさらに分割する。owl:sameAs で重複を
    除き、(総数, カレンダー別件数, パターン別オブジェクト) を返す。
    """
    bt_dir = Path(cache_dir) / "tokyubus_bt" if cache_dir else None

    def fetch(pid):
        key = "bt_" + short_id(pid).replace("/", "_") if bt_dir else None
        res = api_get(token, "odpt:BusTimetable",
                      str(bt_dir) if bt_dir else None, key,
                      **{"odpt:busroutePattern": pid})
        if len(res) < RESULT_CAP:
            return res
        # 上限に達したらカレンダー別に取り直す
        out = []
        for cal in ("Weekday", "Saturday", "Holiday", "Sunday", "SaturdayHoliday"):
            sub = api_get(token, "odpt:BusTimetable",
                          str(bt_dir) if bt_dir else None,
                          (key + "_" + cal) if key else None,
                          **{"odpt:busroutePattern": pid,
                             "odpt:calendar": f"odpt.Calendar:{cal}"})
            if len(sub) >= RESULT_CAP:
                raise RuntimeError(f"分割しても上限に達しました: {pid} / {cal}")
            out.extend(sub)
        return out

    per_pattern = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for pid, res in zip(pat_ids, ex.map(fetch, pat_ids)):
            per_pattern[pid] = res
    seen = {}
    per_calendar = Counter()
    for pid, res in per_pattern.items():
        for obj in res:
            sid = obj["owl:sameAs"]
            if sid in seen:
                continue
            seen[sid] = obj
            per_calendar[obj.get("odpt:calendar")] += 1
    return per_pattern, seen, per_calendar


def build_tokyubus(token, cache_dir):
    rep = {"operator": "東急バス"}
    poles = api_get(token, "odpt:BusstopPole", cache_dir, "tokyubus_poles",
                    **{"odpt:operator": "odpt.Operator:TokyuBus"})
    patterns = api_get(token, "odpt:BusroutePattern", cache_dir, "tokyubus_patterns",
                       **{"odpt:operator": "odpt.Operator:TokyuBus"})
    rep["poles"] = len(poles)
    rep["patterns"] = len(patterns)

    pole_name = {}
    pole_geo = {}
    pole_ids = []
    for p in poles:
        sid = p["owl:sameAs"]
        pole_name[sid] = p.get("dc:title", "")
        if p.get("geo:lat") is not None and p.get("geo:long") is not None:
            pole_geo[sid] = (float(p["geo:lat"]), float(p["geo:long"]))
            pole_ids.append(sid)
    rep["poles_without_geo"] = len(poles) - len(pole_ids)

    # 系統とパターンの整理 (方向判定と headsign 用)
    pat_info = {}
    route_titles = defaultdict(Counter)
    route_patterns = defaultdict(list)
    for p in patterns:
        pid = p["owl:sameAs"]
        order = sorted(p.get("odpt:busstopPoleOrder", []),
                       key=lambda o: o["odpt:index"])
        seq = [o["odpt:busstopPole"] for o in order
               if o["odpt:busstopPole"] in pole_geo]
        pat_info[pid] = {"route": p["odpt:busroute"], "seq": seq,
                         "title": p.get("dc:title", "")}
        route_patterns[p["odpt:busroute"]].append(pid)
        route_titles[p["odpt:busroute"]][p.get("dc:title", "")] += 1
    rep["routes"] = len(route_patterns)

    # direction_id: 系統ごとに「終点の停留所」で 0/1 を割り当てる
    pat_direction = {}
    for route, pids in route_patterns.items():
        terminals = Counter()
        for pid in pids:
            seq = pat_info[pid]["seq"]
            if seq:
                terminals[seq[-1]] += 1
        ordered = [t for t, _ in terminals.most_common()]
        for pid in pids:
            seq = pat_info[pid]["seq"]
            if not seq:
                pat_direction[pid] = 0
            else:
                pat_direction[pid] = 1 if len(ordered) > 1 and seq[-1] == ordered[1] else 0

    pat_ids = [p["owl:sameAs"] for p in patterns]
    per_pattern, objects, per_calendar = fetch_bus_timetables(token, cache_dir, pat_ids)
    rep["bus_timetables"] = len(objects)
    rep["bus_timetables_by_calendar"] = dict(per_calendar)
    covered = {pid for pid, res in per_pattern.items() if res}
    rep["patterns_with_times"] = len(covered)
    rep["patterns_without_times"] = [
        {"title": pat_info[pid]["title"], "pattern": short_id(pid)}
        for pid in pat_ids if pid not in covered]

    start, end = service_window(poles + patterns + list(objects.values()))
    service_order = {"weekday": 0, "saturday": 1, "sunday": 2, "holiday": 3}

    def sort_key(obj):
        entries = obj.get("odpt:busTimetableObject", [])
        first = 0
        if entries:
            e0 = sorted(entries, key=lambda o: o["odpt:index"])[0]
            t = e0.get("odpt:departureTime") or e0.get("odpt:arrivalTime")
            if t:
                first = parse_hm(t, bool(e0.get("odpt:isMidnight")))
        return (obj.get("odpt:busroutePattern", ""),
                service_order.get(SERVICE_BY_CALENDAR.get(obj.get("odpt:calendar"), ""), 9),
                first, obj["owl:sameAs"])

    trips = []
    stats = Counter()
    n_entries = 0
    for obj in sorted(objects.values(), key=sort_key):
        pat = obj.get("odpt:busroutePattern")
        sid = SERVICE_BY_CALENDAR.get(obj.get("odpt:calendar"))
        if pat not in pat_info or sid is None:
            stats["objects_skipped_unknown_pattern_or_calendar"] += 1
            continue
        entries = sorted(obj.get("odpt:busTimetableObject", []),
                         key=lambda o: o["odpt:index"])
        times = []
        unknown_pole = False
        rollover = 0       # 日付またぎの繰り上げ秒 (深夜便の 0 時台表記対策)
        prev_secs = None
        rolled = False
        for e in entries:
            pole = e.get("odpt:busstopPole")
            if pole not in pole_geo:
                unknown_pole = True
                break
            midnight = bool(e.get("odpt:isMidnight"))
            arr = e.get("odpt:arrivalTime")
            dep = e.get("odpt:departureTime")
            arr_s = parse_hm(arr, midnight) if arr else None
            dep_s = parse_hm(dep, midnight) if dep else None
            if arr_s is None:
                arr_s = dep_s
            if dep_s is None:
                dep_s = arr_s
            if arr_s is None:
                continue
            # BusTimetable には深夜フラグが無く、日付をまたぐ便の到着が
            # 0 時台のまま書かれる (実測: 全33,554便中6便)。時刻列が
            # 単調になるよう 24 時間を繰り上げる。
            base = min(arr_s, dep_s)
            while prev_secs is not None and base + rollover < prev_secs:
                rollover += 24 * 3600
                rolled = True
            arr_s += rollover
            dep_s += rollover
            prev_secs = dep_s
            times.append({"stop_id": pole, "arr": arr_s, "dep": dep_s})
        if rolled:
            stats["trips_midnight_rollover"] += 1
        if unknown_pole:
            stats["trips_skipped_unknown_pole"] += 1
            continue
        if len(times) < 2:
            stats["trips_skipped_too_short"] += 1
            continue
        n_entries += len(times)
        trips.append({
            "trip_id": f"tb{len(trips) + 1}",
            "route_id": pat_info[pat]["route"],
            "service_id": sid,
            "trip_headsign": pole_name.get(times[-1]["stop_id"], ""),
            "direction_id": pat_direction[pat],
            "times": times,
        })
    rep["timetable_stats"] = dict(stats)
    rep["trips"] = len(trips)
    rep["stop_times"] = n_entries

    used_services = sorted({t["service_id"] for t in trips},
                           key=lambda s: service_order.get(s, 9))
    doc = base_doc(
        {"agency_id": "odpt", "agency_name": "東急バス",
         "agency_url": "https://www.tokyubus.co.jp/",
         "agency_timezone": "Asia/Tokyo", "agency_lang": "ja"},
        start, end)
    doc["stops"] = [{"stop_id": pid, "stop_name": pole_name[pid],
                     "stop_lat": pole_geo[pid][0], "stop_lon": pole_geo[pid][1],
                     "zone_id": ""} for pid in pole_ids]
    doc["routes"] = [{"route_id": r, "agency_id": "odpt",
                      "route_short_name": route_titles[r].most_common(1)[0][0],
                      "route_long_name": "", "route_type": 3}
                     for r in sorted(route_patterns)]
    doc["services"] = services_doc(used_services, start, end)
    doc["trips"] = trips
    rep["service_window"] = [start, end]
    rep["service_date_exceptions"] = {
        svc["service_id"]: {"added": len(svc["added_dates"]),
                            "removed": len(svc["removed_dates"])}
        for svc in doc["services"]}
    return doc, rep


# ---------------------------------------------------------------------------
# ゆりかもめ (鉄道として変換、便は駅別時刻表から再構成)
# ---------------------------------------------------------------------------

def build_yurikamome(token, cache_dir):
    rep = {"operator": "ゆりかもめ"}
    stations = api_get(token, "odpt:Station", cache_dir, "yurikamome_stations",
                       **{"odpt:operator": "odpt.Operator:Yurikamome"})
    railway = api_get(token, "odpt:Railway", cache_dir, "yurikamome_railway",
                      **{"odpt:operator": "odpt.Operator:Yurikamome"})[0]
    timetables = api_get(token, "odpt:StationTimetable", cache_dir,
                         "yurikamome_timetables",
                         **{"odpt:operator": "odpt.Operator:Yurikamome"})
    fares = api_get(token, "odpt:RailwayFare", cache_dir, "yurikamome_fares",
                    **{"odpt:operator": "odpt.Operator:Yurikamome"})
    rep["stations"] = len(stations)
    rep["station_timetables"] = len(timetables)
    rep["fares"] = len(fares)

    st_name = {s["owl:sameAs"]: s.get("dc:title", "") for s in stations}
    st_geo = {s["owl:sameAs"]: (float(s["geo:lat"]), float(s["geo:long"]))
              for s in stations
              if s.get("geo:lat") is not None and s.get("geo:long") is not None}
    order = sorted(railway["odpt:stationOrder"], key=lambda o: o["odpt:index"])
    line = [o["odpt:station"] for o in order]  # 新橋 → 豊洲
    route_id = railway["owl:sameAs"]

    # (calendar, direction) × station → [(秒, 行先station)]
    deps = defaultdict(lambda: defaultdict(list))
    n_objects = 0
    for tt in timetables:
        cal = tt.get("odpt:calendar")
        direction = tt.get("odpt:railDirection", "")
        station = tt.get("odpt:station")
        for obj in tt.get("odpt:stationTimetableObject", []):
            dests = obj.get("odpt:destinationStation") or []
            if not dests:
                continue
            secs = parse_hm(obj["odpt:departureTime"])
            deps[(cal, direction)][station].append((secs, dests[0]))
            n_objects += 1
    rep["timetable_objects"] = n_objects

    start, end = service_window(stations + timetables)
    seg_durations = defaultdict(list)
    pending = []  # (service_id, seq, direction_id, trips)
    total_stats = Counter()
    for (cal, direction), per_station in sorted(deps.items()):
        sid = SERVICE_BY_CALENDAR.get(cal)
        if sid is None:
            continue
        if direction.endswith("Outbound"):
            seq, dir_id = line, 0
        else:
            seq, dir_id = list(reversed(line)), 1
        idx_of = {s: i for i, s in enumerate(seq)}
        deps_by_idx = {idx_of[s]: lst for s, lst in per_station.items()
                       if s in idx_of}
        trips, stats = chain_trips(seq, deps_by_idx, RAIL_MAX_GAP_SECS, seg_durations)
        total_stats.update(stats)
        if trips:
            pending.append((sid, seq, dir_id, trips))
    n_extended = 0
    for sid, seq, dir_id, trips in pending:
        n_extended += extend_trips(trips, seq, seg_durations, RAIL_FALLBACK_SEG_SECS)
    total_stats["trips_extended_to_dest"] = n_extended

    trips = []
    n_entries = 0
    for sid, seq, dir_id, chained in pending:
        for trip, _dest_idx in chained:
            n_entries += len(trip)
            trips.append({
                "trip_id": f"yk{len(trips) + 1}",
                "route_id": route_id,
                "service_id": sid,
                "trip_headsign": st_name.get(seq[trip[-1][0]], ""),
                "direction_id": dir_id,
                "times": [{"stop_id": seq[idx], "arr": secs, "dep": secs}
                          for idx, secs in trip],
            })
    rep["chain_stats"] = dict(total_stats)

    # 運賃: 駅ごとにゾーンを分け、全ペアを fare rules にする (券売機運賃)
    zone_of = {s: short_id(s).split(".")[-1] for s in line}
    fare_attrs = []
    fare_rules = []
    for i, f in enumerate(sorted(fares, key=lambda x: x["owl:sameAs"])):
        frm, to = f["odpt:fromStation"], f["odpt:toStation"]
        if frm not in zone_of or to not in zone_of:
            continue
        fid = f"ykf{i}"
        fare_attrs.append({"fare_id": fid, "price": int(f["odpt:ticketFare"]),
                           "currency_type": "JPY", "payment_method": 0,
                           "transfers": None})
        fare_rules.append({"fare_id": fid, "route_id": "",
                           "origin_id": zone_of[frm], "destination_id": zone_of[to]})
    rep["fare_rules"] = len(fare_rules)

    rt = railway.get("odpt:railwayTitle")
    route_long = rt.get("ja", "") if isinstance(rt, dict) else "ゆりかもめ"
    doc = base_doc(
        {"agency_id": "odpt", "agency_name": "ゆりかもめ",
         "agency_url": "https://www.yurikamome.co.jp/",
         "agency_timezone": "Asia/Tokyo", "agency_lang": "ja"},
        start, end)
    doc["stops"] = [{"stop_id": s, "stop_name": st_name[s],
                     "stop_lat": st_geo[s][0], "stop_lon": st_geo[s][1],
                     "zone_id": zone_of[s]} for s in line if s in st_geo]
    doc["routes"] = [{"route_id": route_id, "agency_id": "odpt",
                      "route_short_name": "ゆりかもめ",
                      "route_long_name": route_long, "route_type": 2}]
    doc["services"] = services_doc(["weekday", "saturday_holiday"], start, end)
    doc["trips"] = trips
    doc["fares"] = {"attributes": fare_attrs, "rules": fare_rules}
    rep["trips"] = len(trips)
    rep["stop_times"] = n_entries
    rep["service_window"] = [start, end]
    rep["service_date_exceptions"] = {
        svc["service_id"]: {"added": len(svc["added_dates"]),
                            "removed": len(svc["removed_dates"])}
        for svc in doc["services"]}
    return doc, rep


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_dir")
    ap.add_argument("--report", default="")
    ap.add_argument("--cache-dir", default="")
    ap.add_argument("--offline", action="store_true",
                    help="API に触らずキャッシュだけで組み立てる")
    ap.add_argument("--operators", default="tokyubus,yurikamome")
    args = ap.parse_args()

    token = os.environ.get("ODPT_TOKEN", "")
    if not token and not args.offline:
        print("環境変数 ODPT_TOKEN が必要です", file=sys.stderr)
        return 1
    if args.offline:
        token = token or "offline"  # キャッシュ命中時は使われない

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = args.cache_dir or str(out_dir / ".odpt-cache")

    report = {}
    builders = {"tokyubus": (build_tokyubus, "odpt-tokyubus.json"),
                "yurikamome": (build_yurikamome, "odpt-yurikamome.json")}
    for op in args.operators.split(","):
        op = op.strip()
        if op not in builders:
            print(f"未知の事業者: {op}", file=sys.stderr)
            return 1
        fn, fname = builders[op]
        doc, rep = fn(token, cache_dir)
        path = out_dir / fname
        # 中間データなので整形せず詰めて書く (停留所 URI の繰り返しが嵩む)
        path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        rep["file"] = fname
        rep["json_bytes"] = path.stat().st_size
        report[op] = rep

    text = json.dumps(report, ensure_ascii=False, indent=1)
    print(text)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
