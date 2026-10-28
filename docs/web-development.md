# Web 版の開発（Web Development）

ブラウザ版（Cloudflare Worker と PHP 版）を手元で動かす・試験する・公開する手順です。

## 公開する（Cloudflare と PHP 版）

2026-10-22 から、GitHub Pages では公開しません。GitHub はプログラムの置き場とテスト（`test.yml`）だけです。
組み立て・試し・公開は、端末（SSH でも）から `./tabisaki` 1つでできます。
公開先は **Cloudflare Worker（正式）と PHP 版（InfinityFree）の2つだけ**で、どちらも同じ `tools/build_site.sh` の成果物を配り、canonical はどちらも workers.dev を名乗ります（`tests/canonical.test.js`）。
**試験が落ちたら公開しません**: Workers Builds では `tools/build_worker.sh` が組み立ての前に `node --test` を走らせ、`./tabisaki deploy` も先に試験を通します。

    ./tabisaki help          # 使いかた
    ./tabisaki serve php     # 手元で PHP 版を開く（http://127.0.0.1:8090/）
    ./tabisaki test          # 試験
    ./tabisaki deploy cf     # Cloudflare に上げる
    ./tabisaki deploy ftp    # InfinityFree に FTP で上げる（FTP_HOST などは .env.deploy に）

トップ（`/`）は Anthropic・OpenAI のサイトのような、動く紹介のページです。チャットの画面は `/app` です。
どちらも開いたときにサーバーが作ります（挨拶・季節・日替わりのおすすめ・実際に組んだコースの再生）。
トップのひな形は `php/inc/landing.html` の1つだけで、PHP 版（`php/inc/site.php`）と Cloudflare 版（`server/landing.js`）が同じ中身を入れます。
`tests/landing.test.js` が、両方の HTML が1字も違わないことを確かめます。

- **Cloudflare Worker**（`wrangler.jsonc`）: AIの中継・管理画面に加えて、サイトそのものも配ります。Workers Builds が push ごとに `tools/build_worker.sh` で `.site/` を組み立てて上げます。`/`・`/app`・`/index.html` は Worker が作り、ほかは静的なファイルをそのまま返します。管理画面のファイルは `.site/__admin/` に入り、合言葉を通ったときだけ見えます。
- **PHP 版**（InfinityFree など）: `./tabisaki php --zip` で `tabisaki-php.zip` ができます。中身をサーバーの `htdocs/` に上げれば動きます。`index.php`（トップ）と `app.php`（チャットの画面）が PHP で、ほかは静的なファイルです。PHP 版のアドレスは、Worker の `ALLOW_ORIGIN` に足してください（AIを呼べるようにするため）。

どちらも `tools/build_site.sh` を通るので、**公開するのはブラウザが読むものだけ**です。`admin/`・`tests/`・`tools/`・`server/`・`data/` や README は公開されません。公開に要るファイルを増やしたら、`tools/build_site.sh` に足してください。

### 管理画面を開く

管理画面（`admin/`）には認証が無いので、PHP 版には入れません。中継の Worker が、合言葉を聞いてから見せます（`server/admin.js`）。

1. 合言葉を Worker に入れる（一度だけ）: `npx wrangler secret put ADMIN_PASSWORD`、またはダッシュボードの Workers & Pages → `tabisaki-github-io` → Settings → Variables and Secrets → Add で、種類を Secret、名前を `ADMIN_PASSWORD` にします。
2. `https://tabisaki-github-io.shitianliang1000.workers.dev/admin` を開き、ユーザー名は何でも、パスワードに合言葉を入れます。

合言葉を入れていないあいだ、`/admin` は 404 です。手元で見るだけなら、リポジトリの一番上で `python3 -m http.server 8000` を動かし、`http://localhost:8000/admin/` を開いてもかまいません（読むだけの項目だけ動きます）。

項目: 概要 / 使用量 / 旅程の結果 / エラー / kb/ 点検 / スポット。

- **件数・変更待ち**は Worker の Durable Object（`STATS`、`server/stats.js`）に貯めます。Analytics Engine や KV・D1 のような、ダッシュボードで先に有効にする作業は要りません（デプロイで自動で作られます）。IP・入力した文・地名・旅程は残しません。利用者の区別は「その日だけの塩＋IP」のハッシュ頭8文字で、日をまたいでは追えません。古い件数は90日で消えます。件数はメモリに貯めて30秒ごとにまとめて書きます（Durable Object の無料枠は書き込みが1日10万行までなので）。
- **旅程の結果**（成功率・かかった時間・AIに聞いた回数・入力条件の分布）は、「使われかたの集計に協力しない」にチェックを入れていない人のぶんです（初期は協力する）。決まった選択肢と数だけが届きます（`js/metrics.js`）。
- **回数の上限**は、Worker の環境変数（`RATE_FREE_PER_MINUTE`・`RATE_PAID_PER_HOUR` など）で変えます。管理画面の「設定」タブ（入口の入り切り・上限の保存）は、2026-10 にやめました。
- **スポットの追加・削除・分類の直し**は、管理画面では「変更待ち」に積むだけで、公開サイトには出ません。書き込みは合言葉を通った管理画面からだけです。Worker の secret `GITHUB_TOKEN`（このリポジトリだけに絞った fine-grained token。Contents と Pull requests に Read and write）を入れると「PRにする」で `kb/` の変更を PR にします。入れていないときは「JSONで書き出す」→ `node tools/apply_kb_edits.mjs kb-edits.json` で手元に当てます。

公開する URL を変えたら、`index.html` の OGP（`og:url` / `og:image` / canonical）と `sitemap.xml`・`robots.txt` の絶対 URL も合わせて書き換えてください。

`.github/workflows/test.yml` は pull request と `main` への push ごとに、単体テスト・PHP 版の組み立てと、ブラウザを使う E2E テスト・読み上げと色のテスト（外へは出ない設定）を走らせます。

エリア別のページを手元で見るときは、作ってから開きます。

```bash
node tools/build_area_pages.mjs dist
cp -r index.html css js kb icon.svg og.png dist/
python3 -m http.server 8000 --directory dist   # http://localhost:8000/areas/
```

## ローカルで動かす

ES Modulesを使っているため、`file://` で直接開くのではなくHTTPサーバーから起動してください。

Pythonだけで起動できます。

```bash
python3 -m http.server 8000
```

その後、ブラウザで以下を開きます。

```text
http://localhost:8000
```

### ポイント

- `npm install` は本体の実行には必要ありません
- APIキーなしでも基本機能を確認できます
- `packages/core/src/config.js` を変更したらブラウザを再読み込みしてください

## テスト

### 単体テスト

Node.jsの標準テストランナーを使います。

```bash
node --test tests/*.test.js
```

旅程生成、営業時間、経路、知識ベース、天気などの各モジュールを個別に検証できます。

### E2Eテスト

画面操作まで確認するテストは `tests/e2e/` に分離しています。

```bash
npm i -D playwright-core axe-core
npx playwright install chromium
python3 -m http.server 8000 &
node tests/e2e/run.mjs
E2E_OFFLINE=1 node tests/e2e/run.mjs   # 外へ出られない環境では、こちら
```

### 読み上げ・色・構造のテスト

薄すぎる文字や、ボタンの中のボタンは、目で見ているぶんには気づけません。
axe-core に測らせます。

```bash
node tests/e2e/a11y.mjs
```

詳細は [tests/e2e/README.md](../tests/e2e/README.md) を参照してください。
