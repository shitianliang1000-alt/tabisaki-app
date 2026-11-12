# データの出どころを、項目ごとに追う

収録の1件は、いくつもの出どころが混ざってできています。名前は県の観光サイトの一覧、座標は OpenStreetMap、説明はウィキペディア、分類と「定番か穴場か」は旅さきが付けたもの、というふうにです。出どころが違えばライセンスも違います。

ここでは、それを**機械で追えるようにした仕組み**を説明します（Issue #426）。それぞれのライセンスの中身は [data-licenses.md](./data-licenses.md) にあります。

- 決まりの本体は `packages/core/src/provenance.js`（通信なし。ブラウザでも Node.js でも同じに動きます）
- 点検と移行の道具は `tools/kb_provenance.mjs`
- 試験は `tests/provenance.test.js`（収録の全件で確かめます）

## 出どころの台帳

| 鍵 | 何か | ライセンス | 表記の義務 | 継承 |
| --- | --- | --- | --- | --- |
| `tabisaki_original` | 旅さきが付けた分類・定番/穴場・所要時間・手書きの説明 | PolyForm Noncommercial 1.0.0 | — | — |
| `wikipedia` | 説明、記事の題、記事の座標 | CC BY-SA 4.0 | あり | あり |
| `osm` | OpenStreetMap の座標、`osm`、`osmInfo`（営業時間・電話・サイト・車いす） | ODbL 1.0 | あり | あり |
| `wikidata` | 名前・座標・公式サイト・電話 | CC0 1.0 | なし | — |
| `overture` | Overture Maps の座標 | 1件ごと（CDLA-Permissive-2.0 / Apache-2.0） | あり | — |
| `yahoo` | Yahoo! のローカルサーチ・ジオコーダで引いた座標 | Yahoo! JAPAN の Web サービスの規約 | あり（クレジット） | — |
| `gsi` | 国土地理院の検索で引いた座標 | 国土地理院コンテンツ利用規約 | あり | — |
| `mlit_river` | ダムの名前と座標（川の防災情報） | 公共データ利用規約 1.0 | あり | — |
| `tourlist` | 県の公式観光サイトに載っていた**名前だけ** | 事実のみ | なし | — |
| `user` | 自分で足したスポット（id が `u:` で始まるもの） | 自分のもの | — | — |
| `unknown` | 決まりに当てはまらないもの | — | 点検で止めます | — |

いまの収録（40,843件）では `unknown` は 0件です。件数は `node tools/kb_provenance.mjs --stats` で出ます。

## 項目 → 出どころの決まり

出どころは、取り込みの道具が1件ずつ残している印（`src`・`geo`・`osm`・`overture`・`osmInfo`）から読みます。推測はしません。

| `src` | 名前 | 座標 | 説明 |
| --- | --- | --- | --- |
| （なし。手で作った 336件） | `tabisaki_original` | `tabisaki_original` | `tabisaki_original` |
| `wikidata` | `wikidata` | `wikidata` | `wikipedia` |
| `wikipedia` | `wikipedia` | `wikipedia` | `wikipedia` |
| `wikipedia-tourlist` | `tourlist` | `wikipedia` | `wikipedia` |
| `osm-tourlist` | `tourlist` | `osm` | `wikipedia` |
| `overture-tourlist` | `tourlist` | `overture` | `wikipedia` |
| `tourlist-geocoded` | `tourlist` | `geo` で決まる（下） | `wikipedia` |
| `opendata` | ダムは `mlit_river`、ほかは `wikipedia`（一覧記事） | 同じ | `tabisaki_original`（分類から作った決まり文句） |

- `geo`（座標の取得元）: `Yahoo…` → `yahoo`、`国土地理院` → `gsi`、`Photon`・`Nominatim` → `osm`、`Wikipedia` → `wikipedia`、`Web調査…` → `tabisaki_original`
- `osm`・`osmInfo` → `osm`、`overture`・その1件の `license` → `overture`、`listedIn`・`listedAs` → `tourlist`
- `url`・`tel` は、`src=wikidata` のとき `wikidata`
- `wikipedia`（記事の題）は、名前と同じなら名前の写しなので名前と同じ出どころ、違う題のときだけ `wikipedia`
- そのほかの項目（分類・`fame_tier`・`regionId`・`fetchedAt` など）は `tabisaki_original`

知らない `src`・`geo` が入ると `unknown` になり、点検が 1 で終わります。新しい取り込み元を足すときは、`provenance.js` の `SOURCES` と `ruleOf` に足してください。

## 出どころごとに分けた形（スキーマ）

`splitBySource(spot)` は、1件を出どころごとの入れ物に分けます。1つの項目は、必ず1つの入れ物にだけ入ります。

```json
{
  "schema": "tabisaki.spot-sources/1",
  "id": "os-1988117712",
  "osm": { "lat": 43.52891, "lng": 142.46549, "osm": "way/369100684", "osmInfo": { "phone": "…" } },
  "tourlist": { "name": "四季彩の丘" },
  "tabisaki_original": { "regionId": "n0880", "category": "庭園", "fame_tier": "hidden", "src": "osm-tourlist", "fetchedAt": 1793165089000 },
  "license_summary": {
    "schema": "tabisaki.license-summary/1",
    "sources": [{ "id": "osm", "license": "ODbL 1.0", "shareAlike": true, "attributionRequired": true, "attribution": "© OpenStreetMap contributors（ODbL）", "fields": ["lat,lng", "osm", "osmInfo"] }],
    "licenses": ["ODbL 1.0", "facts-only", "PolyForm-Noncommercial-1.0.0"],
    "shareAlike": ["osm"],
    "attribution": ["© OpenStreetMap contributors（ODbL）"],
    "complete": true
  }
}
```

- `joinSources(record)` で元の1件に戻ります。収録の全件で「分けて戻すと同じ」を試験しています
- `license_summary.attribution` は**書かなければいけない表記**（義務のあるものだけ）です。義務のないものも `sources` には並びます
- `complete` は、出どころの分からない項目が1つも無い印です
- 1件だけ見るには `node tools/kb_provenance.mjs --spot <id>`

## 出典が自動で付くところ

使ったデータだけを数えて、出します。手で書き足す必要はありません。

| 出力 | 付くもの |
| --- | --- |
| 旅程の JSON（`./tabisaki plan --json`、API の `POST /v1/plan`） | `license_summary`、スポットの行ごとの `sources` |
| 旅程の Markdown・ふつうの文 | 末尾に「出典: …」の1行（英語では `Data sources: …`） |
| カレンダー（.ics） | 予定ごとの説明に、その場所の「出典: …」 |
| 画面 | 旅程の下に「この旅程のデータの出典」（使ったものだけ）。全体は [著作権表記](../credits.html) |
| スポットの書き出し（`./tabisaki spot export`） | JSON・GeoJSON・KML に `license_summary`、CSV は最後の列 `sources`（例: `wikipedia;osm`） |

外から来たデータを1つも使っていない旅程には、出典の行は出ません。CSV の `sources` の列は、取り込みでは読み飛ばします。

## いまある収録の移行

`kb/` の段（`spots-*.json`）は、いまは平らな形のままです。平らな形でも、上の決まりで項目ごとに追えます（点検が毎回確かめます）。分けた形に移すときの手順は次のとおりです。

1. 点検する。`node tools/kb_provenance.mjs`（`unknown` があれば、先に決まりを足します）
2. 分けて書く。`node tools/kb_provenance.mjs --split /tmp/kb-split`（`kb/` そのものには書けません）
3. 確かめる。`node tools/kb_provenance.mjs --verify /tmp/kb-split`（元に戻すと `kb/` と同じか）
4. 置き換える。`cp /tmp/kb-split/spots-*.json kb/`
5. 試験を回す。`node --test tests/*.test.js`

アプリとコマンドの読み込み（`packages/core/src/kb.js`）は、**どちらの形でも読めます**。段ごとに形が違っていても読めます。

**まだ置き換えていない理由**が2つあります。

- 収録を書き足す道具（`tools/import_*.py`・`tools/osm_enrich.py`・`tools/kb_check.mjs` など）と PHP 版のデータ作り（`tools/build_php_data.mjs`）は、平らな形を読み書きします。先にこれらを分けた形に対応させる必要があります
- 分けた形は、段の合計が 14MB → 17MB と大きくなります。携帯で読む量が増えます

そのため、この変更では「決まり・点検・読み込み・移行の道具」までを入れ、`kb/` の置き換えは次の段階に残しています。

## 分かっている限界

- 説明の出どころは `src` で決めています。`src` が付いているのに説明がウィキペディアの抜粋ではないものが 4件あり、これらも `wikipedia` に数えます（表記が多すぎる側に倒しています）
- `opendata` の文化財・灯台・城・道の駅・滝は、ウィキペディアの一覧記事から来ています。元の表（`data/extra-spots.csv`）の「データソース」の列は収録に残していないので、分類がダムかどうかで分けています
- 共有リンクや履歴から開いた旅程は、場所のデータを持っていないことがあります。そのときは、画面の「この旅程のデータの出典」は出ません（著作権表記のページは、いつでも下から開けます）
