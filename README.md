# 旅さき

**「行きたいこと」から旅程をつくる、ブラウザベースのAI旅行プランナー。**

> 「温泉と海をゆっくり楽しみたい」のように希望を入力すると、行き先・立ち寄る順番・移動時間・営業時間などを考慮して旅程を組み立てます。

**▶ 公開サイト: <https://tabisaki-github-io.shitianliang1000.workers.dev/>**（正式なアドレス。同じものを PHP 版 <https://tabisaki.site.je/> でも配っています）

- ビルド不要・サーバー不要。
- APIキーが無くても旅程は作れます（移動時間は距離からの推定、行き先は収録データから）
- 実際の乗換・所要時間やAIによる選定を使いたいときは、**画面右上の ⚙ →「開発者向け」から自分のキーを入れられます**（キーはその端末の中だけに保存されます）

---

## ✨ このプロジェクトについて

「有名な場所をいくつか並べる」だけではなく、**実際にその日に回れる旅程**を作ることを目標にしています。

旅さきでは、AIにすべてを任せるのではなく、役割を分けています。

- **AI**：希望文の理解、行き先・スポットの選定、必要に応じた追加調査
- **プログラム**：営業時間、移動時間、食事時間、帰着期限などの制約処理
- **知識ベース**：多数の観光スポットを検索するためのデータ
- **外部API**：経路、天気、写真などの補助情報

AIが返したスポットIDも候補集合と照合し、**存在しない場所をそのまま旅程に採用しない**設計になっています。

---

## 🚀 主な特徴

### 自然な文章から旅程を作成

「京都で歴史を感じたい」「温泉に入りつつ海も見たい」のような文章から希望を読み取ります。

### 時間を考慮して旅程化

単なるおすすめ一覧ではなく、次の条件を考慮して時刻を割り当てます。

- 開館時間・営業時間
- 最終入場・到着期限
- スポット間の移動時間
- 食事に必要な時間
- 1日に動ける時間
- 帰着時刻
- 宿泊地・チェックイン条件

### 定番と穴場を調整

「定番中心」「穴場を多め」など、候補の傾向をスライダーで調整できます。

### 混雑・天気・季節を考慮

混雑しやすい場所を朝に回す、天気や日没を考えて順番を調整する、といった再計画に対応しています。

### 日帰り・複数日・国内外に対応

出発地、最終目的地、帰着地を分けて扱えるため、単純な往復だけでなく片道旅や周遊旅にも対応します。

### 写真・地図・外部リンク

- **Leaflet + OpenStreetMap**：地図表示。広い画面（幅1360px以上）では地図を旅程の横に固定し、読んでいる立ち寄りの印を濃くします（`js/follow.js`）
- **Wikipedia**：代表写真の取得。記事名を持つ立ち寄りは、旅程のカードの上に写真を敷きます（取れなければ何も出しません）
- **Google Maps**：地図・旅行関連リンク

### エリア別のページ

`areas/` に、都道府県ごとの定番・穴場と、主なエリアの1日モデルコースのページを置きます（検索から場所の名前で来る人の入口です）。モデルコースはアプリと同じエンジンで組み、移動時間は距離からの目安です。公開のたびに `tools/build_area_pages.mjs` が `kb/` から作るので、リポジトリには入っていません。共有したときの絵（`og:image`）も県・エリアごとに `tools/area_card.mjs` が収録の点だけで描きます（写真や地図タイルは使いません）。`sitemap.xml` の `lastmod` は、そのページの元になった県の収録ファイルが git で最後に変わった日です。

---

## 🧭 全体の処理フロー

```text
希望文
  ↓
AIで意味を理解
  ↓
知識ベースから候補を検索
  ↓
AIが行き先・スポットを選定
  ↓
経路を取得
  ↓
営業時間・移動時間・帰着期限などを検証
  ↓
問題があればAIに再計画を依頼
  ↓
必要なら候補を削って時間内に収める
  ↓
planner.js が時刻を割り当てる
  ↓
旅程 + 地図 + 補足情報
```

### AIとプログラムの役割分担

```text
AI                     プログラム
────────────────────────────────────
「何がしたい？」       → 制約を守れるか？
「どこが合いそう？」   → 開いているか？
「候補を選んで」       → 移動時間は足りるか？
「必要なら調べて」     → 帰着時刻に間に合うか？
                       → 最終的な時刻計算
```

**AIは「意味」と「選定」、プログラムは「制約」と「計算」を担当します。**

---

## 📁 プロジェクト構成

現在のリポジトリは、ビルドシステムに依存しないシンプルな構成です。

```text
.
├── index.html                 # アプリ本体
├── credits.html               # 著作権表記のページ（使っている地図・写真・データ・サービス）
├── icon.svg                   # アプリアイコン（ブラウザのタブ用）
├── icon-180.png               # iOS のホーム画面用（SVG は読まれません）
├── icon-192.png               # Android / PWA
├── icon-512.png               # Android / PWA
├── icon-maskable-512.png      # Android の切り抜き対応（内側80%に収めたもの）
├── og.svg                     # SNS共有時のOG画像（元データ）
├── og.png                     # og.svg を 1200×630 に焼き出したもの（共有先が読むのはこちら）
├── manifest.webmanifest       # PWA用マニフェスト
├── robots.txt
├── sitemap.xml
├── sw.js                      # Service Worker
│
├── css/
│   ├── hig-tokens.css         # カラー・デザイントークン
│   ├── hig.css                # ボタン・カード等の共通UI
│   ├── app.css                # アプリ固有のレイアウト
│   └── area.css               # エリア別のページ（areas/）
│
├── js/
│   ├── app.js                 # アプリの起点・画面連携
│   ├── ui.js                  # UI描画・入力処理
│   ├── pipeline.js            # 旅程生成パイプライン本体
│   │
│   ├── ai.js                  # AI呼び出し・意味理解・候補選定
│   ├── endpoints.js           # APIの接続先を切り替え
│   ├── config.js              # APIキー・モデル等の設定（ファイル側）
│   ├── settings.js            # 画面から入れたキーの保存（localStorage 側）
│   ├── quota.js               # クライアント側の使用量ゲート
│   │
│   ├── kb.js                  # 知識ベースの読み込み・検索
│   ├── keywords.js            # 希望文から検索語を抽出
│   ├── areas.js               # 地名・エリアの解釈
│   ├── discover.js            # 未収録の土地をAIで調査
│   ├── sample-data.js         # 収録済みサンプルデータ
│   │
│   ├── planner.js             # 時刻の割り当て
│   ├── verify.js              # 実時刻で旅程を検証
│   ├── feasibility.js         # 営業時間・移動時間の成立判定
│   ├── routes.js              # Google Routes API / 経路推定
│   ├── transit.js             # 公共交通の乗換・待ち時間
│   ├── trip.js                # 出発・帰着・宿泊など旅の条件
│   ├── stays.js               # 拠点と宿泊日数
│   │
│   ├── hours.js               # 営業時間・定休日・季節休業
│   ├── crowd.js               # 混雑の見込みと順番調整
│   ├── weather.js             # Open-Meteoの天気情報
│   ├── sun.js                 # 日の出・日の入り
│   ├── events.js              # 季節イベント・見頃
│   ├── luggage.js             # チェックアウト後の荷物
│   ├── lodging.js             # 宿泊地の選定
│   ├── cost.js                # 交通・食事・入場・宿泊費の概算
│   │
│   ├── fit.js                 # 希望との適合度
│   ├── score.js               # 旅程のスコアリング
│   ├── match.js               # 希望に応えられたかの判定
│   ├── variants.js            # ゆったり・王道・探索の3案
│   ├── replan.js              # 天気・混雑等による再計画
│   ├── relax.js               # 制約を緩めた場合の代替案
│   ├── confidence.js          # 情報の確からしさ
│   ├── errors.js              # エラーを旅行者向けに変換
│   ├── story.js               # 旅程の意味づけ
│   ├── today.js               # 旅行中モード
│   │
│   ├── geo.js                 # 国・空路・時差などの地理処理
│   ├── places.js              # 出発地・終着地候補
│   ├── map.js                 # OpenStreetMap / Leaflet
│   ├── follow.js              # 読んでいる立ち寄りを地図でも示す
│   ├── photos.js              # Wikipediaから代表写真を取得
│   ├── links.js               # Google Maps等へのリンク生成
│   ├── history.js             # 過去に作った旅の保存
│   ├── art.js                 # 写真がない場合の代替ビジュアル
│   ├── edit.js                # 「もっとゆっくり」等を条件へ変換
│   └── mix.js                 # 候補の組み合わせ調整
│
├── kb/
│   ├── index.json             # 知識ベースの入口・出典・件数
│   ├── regions.json           # エリア情報
│   └── spots-*.json           # 観光スポットのシャード
│
├── tools/
│   ├── build_kb.py            # 知識ベース生成
│   ├── build_area_pages.mjs   # エリア別のページと sitemap.xml（公開のたびに実行）
│   ├── area_card.mjs          # エリアのページの共有カード（収録の点で描く地図の PNG）
│   ├── clean_kb.py            # 不要・重複データの除去
│   ├── import_p27.py          # 国土数値情報「文化施設」の追加
│   ├── build_sample_data.py   # 同梱サンプルデータ生成
│   ├── extra_data.py          # 補助データ
│   └── vendor.sh              # 外部ライブラリ取り込み
│
├── wrangler.jsonc             # Cloudflare Worker の設定（一番上に置きます）
│
├── server/
│   ├── README.md              # APIキーをサーバー側で管理する方法
│   ├── worker.js              # Cloudflare Worker向けプロキシ
│   └── node-proxy.mjs         # Node.js向けプロキシ
│
├── admin/
│   ├── index.html             # 管理画面
│   ├── admin.js
│   └── admin.css
│
├── tests/
│   ├── *.test.js              # Node.js標準テストランナーによるテスト
│   └── e2e/                   # ブラウザを使うE2Eテスト（画面操作と、読み上げ・色）
│
├── README.md
└── API_KEYS.md                # APIキー設定の詳しい説明
```

---

## 🗃️ 知識ベース

`kb/` には、旅程候補を検索するための公開知識ベースが入っています。

現在の `kb/index.json`（`counts`）では、次の規模になっています。件数はここが唯一の出どころで、エリアのページもアプリもここから引きます（この表は tests/kb-counts.test.js が `counts` と照らし合わせます）。

| 項目 | 件数 |
|---|---:|
| エリア | **1,371** |
| スポット | **54,101** |

主なデータソースは以下です。

| データソース | 内容 |
|---|---|
| 国土数値情報「観光資源」 | 国土交通省 |
| 国土数値情報「文化施設」 | 国土交通省 |
| 収録済みサンプルデータ | 手作業で確認したデータ |
| Wikidata | CC0。名前・座標・分類 |
| Wikipedia | CC BY-SA。日本語版の一覧記事71本（各地の温泉地・古墳・山・川・寺院・島・史跡…と、47都道府県の観光地）から、記事名・座標・冒頭の説明。画面の出典は「Wikipedia」にまとめています |
| 各都道府県の公式観光サイト | 観光地の名前の一覧（xlsx）の出どころ。**「観光地として挙がっている」ことの確認にだけ**使い、名前・座標・説明は写していません（`tools/import_tourism_list.py`） |
| OpenStreetMap | **ODbL 1.0**。座標が引けなかった観光地の名前に、名前と県の一致で付けた座標（4,312件。`tools/import_osm_tourlist.py`）。下の「OpenStreetMap 由来の座標」を読んでください |
| Overture Maps | **CDLA Permissive 2.0 / Apache 2.0 / CC0**（出どころごと。1件ずつ `license` に持たせています）。座標が引けなかった観光地の名前に、名前と県の一致で付けた座標（1,515件。`tools/import_overture_places.py`）。**飲食店・宿・店は入れていません**（営業の状態がほぼ空で、閉業を見分けられないため）。表示は「Overture Maps Foundation, overturemaps.org」。共有の義務はありません |
| 座標つきの観光地一覧（いただいたもの） | 各都道府県の公式観光サイトの名前に、Yahoo!ローカルサーチ・コンテンツジオコーダ、国土地理院（住所検索API）、Wikipedia・Wikidata、Photon・Nominatim・Overpass API（OSM）で座標を付けた一覧から10,653件（`tools/import_tourism_coords.py`。`src="tourlist-geocoded"`、取得元は1件ずつ `geo`）。下の「座標つきの観光地一覧」を読んでください |

再配布の条件がはっきりしているものだけを収録する方針です。
観光資源台帳（日本観光振興協会）は、条件が曖昧なため収録していません
（`tools/drop_daicho.py`）。各都道府県の公式観光サイトの利用条件は確かめて
いないため、**その一覧から写しているものはありません**（名前が観光地として
挙がっているかの確認にだけ使っています）。

大きなデータを1つのJavaScriptファイルにまとめず、`spots-*.json` に分割して読み込む構成です。

### 知識ベースを作り直す

主な生成処理は `tools/build_kb.py` です。

```bash
python3 tools/build_kb.py <P12を展開したディレクトリ> <doc.kml> [出力先]
```

不要なデータの除去や文化施設データの追加には、次のツールがあります。

```bash
python3 tools/clean_kb.py ...
python3 tools/import_p27.py ...
```

---

## 🤖 AIを使う場合 / 使わない場合

AI用APIキーを設定しなくても、アプリ自体は動作します。

### APIキーなし

- 語句検索ベースで候補を選びます
- 同梱されている範囲のデータを中心に旅程を作ります
- Google Routes APIがなければ、移動時間は距離から推定します

### キーを入れる場所（2通り）

| 場所 | 向いている人 |
|---|---|
| **⚙ 設定 →「開発者向け」**（画面から入力） | 公開サイトを開いて使う人。キーはその端末の `localStorage` だけに残り、どこにも送られません。保存した直後から効きます |
| **`js/config.js`** | 自分で clone して動かす人。**公開すると誰からも見えるので、公開サイトの `config.js` には書かないでください** |

画面から入れたキーは `config.js` より優先されます。「確認」ボタンで1リクエストだけ送って疎通を確かめられ、Routes API が 403 を返したときは原因の切り分け（API未有効・請求先・キーのAPI制限・HTTPリファラー制限）まで日本語で出ます。

### Geminiを設定

`js/config.js` でモデルを設定すると、希望文の理解・候補選定・必要に応じた追加調査などをAIに任せられます。

現在の設定ファイルでは、主モデルとフォールバックモデルが指定されています。

```js
export const MODEL_PROVIDER = "gemini";
export const MODEL = "gemma-4-e2b-it";
export const FALLBACK_MODELS = [
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
];
```

### ローカルモデル

`MODEL_PROVIDER = "local"` にすると、Ollama / vLLM / llama.cpp serverなど、OpenAI互換APIを持つローカルモデルを利用できます。

ただし、ローカルモデルではGoogle検索による追加調査やGeminiの構造化出力など、いくつかの機能が利用できません。

---

## 🔑 APIキーと公開サイトの注意

**公開サイトの `js/config.js` にAPIキーを直書きしないでください。** そこへキーを書くとブラウザを開いた利用者から確認できます。

公開サイトでキーを使う方法は2つです。

1. **使う人が自分のキーを持ち込む** — `config.js` は空のまま公開し、⚙ 設定から入れてもらう。キーはその人の端末から出ません（このリポジトリの公開サイトはこの構成です）
2. **自分のキーをサーバー側に置く** — `server/` のプロキシ実装を利用して以下の構成にする

```text
ブラウザ
  ↓
PROXY_URL
  ↓
自分のバックエンド
  ├─ Gemini API
  └─ Google Routes API
```

詳しくは **[API_KEYS.md](./API_KEYS.md)** と **[server/README.md](./server/README.md)** を参照してください。

### 最低限確認したい設定

- `PROXY_URL`：公開時はHTTPSのバックエンドを指定
- `ALLOW_ORIGIN`：自分のサイトだけに制限
- `ALLOWED_MODELS`：利用可能なモデルを制限
- Google側のAPIキー制限
- サーバー側のレート制限

---

## 🗺️ 外部サービス

| サービス | 用途 | なくても動く？ |
|---|---|---|
| OpenStreetMap | 地図タイル | 地図表示を使う場合に必要 |
| Leaflet | 地図UI | 地図表示に必要 |
| Google Gemini | AIによる理解・選定・調査 | ✅ |
| Google Routes API | 実際の経路・移動時間 | ✅（距離推定にフォールバック） |
| Open-Meteo | 天気 | ✅ |
| Wikipedia | スポット写真の取得 | ✅ |

---

## 🚀 公開する（Cloudflare と PHP 版）

2026-10-22 から、GitHub Pages では公開しません。GitHub はプログラムの置き場とテスト（`test.yml`）だけです。
組み立て・試し・公開は、端末（SSH でも）から `./tabisaki` 1つでできます。

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

項目: 概要 / 設定 / 使用量 / 旅程の結果 / エラー / kb/ 点検 / スポット。

- **件数・設定・変更待ち**は Worker の Durable Object（`STATS`、`server/stats.js`）に貯めます。Analytics Engine や KV・D1 のような、ダッシュボードで先に有効にする作業は要りません（デプロイで自動で作られます）。IP・入力した文・地名・旅程は残しません。利用者の区別は「その日だけの塩＋IP」のハッシュ頭8文字で、日をまたいでは追えません。古い件数は90日で消えます。
- **旅程の結果**（成功率・かかった時間・AIに聞いた回数・入力条件の分布）は、「使われかたの集計に協力しない」にチェックを入れていない人のぶんです（初期は協力する）。決まった選択肢と数だけが届きます（`js/metrics.js`）。
- **機能の入り切りと上限**は、管理画面で保存すると、30秒ほどで Worker に効きます。
- **スポットの追加・削除・分類の直し**は、管理画面では「変更待ち」に積むだけで、公開サイトには出ません。書き込みは合言葉を通った管理画面からだけです。Worker の secret `GITHUB_TOKEN`（このリポジトリだけに絞った fine-grained token。Contents と Pull requests に Read and write）を入れると「PRにする」で `kb/` の変更を PR にします。入れていないときは「JSONで書き出す」→ `node tools/apply_kb_edits.mjs kb-edits.json` で手元に当てます。

公開する URL を変えたら、`index.html` の OGP（`og:url` / `og:image` / canonical）と `sitemap.xml`・`robots.txt` の絶対 URL も合わせて書き換えてください。

`.github/workflows/test.yml` は pull request と `main` への push ごとに、単体テスト・PHP 版の組み立てと、ブラウザを使う E2E テスト・読み上げと色のテスト（外へは出ない設定）を走らせます。

エリア別のページを手元で見るときは、作ってから開きます。

```bash
node tools/build_area_pages.mjs dist
cp -r index.html css js kb icon.svg og.png dist/
python3 -m http.server 8000 --directory dist   # http://localhost:8000/areas/
```

## ▶️ ローカルで動かす

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
- `js/config.js` を変更したらブラウザを再読み込みしてください

---

## 🧪 テスト

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

詳細は [tests/e2e/README.md](./tests/e2e/README.md) を参照してください。

---

## 🧩 重要な設計ポイント

### 1. AIに最終的な時刻計算を任せない

AIには候補の意味理解・選定を担当させ、最終的な時間計算はプログラムで行います。

### 2. 候補IDを検証する

AIから返ったIDをそのまま信用せず、候補集合と照合します。

### 3. 収録外データも検証してから採用する

`discover.js` によってAIが調査した場所も、そのまま旅程へ入れるのではなく、座標や地域などを機械的に確認してから候補に加えます。

### 4. 問題のある旅程は理由付きで再計画する

営業時間や到着期限に合わない候補を落とすだけではなく、失敗理由を保持してAIへ返し、再計画に利用します。

### 5. 候補を多めに用意して最後に検証する

旅程に入る候補数より多くを最初に用意し、時間に収まらないものを検証段階で削る設計です。

---

## 🛠️ 開発するときの入口

| 目的 | 最初に見るファイル |
|---|---|
| 画面や入力を変える | `index.html` / `js/ui.js` / `js/app.js` |
| 旅程生成の流れを変える | `js/pipeline.js` |
| AIの動作を変える | `js/ai.js` / `js/config.js` |
| 候補検索を変える | `js/kb.js` / `js/keywords.js` / `js/areas.js` |
| 時刻・営業時間の判定を変える | `js/planner.js` / `js/verify.js` / `js/feasibility.js` / `js/hours.js` |
| 経路を変える | `js/routes.js` / `js/transit.js` |
| 天気・混雑・季節対応 | `js/weather.js` / `js/crowd.js` / `js/events.js` / `js/sun.js` |
| 新しいデータを追加する | `kb/` / `tools/` |
| APIキーの扱いを変える | `js/config.js` / `server/` / `API_KEYS.md` |
| テストを追加する | `tests/` |

---

## 📌 関連ドキュメント

- **[API_KEYS.md](./API_KEYS.md)** — APIキー、AIモデル、検索機能の設定
- **[server/README.md](./server/README.md)** — APIキーをブラウザから隠すためのバックエンド構成
- **[tests/e2e/README.md](./tests/e2e/README.md)** — E2Eテストの実行方法

---

## 📄 ライセンス・外部データについて

このリポジトリで利用している地図・外部データ・APIには、それぞれ提供元の利用規約・ライセンスがあります。

公開・商用利用の前に、各サービスの最新の規約を確認してください。特に `kb/index.json` に記載されている外部データソースは、それぞれ利用条件が異なります。

画面から見られる一覧は **[credits.html](./credits.html)**（条件の画面の下のリンク）です。
データや外部サービスを足した・外したときは、そこも直してください。

### 国土数値情報の「非商用」のデータ

国土数値情報のうち「観光資源（P12）」「文化施設（P27）」「バス停留所（P11）」は、
使用許諾条件が**非商用**です。利用規約（<https://nlftp.mlit.go.jp/ksj/other/agreement_02.html>）
では、非商用のデータは**複製物の再配布ができず**、データベースの形で使う場合は
運営事務局への相談が求められています。`kb/` はこれらを加工して JSON のまま公開して
いるので、**このまま公開してよいかは確かめていません。** 鉄道（N02、2008年度版）は商用可です。
外すときは、観光資源が `src="kokudo"`、文化施設が `dataSource` に「文化施設」、
バス停が `kb/stops-bus*` です。

### OpenStreetMap 由来の座標

`tools/import_osm_tourlist.py` が入れた座標（`src="osm-tourlist"`、元の番号は
`osm="node/123"`）は、**OpenStreetMap のデータで、ODbL 1.0 です**。

- **「© OpenStreetMap contributors」の表示が必須です。** 著作権表記の
  ページ（`credits.html`、画面の下のリンク）に出しています。消さないでください
- **同じ条件で共有する義務があります**（share-alike）。これらの座標を含む
  `kb/` は、ODbL の派生データベースにあたります。再配布するときは、その部分
  を ODbL で共有してください
- まとめて外すときは、`src="osm-tourlist"` の印で消えます
  （`python3 tools/import_osm_tourlist.py` は走らせるたびに前回のぶんを取り除きます）

ライセンスの全文: <https://opendatacommons.org/licenses/odbl/1-0/>

### 座標つきの観光地一覧

`tools/import_tourism_coords.py` が入れたもの（`src="tourlist-geocoded"`）は、
いただいた一覧の座標です。

- **Yahoo! JAPAN の API で取った座標が9割です。** 著作権表記のページに「Web Services by
  Yahoo! JAPAN」を出しています。**取った座標を保存して配ってよいかは、
  Yahoo! の利用規約を確かめていません。** 公開の前に確かめてください。
  外すときは `src="tourlist-geocoded"`（取得元ごとなら `geo`）の印で消えます
- 祭りなどの追加表記は外して入れました（`listedAs` に一覧の名前が残ります）
- 一覧の県の外に落ちた座標は、県境から15km以内だけを採りました。それより
  遠いもの（約2,000件）は、別の県の同じ名前に当たった疑いが強いので入れて
  いません（鳥取県「長谷寺」→ 広島県の長谷寺 など）
- 一覧の「まとめ名」の列は使っていません。別々の場所が1つにまとまっていた
  り（「徳島県立」）、座標がメンバーの平均だったりしたためです

### 県が食い違う座標

一覧の県と、座標のある県が違うものがあります（名前が全国で1つだけの場所など）。
ご指示で入れていますが、**別の場所を取り違えている可能性が、県が合うものより高いです。**
一覧の県は `listedIn` に残してあります。見直すときは、`listedIn` があるものから見てください。

---

## 🌱 今後の改善候補

- スクリーンショットまたはデモGIFをREADME冒頭に追加
- ODPT（公共交通オープンデータ）の時刻表連携

---

## 👤 Project

**旅さき** — 「行きたいこと」から、実際に回れる旅程へ。
