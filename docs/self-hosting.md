# 自分の端末で動かす（手元用 API サーバー）

旅程を組む機能を、ほかの道具（スクリプト・ほかのアプリ）から HTTP で呼べるようにします。
中身は [CLI](./cli-usage.md) と同じエンジンで、**外へは通信しません**（移動時間は距離からの目安）。

## 起動

Docker で:

```sh
docker compose up        # http://127.0.0.1:8787
```

Docker を使わずに（Node.js 22 以上）:

```sh
./tabisaki api           # node packages/server/server.mjs と同じ
```

## 呼びかた

```sh
curl -X POST http://127.0.0.1:8787/v1/plan \
  -H 'Content-Type: application/json' \
  -d '{"wish":"温泉と海","days":2}'
```

本文（JSON）の項目は CLI のオプションと同じです。

| 項目 | 例 | 既定 |
|---|---|---|
| `wish`（必須） | `"温泉と海をゆっくり"` | |
| `from` | `"新大阪駅"` | 東京駅 |
| `days` | `2` | 1 |
| `date` | `"2026-11-03"` | 明日 |
| `start` / `back` | `"08:00"` / `"20:00"` | 08:00 / 20:00 |
| `transport` | `"car"` | any |
| `markdown` | `true` | false（true なら Markdown の文も付けます） |
| `lang` | `"en"` | ja（Markdown の見出しなどの言語。[i18n.md](i18n.md)） |

知らない項目が入っていると 400 にします（書きまちがいに気づけるように）。

### 応答

成功（200）:

```json
{ "ok": true, "plan": { "version": 1, "request": { … }, "title": "熱海", "days": [ … ] } }
```

`plan` の形は [cli-usage.md の JSON](./cli-usage.md#出力) と同じです。

失敗はどれも `{ "ok": false, "error": { "code": "…", "message": "…", "request_id": "…" } }` の形です。

| 状態 | code | いつ |
|---|---|---|
| 400 | `invalid_input` / `unknown_place` / `invalid_json` | 入力のまちがい（`message` に日本語の理由） |
| 401 | `unauthorized` | 鍵を設定したのに、鍵が無い・ちがう |
| 403 | `origin_not_allowed` / `bad_host` | 許していないページ・名前から呼んだ（[api.md](./api.md#ブラウザから呼ぶときcors-と-host)） |
| 404 / 405 | `not_found` / `method_not_allowed` | `POST /v1/plan` と `GET /v1/health` 以外 |
| 413 | `too_large` | 本文が 4KB を超えた |
| 415 | `unsupported_media_type` | `Content-Type: application/json` でない |
| 422 | `plan_failed` | 条件に合う旅程を組めなかった |
| 429 | `rate_limited` | 1つの相手から1分に30回を超えた（`Retry-After`） |
| 503 | `busy` | 同時に2本を組んでいる（`Retry-After`） |
| 504 | `timeout` | 30秒で組み終わらなかった |

`GET /v1/health` は `{"ok":true,"version":"0.1.0","api":1,"spots":53734}` を返します（Docker の HEALTHCHECK もこれを見ます）。

## 安全のための初期設定

くわしい決めごと（鍵・回数・CORS・記録・設定の一覧）は [api.md](./api.md) にあります。

- 何も設定しなければ **認証なしで、`127.0.0.1`（その端末の中）だけ** で待ち受けます。`compose.yaml` も `127.0.0.1:8787` にだけ出しています
- ほかの端末から使うときは、鍵を作って渡します。127.0.0.1 以外で待ち受けるのに鍵が無いと、**起動しません**

  ```sh
  export TABISAKI_API_TOKEN=$(openssl rand -hex 32)
  HOST=0.0.0.0 ./tabisaki api
  curl -X POST http://SERVER:8787/v1/plan -H "Authorization: Bearer $TABISAKI_API_TOKEN" \
    -H 'Content-Type: application/json' -d '{"wish":"温泉と海"}'
  ```

- **インターネットに出すときは、鍵に加えて HTTPS の逆プロキシを手前に置いてください**（[api.md](./api.md#インターネットに出すとき)）
- 記録（stderr）には、時刻・要求番号・道・状態・かかった時間だけを出します。**入力の文・相手の住所・鍵は残しません**
- 入れ物は読み取り専用（`read_only: true`）で、root ではない利用者（`node`）で動きます

## Node.js から使う

HTTP を通さずに使うなら、[packages/core](./cli-usage.md#nodejs-から使うpackagescore) を直接読むほうが速いです。
