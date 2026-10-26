# セキュリティについて

## 対象

- 公開サイト（Cloudflare Worker 版 <https://tabisaki-github-io.shitianliang1000.workers.dev/>、PHP 版 <https://tabisaki.site.je/>）
- このリポジトリのコード（`js/`・`server/`・`php/`・`tools/`）

古い版は直しません。いつも `main`（公開中のもの）だけを直します。

## 知らせかた

**脆弱性は Issue や Discussions に書かないでください**（直す前に誰でも読めてしまいます）。

1. リポジトリの **Security → Report a vulnerability**（GitHub の非公開の報告）から送ってください
2. 書いてほしいこと: どこで（URL・ファイル）、何が起きるか、再現の手順、考えられる影響

## 返事と対応

- 受け取ったら、なるべく1週間以内に返事をします（個人で運営しているので、遅れることがあります）
- 直したら、報告した人に知らせます。希望があれば、CHANGELOG にお名前を載せます
- 直すまでは、内容を公にしないようお願いします

## 特に気にしているところ

- APIキーがブラウザや公開ファイルに出ていないか（キーは Cloudflare Worker の secret にだけ置きます）
- 管理画面（`/admin`）が合言葉なしで開けないか
- 利用者の入力文・位置情報が外へ送られたり残ったりしていないか（位置は端末の中だけで使います）
- Worker の中継（`PROXY_URL`）が、旅さき以外から使われすぎないか（CORS・回数の制限）
