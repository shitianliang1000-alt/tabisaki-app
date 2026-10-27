# 変更の履歴

旅さきの、利用者から見える変更をまとめます。細かい変更はプルリクエスト（PR）の一覧を見てください。
版の付けかたは [docs/releases.md](./docs/releases.md) にあります。

書きかた: 新しい PR をマージしたら「まだ版にしていない変更」に1行足します。
版を出すときに、その見出しを版の番号と日付に変えます。

## まだ版にしていない変更

- 乗り換え検索で、駅すぱあと・NAVITIME・HERE・Transitous の API を使えるようにしました（中継の `POST /transit`。キーのあるものから順に試します。[docs/transit-apis.md](./docs/transit-apis.md)）
- **ライセンスを The Unlicense から PolyForm Noncommercial License 1.0.0 に変えました（商用利用はできません）。** これより前に公開した版は Unlicense のままです。収録データは、それぞれの提供元の条件に従います

- リポジトリの運用を整えました: Issue・PR のひな形、[CONTRIBUTING.md](./CONTRIBUTING.md)、[SECURITY.md](./SECURITY.md)、行動規範、この履歴、版の付けかた、これからの計画（[docs/roadmap.md](./docs/roadmap.md)）
- 知識ベースの点検（`tools/kb_check.mjs`）を足し、PR ごとと週に1回走らせるようにしました
- 端末から旅程を組む `./tabisaki plan` と、Node.js から使う入口 `packages/core` を足しました（[docs/cli-usage.md](./docs/cli-usage.md)）
- 組んだ旅程を端末の中でキーボードだけで見る `./tabisaki tui` を足しました
- 手元用の API サーバー（`POST /plan`、`docker compose up`）を足しました（[docs/self-hosting.md](./docs/self-hosting.md)）
- API サーバーに鍵（`TABISAKI_API_TOKEN`）・`/v1/` の道・CORS の許可リスト・要求番号（`X-Request-Id`）を足しました。127.0.0.1 以外で待ち受けるときは、鍵が無いと起動しません（[docs/api.md](./docs/api.md)）
- README の古い説明（⚙ 設定からキーを入れる、など）を今のつくりに合わせました
- 経路・天気・地名・スポットの取り口を差し替えられるようにしました。キー不要の `mock` と通信しない `off` もあります（[docs/data-providers.md](./docs/data-providers.md)）
- README と CONTRIBUTING を [UTM](https://github.com/utmapp/UTM) の文書の形（短い README と、くわしい内容を `docs/` に分ける）にそろえました
- 旅程を組む部分（59ファイル）を `js/` から `packages/core/src/` へ移しました。Web 版・CLI・TUI・API が同じファイルを使います（[packages/core/README.md](./packages/core/README.md)）。画面の動きは変わりません
- 旅程を英語でも出せるようにしました（`./tabisaki plan --lang=en`、API の `"lang": "en"`）。翻訳の決まりと送りかたは [docs/i18n.md](./docs/i18n.md)、点検は `tools/i18n_check.mjs` です
- 行ってきた旅の「見込みと違ったところ」を、任意で端末の中に残せるようにしました。送るのは利用者が GitHub の画面で自分で送ったときだけです（[docs/feedback.md](./docs/feedback.md)）
- 手元の LLM（Ollama など）で旅程を組めるようにしました（`./tabisaki plan --local`、確かめとモデルの取得は `./tabisaki local setup --pull`。[docs/local-llm.md](./docs/local-llm.md)）
- 知識ベースを地域ごとに切り出し（`./tabisaki kb extract --region=関東`）、似たスポットを探せるようにしました（`./tabisaki similar "清水寺"`。[docs/kb-extract.md](./docs/kb-extract.md)）

## 0.1.0 — 2026-10-25（最初の版にする予定のところ）

ここまでに入った主な変更です（タグはまだ付けていません）。

### 2026-10-22 〜 25: 公開のしかたを変えた

- GitHub Pages をやめ、Cloudflare Worker と PHP 版（InfinityFree）で公開するように（#161）
- 動く紹介のトップ（`/`）とチャットの画面（`/app`）、紹介ページ（#160・#161）
- 正式なアドレスを workers.dev に（#166）、404 のページ、トップの構造化データ（#164）
- 設定の画面をなくし、トップから書いてそのまま旅程を組めるように（#165）
- 試験が通ったものだけを公開する。圏外でのホーム画面からの起動を試験する（#153・#169）
- トップの見本のレイアウトのずれ（CLS）を直す（#168）

### 2026-10-11 〜 15: チャットの画面と AI

- 旅程づくりをチャットの画面に（#132〜#134）
- 質問か旅程の頼みかを AI が決め、旅行以外の質問にも答える（#139〜#144）
- AI は Gemma だけ。考え中の印、質問から「そこ行ってみたい」でプランへ（#147）
- 短いやりとりも「最近のチャット」に残す（#148）、Gemma のチャットでネット検索（#152・#154）
- 旅の目的（デート・アクティブ・のんびり・子どもと・学び）で選ぶ（#158）
- 上高地を独立したエリアに（#155）

### 2026-10-09 〜 10: データと経路

- 全国のスポット（約5万4千件）、写真・地図、都道府県のページ
- バス・飛行機の経路、名前の付いた長い旅（最長往復切符など）
- 著作権表記のページ（credits.html）
