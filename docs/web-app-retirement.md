# サイト版（ブラウザで使う Webアプリ）をやめる範囲

方針（2026-11）: サイト版のアプリはやめ、**CUI と携帯アプリ（Capacitor）に絞る**。サイトは AI の部分を除いた
ソフトウェアの紹介ページにする（別の作業）。

携帯アプリは `mobile/build.sh` が `tools/build_site.sh` の出力をそのまま包んでいます。つまり **Webアプリの画面と
エンジンのファイルは、アプリの中身としてそのまま要ります**。やめるのは「サイトとして配ること」だけです。

## 残すもの（アプリの中身）

* `index.html`（チャットの画面。アプリは `www/index.html` として開く）・`css/`・`js/`・`packages/core/src/`
* `kb/`・`spots/`・`vendor/`・`data/` のうちアプリが読むもの、アイコン類・`manifest.webmanifest`
* `tools/build_site.sh`（分けるなら、アプリ用に上の一式を出す版を残す）
* 中継（`server/worker.js`）の AI・乗り換え・天気などの API 入口と、`OWN_ORIGINS` の `https://app.tabisaki`・`capacitor://app.tabisaki`
* 設定（`js/settings-panel.js`・`packages/core/src/app-settings.js`）とスクレイピング（`js/scrape-button.js`・`packages/core/src/scrape.js`）

## やめるもの（サイトとしての配り）

| 場所 | 中身 |
| --- | --- |
| `server/worker.js`・`server/landing.js` | `/app` と `?p=`・`#t=` の共有リンクを開いたときに作る部分。中継の API 入口は残す |
| `php/app.php` と `.htaccess` の `/app` | PHP 版のチャットの画面 |
| トップ（`php/inc/landing.html` など） | 入力欄・`go=1` で /app へ送るフォームと例のリンク、AI の説明の部分 |
| エリアページ（`tools/build_area_pages.mjs`） | 「この旅をアプリで組む」など /app へのリンク |
| `sitemap.xml`・`robots.txt` | `/app` |
| `sw.js` | サイトで Service Worker を登録すること（アプリは登録しない。`js/native.js`） |
| `js/native.js` の `shareBase` | アプリから共有するリンクの行き先（いまは サイトの `/app`）。紹介ページか、受け取った人がアプリで開ける形に変える |

`/app` を消したあと、古い共有リンク（`/app?p=…`）は紹介ページへ転送するのがよい（404 にしない）。
