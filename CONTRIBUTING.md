# 旅さきの開発に参加する

旅さきに手を貸してくださってありがとうございます。この文書は、手元で動かすところから
プルリクエスト（PR）を出すまでの手順と、守ってほしい決まりをまとめたものです。

- 質問・アイデア → [Discussions](../../discussions)（無いときは Issue の「機能の要望」）
- 不具合 → Issue の「不具合の報告」
- スポットの情報がまちがっている → Issue の「スポット情報の訂正」
- 脆弱性 → **Issue に書かず**、[SECURITY.md](./SECURITY.md) の方法で

## 1. 手元で動かす

要るもの: Node.js 22 以上、Python 3（簡単なサーバーに使うだけ）。ビルドは要りません。

```sh
git clone https://github.com/shitianliang1000-alt/tabisaki-app.git
cd tabisaki-app
python3 -m http.server 8000      # http://localhost:8000/index.html を開く
```

- APIキーが無くても旅程は作れます（行き先は `kb/` の収録データ、移動時間は距離から推定）
- AI を手元で試したいときは [API_KEYS.md](./API_KEYS.md) を見てください。**キーを書いた `js/config.js` は commit しないでください**
- 公開と同じ形（Cloudflare 版・PHP 版）で見るときは `./tabisaki help`
- 端末で旅程を組んで確かめるときは `./tabisaki plan "温泉と海" --days=2`（[docs/cli-usage.md](./docs/cli-usage.md)）

## 2. 試験

```sh
node --test tests/*.test.js       # 単体試験（依存パッケージなしで動きます）
node tools/kb_check.mjs           # 知識ベースの点検（誤りがあると終了コード 1）
```

画面の試験（E2E）と読みやすさの試験はブラウザが要ります。手順は [tests/e2e/README.md](./tests/e2e/README.md) です。

PR を出すと GitHub Actions（`.github/workflows/test.yml`）が全部を走らせます。
**試験が落ちたものは公開されません**（Cloudflare の Workers Builds も `./tabisaki deploy` も、先に試験を通します）。

## 3. 守ってほしい決まり

- **APIキーをブラウザに置かない。** AI や経路の API は Cloudflare Worker の中継（`PROXY_URL`、`server/`）を通します
- **管理画面（`admin/`）は公開しない。** 合言葉を通ったときだけ Worker が返します
- **位置情報は端末の中だけで使う。** 外へ送らない、残さない
- **データを足すときは出典と条件を確かめる。** `kb/index.json` の `sources` と [credits.html](./credits.html) も直します
- **Cloudflare 版と PHP 版をそろえる。** トップ・`/app`・404 などの画面を変えたら `php/` 側も直し、`sh tools/build_php.sh .php-site` が通ることを確かめます
- 新しい依存パッケージは、なるべく足さない（本体はビルドなしで動くのが前提です）
- コードの注釈・文書は日本語で、短く分かりやすく書きます

## 4. ブランチと PR の決まり

規模が小さいので、`main` と作業用ブランチの2段だけにします（`develop` は置きません）。

| ブランチ | 用途 |
|---|---|
| `main` | 公開されている状態。**直接 push しない** |
| `feature/…`・`fix/…`・`docs/…`・`claude/…` | 作業用。1つの PR に1つの目的 |

PR の流れ:

1. `main` から作業用ブランチを切る
2. 変更して、手元で `node --test tests/*.test.js` を通す
3. PR を出す（ひな形の項目を埋める。直す Issue があれば `Fixes #番号`）
4. **マージの条件**: CI（`test` と `e2e` の2つのジョブ）が緑で、持ち主（@shitianliang1000-alt）が見て良いとしたもの
5. マージは「Create a merge commit」を使います（履歴にどの PR かが残るように）

`main` の保護（ブランチ保護ルール）は、リポジトリの Settings → Branches で次のように設定します（持ち主の作業です）:
- Require a pull request before merging
- Require status checks to pass: `test`、`e2e`
- Do not allow force pushes / deletions

## 5. はじめての方へ

`good first issue` の印が付いた Issue は、次のような小さく安全なものです。

- 文書の誤字・リンク切れ・古い説明の修正
- スポットの情報の訂正（説明文・営業時間・座標）
- 試験を1つ足す（`tests/` に同じ形の例がたくさんあります）

印を付けるときは、Issue に「期待する結果」「難しさ（小・中）」「確かめかた」を書いてください。
わからないことは、その Issue に質問を書いてもらえれば答えます。

## 6. 変更の履歴

利用者から見える変更をしたら、[CHANGELOG.md](./CHANGELOG.md) の「まだ版にしていない変更」に1行足してください。
版の付けかたは [docs/releases.md](./docs/releases.md) です。

参加する人はみな [行動規範](./CODE_OF_CONDUCT.md) に従います。
