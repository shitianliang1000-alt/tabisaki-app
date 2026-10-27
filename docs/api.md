# API の仕様と安全の決めごと

旅さきの API サーバー（`packages/server`）の仕様です。手元で動かす方法は [self-hosting.md](./self-hosting.md) にあります。

この文書は Issue #376 で決めたことをまとめています。中身が変わったら、ここと `tests/server-security.test.js` を一緒に直してください。

## 目次

* [前提](#前提)
* [道と版](#道と版)
* [認証](#認証)
* [回数の制限](#回数の制限)
* [入力の確かめ](#入力の確かめ)
* [ブラウザから呼ぶとき（CORS と Host）](#ブラウザから呼ぶときcors-と-host)
* [エラーの形](#エラーの形)
* [記録（ログ）](#記録ログ)
* [設定](#設定)
* [Docker で動かす](#docker-で動かす)
* [インターネットに出すとき](#インターネットに出すとき)
* [まだやらないこと](#まだやらないこと)
* [試験の項目](#試験の項目)

## 前提

* 旅程を組むだけの API です。利用者の登録・保存・課金はありません
* 外へは通信しません。だから API の鍵（Gemini など）もサーバーは持ちません
* **安全な初期設定**: 何も設定しなければ `127.0.0.1` だけで待ち受け、認証はありません。その端末の中の道具からだけ呼べます
* 127.0.0.1 以外で待ち受けるときは、**鍵が無いと起動しません**（終了コード 2）

## 道と版

| 道 | 中身 |
|---|---|
| `POST /v1/plan` | 旅程を組む |
| `GET /v1/health` | 動いているか（鍵なしで呼べます） |
| `OPTIONS /v1/*` | ブラウザの下調べ（CORS） |

* `/plan` と `/health` は前の名前で、`/v1/` と同じものを返します。新しく書くときは `/v1/` を使ってください
* `/v1/` の中では、**項目を足すことはあっても、消したり意味を変えたりはしません**。そういう変更が要るときは `/v2/` を足し、`/v1/` はしばらく残します
* `GET /v1/health` の `api` が、いま動いている API の版（`1`）です

本文の項目と応答の `plan` の形は [self-hosting.md](./self-hosting.md#呼びかた) と [cli-usage.md](./cli-usage.md#出力) にあります。

## 認証

* 方式は **固定の鍵（Bearer トークン）** です。`Authorization: Bearer <鍵>` を付けて送ります
* 鍵は `TABISAKI_API_TOKEN`（または `TABISAKI_API_TOKEN_FILE` に置いたファイル）で渡します。**32文字以上**で、`openssl rand -hex 32` などで作ってください
* 鍵はカンマか改行で区切って複数持てます。入れ替えるときは、新しい鍵を足す → 使う側を変える → 古い鍵を消す、の順にします
* 鍵の比べかたは、長さをそろえてから時間の差が出ない方法（`timingSafeEqual`）です
* 鍵がちがう・無いときは `401 unauthorized` と `WWW-Authenticate: Bearer` を返します
* 認可（だれが何をできるか）の区別はありません。鍵を持っていれば `POST /v1/plan` だけを呼べます。書き込む道が無いので、今はこれで足ります

> [!NOTE]
> OAuth・利用者ごとの鍵は、複数の人に配る公開 API にするときに考えます（[まだやらないこと](#まだやらないこと)）。

## 回数の制限

| 上限 | 既定 | 超えたとき |
|---|---|---|
| 1つの相手から1分に | 30回 | `429 rate_limited`、`Retry-After: 60` |
| 同時に組む本数 | 2本 | `503 busy`、`Retry-After: 5` |
| 1本にかける時間 | 30秒 | `504 timeout` |
| 本文の大きさ | 4KB | `413 too_large` |
| 見出しが届くまで | 10秒 | 接続を切る（遅い送りつけ対策） |

* 回数は **鍵を確かめる前に** 数えます。鍵を当てずっぽうで試す相手も、1分に30回で止まります
* 「相手」は接続元の住所です。逆プロキシの後ろに置くときは `TABISAKI_TRUST_PROXY=1` にすると、`X-Forwarded-For` の **最後の1つ**（逆プロキシが足したもの）で数えます。左側は相手が好きに書けるので使いません
* 数はサーバーの記憶の中だけにあり、再起動で消えます。何台も並べるときは、逆プロキシの側でも制限してください

## 入力の確かめ

* `Content-Type: application/json` でなければ `415`
* 本文は JSON のオブジェクトだけ。**知らない項目があれば `400`**（書きまちがいに気づけるように、また将来の項目とぶつからないように）
* `wish` は500字まで、`days` は 1〜14、日付・時刻・出発地の確かめは `packages/core` がします（CLI と同じ）
* `markdown` は `true` か `false` だけ

## ブラウザから呼ぶとき（CORS と Host）

* **既定では、どのページからも呼べません。** `Origin` の付いた頼みは `403 origin_not_allowed` にします
* 呼ばせたいページは `TABISAKI_ALLOW_ORIGIN=https://app.example.com,https://b.example.com` のように1つずつ書きます。`*` は使えません
* 許したページには `Access-Control-Allow-Origin`（そのページだけ）と `Vary: Origin` を返し、`Authorization`・`Content-Type`・`X-Request-Id` の見出しを許します
* **認証なしで動かしているときは、`Host` が `127.0.0.1`・`localhost`・`::1` 以外なら `403 bad_host` にします。** 悪いページが DNS を差し替えて、手元のサーバーを同じ出どころのように呼ばせる手口（DNS rebinding）を止めるためです。ほかの名前で呼ぶときは `TABISAKI_ALLOW_HOST` に足すか、鍵を設定してください

## エラーの形

失敗はどれも同じ形です。

```json
{ "ok": false, "error": { "code": "rate_limited", "message": "回数が多すぎます。1分おいてください", "request_id": "3f0c…" } }
```

* `code` は英語の決まった言葉で、プログラムはこれを見ます。`message` は人が読む日本語で、変わることがあります
* `request_id` は応答の見出し `X-Request-Id` と同じです。こちらから `X-Request-Id`（英数字と `._-` の64文字まで）を送れば、それを使います
* `500 internal` には、中のまちがいの詳しいこと（ファイルの場所など）を出しません。記録にだけ出します

| 状態 | code |
|---|---|
| 400 | `invalid_input` / `unknown_place` / `invalid_json` |
| 401 | `unauthorized` |
| 403 | `origin_not_allowed` / `bad_host` |
| 404 / 405 | `not_found` / `method_not_allowed` |
| 413 / 415 | `too_large` / `unsupported_media_type` |
| 422 | `plan_failed` |
| 429 / 503 / 504 | `rate_limited` / `busy` / `timeout` |
| 500 | `internal` |

どの応答にも `Cache-Control: no-store`・`X-Content-Type-Options: nosniff`・`Content-Security-Policy: default-src 'none'`・`Referrer-Policy: no-referrer` を付けます。

## 記録（ログ）

stderr に1行ずつ出します。

```
2026-10-27T05:00:00.000Z 3f0c… POST /v1/plan 200 812ms
```

* 出すのは **時刻・要求番号・方法・道・状態・かかった時間だけ** です
* **入力の文・相手の住所（IP）・鍵は残しません。** 何を探したかは、その人のものです
* 住所を残したいときは、逆プロキシの記録で残してください（保存の期間はそちらで決めます）

## 設定

すべて環境変数です。まちがった値があれば、理由を出して起動しません。

| 名前 | 既定 | 中身 |
|---|---|---|
| `HOST` | `127.0.0.1`（Docker では `0.0.0.0`） | 待ち受ける住所 |
| `PORT` | `8787` | 待ち受ける番号 |
| `TABISAKI_API_TOKEN` | なし | 鍵（32文字以上、カンマで複数） |
| `TABISAKI_API_TOKEN_FILE` | なし | 鍵を置いたファイル（Docker の secrets 用） |
| `TABISAKI_NO_AUTH` | なし | `1` で、127.0.0.1 以外でも鍵なしで起動する。前に別の認証があるときだけ |
| `TABISAKI_ALLOW_ORIGIN` | なし | 呼ばせるページ（カンマ区切り） |
| `TABISAKI_ALLOW_HOST` | なし | 認証なしのときに受ける `Host` の名前を足す |
| `TABISAKI_TRUST_PROXY` | なし | `1` で、`X-Forwarded-For` の最後で回数を数える |

秘密の扱い:

* 鍵をリポジトリ・`compose.yaml`・イメージに書き込まないでください。`.env`（Git に入れない）か Docker の secrets で渡します
* 鍵は記録にも応答にも出しません

## Docker で動かす

* `docker compose up` は、入れ物の中では `0.0.0.0` で待ち受け、外には `127.0.0.1:8787` だけを出します。だから compose では `TABISAKI_NO_AUTH=1` を明示しています
* `docker run -p 8787:8787 …` のように全部の住所に出すときは、鍵を渡してください。渡さなければ起動しません
* 入れ物は読み取り専用・root ではない利用者（`node`）で動きます
* `HEALTHCHECK` は `GET /v1/health` を見ます（鍵は要りません）

```sh
echo "TABISAKI_API_TOKEN=$(openssl rand -hex 32)" > .env   # .env は Git に入れない
docker run -d -p 8787:8787 --env-file .env --read-only tabisaki-api
curl -X POST http://SERVER:8787/v1/plan -H "Authorization: Bearer $(cut -d= -f2 .env)" \
  -H 'Content-Type: application/json' -d '{"wish":"温泉と海"}'
```

## インターネットに出すとき

鍵を設定しても、次をそろえるまでは出さないでください。

1. 手前に **HTTPS の逆プロキシ**（Caddy・nginx・Cloudflare Tunnel など）を置く。鍵が平文で流れないように
2. `TABISAKI_TRUST_PROXY=1` にして、逆プロキシの側でも回数を制限する
3. サーバー本体は逆プロキシからだけ届く住所で待ち受ける（`HOST=127.0.0.1` か、内側の網）
4. ブラウザから呼ぶなら `TABISAKI_ALLOW_ORIGIN` にそのページだけを書く

## まだやらないこと

いまの使いかた（自分や仲間うちで呼ぶ）には要らないので、入れていません。複数の人に配る公開 API にするときに決めます。

* 利用者ごとの鍵・鍵の発行の画面・OAuth
* 利用者ごとの回数の上限と、その記録（台数をまたいで数える仕組み）
* 使われた回数の集計・課金
* 監査用の記録（だれがいつ呼んだか）

## 試験の項目

`tests/server.test.js`（形）と `tests/server-security.test.js`（安全）で確かめています。CI の `docker` の仕事では、入れ物が鍵なしでは起動しないことと、鍵があれば旅程を返すことを見ます。

| 項目 | 試験 |
|---|---|
| 127.0.0.1 以外で鍵が無ければ起動しない | `設定: 127.0.0.1 以外で鍵が無ければ起動しない`・CI |
| 短い鍵・`*` の Origin・読めない鍵ファイルを断る | `設定: 短い鍵・ * の Origin…` |
| 鍵が無い・ちがう・Basic なら 401、正しければ 200 | `鍵があると、無い・ちがう鍵は 401`・CI |
| 鍵を記録に残さない | 同上 |
| 鍵のまちがいも回数に数える | `鍵のまちがいも回数に数え…` |
| `/health` は鍵なし、`/v1/` と前の道が同じ | `/health は鍵なしで…`・`/v1/plan と前の /plan は同じもの` |
| エラーの形と要求番号 | `失敗はどれも {ok:false, error:{…}}…` |
| CORS は既定で閉じ、許したページだけ通す | `CORS: …` の2つ |
| 認証なしで見知らぬ Host を断る | `認証なしのときは、見知らぬ Host を断る` |
| 逆プロキシの後ろの数えかた | `逆プロキシの後ろでは…` |
| 安全の見出し・中のまちがいを漏らさない | `応答には安全のための見出しが付き…` |
| 入力の文を記録に残さない・回数・同時・時間切れ・大きさ | `tests/server.test.js` |
