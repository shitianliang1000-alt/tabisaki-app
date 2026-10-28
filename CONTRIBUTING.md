## Getting Started
まず [docs/](docs) の文書を読んで、コードと開発の環境に慣れてください。しくみとファイルの構成は [docs/architecture.md](docs/architecture.md)、Web 版を手元で動かす・試験する手順は [docs/web-development.md](docs/web-development.md) です。手が足りていない作業は [Issue](../../issues) にあります。「good first issue」の印が付いたものから始めるのがおすすめです。これからの大きな計画は [docs/roadmap.md](docs/roadmap.md) にあります。

質問やアイデアは [Discussions](../../discussions)（無いときは Issue の「機能の要望」）へ、不具合は Issue の「不具合の報告」へ、スポットの情報のまちがいは Issue の「スポット情報の訂正」へどうぞ。脆弱性は **Issue に書かず**、[SECURITY.md](SECURITY.md) の方法で知らせてください。大きな変更は、取りかかる前に Issue で相談してください。

要るのは Node.js 22 以上と Python 3（簡単なサーバーに使うだけ）です。ビルドは要りません。

```sh
git clone git@github.com:shitianliang1000-alt/tabisaki-app.git
cd tabisaki-app
python3 -m http.server 8000      # http://localhost:8000/index.html を開く
node --test tests/*.test.js       # 単体試験（依存パッケージなしで動きます）
node tools/kb_check.mjs           # 知識ベースの点検（誤りがあると終了コード 1）
node tools/plan_bench.mjs --check # 旅程の成立率（基準より悪いと終了コード 1。docs/benchmarks.md）
node tools/perf_bench.mjs --check # 速さ（上限を超えると終了コード 1。docs/performance.md）
```

SSH の鍵は GitHub → Settings → SSH and GPG keys で登録します。APIキーが無くても旅程は作れます。AI を手元で試したいときは [API_KEYS.md](API_KEYS.md) を見てください（**キーを書いた `packages/core/src/config.js` は commit しないでください**）。端末で旅程を組んで確かめるときは `./tabisaki plan "温泉と海" --days=2`（[docs/cli-usage.md](docs/cli-usage.md)）、公開と同じ形（Cloudflare 版・PHP 版）で見るときは `./tabisaki help` です。画面の試験（E2E）と読みやすさの試験はブラウザが要ります。手順は [tests/e2e/README.md](tests/e2e/README.md) です。

## Style Guide
本体はビルドなしでブラウザと Node.js の両方で動く JavaScript（ES modules）です。新しい依存パッケージは、なるべく足さないでください。データを作る道具（`tools/`）は Python と Node.js です。

画面の文や文書は、むずかしい言葉や略語を避けて、短く分かりやすく書きます。

### Comment Style
コードの注釈と文書は日本語で書きます。注釈は、続くコードのあらましか、コードを読んでも分からない設計の理由を書くためのものです。書きすぎないでください。コードより注釈が長くなったら、短くできないか考えてください。作業の経過や、消したコードの言いわけは書きません。

## Design Philosophy
- **APIキーをブラウザに置かない。** AI や経路の API は Cloudflare Worker の中継（`PROXY_URL`、`server/`）を通します。
- **管理画面（`admin/`）は公開しない。** 合言葉を通ったときだけ Worker が返します。
- **位置情報は端末の中だけで使う。** 外へ送らない、残さない。
- **AI に時刻の計算を任せない。** AI が選んだ場所も、収録の候補と照らし合わせてから使います（[docs/architecture.md](docs/architecture.md) の「重要な設計ポイント」）。
- **Cloudflare 版と PHP 版をそろえる。** トップ・`/app`・404 などの画面を変えたら `php/` 側も直し、`sh tools/build_php.sh .php-site` が通ることを確かめます。

## Data Sources
収録データ（`kb/`）は、外のデータを取り込んで作っています。データを足すときは、出典と再配布の条件を確かめてから、`kb/index.json` の `sources`、[credits.html](credits.html)、[docs/data-licenses.md](docs/data-licenses.md) を直してください。条件がはっきりしないものは入れません。作り直す手順は [docs/knowledge-base.md](docs/knowledge-base.md) です。

## Translations
旅さきの原文は日本語です。英語などへの翻訳は、画面の文を `locales/<言語>.json` に、スポットの名前・説明を `kb/i18n/<言語>/` に書きます。収録ファイルや原文は書き換えません。訳が無いところは日本語の原文が出るので、一部だけの訳でも送ってください。

決まり（鍵と差し込み・数で変わる文・日付と時刻・スポットの訳の原文と出典）と手順は [docs/i18n.md](docs/i18n.md) です。送る前に `node tools/i18n_check.mjs` を通してください。

## Branches and Pull Requests
規模が小さいので、`main` と作業用ブランチの2段だけにします（`develop` は置きません）。`main` は公開されている状態なので、直接 push しないでください。作業用ブランチ（`feature/…`・`fix/…`・`docs/…`・`claude/…`）は、1つの PR に1つの目的にします。

1. `main` から作業用ブランチを切る
2. 変更して、手元で `node --test tests/*.test.js` を通す
3. PR を出す（ひな形の項目を埋める。直す Issue があれば `Fixes #番号`）
4. CI（`test`・`e2e`・`docker` のジョブ）が緑で、持ち主（shitianliang1000-alt）が見て良いとしたものをマージする
5. マージは「Create a merge commit」を使う（履歴にどの PR かが残るように）

PR を出すと GitHub Actions（`.github/workflows/test.yml`）が全部の試験を走らせます。**試験が落ちたものは公開されません**（Cloudflare の Workers Builds も `./tabisaki deploy` も、先に試験を通します）。

`main` の保護は、リポジトリの Settings → Branches で次のように設定します（持ち主の作業です）。

* Require a pull request before merging
* Require status checks to pass: `test`、`e2e`
* Do not allow force pushes / deletions

### Good First Issues
「good first issue」の印は、次のような小さく安全なものに付けます。印を付けるときは、Issue に「期待する結果」「難しさ（小・中）」「確かめかた」を書いてください。

* 文書の誤字・リンク切れ・古い説明の修正
* スポットの情報の訂正（説明文・営業時間・座標）
* 試験を1つ足す（`tests/` に同じ形の例がたくさんあります）

## Changelog
利用者から見える変更をしたら、[CHANGELOG.md](CHANGELOG.md) の「まだ版にしていない変更」に1行足してください。版の付けかたは [docs/releases.md](docs/releases.md) です。

## License
このリポジトリのプログラムは [PolyForm Noncommercial License 1.0.0](LICENSE) です。PR で送ってもらったコードや文書も、同じ条件で配ることに同意したものとして扱います。参加する人はみな [行動規範](CODE_OF_CONDUCT.md) に従います。
