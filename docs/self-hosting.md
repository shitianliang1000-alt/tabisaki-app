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
curl -X POST http://127.0.0.1:8787/plan \
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

失敗はどれも `{ "ok": false, "error": { "code": "…", "message": "…" } }` の形です。

| 状態 | code | いつ |
|---|---|---|
| 400 | `invalid_input` / `unknown_place` / `invalid_json` | 入力のまちがい（`message` に日本語の理由） |
| 404 / 405 | `not_found` / `method_not_allowed` | `POST /plan` と `GET /health` 以外 |
| 413 | `too_large` | 本文が 4KB を超えた |
| 415 | `unsupported_media_type` | `Content-Type: application/json` でない |
| 422 | `plan_failed` | 条件に合う旅程を組めなかった |
| 429 | `rate_limited` | 1つの相手から1分に30回を超えた（`Retry-After`） |
| 503 | `busy` | 同時に2本を組んでいる（`Retry-After`） |
| 504 | `timeout` | 30秒で組み終わらなかった |

`GET /health` は `{"ok":true,"version":"0.1.0","spots":53734}` を返します（Docker の HEALTHCHECK もこれを見ます）。

## 安全のための初期設定

- **認証がありません。** だから既定では `127.0.0.1`（その端末の中）でしか待ち受けません。`compose.yaml` も `127.0.0.1:8787` にだけ出しています
- ほかの端末から使うときは、`HOST=0.0.0.0` にして、手前に認証のある逆プロキシ（VPN・SSH のポート転送など）を置いてください。**インターネットにそのまま出さないでください。** 公開して使うための要件（認証・回数の制限）は Issue #376 で決めます
- 記録（stderr）には、時刻・道・状態・かかった時間だけを出します。**入力の文は残しません**
- 入れ物は読み取り専用（`read_only: true`）で、root ではない利用者（`node`）で動きます
- 設定は環境変数で: `HOST`（既定 127.0.0.1、Docker では 0.0.0.0）、`PORT`（既定 8787）

## Node.js から使う

HTTP を通さずに使うなら、[packages/core](./cli-usage.md#nodejs-から使うpackagescore) を直接読むほうが速いです。
