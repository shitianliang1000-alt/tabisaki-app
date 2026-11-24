# バス停・駅・観光地のデータ配信 API

旅さきが持っている観光地・駅・バス停のデータを、**要る範囲だけ** HTTP で取れるようにした API です。CUI（`./tabisaki`）とアプリが、収録を丸ごと抱えずに使うためのものです。

- 窓口: Cloudflare Worker の `GET /v1/data/…`（`server/data-api.js`）
- 持ち主の道具: `./tabisaki data …`（`tools/data_api.mjs`）
- 呼ぶ道具（CUI・アプリ用）: `packages/core/src/data-client.js`
- 試験: `tests/data-api.test.js`

## 目次

* [配るもの・配らないもの](#配るもの配らないもの)
* [道](#道)
* [返事の形](#返事の形)
* [出典の表示（使う側の義務）](#出典の表示使う側の義務)
* [回数の制限](#回数の制限)
* [鍵](#鍵)
* [版](#版)
* [データの入れかた（持ち主）](#データの入れかた持ち主)
* [CUI・アプリから使う](#cuiアプリから使う)
* [決めていないこと](#決めていないこと)

## 配るもの・配らないもの

出どころの線引きは [data-provenance.md](./data-provenance.md) の台帳を使います。1件ずつ `sources`（出どころの一覧）を付け、**配ってよい出どころだけでできている1件**だけを配ります。入れ物を作るとき（`./tabisaki data build`）と、返す直前（`server/data-api.js` の `publicProblem`）の2回確かめます。

| データ | 配る？ | 出どころ・条件 |
|---|---|---|
| 観光地（`kb/spots-*.json`、約4万件） | **配る** | Wikidata（CC0）・Wikipedia（CC BY-SA 4.0、継承あり）・OpenStreetMap（ODbL、継承あり）・Overture・国土地理院・川の防災情報・県の観光サイトの名前（事実のみ）・旅さきの独自データ（PolyForm Noncommercial） |
| ↑ のうち、座標を Yahoo! で引いたもの（約9千件） | **配る**（表記つき） | 「Web Services by Yahoo! JAPAN」。2026-11-11 の持ち主の判断（クレジット表記で可）に従っています。外すときは `build --exclude yahoo` |
| 鉄道の駅（`kb/stops-rail.json`、9,532駅） | **配る** | 国土数値情報 N02（2008年度、**商用可**）。「加工して作成」の表記つき。新しい駅は手で足したもの（旅さきの独自データ） |
| バス停（GTFS-JP） | **配る**（時刻表ごと） | `license.json` のある時刻表だけ（下の「入れかた」）。いまは入れていないので 0件です |
| 国土数値情報 **P11 バス停・P12 観光資源・P27 文化施設** | **配らない** | 非商用。複製物の再配布ができません（[kokudo-licenses.md](./kokudo-licenses.md)）。入れ物にも入れません |
| 東京の停留所・駅（`kb-private/tokyo-stops-kv.json`） | **配らない** | 出どころが分からないため |
| 利用者が足したスポット（`u:`） | **配らない** | 本人のもの |

**アプリの中だけで使うもの**（非商用のデータ）は、今までどおり中継の `POST /stops/near`・`POST /spots/check` が「はい／いいえ」だけを返します（[private-kb.md](./private-kb.md)）。名前・座標は外に出ません。この API とは入れ物も別です（`PRIVATE_KB` と `DATA_KB`）。

## 道

すべて `GET`（と `HEAD`・`OPTIONS`）です。どこから呼んでも構いません（CORS は `*`。読むだけで、Cookie も使いません）。

| 道 | 中身 |
|---|---|
| `/v1/data` | 版・件数・道の一覧・使う条件 |
| `/v1/data/attribution` | 出どころの台帳（ライセンス・書くべき表記） |
| `/v1/data/spots?near=緯度,経度&radius=km` | 観光地（近い順。`distance_m` が付きます） |
| `/v1/data/spots?bbox=西,南,東,北` | 観光地（範囲の中。id 順） |
| `/v1/data/spots?pref=13` | 観光地（都道府県コード 1〜47） |
| `/v1/data/spots/{id}` | 観光地の1件 |
| `/v1/data/stations?near=…` か `?bbox=…` | 駅 |
| `/v1/data/stops?near=…` か `?bbox=…` | バス停 |

問い合わせの項目:

| 項目 | 値 | 既定 |
|---|---|---|
| `near` | `緯度,経度`（日本の中） | — |
| `radius` | km、0〜10（`near` と一緒に） | 1 |
| `bbox` | `西経度,南緯度,東経度,北緯度`、1度四方まで | — |
| `pref` | 1〜47（spots だけ） | — |
| `category` | 分類（例 `寺院`。spots だけ） | — |
| `tier` | `major`（定番）か `hidden`（穴場）（spots だけ） | — |
| `limit` | 1〜500 | 100 |
| `offset` | 0〜 | 0 |

- `near`・`bbox`・`pref` は**どれか1つ**を必ず付けます（全件を1回で取る道はありません）
- 知らない項目は `400 unknown_param` にします（書きまちがいに気づけるように）
- 範囲を絞るのは、無料枠の CPU 時間（1回 10ms）に収めるためです

## 返事の形

```json
{
  "api": 1,
  "schema": "tabisaki.data-api/1",
  "version": "2026-11-24.9e0541c6",
  "dataset": "spots",
  "total": 132,
  "offset": 0,
  "count": 100,
  "next": "/v1/data/spots?near=35.0037,135.7788&radius=2&offset=100",
  "items": [
    { "id": "wd-Q…", "name": "清水寺", "category": "寺院", "lat": 34.9949, "lng": 135.785,
      "pref": "26", "fame_tier": "major", "description": "…", "sources": ["wikidata", "wikipedia", "tabisaki_original"],
      "distance_m": 120 }
  ],
  "license_summary": {
    "sources": [{ "id": "wikipedia", "license": "CC BY-SA 4.0", "shareAlike": true }, …],
    "attribution": ["Wikipedia の執筆者（CC BY-SA 4.0）", …]
  }
}
```

- 観光地の1件の項目は収録（`kb/spots-*.json`）と同じです。`pref`（都道府県コード2桁）と `sources` を足しています
- 駅は `{ id, kind: "station", name, lat, lng, sources }`、バス停は `{ id: "<時刻表>:<stop_id>", kind: "stop"|"station", name, lat, lng, sources }`
- 駅の id は「名前と座標」から作ります（`st-` ＋ 10桁）。元データを入れ替えると変わることがあります
- エラーは `{ "error": { "code": "bad_bbox", "message": "…" } }`。`code` で見分けてください

| 状態 | code | いつ |
|---|---|---|
| 400 | `need_area`・`unknown_param`・`bad_near`・`bad_bbox`・`bbox_too_large`・`bad_radius`・`bad_pref`・`bad_limit`・`bad_offset`・`bad_tier` | 問い合わせの誤り |
| 401 | `bad_key`・`key_required` | 鍵がちがう・取り消し済み・要るのに無い |
| 404 | `not_found` | 無い道・無い id |
| 405 | `method_not_allowed` | GET 以外 |
| 429 | `rate_limited` | 回数の上限。`Retry-After` 秒待つ |
| 503 | `no_data`・`disabled` | データが入っていない・止めている |

## 出典の表示（使う側の義務）

返事の `license_summary.attribution` に並ぶ表記は、**取ったデータを見せる画面・出力に必ず添えてください**（CC BY-SA・ODbL・Yahoo! のクレジット・国土数値情報の「加工して作成」など）。`license_summary.sources` に `shareAlike: true` のものがあるときは、そのデータを含めて配り直すなら同じ条件（CC BY-SA 4.0・ODbL）で配る必要があります。

旅さきの独自データ（`tabisaki_original`。分類・定番/穴場・手書きの説明など）は **PolyForm Noncommercial 1.0.0** です。商用には使えません。

## 回数の制限

| 相手 | 1分 | 1時間 |
|---|---|---|
| 鍵なし（接続元の IP ごと。IPv6 は /64 ごと） | 60回 | 1,000回 |
| 鍵あり（鍵ごと） | 600回 | 20,000回 |

- 中継（AI・乗り換え）とは**別の枠**で数えます。データをたくさん読んでも AI の枠は減りません
- 数えるのは Durable Object（`RateLimiter`）です。超えたら `429 rate_limited` と `Retry-After`
- Worker の環境変数で変えられます: `DATA_ANON_PER_MINUTE`・`DATA_ANON_PER_HOUR`・`DATA_KEY_PER_MINUTE`・`DATA_KEY_PER_HOUR`。鍵ごとの値（`key new --per-minute`）が優先です
- `RATE_LIMIT=off` で数えるのをやめます（中継と共通）。`DATA_API=off` で API ごと止まります（503）
- 届く前に落としたいときは、Cloudflare の WAF の Rate limiting rules で `/v1/data/*` にも上限をかけてください（中継と同じ考えかたです）

## 鍵

**鍵は無くても呼べます。** アプリと CUI は誰でも中身を見られる形で配るので、中に鍵を埋めても秘密になりません。鍵で守るものは無く、鍵は「たくさん使う相手の枠を広げる・止める」ための札です。

- 送りかた: `Authorization: Bearer tbk_…`（か `X-API-Key: tbk_…`）。クエリ文字列では受けません（記録に残るため）
- 作りかた: `./tabisaki data key new <名前> [--per-minute 1200]`。鍵はこのとき1回だけ出ます。KV（`DATA_KB`）には SHA-256 の指紋だけを置きます
- 取り消し: `./tabisaki data key revoke <鍵か指紋の頭16文字>`
- 鍵を必須にする: Worker の環境変数 `DATA_API_REQUIRE_KEY=1`（このときアプリと CUI も鍵が要ります）
- 鍵を使うには `DATA_KB` の入れ物が要ります（下）

## 版

- 道の版は `/v1/` です。`/v1/` の中では、**項目を足すことはあっても、消したり意味を変えたりはしません**。変えるときは `/v2/` を足し、`/v1/` はしばらく残します（[api.md](./api.md#道と版) と同じ決まり）
- データの版は `version`（`作った日.中身の指紋`）です。返事の `ETag` も同じ値で、`If-None-Match` を付けて聞くと、変わっていなければ `304` だけが返ります（`data-client.js` は自動でそうします）
- `Cache-Control: public, max-age=300`

## データの入れかた（持ち主）

データの置き場は2つあり、**どちらか片方だけ**を使います（混ぜると版が食い違うため）。

1. **デプロイに同梱（既定。何も設定しなくて動きます）** — `tools/build_worker.sh` が毎回 `kb/` から作り、`.site/__data/v1/` に入れます。外から `/__data/` を開いても 404 です。`kb/` を直してデプロイすれば、そのまま新しい版になります
2. **Workers KV（`DATA_KB`）** — デプロイせずにデータを差し替えたいとき、鍵を使いたいときに使います。KV に manifest があれば、そちらだけを読みます

KV を使う手順:

1. Cloudflare のダッシュボード → Storage & Databases → Workers KV → Create で `tabisaki-data` を作る（**非商用データの `tabisaki-private` とは別のもの**）
2. 出てきた ID を `wrangler.jsonc` の `DATA_KB` の行に入れ、// を外してデプロイ
3. 手元で:

```sh
npx wrangler login
./tabisaki data build            # .data-api/v1/ に作る（配れないものが混ざっていないかも確かめます）
./tabisaki data push --dry-run   # 何を書くかだけ見る
./tabisaki data push             # KV に入れる（manifest は最後に書くので、途中で読まれても前の版のまま）
```

- 1回の push で書く鍵は約520個です。KV の無料枠は1日 1,000 回の書き込みなので、**1日1回まで**にしてください
- KV をやめて同梱に戻すときは、KV の `v1/manifest.json` を消します（`npx wrangler kv key delete v1/manifest.json --binding DATA_KB --remote`）

### バス停（GTFS-JP）を足す

時刻表のフォルダ（`stops.txt` が入っているもの）に `license.json` を置き、`--gtfs` で渡します。**`license.json` の無い時刻表は配りません。**

```json
{ "id": "ryobi", "name": "両備バス", "license": "CC BY 4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by/4.0/deed.ja",
  "attribution": "両備ホールディングス株式会社（CC BY 4.0）" }
```

```sh
./tabisaki data build --gtfs data/gtfs-bus/ryobi --gtfs data/gtfs-bus/okaden
./tabisaki data push
```

`license` と `attribution` は、その時刻表の配布元が書いている条件のとおりに書いてください（[gtfs-pipeline.md](./gtfs-pipeline.md) の一覧の「ライセンス」）。

### 出どころごと外す

```sh
./tabisaki data build --exclude yahoo        # Yahoo! で座標を引いたスポットを外す
./tabisaki data build --exclude osm,wikipedia
```

## CUI・アプリから使う

```sh
./tabisaki data get spots --near 35.0037,135.7788 --radius 2
./tabisaki data get stations --bbox 139.6,35.6,139.8,35.8
./tabisaki data get spot --id takao-1
TABISAKI_DATA_KEY=tbk_… ./tabisaki data get manifest
```

```js
import { createDataClient } from "./packages/core/src/data-client.js";
const c = createDataClient();                     // 既定は packages/core/src/config.js の PROXY_URL
const { items, license_summary } = await c.spots({ near: "35.68,139.76", radius: 2 });
const every = await c.all("spots", { pref: "47" }); // next を辿って集める（既定 2,000件まで）
```

## 決めていないこと

持ち主の判断が要るものです。

- **Yahoo! の座標**: クレジット表記で可、という判断で配っています。ただ、Yahoo! の Web API の規約が「取得した結果を保存して第三者に配ること」まで認めているかは、確かめられていません。気になるなら `--exclude yahoo` で外せます（約9千件減ります）
- **ODbL（OpenStreetMap）**: 配る入れ物は「派生データベース」に当たるので、OSM 由来の部分は ODbL で提供する、と示す必要があります。`/v1/data/attribution` と各返事の `shareAlike` で示していますが、文面は持ち主が確かめてください
- **鍵を必須にするか**: いまは任意です。必須にすると、アプリと CUI に鍵を配ることになります（鍵は秘密になりません）
- **東京のタイル**: 0.5度四方の1枚（`71_279`）が 1.2MB あり、近くを聞くと読むのに数ms かかります。混むようなら、細かく分ける（四分木）か、項目を減らした軽い版を足します
