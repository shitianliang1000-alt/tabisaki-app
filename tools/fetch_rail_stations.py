# -*- coding: utf-8 -*-
"""駅の記事から、駅の情報欄（{{駅情報}}）を集める。

    python3 tools/fetch_rail_stations.py            配布ファイルを流しながら読む（約25分）
    python3 tools/fetch_rail_stations.py FILE.bz2   手元に落としてあるファイルを読む

最長片道切符のソルバー（Issue #431、solver/longest-ticket/）が使う
路線網の**素データ**です。日本語版ウィキペディアの駅の記事には、
となりの駅と、そこまでの営業キロが、決まった欄に書かれています
（前の駅・駅間A・駅間B・次の駅・キロ程）。これを駅ぜんぶで集めると、
駅と駅のつながりと距離が手に入ります。

## なぜ API ではなく配布ファイルなのか

はじめは API に50駅ずつ聞くつもりでした。ところが、この環境の出口からは
**1回目から 429（多すぎ）で断られ、10分待っても通りませんでした**
（共用の回線なので、ほかの人のぶんも合わせて数えられます）。

まとめて読むときは配布ファイル（dumps.wikimedia.org）を使うのが、
ウィキメディアの決まりでもあります。日本語版の全記事で 4.9GB あり、
毎秒5MBほどで流れてきます。**手元には置かず、流しながら駅の記事だけを
抜き出します**（残るのは 40MB ほどです）。

落としたものは data/rail-raw/ に置きます（.gitignore 済み。走らせ直せば
また作れます）。路線網に直すのは tools/build_rail_graph.py です。

出典: 日本語版ウィキペディア（CC BY-SA 4.0）。
"""
import html
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
OUT = os.path.join(WEB, "data", "rail-raw")

DUMP = "https://dumps.wikimedia.org/jawiki/latest/jawiki-latest-pages-articles-multistream.xml.bz2"
UA = ("tabisaki-kb/1.0 (https://github.com/shitianliang1000-alt/"
      "tabisaki.github.io; rail graph build)")
MARK = "{{駅情報"
# 路線の記事の情報欄。路線を運営している会社（JR かどうか）を見るのに使います。
LINE_MARK = "{{Infobox 鉄道路線"


def infoboxes(text, mark=MARK):
    """記事の中の {{駅情報 …}} を、かっこの対応を数えて切り出します。"""
    out = []
    i = 0
    while True:
        i = text.find(mark, i)
        if i < 0:
            return out
        depth, j = 0, i
        while j < len(text):
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
        out.append(text[i:j])
        i = j


def pages(stream):
    """XML を1行ずつ読んで、(題, 本文, 時刻) を返します。

    配布ファイルの XML は、<title>・<timestamp>・<text> がそれぞれ行の頭から
    始まる、決まった形です。XML の部品は使わず、行で読みます（20GB を
    木に組み立てると、記憶が足りません）。"""
    title, stamp, buf, ns = None, None, None, None
    for raw in stream:
        line = raw.decode("utf-8", "replace")
        if buf is not None:
            end = line.find("</text>")
            if end >= 0:
                buf.append(line[:end])
                yield title, ns, html.unescape("".join(buf)), stamp
                buf = None
            else:
                buf.append(line)
            continue
        s = line.lstrip()
        if s.startswith("<title>"):
            title = html.unescape(s[7:s.rfind("</title>")])
        elif s.startswith("<ns>"):
            ns = s[4:s.find("</ns>")]
        elif s.startswith("<timestamp>"):
            stamp = s[11:s.find("</timestamp>")]
        elif s.startswith("<text"):
            start = s.find(">") + 1
            if s.rstrip().endswith("/>"):
                continue
            end = s.find("</text>")
            if end >= 0:
                yield title, ns, html.unescape(s[start:end]), stamp
            else:
                buf = [s[start:]]


def main(argv):
    os.makedirs(OUT, exist_ok=True)
    if argv:
        feed = None
        proc = subprocess.Popen(["bzcat", argv[0]], stdout=subprocess.PIPE, bufsize=1 << 20)
    else:
        feed = subprocess.Popen(["curl", "-sS", "-L", "--retry", "5", "-A", UA, DUMP],
                                stdout=subprocess.PIPE)
        proc = subprocess.Popen(["bzcat"], stdin=feed.stdout, stdout=subprocess.PIPE, bufsize=1 << 20)
        feed.stdout.close()
    tmp = os.path.join(OUT, "pages.jsonl.part")
    seen = kept = 0
    with open(tmp, "w", encoding="utf-8") as f:
        for title, ns, text, stamp in pages(proc.stdout):
            seen += 1
            if seen % 200000 == 0:
                print(f"  {seen}記事（駅 {kept}件）", flush=True)
            if ns != "0":
                continue
            # 転送（#REDIRECT / #転送）は、駅名の言い換えを解くのに使います。
            head = text[:200].lstrip()
            if head[:1] == "#" and "[[" in head and title.endswith("駅"):
                to = head[head.find("[[") + 2:head.find("]]")].split("|")[0].split("#")[0].strip()
                f.write(json.dumps({"title": title, "redirect": to}, ensure_ascii=False) + "\n")
                continue
            row = {"title": title, "at": stamp}
            if MARK in text:
                row["boxes"] = infoboxes(text)
            if LINE_MARK in text:
                row["line"] = infoboxes(text, LINE_MARK)[:1]
            if len(row) == 2:
                continue
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            kept += 1
    if proc.wait() != 0 or (feed is not None and feed.wait() != 0):
        raise SystemExit("配布ファイルを最後まで読めませんでした。もう一度走らせてください。")
    os.replace(tmp, os.path.join(OUT, "pages.jsonl"))
    print(f"終わりました。{seen}記事のうち、駅の情報欄があるもの {kept}件。")


if __name__ == "__main__":
    main(sys.argv[1:])
