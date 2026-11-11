# -*- coding: utf-8 -*-
"""駅の情報欄から、JR の路線網（駅のつながりと営業キロ）を作る。

    python3 tools/build_rail_graph.py            確認だけ（数と、合わなかったものを出す）
    python3 tools/build_rail_graph.py --write    packages/core/rail/jr-graph.json に書く
    python3 tools/build_rail_graph.py --why 鶴見  その駅まわりの読み取りを見る

最長片道切符のソルバー（Issue #431、solver/longest-ticket/）に渡す路線網です。
素データは tools/fetch_rail_stations.py が落とします（data/rail-raw/pages.jsonl）。

## どう作るか

駅の記事の情報欄には、路線ごとに「前の駅・そこまでの営業キロ・次の駅・そこまでの
営業キロ」が書いてあります。これを駅ぜんぶで集めると、「A のとなりは B で 2.1km」
という申告が、**両側から1つずつ**出てきます。

1. **両側の申告が合ったものを辺にする。** A が「となりは B、2.1km」と言い、
   B も「となりは A、2.1km」と言っていれば採ります。食い違ったときは、
   情報欄のキロ程（起点からの距離）の差で決めます。片側だけの申告は、
   相手の駅が路線網にあって、ほかの会社の線でないときだけ採ります
   （残りは --lonely で一覧に出ます）。廃止された駅・まだ開業していない駅
   （「2028年予定」など）の情報欄は読みません
2. **JR の旅客の線だけを残す。** 情報欄の「所属事業者」が JR の旅客会社だけの
   駅どうしを結ぶ辺を採ります。私鉄や第三セクターと同じ欄に入っている駅は、
   路線の記事の運営者を見て決めます
3. **同じ線路を二重に数えない。** 首都圏や関西の情報欄は、運転系統の名前
   （京浜東北線・湘南新宿ライン・JR神戸線…）で書かれています。快速が通過する
   駅を飛ばした「東京―新橋 1.9km」は、「東京―有楽町―新橋」と同じ線路です。
   **ほかの辺をつないだ道のりと営業キロがぴったり同じ辺は、同じ線路として落とします**
4. **新幹線は、決まりどおりに扱う。** 並行する在来線と営業キロが同じ区間は
   同じ線として落ちます（3. と同じ仕組みです）。新幹線にしかない駅をはさむ区間
   （品川―新横浜―小田原 など）は、その駅で乗り換えるときだけ別の線として
   使えるので、「通り抜け禁止」の印を付けて残します

人の手で決めたことは、下の PATCHES に、理由と一緒にぜんぶ書いてあります。

出典: 日本語版ウィキペディア（CC BY-SA 4.0）の各駅の記事。
"""
import heapq
import json
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
RAW = os.path.join(WEB, "data", "rail-raw", "pages.jsonl")
OUT = os.path.join(WEB, "packages", "core", "rail", "jr-graph.json")

JR = ["北海道旅客鉄道", "東日本旅客鉄道", "東海旅客鉄道", "西日本旅客鉄道",
      "四国旅客鉄道", "九州旅客鉄道"]
JR_SHORT = ["JR北海道", "JR東日本", "JR東海", "JR西日本", "JR四国", "JR九州"]
# 旅客の駅ではないもの。
NOT_STATION = re.compile(r"貨物|信号場|操車場|車両基地|運転所|車両センター")
# JR 以外の会社の線（駅の情報欄で、JR の線と見誤りやすいもの）。
OTHER_OPERATOR = re.compile(r"メトロ|近鉄|名鉄|東武|京急|相鉄|鉄道|鐵道|電鐵|電鉄|交通事業|IGR|ハピライン|"
                            r"いさりび|トキめき|青い森|しなの|アルピコ|急行|いわて銀河|リアス")
# 鉄道の旅客の線ではないもの（バス転換・船・貨物）。
NOT_RAIL = re.compile(r"BRT|航路|フェリー|貨物|バス")
EPS = 0.051
# この年より後の「予定」は、まだ先のこととみなします（配布ファイルの年）。
AS_OF_YEAR = 2026


# ---------------------------------------------------------------------------
#  情報欄を読む
# ---------------------------------------------------------------------------

def strip_noise(text):
    """注釈・脚注を消します（<!-- -->、<ref>、{{Refnest}}、{{Efn}}）。"""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    # 中身の無い <ref name="a/b" /> を先に消します（名前に / が入ることがあります。
    # ここで取りこぼすと、次の行が、ずっと先の </ref> までを消してしまいます）。
    text = re.sub(r"<ref\b[^>]*?/\s*>", "", text)
    text = re.sub(r"<ref\b.*?</ref>", "", text, flags=re.S)
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith("{{", i):
            name = text[i + 2:i + 12].lower()
            depth, j = 0, i
            while j < n:
                if text.startswith("{{", j):
                    depth += 1
                    j += 2
                elif text.startswith("}}", j):
                    depth -= 1
                    j += 2
                    if depth == 0:
                        break
                else:
                    j += 1
            if name.startswith(("refnest", "efn", "color", "sfn", "r|", "要出典", "#tag")):
                i = j
                continue
            out.append(text[i:j])
            i = j
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def params(box):
    """{{駅情報 |鍵 = 値 |…}} を、いちばん外側の | で切ります。"""
    body = box[2:-2] if box.endswith("}}") else box[2:]
    parts, depth, cur, i = [], 0, [], 0
    while i < len(body):
        two = body[i:i + 2]
        if two in ("{{", "[["):
            depth += 1
            cur.append(two)
            i += 2
        elif two in ("}}", "]]"):
            depth -= 1
            cur.append(two)
            i += 2
        elif body[i] == "|" and depth == 0:
            parts.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(body[i])
            i += 1
    parts.append("".join(cur))
    out = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k.strip()] = v.strip()
    return out


LINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]")


def first_link(value):
    m = LINK.search(value)
    return m.group(1).replace("_", " ").strip() if m else None


STATION_TITLE = re.compile(r"駅(\s*[（(].*[）)])?$")


def station_link(value):
    """となりの駅の欄から、駅の記事へのリンクを取ります。

    欄には、信号場や支社の境（「この間に○○支社との境界あり」）へのリンクも
    混ざります。題が「駅」で終わるものだけを見ます。"""
    for m in LINK.finditer(value):
        t = m.group(1).replace("_", " ").strip()
        if STATION_TITLE.search(t) and not NOT_STATION.search(t):
            return t
    return None


def plain(value):
    """リンクや飾りを外した文字。"""
    v = LINK.sub(lambda m: m.group(2) or m.group(1), value)
    v = re.sub(r"\{\{[^{}]*\}\}", "", v)
    v = re.sub(r"<[^>]+>", " ", v)
    v = v.replace("&nbsp;", " ").replace("'''", "")
    return v.strip()


def station_name(value):
    """「JT 17 早川」「神田 JC 02」「(1.2 km) 八丁堀 JE 02」から、駅名だけを取ります。"""
    v = plain(value)
    v = re.sub(r"[（(][^）)]*[）)]", " ", v)
    v = re.sub(r"[A-Za-z]{1,3}[-‐]?[A-Za-z]?\s?\d{1,3}", " ", v)   # 駅番号
    v = re.sub(r"[A-Za-z0-9・\-\s.]+", " ", v).strip()
    v = v.split()[0] if v.split() else ""
    return re.sub(r"駅$", "", v)


def km_of(value):
    m = re.search(r"\d+(?:\.\d+)?", plain(value))
    return float(m.group(0)) if m else None


def base_name(title):
    return re.sub(r"駅$", "", re.sub(r"\s*[（(].*[）)]$", "", title))


def read_pages(path):
    stations, lines, redirects = {}, {}, {}
    for raw in open(path, encoding="utf-8"):
        d = json.loads(raw)
        if "redirect" in d:
            redirects[d["title"]] = d["redirect"]
            continue
        if d.get("line"):
            lines[d["title"]] = d["line"][0]
        if d.get("boxes"):
            stations[d["title"]] = d["boxes"]
    return stations, lines, redirects


def line_is_jr(title, lines, redirects, memo={}):
    """路線の記事の「運営者」が JR の旅客会社か。分からなければ None。"""
    if title in memo:
        return memo[title]
    t = redirects.get(title, title)
    box = lines.get(t)
    ans = None
    if box:
        p = params(box)
        who = " ".join(p.get(k, "") for k in ("運営者", "所有者", "第1種鉄道事業者", "運行者"))
        if who.strip():
            ans = any(j in who for j in JR + JR_SHORT)
    memo[title] = ans
    return ans


YEAR = re.compile(r"(1[89]\d\d|20\d\d)年")


def closed(p):
    """廃止された・まだ開業していない駅か。

    「廃止年月日」に何か書いてあっても、廃止されたとは限りません。
    * 「2027年4月1日（予定）」「未定」…まだ営業しています
    * 上三田駅の「1941年（初代）」…戦時中に一度廃止され、1948年に再開業しています
    いちばん新しい開業の年より後に廃止されていて、予定でないものだけを廃止とみなします。
    開業年月日の欄があって年が書かれていない駅（北海道新幹線の新小樽、中央新幹線の
    神奈川県駅など）は、まだ開業していないとみなします。
    """
    opened = p.get("開業年月日")
    if opened is not None:
        years = [int(y) for y in YEAR.findall(opened)]
        if not years or max(years) > AS_OF_YEAR or ("予定" in opened and max(years) >= AS_OF_YEAR):
            return True
    gone = p.get("廃止年月日", "").strip()
    if not gone or "予定" in gone or "未定" in gone:
        return False
    years_gone = [int(y) for y in YEAR.findall(gone)]
    years_open = [int(y) for y in YEAR.findall(opened or "")]
    if not years_gone:
        return False
    return not years_open or max(years_gone) >= max(years_open)


def claims_of(title, boxes, lines, redirects):
    """その駅の「となりは誰で、何 km」の申告。"""
    out = []
    for box in boxes:
        p = params(strip_noise(box))
        owner = p.get("所属事業者", "")
        has_jr = any(j in owner for j in JR)
        if not has_jr:
            continue
        # 廃止された駅・路線、まだ開業していない駅の情報欄は使いません
        # （幌内線の駅どうしも、申告は合ってしまいます）。
        if closed(p):
            continue
        # JR の旅客会社と JR 貨物だけなら、欄の線はぜんぶ JR。
        others = re.sub("|".join(JR + ["日本貨物鉄道"] + JR_SHORT + ["JR貨物"]), "", plain(owner))
        pure = not re.search(r"鉄道|電鉄|交通|モノレール|地下鉄|メトロ|市営|都営|バス|急行|軌道|電気|高速|ライン|\S線", others)
        idx = sorted({m.group(1) for k in p for m in [re.match(r"所属路線(\d*)$", k)] if m})
        for n in idx:
            label_raw = p.get(f"所属路線{n}", "")
            label = plain(label_raw)
            link = first_link(label_raw)
            if NOT_RAIL.search(label) or (link and NOT_RAIL.search(link)) \
                    or any(x in label for x in PATCHES["drop_lines"]):
                continue
            if pure:
                jr = True
            else:
                jr = line_is_jr(link, lines, redirects) if link else None
                if jr is None:
                    jr = "JR" in label or any(j in label for j in JR)
            if not jr:
                continue
            name = link or re.sub(r"[（(].*", "", label).strip()
            for side, gap in (("前の駅", "駅間A"), ("次の駅", "駅間B")):
                who = p.get(f"{side}{n}", "")
                d = km_of(p.get(f"{gap}{n}", ""))
                if not who.strip() or d is None or d <= 0:
                    continue
                target = station_link(who)
                out.append({"from": title, "to_title": target, "to_name": station_name(who),
                            "km": d, "line": name, "label": label,
                            "post": km_of(p.get(f"キロ程{n}", "")), "origin": plain(p.get(f"起点駅{n}", ""))})
    return out


# ---------------------------------------------------------------------------
#  人の手で決めたこと
# ---------------------------------------------------------------------------

# 情報欄からは読み取れない、または決まりで別扱いになるもの。
PATCHES = {
    # 新幹線と在来線を「同じ線」と数えない区間（旅客営業規則 第16条の2 に載っていない）。
    # 山陽新幹線の新下関―博多は JR西日本、並行する在来線は JR九州で、別の線です。
    # 営業キロが同じなので、何もしないと 3. の仕組みで落ちてしまいます。
    "independent": [
        ["新下関駅", "小倉駅 (福岡県)"],
        ["小倉駅 (福岡県)", "博多駅"],
    ],
    # 列車は止まらないが、運賃の計算ではその駅を通る扱いの区間。
    # 横須賀線（品鶴線）は鶴見で東海道本線に合流します。ホームが無いので
    # 情報欄では「新川崎のとなりは横浜」ですが、鶴見―横浜は東海道本線と同じ線路です。
    # [飛ばしている辺の両端, 実際に通る駅]。辺はその駅で2つに割り、その駅から先は
    # 既にある道のりと同じ長さとして割ります（あとの dedupe で、同じ線路の側は落ちます）。
    "via": [
        ["新川崎駅", "横浜駅", "鶴見駅"],
    ],
    # 足す辺 [駅, 駅, 営業キロ, 線]。情報欄からは出ないもの。
    # 羽沢横浜国大駅の JR の欄は「となりは武蔵小杉、16.6km」ですが、線路は鶴見で
    # 品鶴線に合流します。16.6 から武蔵小杉―鶴見（2.7＋新川崎―鶴見）を引いた長さです。
    "add": [
        ["鶴見駅", "羽沢横浜国大駅", "16.6-武蔵小杉駅-鶴見駅", "東海道本線"],
    ],
    # 両側の記事で距離が食い違い、キロ程でも決まらないもの [[駅, 駅], 営業キロ]。
    "km": [
        # 松島駅の欄は 0.3（東北本線と仙石線をつなぐ線）、高城町駅の欄は 10.3（塩釜から）。
        [["松島駅", "高城町駅"], 0.3],
    ],
    # 落とす線（旅客列車が走っていない）。ラベルの一部で選びます。
    #   海峡線: 中小国―木古内。2016年から旅客列車は走らず、青函トンネルは新幹線で通ります
    "drop_lines": ["海峡線"],
    # 落とす駅（旅客の営業が無い）。
    #   東小倉: 鹿児島本線の貨物の駅（旅客の扱いはありません）
    "drop_stations": ["東小倉駅"],
}


# ---------------------------------------------------------------------------
#  路線網に組み立てる
# ---------------------------------------------------------------------------

def build(stations, lines, redirects, log=print):
    names = defaultdict(list)
    for t in stations:
        if not NOT_STATION.search(t):
            names[base_name(t)].append(t)
    claims = []
    for t, boxes in stations.items():
        if NOT_STATION.search(t) or t in PATCHES["drop_stations"]:
            continue
        claims += claims_of(t, boxes, lines, redirects)

    def candidates(c):
        out = []
        t = c["to_title"]
        if t:
            t = redirects.get(t, t)
            out += [t] if t in stations else names.get(base_name(t), [])
        # リンクが注記のもの（「日暮里経由」など）のこともあるので、欄の文字からも探します。
        if not t or base_name(t) != c["to_name"]:
            out += [x for x in names.get(c["to_name"], []) if x not in out]
        return [x for x in out if x != c["from"]]

    by_pair = defaultdict(list)     # (from, to) → 申告
    for c in claims:
        c["cands"] = candidates(c)
        for t in c["cands"]:
            by_pair[(c["from"], t)].append(c)

    edges = {}       # (a, b, km) → {"lines": set}
    used = set()
    for (a, b), cs in by_pair.items():
        if a >= b:
            continue
        back = by_pair.get((b, a), [])
        for c in cs:
            for r in back:
                if abs(c["km"] - r["km"]) < EPS:
                    key = (a, b, round(min(c["km"], r["km"]), 1))
                    e = edges.setdefault(key, {"lines": set()})
                    e["lines"].update([c["line"], r["line"]])
                    used.add(id(c))
                    used.add(id(r))
    lonely = [c for c in claims if id(c) not in used]

    # 両側の記事で、距離が食い違うもの（どちらかの書き誤り）。
    #
    # 与野駅の欄は、前の駅と次の駅の距離が入れ替わっています（北浦和 1.1・さいたま新都心 1.6。
    # 正しくは逆）。こういうときは、両方の駅の「キロ程」（起点からの距離）の差を見て、
    # 差と同じほうを採ります。差でも決まらないものは、PATCHES["km"] に人が書きます。
    def add(a, b, km, *cs):
        key = (min(a, b), max(a, b), round(km, 1))
        edges.setdefault(key, {"lines": set()})["lines"].update(c["line"] for c in cs)
        for c in cs:
            used.add(id(c))

    fixed = {tuple(sorted(k)): v for k, v in PATCHES["km"]}
    for c in lonely:
        if id(c) in used:
            continue
        for r in lonely:
            if id(r) in used or r is c or r["from"] not in c["cands"] or c["from"] not in r["cands"]:
                continue
            pair = tuple(sorted((c["from"], r["from"])))
            if pair in fixed:
                add(*pair, fixed[pair], c, r)
                break
            # 起点駅の欄が空のことも多い（「304.7 km（神戸起点）」のように、キロ程の欄に書く）。
            same_origin = c["origin"] == r["origin"] or not c["origin"] or not r["origin"]
            if c["post"] is not None and r["post"] is not None and same_origin:
                gap = round(abs(c["post"] - r["post"]), 1)
                if abs(gap - c["km"]) < EPS or abs(gap - r["km"]) < EPS:
                    add(c["from"], r["from"], gap, c, r)
                    log(f"  キロ程で決めました: {c['from']}―{r['from']} {c['km']} / {r['km']} → {gap}")
                    break
    lonely = [c for c in claims if id(c) not in used]

    # 片側の記事にしか書かれていない区間（名古屋駅の欄に中央本線が無い、など）。
    # 相手の駅がほかの JR の線で路線網に入っていて、JR 以外の会社の線でなければ採ります。
    # 急行が止まらない駅を飛ばした辺がまぎれても、あとの dedupe が落とします。
    inside = {x for k in edges for x in k[:2]}
    seen_one = set()
    for c in lonely:
        if OTHER_OPERATOR.search(c["label"]) or c["from"] in PATCHES["drop_stations"]:
            continue
        hit = [t for t in c["cands"] if t in inside and t not in PATCHES["drop_stations"]]
        if len(hit) != 1:
            continue
        key = (min(c["from"], hit[0]), max(c["from"], hit[0]), round(c["km"], 1))
        if key not in seen_one:
            seen_one.add(key)
            add(c["from"], hit[0], c["km"], c)
            log(f"  片側の申告を採りました: {c['from']} → {hit[0]} {c['km']}（{c['label'][:20]}）")
        used.add(id(c))
    lonely = [c for c in claims if id(c) not in used]

    # 列車が止まらない駅（ホームが無い）をはさむ区間。
    #
    # 尾久の欄は「となりは上野、4.8km」、上野の欄も「となりは尾久、4.8km」ですが、
    # 線路は日暮里で分かれます（上野―日暮里は山手線と同じ線路）。日暮里の欄には
    # 「上野 2.2km・尾久 2.6km」と書いてあり、足すと 4.8km です。このように、
    # **両どなりへの申告を足すと既にある辺の長さになる駅**は、その辺の途中にあります。
    # 辺を2つに割ります。
    by_from = defaultdict(list)
    for c in claims:
        by_from[c["from"]].append(c)
    splits = []
    for m, cs in by_from.items():
        for i, c1 in enumerate(cs):
            for c2 in cs[i + 1:]:
                # 同じ路線の欄の前後で、少なくとも片方がまだ合っていないもの。
                if c1["label"] != c2["label"] or (id(c1) in used and id(c2) in used):
                    continue
                for a in c1["cands"]:
                    for b in c2["cands"]:
                        key = (min(a, b), max(a, b), round(c1["km"] + c2["km"], 1))
                        if a != b and key in edges:
                            splits.append((key, m, a, c1, b, c2))
    for key, m, a, c1, b, c2 in splits:
        if key not in edges:
            continue
        e = edges.pop(key)
        for x, c in ((a, c1), (b, c2)):
            k = (min(m, x), max(m, x), round(c["km"], 1))
            edges.setdefault(k, {"lines": set()})["lines"].update(e["lines"] | {c["line"]})
            used.add(id(c))
        log(f"  途中の駅で割りました: {key[0]}―{key[1]} {key[2]}km → {m} で {c1['km']} + {c2['km']}")
    lonely = [c for c in claims if id(c) not in used]
    return claims, edges, lonely


def apply_patches(edges, log=print):
    """PATCHES の via と add を当てます（build のあと、dedupe の前）。"""
    for a, b, via in PATCHES["via"]:
        key = next((k for k in edges if {k[0], k[1]} == {a, b}), None)
        if key is None:
            raise SystemExit(f"PATCHES の via: {a}―{b} の辺がありません")
        rest = shortest(adjacency(edges), via, b, {key}, key[2])
        if rest is None:
            raise SystemExit(f"PATCHES の via: {via} から {b} への道がありません")
        e = edges.pop(key)
        first = round(key[2] - rest, 1)
        edges.setdefault((min(a, via), max(a, via), first), {"lines": set()})["lines"].update(e["lines"])
        edges.setdefault((min(via, b), max(via, b), round(rest, 1)), {"lines": set()})["lines"].update(e["lines"])
        log(f"  {a}―{b} {key[2]}km を {via} で割りました（{first} + {round(rest, 1)}）")
    for a, b, km, line in PATCHES["add"]:
        if isinstance(km, str):
            total, x, y = km.split("-")
            d = shortest(adjacency(edges), x, y, set(), 1e9)
            km = round(float(total) - d, 1)
        edges.setdefault((min(a, b), max(a, b), km), {"lines": set()})["lines"].add(line)
        log(f"  足しました: {a}―{b} {km}km（{line}）")


def adjacency(edges):
    adj = defaultdict(list)
    for (a, b, km), e in edges.items():
        adj[a].append((b, km, (a, b, km)))
        adj[b].append((a, km, (a, b, km)))
    return adj


def shortest(adj, src, dst, skip, cap):
    """skip の辺を使わない、src から dst までの最短の道のり（cap を超えたら None）。"""
    dist = {src: 0.0}
    heap = [(0.0, src)]
    while heap:
        d, x = heapq.heappop(heap)
        if x == dst:
            return d
        if d > dist.get(x, 1e18) or d > cap:
            continue
        for y, w, key in adj[x]:
            if key in skip:
                continue
            nd = d + w
            if nd < dist.get(y, 1e18) and nd <= cap:
                dist[y] = nd
                heapq.heappush(heap, (nd, y))
    return None


# 秋田・山形新幹線は、在来線（田沢湖線・奥羽本線）を新幹線の車両が走る区間です。
# 決まりの上では在来線なので、新幹線には数えません。
MINI = ("秋田新幹線", "山形新幹線")


def is_shinkansen(e):
    return all("新幹線" in l and not any(m in l for m in MINI) for l in e["lines"])


def dedupe(edges, log=print):
    """同じ線路を表す辺を落とします（長い辺から順に、ほかの道のりと同じ長さなら落とす）。"""
    keep = {tuple(sorted(p)) for p in PATCHES["independent"]}
    adj = adjacency(edges)
    dropped = {}
    for key in sorted(edges, key=lambda k: -k[2]):
        a, b, km = key
        if tuple(sorted((a, b))) in keep and is_shinkansen(edges[key]):
            continue
        d = shortest(adj, a, b, set(dropped) | {key}, km + 0.11)
        if d is not None and abs(d - km) < 0.11:
            dropped[key] = d
    for key in dropped:
        del edges[key]
    return dropped


def shinkansen_sections(edges, log=print):
    """新幹線にしかない駅をはさむ区間を、決まりどおりに直します。

    dedupe のあとに残る新幹線の辺は、2種類です。

    * **並行する在来線が無い区間**（盛岡―新青森、北陸新幹線、西九州新幹線…）。
      そのまま、ふつうの線として残します
    * **在来線と同じ線として数える区間のうち、新幹線にしかない駅をはさむところ**
      （品川―新横浜―小田原 など）。両端の駅の間の営業キロが在来線と同じなので、
      それで見分けます。決まり（旅客営業規則 第16条の2）では、はさまれた駅で
      乗り降り・乗り換えをするときだけ、在来線とは別の線として使えます。
      通り抜けるだけなら在来線と同じ線です

    後者は、こう直します。

    * はさまれた駅にほかの JR の線が来ている（新横浜・古川・新花巻・燕三条・新鳥栖）
      → 両端からその駅までの辺を残し、**その駅を通り抜けてはいけない**印を付ける
    * 来ていない（新富士・岐阜羽島・新神戸…）→ 乗り換えられないので、辺ごと落とす
      （そこで旅を始める・終える経路だけが出せなくなります）
    """
    independent = {tuple(sorted(p)) for p in PATCHES["independent"]}
    shin = {k for k, e in edges.items() if is_shinkansen(e) and tuple(sorted(k[:2])) not in independent}
    conv = adjacency({k: e for k, e in edges.items() if k not in shin})
    # 新幹線の線ごとに見ます（高崎で上越と北陸が分かれるので、まとめては見られません）。
    sadj = defaultdict(list)
    for k in shin:
        name = sorted(edges[k]["lines"])[0]
        sadj[(name, k[0])].append(((name, k[1]), k))
        sadj[(name, k[1])].append(((name, k[0]), k))
    seen, sections, forbid = set(), [], []
    for start in sorted(sadj):
        if start in seen or len(sadj[start]) != 1:
            continue
        # 端から順にたどる（1つの線の、新幹線だけの部分は、1本の道になっています）。
        path, keys, x, prev = [start[1]], [], start, None
        while True:
            seen.add(x)
            nxt = [(y, k) for y, k in sadj[x] if k != prev]
            if not nxt:
                break
            if len(nxt) > 1:
                raise SystemExit(f"{x[0]} の辺が {x[1]} で分かれています。PATCHES で直してください。")
            y, k = nxt[0]
            path.append(y[1])
            keys.append(k)
            x, prev = y, k
        pre = [0.0]
        for k in keys:
            pre.append(pre[-1] + k[2])
        i = 0
        while i < len(path) - 1:
            hit = None
            for j in range(i + 1, len(path)):
                want = pre[j] - pre[i]
                d = shortest(conv, path[i], path[j], set(), want + 0.11)
                if d is not None and abs(d - want) < 0.11:
                    hit = j
                    break
            if hit is None:
                i += 1
                continue
            inner = path[i + 1:hit]
            transfer = [x for x in inner if conv.get(x)]
            line = sorted(edges[keys[i]]["lines"])[0]
            for k in keys[i:hit]:
                del edges[k]
            if len(transfer) > 1:
                raise SystemExit(f"{path[i]}―{path[hit]} に乗り換え駅が2つあります: {transfer}")
            if transfer:
                x = transfer[0]
                at = path.index(x)
                ka = (min(path[i], x), max(path[i], x), round(pre[at] - pre[i], 1))
                kb = (min(path[hit], x), max(path[hit], x), round(pre[hit] - pre[at], 1))
                edges[ka] = {"lines": {line}}
                edges[kb] = {"lines": {line}}
                forbid.append((x, ka, kb))
            sections.append((path[i], inner, path[hit], transfer))
            i = hit
    for a, inner, b, transfer in sections:
        log(f"  同じ線の区間: {base_name(a)}―{base_name(b)}（{'・'.join(base_name(x) for x in inner)}）"
            + (f" 乗り換えは {base_name(transfer[0])}" if transfer else " 乗り換えなし"))
    return sections, forbid


SERVICE = re.compile(r"ライン|快速|緩行|各駅|・|JR|線 \(")


def line_name(names):
    """辺に付ける線の名前を1つ選びます（「○○本線」など、正式な名前に近いものを先に）。"""
    def rank(n):
        n2 = re.sub(r"\s*\(.*\)$", "", n)
        return (0 if n2.endswith("本線") else 1 if n2.endswith("線") and not SERVICE.search(n) else 2, len(n2), n2)
    best = min(names, key=rank)
    return re.sub(r"\s*\(.*\)$", "", best)


def components(edges):
    adj = adjacency(edges)
    seen, out = set(), []
    for s in adj:
        if s in seen:
            continue
        stack, comp = [s], []
        seen.add(s)
        while stack:
            x = stack.pop()
            comp.append(x)
            for y, _, _ in adj[x]:
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        out.append(comp)
    return sorted(out, key=len, reverse=True)


def to_json(edges, forbid, as_of, isolated=()):
    titles = sorted({x for k in edges for x in k[:2]})
    index = {t: i for i, t in enumerate(titles)}
    lines, line_index = [], {}
    keys = sorted(edges)
    rows = []
    for k in keys:
        n = line_name(edges[k]["lines"])
        if n not in line_index:
            line_index[n] = len(lines)
            lines.append(n)
        rows.append([index[k[0]], index[k[1]], round(k[2] * 10), line_index[n]])
    at = {k: i for i, k in enumerate(keys)}
    return {
        "asOf": as_of,
        "source": "日本語版ウィキペディアの各駅の記事（駅情報の「前の駅・次の駅・駅間の営業キロ」）",
        "license": "CC BY-SA 4.0",
        "attribution": "© ウィキペディアの執筆者（CC BY-SA 4.0）",
        "tool": "tools/build_rail_graph.py",
        "unit": "edges の3つめは営業キロの10倍（0.1km 単位の整数）",
        "stations": [t.replace("駅", "", 1) if t.endswith("駅") else re.sub(r"駅(\s*\()", r"\1", t) for t in titles],
        "lines": lines,
        "edges": rows,
        "forbid": [[index[x], at[a], at[b]] for x, a, b in forbid],
        "isolated": list(isolated),
    }


def main(argv):
    path = RAW if os.path.exists(RAW) else RAW + ".part"
    stations, lines, redirects = read_pages(path)
    quiet = "--why" in argv
    claims, edges, lonely = build(stations, lines, redirects, log=(lambda *_: None) if quiet else print)
    print(f"駅の記事 {len(stations)}件・路線の記事 {len(lines)}件・転送 {len(redirects)}件")
    print(f"JR の申告 {len(claims)}件 → 両側が合った辺 {len(edges)}本、合わなかった申告 {len(lonely)}件")
    if "--why" in argv:
        q = argv[argv.index("--why") + 1]
        for c in claims:
            if q in c["from"] or q in (c["to_title"] or "") or q == c["to_name"]:
                print("  ", "×" if any(c is l for l in lonely) else "○",
                      c["from"], "→", c["to_title"] or c["to_name"], c["km"], c["label"])
        return
    apply_patches(edges, log=(lambda *_: None) if quiet else print)
    dropped = dedupe(edges)
    print(f"同じ線路として落とした辺 {len(dropped)}本 → 残り {len(edges)}本")
    sections, forbid = shinkansen_sections(edges)
    print(f"新幹線と在来線を同じ線と数える区間 {len(sections)}か所（通り抜け禁止の駅 {len(forbid)}）")
    comps = components(edges)
    total = sum(k[2] for k in edges)
    print(f"駅 {sum(len(c) for c in comps)}・辺 {len(edges)}本・合計 {total:.1f}km・つながり {len(comps)}個")
    # ほかの JR の線とつながっていない線（越美北線・七尾線・大湊線など。まわりの区間が
    # 第三セクターに移ったもの）は、乗り継いで1枚の切符にできないので外します。
    isolated = []
    for c in comps[1:]:
        cs = set(c)
        names = sorted({line_name(e["lines"]) for k, e in edges.items() if k[0] in cs})
        km = sum(k[2] for k in edges if k[0] in cs)
        isolated.append({"lines": names, "stations": len(c), "km": round(km, 1)})
        print(f"  離れた部分（{len(c)}駅・{km:.1f}km）: {'・'.join(names)}")
        for k in [k for k in edges if k[0] in cs]:
            del edges[k]
    if "--lonely" in argv:
        for c in sorted(lonely, key=lambda c: c["from"]):
            print("  ×", c["from"], "→", c["to_title"] or c["to_name"], c["km"], c["label"])
    if "--dropped" in argv:
        for k, d in sorted(dropped.items()):
            print("  同じ線路:", k[0], "―", k[1], k[2], "/".join(sorted(edges.get(k, {}).get("lines", []))))
    if "--write" in argv:
        as_of = max((b.get("at") or "") for b in map(json.loads, open(path, encoding="utf-8")))[:10]
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(to_json(edges, forbid, as_of, isolated), f, ensure_ascii=False, separators=(",", ":"))
        print(f"書きました: {os.path.relpath(OUT, WEB)}（{os.path.getsize(OUT) // 1024}KB）")


if __name__ == "__main__":
    main(sys.argv[1:])
