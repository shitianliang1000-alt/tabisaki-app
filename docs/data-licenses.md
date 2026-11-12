# ライセンスと外部データ

プログラムのライセンスと、収録データ・外部サービスそれぞれの条件です。公開・再配布の前に読んでください。

**プログラム本体のライセンスは [PolyForm Noncommercial License 1.0.0](../LICENSE) です。商用利用はできません。**
個人の利用・学習・研究・趣味の改変や、非営利の団体での利用はできます（くわしい範囲は LICENSE の「Noncommercial Purposes」）。

| 対象 | 条件 |
|---|---|
| プログラム（`js/`・`server/`・`php/`・`packages/`・`tools/` など）と、このリポジトリで書いた文書 | PolyForm Noncommercial 1.0.0 |
| 2026-10-27 より前に公開した版 | The Unlicense のまま（すでに配ったぶんは取り消せません） |
| 収録データ（`kb/`）のうち、外から取り込んだ部分 | **それぞれの提供元の条件**（下の表と [credits.html](../credits.html)）。たとえば OpenStreetMap 由来は ODbL、Wikipedia の文は CC BY-SA |
| 同梱の部品（`vendor/` の Leaflet・フォントなど） | それぞれのライセンス（BSD 2-Clause、SIL OFL 1.1 など） |

外部データ・API の条件は、本体のライセンスとは別に、提供元ごとに決まっています（以下）。本体を非商用にしても、外部データの条件がゆるくなったり、きびしくなったりはしません。

このリポジトリで利用している地図・外部データ・APIには、それぞれ提供元の利用規約・ライセンスがあります。

公開・再配布の前に、各サービスの最新の規約を確認してください。特に `kb/index.json` に記載されている外部データソースは、それぞれ利用条件が異なります。

収録の1件1件について「どの項目がどこから来たか」を機械で追う仕組みと、出典が自動で付く出力の一覧は **[data-provenance.md](./data-provenance.md)** にあります（`node tools/kb_provenance.mjs` で点検できます）。

画面から見られる一覧は **[credits.html](../credits.html)**（条件の画面の下のリンク）です。
データや外部サービスを足した・外したときは、そこも直してください。

## 手元で足す情報（tabisaki spot）

`./tabisaki spot enrich` は Wikidata（CC0 1.0）から別名を、Wikimedia Commons から写真の URL と作者・ライセンスを取ります。
写真はファイルを保存せず URL で指すだけで、ライセンスが読めない写真は入れません。取った値は利用者の手元（`~/.tabisaki/`）にだけ入り、
`kb/` には入りません。Yahoo! のデータ・API は使いません。くわしくは [spot-data.md](./spot-data.md)。

## 気象庁の注意報・警報（その場で取るもの）

今日・明日の旅の行き先に出ている注意報・警報は、ブラウザから気象庁の
`https://www.jma.go.jp/bosai/warning/data/r8/map.json` を1回取って調べます（`packages/core/src/alerts.js`）。
保存も再配布もせず、画面には「気象庁「気象警報・注意報」を加工して作成」と出します
（[公共データ利用規約 第1.0版](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)）。
予報区の名前の表（`packages/core/src/jma-areas.js`）は、同じく気象庁の `area.json` から
`tools/build_jma_areas.mjs` で作ります。

## 国土数値情報

国土数値情報は、データごとに使用許諾条件が違います。**鉄道（N02、2008年度版）は商用可、観光資源（P12）・文化施設（P27）・バス停留所（P11）は非商用**です
（2026-11-03 に公式ページで確認）。データごとの条件、出典の書きかた、事務局に聞くことは **[kokudo-licenses.md](./kokudo-licenses.md)** にまとめました。

非商用のデータは、利用規約（<https://nlftp.mlit.go.jp/ksj/other/agreement_02.html>）で**複製物の再配布ができず**、データベースの形で使う場合は
運営事務局への相談が求められています。方針として、**これらの JSON は公開しません**（2026-11-03 持ち主）。2026-11-04 に `kb/` から外し、手元の `kb-private/` に移しました（Git の履歴には残っています）。くわしくは [kokudo-licenses.md](./kokudo-licenses.md#いまの公開状況)。
出典と「加工して作成」の表記は [credits.html](../credits.html) に入れてあります。
外すときは、観光資源が `src="kokudo"`、文化施設が `dataSource` に「文化施設」、バス停が `kb/stops-bus*` です。

PHP 版の zip（`tools/build_php.sh`）は、これらを外した `kb/` で組み立てます
（`tools/strip_noncommercial.mjs`。スポット約1.3万件・バス停がすべて抜けます）。
リポジトリの `kb/` と Cloudflare 版は、まだそのままです。

## 最長片道切符の路線網（JR の駅のつながりと営業キロ）

`packages/core/rail/jr-graph.json` は、日本語版ウィキペディアの各駅の記事の情報欄
（となりの駅・駅間の営業キロ）から `tools/build_rail_graph.py` で作ったデータです。
**CC BY-SA 4.0 です。** 表示は「© ウィキペディアの執筆者（CC BY-SA 4.0）」で、ファイルの
`attribution` にも入れてあります。配るときは同じ条件で配ります。

- Node.js のソルバー（Issue #431）だけが読みます。サイト・PHP 版・アプリには入れていません
- 素データ（`data/rail-raw/`）はリポジトリに入れていません（`tools/fetch_rail_stations.py` で作り直せます）

くわしくは [longest-ticket.md](./longest-ticket.md)。

## OpenStreetMap から足した営業時間・電話・サイト・車いすの可否

`tools/osm_enrich.py` が、収録にある場所へ `osmInfo` という入れ物を足します
（営業時間・電話・公式サイト・車いすの可否・料金の有無。元の番号は `osmInfo.ref`）。
**OpenStreetMap のデータで、ODbL 1.0 です。** 条件は下の「座標」と同じです
（「© OpenStreetMap contributors」の表示、同じ条件での共有）。

- 出どころごとに項目を分けてあります。収録のほかの項目（名前・座標・分類・説明）には触りません
- まとめて外すときは、`osmInfo` を消すだけです（道具は走らせるたびに前回のぶんを付け替えます）
- Overpass API は使いません。配布ファイルを手元で読みます

くわしくは [osm-enrich.md](./osm-enrich.md)。

## OpenStreetMap 由来の座標

`tools/import_osm_tourlist.py` が入れた座標（`src="osm-tourlist"`、元の番号は
`osm="node/123"`）は、**OpenStreetMap のデータで、ODbL 1.0 です**。

- **「© OpenStreetMap contributors」の表示が必須です。** 著作権表記の
  ページ（`credits.html`、画面の下のリンク）に出しています。消さないでください
- **同じ条件で共有する義務があります**（share-alike）。これらの座標を含む
  `kb/` は、ODbL の派生データベースにあたります。再配布するときは、その部分
  を ODbL で共有してください
- まとめて外すときは、`src="osm-tourlist"` の印で消えます
  （`python3 tools/import_osm_tourlist.py` は走らせるたびに前回のぶんを取り除きます）

ライセンスの全文: <https://opendatacommons.org/licenses/odbl/1-0/>

## 座標つきの観光地一覧

`tools/import_tourism_coords.py` が入れたもの（`src="tourlist-geocoded"`）は、
いただいた一覧の座標です。

- **Yahoo! JAPAN の API で取った座標が9割です。** 著作権表記のページに「Web Services by
  Yahoo! JAPAN」を出しています。**取った座標を保存して配ってよいかは、
  Yahoo! の利用規約を確かめていません。** 公開の前に確かめてください。
  外すときは `src="tourlist-geocoded"`（取得元ごとなら `geo`）の印で消えます
- 祭りなどの追加表記は外して入れました（`listedAs` に一覧の名前が残ります）
- 一覧の県の外に落ちた座標は、県境から15km以内だけを採りました。それより
  遠いもの（約2,000件）は、別の県の同じ名前に当たった疑いが強いので入れて
  いません（鳥取県「長谷寺」→ 広島県の長谷寺 など）
- 一覧の「まとめ名」の列は使っていません。別々の場所が1つにまとまっていた
  り（「徳島県立」）、座標がメンバーの平均だったりしたためです

## 県が食い違う座標

一覧の県と、座標のある県が違うものがあります（名前が全国で1つだけの場所など）。
ご指示で入れていますが、**別の場所を取り違えている可能性が、県が合うものより高いです。**
一覧の県は `listedIn` に残してあります。見直すときは、`listedIn` があるものから見てください。
