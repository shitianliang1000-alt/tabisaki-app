# しくみ（Architecture）

旅さきのエンジンがどう旅程を組むか、どのファイルが何をしているかをまとめます。

## このプロジェクトについて

「有名な場所をいくつか並べる」だけではなく、**実際にその日に回れる旅程**を作ることを目標にしています。

旅さきでは、AIにすべてを任せるのではなく、役割を分けています。

- **AI**：希望文の理解、行き先・スポットの選定、必要に応じた追加調査
- **プログラム**：営業時間、移動時間、食事時間、帰着期限などの制約処理
- **知識ベース**：多数の観光スポットを検索するためのデータ
- **外部API**：経路、天気、写真などの補助情報

AIが返したスポットIDも候補集合と照合し、**存在しない場所をそのまま旅程に採用しない**設計になっています。

## 主な特徴

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

## 全体の処理フロー

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

## プロジェクト構成

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
├── js/                        # 画面（DOM・地図・入力）。旅程を組む部分は packages/core/src/ から読みます
│   ├── app.js                 # アプリの起点・画面連携
│   ├── ui.js                  # UI描画・入力処理
│   ├── fit.js                 # 希望との適合度
│   ├── variants.js            # ゆったり・王道・探索の3案
│   ├── confidence.js          # 情報の確からしさ
│   ├── errors.js              # エラーを旅行者向けに変換
│   ├── today.js               # 旅行中モード
│   ├── map.js                 # OpenStreetMap / Leaflet
│   ├── follow.js              # 読んでいる立ち寄りを地図でも示す
│   ├── photos.js              # Wikipediaから代表写真を取得
│   ├── links.js               # Google Maps等へのリンク生成
│   ├── history.js             # 過去に作った旅の保存
│   ├── art.js                 # 写真がない場合の代替ビジュアル
│   └── edit.js                # 「もっとゆっくり」等を条件へ変換
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
├── packages/
│   ├── core/                  # 旅程を組む部分（Web・CLI・TUI・API で共通。README.md）
│   │   ├── index.mjs          # Node.js から使う入口（createCore・CoreError）
│   │   ├── format.mjs         # Markdown・文・JSON への書き出し
│   │   └── src/               # 本体。ブラウザでも Node.js でも動きます
│   │       ├── pipeline.js            # 旅程生成パイプライン本体
│   │       ├── ai.js                  # AI呼び出し・意味理解・候補選定
│   │       ├── endpoints.js           # APIの接続先を切り替え
│   │       ├── config.js              # APIキー・モデル等の設定（ファイル側）
│   │       ├── settings.js            # 画面から入れたキーの保存（localStorage 側）
│   │       ├── quota.js               # クライアント側の使用量ゲート
│   │       ├── kb.js                  # 知識ベースの読み込み・検索
│   │       ├── keywords.js            # 希望文から検索語を抽出
│   │       ├── areas.js               # 地名・エリアの解釈
│   │       ├── discover.js            # 未収録の土地をAIで調査
│   │       ├── sample-data.js         # 収録済みサンプルデータ
│   │       ├── planner.js             # 時刻の割り当て
│   │       ├── verify.js              # 実時刻で旅程を検証
│   │       ├── feasibility.js         # 営業時間・移動時間の成立判定
│   │       ├── routes.js              # Google Routes API / 経路推定
│   │       ├── transit.js             # 公共交通の乗換・待ち時間
│   │       ├── trip.js                # 出発・帰着・宿泊など旅の条件
│   │       ├── stays.js               # 拠点と宿泊日数
│   │       ├── hours.js               # 営業時間・定休日・季節休業
│   │       ├── crowd.js               # 混雑の見込みと順番調整
│   │       ├── weather.js             # Open-Meteoの天気情報
│   │       ├── sun.js                 # 日の出・日の入り
│   │       ├── events.js              # 季節イベント・見頃
│   │       ├── luggage.js             # チェックアウト後の荷物
│   │       ├── lodging.js             # 宿泊地の選定
│   │       ├── cost.js                # 交通・食事・入場・宿泊費の概算
│   │       ├── score.js               # 旅程のスコアリング
│   │       ├── match.js               # 希望に応えられたかの判定
│   │       ├── replan.js              # 天気・混雑等による再計画
│   │       ├── relax.js               # 制約を緩めた場合の代替案
│   │       ├── story.js               # 旅程の意味づけ
│   │       ├── geo.js                 # 国・空路・時差などの地理処理
│   │       ├── places.js              # 出発地・終着地候補
│   │       ├── mix.js                 # 候補の組み合わせ調整
│   │       └── root.js                # アプリの一番上の場所（まとめる前・後どちらでも）
│   ├── cli/                   # ./tabisaki plan の本体
│   ├── tui/                   # ./tabisaki tui（端末の中で旅程を見る）
│   └── server/                # 手元用の API サーバー（Dockerfile・compose.yaml）
├── docs/                      # CLI の使いかた・ロードマップ・版の付けかた
│
├── tests/
│   ├── *.test.js              # Node.js標準テストランナーによるテスト
│   └── e2e/                   # ブラウザを使うE2Eテスト（画面操作と、読み上げ・色）
│
├── README.md
└── API_KEYS.md                # APIキー設定の詳しい説明
```

## 重要な設計ポイント

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

## 開発するときの入口

| 目的 | 最初に見るファイル |
|---|---|
| 画面や入力を変える | `index.html` / `js/ui.js` / `js/app.js` |
| 旅程生成の流れを変える | `packages/core/src/pipeline.js` |
| AIの動作を変える | `packages/core/src/ai.js` / `packages/core/src/config.js` |
| 候補検索を変える | `packages/core/src/kb.js` / `packages/core/src/keywords.js` / `packages/core/src/areas.js` |
| 時刻・営業時間の判定を変える | `packages/core/src/planner.js` / `packages/core/src/verify.js` / `packages/core/src/feasibility.js` / `packages/core/src/hours.js` |
| 経路を変える | `packages/core/src/routes.js` / `packages/core/src/transit.js` |
| 天気・混雑・季節対応 | `packages/core/src/weather.js` / `packages/core/src/crowd.js` / `packages/core/src/events.js` / `packages/core/src/sun.js` |
| 新しいデータを追加する | `kb/` / `tools/` |
| APIキーの扱いを変える | `packages/core/src/config.js` / `server/` / `API_KEYS.md` |
| テストを追加する | `tests/` |
