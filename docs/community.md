# 発信とコミュニティ

旅さきを知ってもらい、使った人の声を集めるための計画です。**まだ始めていません。** 投稿や場所づくりは持ち主（shitianliang1000-alt）が決めて行います。

いつも守ること:

* **「商用利用はできません」をはっきり書く。** 記事・発表・紹介文のどれにも、ライセンス（[PolyForm Noncommercial 1.0.0](../LICENSE)）へのリンクを付けます。「自由に使えます」「だれでも使えます」のような、商用利用もできると読める言いかたはしません。
* **自分で作ったものだと書く。** 宣伝なのに第三者のふりをする書きかたはしません。
* **再配布を確かめていないデータを勧めない。** `kb/` には再配布の条件を確かめていないデータがあります（[data-licenses.md](./data-licenses.md)）。記事の中で「`kb/` を取って自分のサービスに使える」のようには書きません。
* **AI が書いた文は、自分で確かめてから出す。** 動く手順・数字・画面は、出す前に手元で試します。

## 対象読者

| だれ | 知ってほしいこと | 入口 |
|---|---|---|
| 旅行の計画を立てる人 | 文で頼むと、その日に回れる旅程になる | Web 版 |
| 端末で道具を使う開発者 | `./tabisaki plan` で旅程が Markdown・JSON で出る。依存なし・通信なし | README と [cli-usage.md](./cli-usage.md) |
| 地図・観光データに詳しい人 | スポット情報の訂正、データの出どころの改善 | Issue の「スポット情報の訂正」 |
| JavaScript を書く人 | 小さな Issue から参加できる | [CONTRIBUTING.md](../CONTRIBUTING.md) の Good First Issues |

## デモ

すでにあるもの:

* Web 版: <https://tabisaki-github-io.shitianliang1000.workers.dev/>（PHP 版 <https://tabisaki.site.je/>）
* 端末の画面: [screen.png](../screen.png)
* Web 版の動き: プロジェクトのファイル `screens/app-motion/app-motion.mp4`（リポジトリには入れていません）

これから用意するもの:

* 端末で動かす短い例（3行で旅程が出るところ）。記事の冒頭にそのまま貼れる形にします

```sh
git clone git@github.com:shitianliang1000-alt/tabisaki-app.git && cd tabisaki-app
./tabisaki plan "温泉と海をゆっくり楽しみたい" --days=2
```

* 端末の録画（asciinema などの文字の録画か GIF）。`./tabisaki plan` と `./tabisaki tui`
* Web 版の 30 秒ほどの動画（頼む → 旅程 → 地図）

画面を撮るときは、地図の帰属表示（© OpenStreetMap）と写真の出典が写る形にします。個人の位置や、キーを書いた `js/config.js` が写らないようにします。

## 発信先

| 場所 | 読む人 | 出すもの | 規約で気をつけること |
|---|---|---|---|
| [Zenn](https://zenn.dev/) | 日本語の開発者 | 作りかたの記事 | [ガイドライン](https://zenn.dev/guideline): 宣伝が主目的の投稿は避ける（宣伝は記事末尾の固定メッセージ程度）。誇張したタイトルにしない。生成 AI を使うなら正確さを確かめる |
| [Qiita](https://qiita.com/) | 日本語の開発者 | 技術の解説記事 | [ガイドライン](https://help.qiita.com/ja/articles/qiita-community-guideline): 宣伝・販売が主目的の記事は出さない（自作の技術的な解説は宣伝に当たらない）。AI の文は確かめてから |
| [DEV Community](https://dev.to/) | 英語の開発者 | 英語版の記事（多言語対応 #379 のあと） | [Code of Conduct](https://dev.to/code-of-conduct) と [Terms](https://dev.to/terms) |
| 勉強会の LT（connpass などで探す） | 近い分野の開発者 | 5分の発表 | 会ごとの決まり（録画・資料の公開） |
| GitHub（README・Release） | リポジトリに来た人 | 変更点と使いかた | — |

規約は変わるので、**投稿のたびに読み直します。** 上の内容は 2026-10-27 に読んだものです。

同じ記事を何か所にも貼りません。1つの場所に書き、ほかからはリンクします。

## 記事の案

1. **「その日に回れる」旅程の組みかた**（Zenn）: 営業時間・最終入場・移動時間を守って時刻を割り当てるしくみ。AI に時刻を任せない理由
2. **依存なし・通信なしの CLI を Node.js で作る**（Qiita）: `./tabisaki plan` と TUI を `npm install` なしで作ったときの工夫
3. **AI が出した場所を、収録データと照らし合わせる**（Zenn）: 無い場所を旅程に入れないための照合
4. **観光データの出どころとライセンスを調べた記録**（Zenn）: 国土数値情報・OSM・Wikidata の条件の違い。[data-licenses.md](./data-licenses.md) をもとに

どの記事も、終わりに「旅さきは非商用ライセンスです」と Issue・Discussions へのリンクを1段落だけ付けます。

## 問い合わせ先

| 用件 | 送り先 |
|---|---|
| 質問・アイデア・感想 | [Discussions](https://github.com/shitianliang1000-alt/tabisaki-app/discussions)（有効にするまでは Issue の「機能の要望」） |
| 不具合 | Issue の「不具合の報告」 |
| スポットの情報のまちがい | Issue の「スポット情報の訂正」 |
| 脆弱性 | Issue に書かず [SECURITY.md](../SECURITY.md) の方法で |
| ライセンス・商用利用の相談 | 商用利用の許可は出していません（[governance.md](./governance.md)） |

個人のメールアドレスや SNS の DM は、問い合わせ先にしません（記録が残らず、ほかの人も読めないため）。

## 常設の場所（Discord・Slack など）

| 場所 | よいところ | 保守の手間 | 判断 |
|---|---|---|---|
| GitHub Discussions | リポジトリと同じ場所。検索できて記録が残る。追加の費用なし | 小さい（Issue と同じ通知） | **まずこれだけ使う**（有効にするのは持ち主の作業、#343） |
| Discord | すぐ話せる。旅行好きにも届きやすい | 大きい（荒らし対策・ロール・常に見張る人） | 見送り |
| Slack | 開発者に慣れた人が多い | 大きい（無料版は古いメッセージが見られなくなる） | 見送り |

Discord などは、Discussions で1か月に 10 件ほどの話題が続くようになってから、もう一度考えます。そのときも、決まったことは Issue か Discussions に書き戻します。

## 進めかた

1. GitHub Discussions を有効にする（持ち主、#343）
2. 端末の短い例と録画を用意する
3. 記事 1 を Zenn に出す。反応を見て次を決める
4. 3 か月ごとに、Issue・Discussions・Star の数と、来た質問をこの文書に短く書き足す

アクセス数の計測は、今は止めています（Analytics Engine を有効にするまで）。数は GitHub で見られるものだけを使います。
