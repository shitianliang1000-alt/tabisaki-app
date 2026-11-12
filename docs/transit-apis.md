# 乗り換え検索の API

電車・バス・飛行機・船の経路は、中継（Cloudflare Worker）の `POST /transit` で引きます。中継はキーが入っている API を決まった順に試し、どの API の答えも同じ形にそろえて返します。キーは中継の中だけに置き、ブラウザには置きません。

## 対応している API

| API | 中継に入れるもの | 費用 | 終電 | 範囲 |
|---|---|---|---|---|
| OpenTripPlanner（手元で動かす。[otp.md](otp.md)） | `OTP_URL` | 無料（自分の機械） | × | 読ませた GTFS-JP の範囲だけ。いまは熊本（路線バス・熊本電鉄・熊本市電）。JR は入らない |
| [駅すぱあと API][1]（Val研究所） | `EKISPERT_API_KEY` | 従量課金。90日の無料試用・フリープランあり | ○ | 全国の鉄道・飛行機・船。バスは契約しだい |
| [NAVITIME Route(totalnavi)][2]（RapidAPI） | `NAVITIME_RAPIDAPI_KEY` | RapidAPI の料金表しだい | × | 全国の鉄道・飛行機。路線バス・高速バス・フェリーは追加契約 |
| [HERE Public Transit API v8][3] | `HERE_API_KEY` | 無料枠あり。日本の対応範囲は都市ごと | × | 主に海外。日本は一部の都市 |
| [Transitous][4]（MOTIS・GTFS） | 要らない（`TRANSITOUS=off` で止める） | 無料・**非商用だけ** | × | 公開された GTFS のある路線だけ。新幹線と大手私鉄は入っていて、京都市バスや JR 北海道、飛行機は入っていない（2026年10月に確かめた） |
| [Transit API](https://api.transit.ls8h.com/)（api.transit.ls8h.com） | 要らない（`LS8H_TRANSIT=off` で止める。自前の同じ形の API は `LS8H_API_URL`） | 無料 | ○ | JR を含む全国の時刻表（GTFS・ODPT）。**一部のバスは入っていない**（持ち主の確認）。入っていない区間は次の API（Transitous など）へ進み、全部だめなら Google マップのリンクと距離からの目安になる |

自動で試す順番は、`OpenTripPlanner → 駅すぱあと → NAVITIME → HERE → Transit API → Transitous` です（OpenTripPlanner は `OTP_URL` を入れたときだけ）。中継の変数 `TRANSIT_ORDER`（カンマ区切り）で変えられます。キーが無いもの、終電を探せないもの（終電を聞かれたとき）は飛ばします。答えが「経路なし」のときも次へ進みます。全部だめなら、画面は駅までの距離からの目安で組みます。

Transit APIから移るときは、駅すぱあとか NAVITIME のキーを入れてから `YAHOO_TRANSIT=off` にしてください。キーを入れる前に止めると、無料の Transitous だけになり、バスの入っていない地域では目安の時間になります。

## 対応していないもの

* **Google Routes API**: 日本の電車・バスは返しません（Google の説明で、日本の提供元が除かれています）。海外の区間は、今までどおり `/routes` で引きます。
* **ジョルダン 乗換案内**: 法人向けの契約だけで、公開された仕様がありません。契約できたら足します。
* **公共交通オープンデータ（ODPT）**: 時刻表のデータで、経路を探す API ではありません。時刻表との連携として、別に計画しています（[roadmap](roadmap.md)）。

## 中継に入れる

```bash
npx wrangler secret put EKISPERT_API_KEY        # 駅すぱあと
npx wrangler secret put NAVITIME_RAPIDAPI_KEY   # NAVITIME（RapidAPI の X-RapidAPI-Key）
npx wrangler secret put HERE_API_KEY            # HERE
npx wrangler secret put OTP_URL                 # 手元の OpenTripPlanner（HTTPS で届く URL。otp.md）
npx wrangler secret put TRANSIT_ORDER           # 任意。例: ekispert,navitime,transitous
npx wrangler secret put YAHOO_TRANSIT           # 任意。off で Transit APIを止める
```

入っているかは `POST /transit/providers` か `POST /status` の `transit` で確かめられます（キーの値は返しません）。

## 呼びかた

```sh
curl -X POST "$PROXY_URL/transit" -H 'Content-Type: application/json' -d '{
  "from": "京都駅", "to": "金閣寺",
  "fromAt": {"lat": 34.9858, "lng": 135.7588}, "toAt": {"lat": 35.0394, "lng": 135.7292},
  "departAt": "2026-11-14T10:00:00+09:00",
  "provider": "auto"
}'
```

`provider` は `auto`（既定）・`ekispert`・`navitime`・`here`・`transitous`・`yahoo` のどれかです。答えの形は `/yahoo/transit` と同じで、`provider` と `providerLabel` に答えた API が入ります。`auto` のときは、試した順と結果が `tried` に入ります。

本文の `modes`（`al` 飛行機・`shin` 新幹線・`ex` 特急・`hb` 高速バス・`lb` 路線バス・`sr` 船、0 で使わない）と `prefer`（`air`・`ferry`）、`search: "last"`（終電）も、`/yahoo/transit` と同じです。

## アプリの側

アプリ（`packages/core`）は、乗り換えを中継の `POST /transit` で引きます。どれを使うかは `packages/core/src/config.js` の `TRANSIT_PROVIDER` で決まり、既定の `auto` なら中継が上の順に試します。中継がまだ古く `/transit` を知らない（404）ときは、これまでの `/yahoo/transit` で引き直します。

旅程の「どこまで確かめたか」と区間の説明には、答えた API の名前（`providerLabel`）が出ます。CLI や組み込みでは、経路の取り口を `transit`（既定・中継に任せる）・`ekispert`・`navitime`・`here`・`transitous`・`yahoo` から選べます（`useProvider("routing", "transitous")`）。

## 各社の決まり

* **Transitous** は、オープンソースで非商用のものだけが使えます。1日に720回を超えて経路を聞くときは、先に Transitous に相談します。中継は `User-Agent` に連絡先（このリポジトリ）を入れ、著作権表記のページから [Transitous の出典][5] にリンクしています。
* **NAVITIME** の規約では、受け取った答え（座標を含む）を控えて使い回せません。中継は NAVITIME の答えをキャッシュしません。
* **駅すぱあと**・**HERE** は、それぞれの契約の回数と表示の決まりに従います。

駅すぱあと・NAVITIME・HERE の読み替えは、各社の仕様書に書かれた答えの形で試験しています（キーが無く、本物ではまだ試していません）。キーを入れたら、まず `provider` を名指しして1回引き、区間と時刻が正しく出るかを確かめてください。

  [1]: https://ekispert.jp/products/api
  [2]: https://api-sdk.navitime.co.jp/api/
  [3]: https://docs.here.com/transit/docs/route
  [4]: https://transitous.org/
  [5]: https://transitous.org/sources/

## Yahoo!路線情報のページ読みは、やめました（2026-11-12）

以前は Yahoo!路線情報の検索結果ページを読んでいましたが、API ではなく規約上も確かめられないため、
取り除きました（`/yahoo/transit` の入口は残してあり、いまは `/transit` と同じ答えを返します）。

* 引く順番は `otp` → `ls8h`（Transit API）→ `ekispert` → `navitime` → `here` → `transitous`。答えが出なければ次へ進みます
* どれも答えなかった区間には、Google マップの経路 URL（[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)）を `url` に添えます。
  これは「Google マップで開く」リンクで、時刻・所要時間を返す API ではありません。ページを機械で読むのは
  Google の規約で禁じられているので、やっていません。画面には距離からの目安を出します
