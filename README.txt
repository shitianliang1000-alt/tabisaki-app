旅さき サイト再設計パッケージ（生成済み版）

【このZIPの中身】
- tour.html              : 表紙（メインページ）
- ssh.html               : SSH・端末版の紹介ページ
- mobile.html            : アプリ版の紹介ページ
- api.html               : APIの紹介ページ
- spots/                 : 観光地52ページ（個別51枚 + 一覧 index.html）← 生成済み！
- php/assets/            : CSS・JS（site.css, site.js, tour-polish.css）
- data/                  : 観光地データ（spots.mjs, photos.json）
- tools/                 : 更新用ビルドスクリプト（使わなくてもOK）
- tests/                 : 自動テスト

【配置手順】※ これだけ

1. バックアップ
   cp tour.html tour.html.bak
   cp php/assets/tour-polish.css php/assets/tour-polish.css.bak

2. ファイルをコピー（リポジトリルートに）
   cp tour.html ssh.html mobile.html api.html /path/to/tabisaki-app/
   cp -r spots/ /path/to/tabisaki-app/
   cp php/assets/site.css php/assets/site.js php/assets/tour-polish.css /path/to/tabisaki-app/php/assets/

3. コミット＆プッシュ
   git add tour.html ssh.html mobile.html api.html spots/ php/assets/
   git commit -m "サイト再設計: 観光地ページ・SSH・アプリ・API追加"
   git push

【変更点】
- 「順路が、地図に…」の地図カードを削除
- 「4万」→「40,000」に表記変更
- ナビに「観光地」「SSH・端末」「アプリ」「API」を追加
- 携帯用横スクロールサブナビ（.pagenav）を追加
- 観光地52ページ（51か所 + 一覧）を追加
- 各観光地ページにモデルコース（時刻つき4ステップ）を掲載

【写真について】
現在はWikipedia/Commonsの写真URLを参照する設定です。
写真が読み込まれる場合と、読み込まれない場合（地名の1文字目を表示した下地）があります。
写真を確実に表示したい場合は、tools/fetch_spot_photos.mjs を実行後、
tools/build_spot_pages.mjs で再生成してください（上級者向け）。

【ページ構成】
メインページ: /tour.html
├─ 観光地一覧: /spots/index.html
│  └─ 個別ページ: /spots/sensoji.html, /spots/fuji.html など51枚
├─ SSH・端末: /ssh.html
├─ アプリ版: /mobile.html
└─ API: /api.html
