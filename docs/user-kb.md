# 自分の知識ベース（ユーザーKB）

公式の収録（`kb/`）には手を入れずに、自分でスポットを足したり、説明や料金を直したり、行きたくない場所を外したりする仕組みです。

```sh
./tabisaki plan "高尾山で景色" --kb=mine     # ~/.tabisaki/kbs/mine/ の差分を重ねて組む
```

端末からの足しかた・直しかた・取り込みかたは「[コマンド](#コマンド)」に、その下にある**データの形と決まり**はそのあとに書きます。コードは [`packages/core/userkb.mjs`](../packages/core/userkb.mjs)（形）・[`packages/core/spotio.mjs`](../packages/core/spotio.mjs)（取り込み・書き出し）・[`packages/cli/bin/spotkb.mjs`](../packages/cli/bin/spotkb.mjs)（コマンド）、試験は [`tests/userkb.test.js`](../tests/userkb.test.js)・[`tests/spotio.test.js`](../tests/spotio.test.js)・[`tests/spotkb.test.js`](../tests/spotkb.test.js) です。

## コマンド

```sh
./tabisaki spot add name=裏高尾の湧き水 lat=35.64 lng=139.25 genres="nature;view" dwell=20
./tabisaki spot add                         # 項目を書かずに端末で動かすと、1つずつ聞きます
./tabisaki spot edit takao-1 fee=300 --unset=tel
./tabisaki spot rm 高尾山山頂 --reason=混みすぎる   # 端末なら確かめます。スクリプトからは --yes
./tabisaki spot restore 高尾山山頂
./tabisaki spot list                        # 自分が足した・直した・消したもの
./tabisaki spot list --all --q=薬王院       # 収録からも探す
./tabisaki spot show takao-1                # 収録の値と、直した値を並べて
./tabisaki spot import mymaps.kml --dry-run
./tabisaki spot export --format=geojson --out=mine.geojson
./tabisaki spot dedup                       # 足したスポットのうち、収録や互いに重なっていそうなもの
```

| コマンド | すること | おもなオプション |
|---|---|---|
| `spot add [項目=値 …]` | スポットを足す。100m 以内に同じ名前があれば止めます | `--force`（それでも足す） |
| `spot edit <スポット> 項目=値 …` | 直す。公式のスポットは差分（`patch`）として持ちます | `--unset=項目,…` |
| `spot rm <スポット>` | 消す（印を付けるだけ） | `--reason=…`・`--yes` |
| `spot restore <スポット>` | 消した印・直した差分を取り消す | |
| `spot list` | 差分のあるスポットの一覧 | `--all --q=語`・`--limit=50` |
| `spot show <スポット>` | 1件の中身と差分の状態 | |
| `spot import <ファイル>` | CSV・GeoJSON・KML・JSON から足す | `--format`・`--encoding`・`--dry-run`・`--strict`・`--allow-dup` |
| `spot export` | 足したスポットを書き出す | `--format`・`--out`・`--with-edited` |
| `spot dedup` | 重なっていそうなものを並べる（消すのは利用者） | `--radius=100`（m） |

どのコマンドも `--kb=<名前>` で書く先を選べます。書かなければ、環境変数 `TABISAKI_KB`、`kb switch` で決めたもの、どちらも無ければ `mine` の順に使います。まだ無いユーザーKB は、はじめて書くときに作ります。`list`・`show`・`import`・`dedup` は `--output=json` で JSON を返します。

`<スポット>` は id（`takao-1`・`u:…`）か名前です。同じ名前がいくつもあるときは、候補の id を出して止めます。`spot show` は、ユーザーKB に差分があるスポット（と `u:` の id、`--kb` を書いたとき）だけをこの形で出し、それ以外は収録の情報（[spot-data.md](./spot-data.md)）を出します。

終了コードは `0` = できた、`1` = できなかった（取り込みで一部の行が入らなかったときを含む）、`2` = 使いかたのまちがい、です。

## 取り込み・書き出し

| 形 | 拡張子 | 読む | 書く |
|---|---|---|---|
| CSV | `.csv`・`.tsv` | 1行目が列名。カンマかタブ区切り。引用符の中の改行・`""` も読みます | 列は `id,name,lat,lng,category,genres,…`。改行は CRLF |
| GeoJSON | `.geojson`・`.json` | `FeatureCollection` の `Point` だけ | `tabisaki.schema` を付けます |
| KML | `.kml` | Google マイマップの書き出し（`<Placemark>` の `<Point>`）。CDATA も読みます | `ExtendedData` に項目を入れます |
| JSON | `.json` | 旅さきの `tabisaki.spots/1` | 同じ形 |

**列名。** CSV は `name`・`lat`・`lng` のほか、`名前`・`名称`・`緯度`・`経度`・`住所`・`説明`・`分類`・`料金` などの日本語の列名も読みます。使わなかった列は、黙って捨てずに「使わなかった列」として知らせます。

**文字コード。** UTF-8（BOM があってもよい）でなければ、Shift_JIS として読みます（表計算ソフトの既定のため）。`--encoding=shift_jis` で決めることもできます。

**部分失敗。** おかしい行は、行番号と理由を出して飛ばし、残りは足します。そのときの終了コードは `1` です。`--strict` を付けると、1行でもおかしければ1行も足しません。`--dry-run` は何も書かずに、足せる行・重なり・まちがいを数えます。

| 見つけること | 扱い |
|---|---|
| 必須の項目が無い・値の形がちがう | その行を飛ばし、理由を出す |
| 緯度と経度が逆（日本の外になり、入れ替えると日本に入る） | 「入れ替わっているようです」と出して飛ばす |
| `0,0` | 座標が入っていないとみなして飛ばす |
| 点（Point）でない形 | 飛ばす |
| 収録・ユーザーKB・同じファイルの中に、100m 以内で同じ名前 | 重なりとして飛ばす。`--allow-dup` で足す |
| 2万行より多い | 全体を断る（分けてください） |

**書き出し。** 既定では、自分で足したスポットだけを書き出します（収録のスポットは、それぞれの出どころの条件があるため）。`--with-edited` で、直した公式のスポットも直したあとの値で入ります。`--out` のファイルがもうあるときは上書きせず、新しく作るファイルは `0600` です。書き出したものは、そのまま `spot import` で取り込み直せます。

**安全のため。** CSV の欄が `=`・`+`・`-`・`@` などで始まるときは、頭に `'` を付けて書き出します（表計算ソフトで式として動かないように）。取り込むときは外します。KML の `DOCTYPE`・`ENTITY` は読みません（外のファイルを読ませる仕掛けを防ぐため）。

## 分ける・比べる・まとめる

ユーザーKB は、いくつも持てます。「家族の旅」「ひとり旅」のように分けておき、あとで片方の変更をもう片方へ取り込めます。

```sh
./tabisaki kb ls                            # 一覧（* が、いま使っているもの）
./tabisaki kb fork family --title=家族の旅  # いまの KB を写して、family を作る
./tabisaki kb switch family                 # これからは family に書く（plan も family を重ねて組む）
./tabisaki spot edit takao-1 fee=800
./tabisaki kb switch mine
./tabisaki kb diff family                   # mine から family への違い
./tabisaki kb merge family --dry-run        # 取り込むとどうなるか（書き込みません）
./tabisaki kb merge family                  # family の変更を mine に取り込む
./tabisaki kb validate                      # 点検
./tabisaki kb stats                         # 件数・都道府県の分布・更新の時刻
```

| コマンド | すること |
|---|---|
| `kb ls` | ユーザーKBの一覧。題・件数・最後に書いた日・分けた元 |
| `kb create <名前>` | 空のユーザーKBを作る |
| `kb fork [<元>] <先>` | 分ける。元を書かなければ、いま使っているもの。`--switch` でそのまま切り替え |
| `kb switch <名前>` | いま使うユーザーKBを決める。`--official` でやめる |
| `kb current` | いま使っているユーザーKBの名前 |
| `kb diff [<a>] [<b>]` | a から b への違い。何も書かなければ「公式の収録 → いまの KB」 |
| `kb merge <相手>` | 相手の変更を、いまの KB に取り込む。相手は名前か、別の端末から持ってきた `overlay.json` |
| `kb validate [<名前>]` | 形・必須の項目・座標・公式の収録とのつながりを点検する。`--strict` で「気をつけること」もまちがい扱い |
| `kb stats [<名前>]` | 件数・都道府県とエリアの分布・直した項目・更新の時刻・ファイルの大きさ |
| `kb backups`・`kb restore <控え>` | 控えの一覧と、控えから戻すこと |
| `kb rm <名前> --yes` | 消す（`trash/` へ動かすだけ） |

`kb extract`・`kb index`（収録の切り出しと索引。[kb-extract.md](./kb-extract.md)）は、これまでどおりです。

### 名前と、分けた元

ユーザーKB を見分けるのは**名前**です（`^[a-z0-9][a-z0-9_-]{0,39}$`）。`official` は公式の収録を指す名前なので、ユーザーKB には使えません。

分けたとき（`kb fork`）、新しいユーザーKB の `overlay.json` に、分けた元を書きます。

```json
{ "name": "family", "parent": { "name": "mine", "forkedAt": "2026-11-11T11:10:00.000Z" } }
```

あわせて、分けたときの中身を `bases/mine.json` に控えます。これが、あとでまとめるときの**土台**です。

### いま使うユーザーKB

`kb switch <名前>` は、置き場の根の `current-kb` に名前を1行書きます。使うユーザーKB は、次の順で決まります。

| | `spot`・`kb` のコマンド | `plan`・`tui`・`trace` |
|---|---|---|
| 1 | `--kb=<名前>` | `--kb=<名前>`（`--kb=official` で重ねない） |
| 2 | 環境変数 `TABISAKI_KB` | `kb switch` で決めたもの |
| 3 | `kb switch` で決めたもの | 重ねない（公式の収録だけ） |
| 4 | `mine` | |

`plan` が `kb switch` で決めたものを重ねたときは、その旨を1行出します。決めた先が読めないときは、公式の収録だけで組みます。

### 違いの形

違いは、スポットの id ごと・項目ごとに出します（`kbmerge.diffOverlays`）。書いた時刻（`at`）だけの違いは数えません。

```text
mine → family: 4 件
~ takao-1 高尾山薬王院
    description: （そのまま） → 家族向け
    fee: 600 → 800
+ takao-2 高尾山山頂［family で消した］
- takao-3 高尾山ケーブルカー［mine で直した。family には無い］
    fee: 100
+ u:mwc0pptu78f281a4 公園［family で足した］
    name: 公園
```

`~` は両方にあって中身が違う差分、`+` は b にだけある差分、`-` は a にだけある差分です。`（そのまま）` はその項目に触っていないこと、`（なし）` は外したことです。

`<a>`・`<b>` には、名前のほかに次のものを書けます。

| 書きかた | 指すもの |
|---|---|
| `official` | 公式の収録（差分なし） |
| `mine@20261111T111041498Z.json` | `mine` の控え（`kb backups` で一覧） |
| `./other.json` | ファイル（別の端末から持ってきた `overlay.json` など。読むだけ） |

### まとめかた（3者の統合）

`kb merge <相手>` は、**土台**（最後に同じ中身だったときの控え）・**自分**（いまの KB）・**相手** の3つを、スポットごと・項目ごとに比べます。

| 土台から見て | 扱い |
|---|---|
| 相手だけが変えた | 相手の値を取り込む |
| 自分だけが変えた | 自分のまま |
| 両方が同じに変えた | そのまま（競合にしない） |
| 両方が、同じスポットの**別々の項目**を変えた | 両方を取り込む |
| 両方が、同じスポットの**同じ項目**を別の値にした | **競合**（項目ごと。`takao-1#fee`） |
| 片方が消し、片方が直した。片方が差分を取り消し、片方が直した | **競合**（スポットごと。`takao-1`） |

土台は、分けたとき（`fork`）と、まとめ終わったとき（`merge`）に `bases/<相手>.json` へ控えます。どちらの側に控えてあっても、新しい方を使います。だから、`family` を `mine` にまとめたあとで `mine` を `family` にまとめても、同じ変更をもう一度聞かれることはありません。

別の端末から持ってきたファイルのように土台が無いときは、**どちらも空から始めた**として比べます。両方にある差分が同じ値なら競合にせず、違う値のところだけを競合にします。土台のファイルが手元にあれば、`--base=<ファイル>` で渡せます。

**競合の解きかた。** 競合が残っているうちは、**1文字も書き込みません**。

```text
$ tabisaki kb merge family
takao-1#fee　高尾山薬王院 の fee
    分かれる前: 500
    mine: 600
    family: 800
続けるとき: tabisaki kb merge --continue --pick=takao-1#fee=theirs（または =ours。全部なら --ours / --theirs）
やめるとき: tabisaki kb merge --abort
```

| やりかた | 書きかた |
|---|---|
| 端末で1つずつ答える | `kb merge family`（`o` = 自分、`t` = 相手、`s` = あとで） |
| 1つずつ指す | `--pick=takao-1#fee=theirs,takao-2=ours` |
| 残りを全部 | `--ours`（自分）・`--theirs`（相手） |

まとめたあとは、相手から足されたスポットが、もとからあるものと重なっていそうなら知らせます（同じ名前で 100m 以内）。消すかどうかは利用者が決めます。

### 途中で止まったとき

| 止まったところ | 残るもの | 戻しかた |
|---|---|---|
| 競合を解いている途中（端末を閉じた・`s` で中断した） | `MERGE.json`（相手の中身の写し・土台・ここまでの答え）。`overlay.json` は変わっていない | `kb merge --continue` で続きから。`kb merge --abort` でやめる |
| 途中のあいだに、自分の KB を別に書き換えた | 同上 | `--continue` は断ります（始めたときと中身が違うため）。`--abort` してやり直す |
| `overlay.json` を書いている最中 | 書く前の `overlay.json`（隣の一時ファイルに書いてから差し替えるので、半端な中身になりません） | そのまま `kb merge --continue` |
| 書いた直後、後片付けの前 | まとめ終わった `overlay.json` と `MERGE.json` | `kb merge --continue` が「書き込み済み」と見分けて、土台の控えと後片付けだけをします |
| まとめ終わったあとで、やっぱり戻したい | `backups/` の控え（まとめた直後に、その名前を出します） | `kb restore <控え>` |

`MERGE.json` があるあいだは、新しい統合を始めません（`--continue` か `--abort` を求めます）。相手の中身は、始めたときの写しを使います。途中で相手が変わっても、結果は変わりません。

### 点検（kb validate）

| | 見ること | 例 |
|---|---|---|
| ✗ まちがい | 形の版・`op`・必須の項目・値の範囲（[書ける項目](#書ける項目)） | `name` が無い、`lat` が 95 |
| ✗ | 足したスポットの座標が `0,0` | 入れ忘れ |
| ✗ | `regionId` のエリアが収録に無い | 打ちまちがい |
| ✗ | 直した結果、`close` が `open` より後でない | 公式は 8〜16 時、`open=17` に直した |
| ✗ | 足したスポットを消した印に、中身が残っていない | 手で書き換えた |
| △ 気をつけること | 直した・消した公式のスポットが、収録に見つからない | 収録から消えた（差分は使われません） |
| △ | 公式の id が変わっていて、名前と場所で当てている | |
| △ | 直したあとで、公式の側も同じ項目を変えた・同じ値になった | |
| △ | 日本の外の座標 | 緯度と経度が逆 |
| △ | 足したスポットどうしが、同じ名前で 100m 以内 | 2回取り込んだ |
| △ | 分けた元のユーザーKB が無い・公式の収録の版が変わった・上限に近い・途中の統合がある | |

まちがいが1つでもあれば、終了コードは `1` です。`--strict` を付けると、気をつけることがあっても `1` にします（CI や、配る前の確かめに）。ファイルが JSON として読めないときも、点検の結果として `1` を返します。

## 履歴・取り消し・スナップショット

ユーザーKB に書くたびに、何を変えたかを履歴に残します。まちがえたら取り消せて、どの値がいつ入ったかも、あとから調べられます。

```sh
./tabisaki spot history                     # いつ・どのコマンドで・何を変えたか（新しい順）
./tabisaki spot history takao-1             # そのスポットを変えたものだけ
./tabisaki spot undo                        # いちばん新しい変更を取り消す
./tabisaki spot undo takao-1                # そのスポットを最後に変えた分だけ取り消す
./tabisaki spot undo --seq=12 --dry-run     # #12 を取り消すとどうなるか（書き込みません）
./tabisaki spot redo                        # いちばん新しい取り消しを、取り消す
./tabisaki spot blame takao-1               # 項目ごとに、いまの値を最後に書いた変更
./tabisaki kb snapshot save before-trip --note=旅の前
./tabisaki kb snapshot restore before-trip
./tabisaki spot batch fix.js                # スクリプトでまとめて直す（まず試すだけ）
./tabisaki spot batch fix.js --apply        # 書き込む
./tabisaki kb git init                      # （git があれば）書くたびに git にもコミットする
```

| コマンド | すること | おもなオプション |
|---|---|---|
| `spot history [<スポット>]` | 履歴を新しい順に | `--limit=20` |
| `spot undo [<スポット>]` | 変更を取り消す | `--seq=<番号>`・`--dry-run`・`--force` |
| `spot redo` | いちばん新しい取り消しを、取り消す | |
| `spot blame <スポット>` | 項目ごとの出どころ | |
| `spot batch <スクリプト.js>` | スクリプトでまとめて直す | `--apply`・`--all`・`--q=語`・`--max=500`・`--timeout=5000` |
| `kb snapshot save [<名前>]` | いまの中身を、名前を付けて取っておく | `--note=…` |
| `kb snapshot ls` / `verify [<名前>]` | 一覧 / 取ったときのままかを確かめる | |
| `kb snapshot restore <名前>` | スナップショットの中身に戻す | |
| `kb snapshot rm <名前> --yes` | スナップショットを消す | |
| `kb git init` / `kb git status` | git への写しを始める / 様子を見る | |

どれも `--kb=<名前>` と `--output=json` が使えます。

### 決めたこと

| 決めること | 決めたこと | わけ |
|---|---|---|
| 履歴をどこに持つか | ユーザーKB のフォルダの `history.jsonl`。1つのコマンド = 1行 | git が入っていない端末でも、同じように動かすため。JSON の行なので、ほかの道具でも読めます |
| git を使うか | 使わなくても全部動く。`kb git init` をしたユーザーKB だけ、書くたびに git にもコミットする（写し） | git がある人は `git log`・`git diff`・自分のリモートへの `push` が使える。無い人も困らない |
| 取り消しのしかた | 履歴を書き換えず、「取り消した」という新しい行を足す（`git revert` と同じ考え） | 取り消しの取り消し（`redo`）ができる。履歴がうそをつかない |
| 取り消しがぶつかったら | 止めて、あとの変更の番号を見せる。`--force` であとの変更ごと戻す | あとから入れた変更を、黙って消さないため |
| 出どころ（blame）の単位 | スポットの項目ごと | 「この営業時間はいつ入れたか」を知りたいことが多いため |
| スナップショット | 名前を付けた、中身の写し。指紋（SHA-256）を一緒に持つ | 控え（`backups/`）は30個で古いものから消える。消えてほしくない時点は、名前を付けて取っておく |
| 一括編集 | スクリプトは「こう変えたい」を頼むだけ。書くのは旅さき。既定は試し（dry-run） | スクリプトのまちがいで、ユーザーKB を壊さないため |

### 履歴の形

`history.jsonl` の1行は、こういう形です。

```json
{"v":1,"seq":3,"at":"2026-11-11T11:46:14.401Z","cmd":"spot edit","note":"takao-1（fee・dwell）",
 "changes":[{"id":"takao-1","before":{"op":"patch","set":{"fee":300},"…":"…"},"after":{"op":"patch","set":{"fee":500,"dwell":40},"…":"…"}}]}
```

| 欄 | 中身 |
|---|---|
| `seq` | 通し番号（`spot history` の `#3`）。ユーザーKB ごとに 1 から |
| `cmd`・`note` | 書いたコマンドと、ひとこと |
| `changes` | 変わったスポットごとに、前の差分（`before`）と後の差分（`after`）。`null` は「差分なし（収録のまま）」 |
| `reverts` | 取り消しの行だけ。まるごと取り消した行の番号 |
| `undoes` | 取り消しの行だけ。もとにした行の番号（スポット1つだけを取り消したときも付きます） |

`cmd` には、コマンドの名前のほかに、次の2つが入ることがあります。

- `external`: 旅さきを通さずに `overlay.json` が書き換えられていた分です（手で直した・控えを手で写した）。次に旅さきが読み書きするときに、気づいて1行にします。取り消すときに、その変更を黙って消さないためです。
- `start`: 履歴を取りはじめる前からあった差分です（この機能より前に作ったユーザーKB）。

`history-head.json` は、最後に履歴へ書いたときの中身の控えです。これと `overlay.json` を比べて、`external` に気づきます。`overlay.json` を書いた直後に落ちて履歴に書けなかったときも、次の回に `external` として拾うので、変更は履歴から漏れません。

履歴が 20MB を超えたら `history.1.jsonl` に回して、新しく始めます（読むときは両方を読みます）。こわれた行（途中で止まった書き込み）は、飛ばして読みます。`kb fork` で分けたユーザーKB には、履歴もついていきます。

### 取り消し（undo・redo）

`spot undo` は、いちばん新しい「まだ取り消していない変更」を、その前の中身に戻します。取り込み（`spot import`）や統合（`kb merge`）、一括編集（`spot batch`）のように、たくさんのスポットを変えたコマンドも、1回で戻ります。

```text
$ tabisaki spot undo --seq=2
#2 spot edit（takao-1（fee））を取り消せません。そのあとで、同じスポットが変わっています:
  takao-1 高尾山薬王院（#3 で変更）
あとの変更を先に取り消す（tabisaki spot undo --seq=3）か、あとの変更ごと戻すなら --force を付けてください
```

| 場面 | 動き |
|---|---|
| 取り消したい変更のあとで、同じスポットが変わっている | 止まる（終了コード `1`）。何も書かない。`--force` で、その変更の前の中身に戻す（あとの変更も消えます） |
| もう前の中身に戻っている | 何もしない（「もう取り消されています」） |
| スポットを書いた（`spot undo takao-1`） | そのスポットを最後に変えた変更の、そのスポットの分だけを戻す。同じ変更のほかのスポットはそのまま |
| `spot redo` | いちばん新しい取り消しを取り消す。取り消したあとで別の変更をしていても、ぶつからなければできます |
| 取り消しを取り消したい（スポット1つだけの取り消し） | もう一度 `spot undo`（ふつうの変更として扱います） |

控えから戻す（`kb restore`）・スナップショットに戻す（`kb snapshot restore`）のも、履歴の1行になるので、`spot undo` で取り消せます。

### 出どころ（blame）

```text
$ tabisaki spot blame takao-1
高尾山薬王院（takao-1） ［直した］
  name: 高尾山薬王院    収録
  fee: 500              #3  2026-11-11 20:46  spot edit  takao-1（fee・dwell）
  dwell: 40             #3  2026-11-11 20:46  spot edit  takao-1（fee・dwell）
```

履歴を古い順にたどり、その行で値が変わった項目に、その行の番号を付け替えていきます。git の blame は行ごとですが、こちらは項目ごとです。

| 表示 | 意味 |
|---|---|
| `収録` | 公式の収録の値（ユーザーKB では変えていない） |
| `#3 … spot edit …` | その変更で入った値 |
| `（自動で付いた値）` | 足したスポットに、旅さきが付けた値（座標から決めたエリアなど） |
| `（履歴を取りはじめる前）` | 履歴に残っていない |

取り消し・やり直しの行は、出どころになりません。取り消して前の値に戻ったら、その値をもともと書いた行を指します（「いつ入れた値か」を知るためのものなので）。

### スナップショット

`kb snapshot save` は、いまの差分をまるごと `snapshots/<名前>.json` に写します。名前は英小文字・数字・`-`・`_`（60文字まで）。書かなければ日時（`20261111-204618`）にします。1つのユーザーKB に200個までです。

| | 控え（`backups/`） | スナップショット（`snapshots/`） |
|---|---|---|
| 取るとき | 書くたびに自動で | `kb snapshot save` をしたとき |
| 名前 | 日時 | 自分で付ける。ひとこと（`--note`）も書ける |
| 消えるとき | 30個を超えたら古いものから | `kb snapshot rm` をしたときだけ |
| 中身の確かめ | 形だけ | 形と、指紋（差分を決まった順に並べた JSON の SHA-256） |

指紋が合わないスナップショット（あとから書き換えられた・こわれた）には戻しません。`kb snapshot verify` は、戻す前に確かめるためのものです（1つでも合わなければ終了コード `1`）。指紋は「取ったときから変わっていないか」を見るもので、だれが取ったかを証明するものではありません。

### スクリプトでまとめて直す（spot batch）

```js
// fix.js: 足した滝に、滞在時間を入れる
for (const s of spots) {
  if (s.status === "add" && s.category === "滝" && s.dwell === undefined) edit(s.id, { dwell: 30 });
}
log("見た数", spots.length);
```

```text
$ tabisaki spot batch fix.js
  ｜見た数 12
fix.js: 見せたスポット 12・頼まれた変更 3・変わるスポット 3・まちがい 0
~ u:mwc1zgkv6b9c4b13 裏高尾の湧き水
    dwell: （そのまま） → 30
…
試しです。書き込むには --apply を付けてください
```

スクリプトから使えるものは、これだけです。

| 名前 | 中身 |
|---|---|
| `spots` | スポットの配列（読むだけ。書き換えられません）。`id`・`status`（`add`・`patch`・`remove`・`official`）と、[書ける項目](#書ける項目)、`region`・`prefecture` |
| `edit(id, {項目: 値}, [消す項目])` | 直す（`spot edit` と同じ） |
| `remove(id, 理由)` / `restore(id)` | 消す印を付ける / 消した印・直した差分を取り消す |
| `add({name, lat, lng, …})` | 足す |
| `log(…)` | 端末に出す（200行まで） |

既定では、ユーザーKB に差分があるスポットだけを見せます。`--all` で収録のスポットも見せ、`--q=語` で名前・エリア・都道府県・分類にその語を含むものにしぼります。

**試しと書き込み。** `--apply` を付けるまでは、どう変わるかを見せるだけです。`--apply` を付けても、頼まれた変更に1つでもまちがい（決まりに合わない値・知らない id など）があれば、**1つも書きません**（終了コード `1`）。書いたら履歴の1行になるので、`spot undo` 1回でまるごと戻ります。大きく変える前に `kb snapshot save` をしておくと、いつでもその時点に戻れます。

**スクリプトにできること（権限）。** スクリプトは、ユーザーKB を自分では書き換えません。「こう変えたい」を頼むだけで、確かめて書くのは旅さきです。囲いは3重にしてあります。

| 囲い | 止めるもの |
|---|---|
| 動かす前に、`import` という語を断る（文字や注釈の中でも） | `import()`。これだけは、次の囲いの中からでも外の世界のエラーに手が届いてしまうため、語そのものを断ります |
| `node:vm` の別の文脈 | `require`・`process`・`fetch`・ファイル・タイマーは渡しません。`eval`・`new Function`・WebAssembly も止めます。渡すのはスポットの写し（文字にして渡し、中で組み立て直します）で、返ってくるのも文字だけです |
| 別スレッド（worker） | 時間（既定 5 秒。`--timeout`）とメモリ（256MB）を使いすぎたら、そのスレッドだけを止めます。環境変数は渡しません。Node.js の権限モデルが使える版（22.13 以降）では、その worker から、ファイルの書き込み・子プロセス・別の worker を使えなくします（ファイルの読み取りは、いまいるフォルダの中だけ） |

上限は、頼める変更が 500 件（`--max` で 20,000 件まで）、スクリプトの大きさが 256KB です。

> **知らない人のスクリプトは動かさないでください。** `node:vm` は安全のための壁ではないと、Node.js の文書にもあります。この囲いは、自分のスクリプトのまちがいで手元を壊さないためのもので、悪意のあるスクリプトを防ぎきるものではありません。Node.js 22 の権限モデルは、ネットワークを止めません。

### git への写し（kb git）

git が入っていれば、ユーザーKB のフォルダを git リポジトリにできます。`kb git init` をしたあとは、書くたびに旅さきがコミットします。

```text
$ tabisaki kb git init
git リポジトリにしました: ~/.tabisaki/kbs/mine
これからは、書くたびにコミットします。見るとき: git -C <このフォルダ> log --stat

$ git -C ~/.tabisaki/kbs/mine log -1 --format=%B
spot edit: takao-1（fee）

Tabisaki-Seq: 5
Tabisaki-Changes: 1
```

| 決まり | わけ |
|---|---|
| コミットするのは `overlay.json`・履歴・スナップショット・土台（`bases/`）。控え（`backups/`）・鍵・途中のファイルは `.gitignore` に入れる | 控えは git の履歴と重なる。鍵や途中のファイルは、ほかの端末に持っていくものではない |
| フックは動かさない（`core.hooksPath=/dev/null`・`--no-verify`）。署名もしない | 書くたびに、利用者の知らないところで別のプログラムが動かないように |
| `.git/config` に、旅さきが知らない設定（`filter`・`include`・`alias`・`core.fsmonitor`・`core.sshCommand` など）があれば、git を呼ばない | よそから写してきたフォルダの `.git` に、プログラムを動かす仕掛けが入っていることがあるため。ユーザーKB への書き込みは通し、「git への写しはしていません」と伝えます |
| `push`・`pull` はしない | どこへ送るかは、利用者が決めること。自分で `git remote add`・`git push` をしてください |
| git が無い・失敗した | ユーザーKB への書き込みは通す。写せなかったことだけを伝える（次に書いたときに、まとめてコミットされます） |

取り消し・出どころ・履歴は、git ではなく `history.jsonl` を読みます。git の側で `git checkout` や `git reset` をして `overlay.json` を巻き戻したときは、`history.jsonl` と `history-head.json` も一緒に巻き戻るので、つじつまは合います。

## 考えかた

| | 公式の収録（`kb/`） | ユーザーKB |
|---|---|---|
| 置き場 | リポジトリの `kb/` | `~/.tabisaki/kbs/<名前>/overlay.json` |
| 書く人 | 収録を作り直す道具（`tools/`）だけ | 利用者 |
| 旅さきからは | **読むだけ** | 読む・書く |
| 中身 | スポットの全部 | 公式との**差分**だけ |

旅程を組むときは、公式の収録を読んでから、ユーザーKBの差分を上から重ねます（オーバーレイ）。重ねた結果はメモリの中にだけあり、`kb/` にもユーザーKBにも書き戻しません。

公式の収録が新しくなっても、差分はそのまま残ります。全部を写して持つと、公式の直しが届かなくなるためです。

## 識別子

| もの | 形 | 例 |
|---|---|---|
| 公式のスポット | 収録の id（`:` を含みません） | `takao-1`・`n0063-12` |
| 足したスポット | `u:` ＋ 時刻（36進）＋ 乱数8字 | `u:mh8k2x1c9f3a7b20` |
| ユーザーKB | 英小文字・数字・`-`・`_` で40字まで（先頭は英数字） | `mine`・`family-2026` |

足したスポットの id は `u:` で始まるので、公式の id とぶつかりません。時刻と乱数でできているので、別の端末で作ったものどうしもぶつかりません（[まとめる](#まとめかた3者の統合)ときに効きます）。

## overlay.json の形

```json
{
  "schema": "tabisaki.user-kb/1",
  "name": "mine",
  "title": "自分の旅",
  "base": { "kind": "official", "stamp": "/1371/54101" },
  "created": "2026-10-27T04:40:00.000Z",
  "updated": "2026-10-27T05:12:00.000Z",
  "spots": {
    "u:mh8k2x1c9f3a7b20": {
      "op": "add",
      "spot": { "name": "裏高尾の湧き水", "lat": 35.64, "lng": 139.25, "genres": ["nature"], "dwell": 20 },
      "at": "2026-10-27T04:41:00.000Z"
    },
    "takao-1": {
      "op": "patch",
      "set": { "description": "朝いちばんが静か", "fee": 300 },
      "unset": [],
      "was": { "description": "山腹に開かれた修験の寺。…", "fee": 0 },
      "anchor": { "name": "高尾山薬王院", "lat": 35.6256, "lng": 139.2472 },
      "at": "2026-10-27T04:50:00.000Z"
    },
    "takao-2": {
      "op": "remove",
      "reason": "混みすぎる",
      "anchor": { "name": "高尾山山頂", "lat": 35.6252, "lng": 139.2434 },
      "at": "2026-10-27T05:12:00.000Z"
    }
  }
}
```

差分は**スポットの id ごとに1件**です。同じスポットを何度直しても1件にまとまるので、並び順で結果が変わることがありません。

| op | 意味 | 持つもの |
|---|---|---|
| `add` | スポットを足す（id は `u:` で始まる） | `spot`（中身の全部） |
| `patch` | 公式のスポットを直す | `set`（変える項目）・`unset`（外す項目）・`was`（直す前の公式の値）・`anchor` |
| `remove` | 消す。**印を付けるだけ**で、ファイルからは消しません | `reason`・`anchor`（足したスポットなら `spot` も） |

`remove` を取り消すと、消す前（`add` や `patch`）に戻ります。足したスポットを直すときは、`add` の中身をそのまま書き換えます。

### 書ける項目

| 項目 | 形 | 決まり |
|---|---|---|
| `name` | 文字 | **必須**。120字まで |
| `lat`・`lng` | 数 | **必須**。−90〜90・−180〜180 |
| `category` | 文字 | 40字まで（寺院・展望台…） |
| `genres` | 一覧 | `nature` `history` `view` `food` `art` `city` `sea` `onsen` から8個まで |
| `regionId` | 文字 | 収録のエリアの id。書かなければ、いちばん近いエリアに入ります |
| `description` | 文字 | 2,000字まで |
| `address`・`wikipedia`・`tel` | 文字 | 200・200・30字まで |
| `url` | URL | `http(s)://` だけ。利用者名・パスワード入りは断ります |
| `fame_tier` | 文字 | `major` / `known` / `hidden`（既定 `hidden`） |
| `dwell` | 整数 | 滞在の目安（分）。5〜720 |
| `open`・`close` | 数 | 時刻（8.5 = 8:30）。`close` は `open` より後 |
| `fee` | 整数 | 料金（円） |

ここに無い項目（`src`・`osm`・`geo` など、公式の収録の出どころを表すもの）は書けません。黙って捨てずに、理由を返して断ります。`name`・`lat`・`lng` は外せません（外すと旅程に置けなくなります）。

タグ・評価・メモ・行った記録（#356）、スポットどうしの関係やルート（#357）は、`spots` とは別の欄として `tabisaki.user-kb/1` に足していきます（知らない欄は読み飛ばします）。

## 公式の収録が変わったとき

重ねるたびに、次のことを調べて報告します（`createCore().overlayReport`）。報告するだけで、**ファイルは書き換えません**。直すかどうかは利用者が決めます。

| 起きたこと | 見分けかた | 扱い |
|---|---|---|
| 直した項目を、公式の側も変えた | `was` と今の公式の値が違う | **利用者の値を使い**、`conflicts` に「直す前・今の公式・利用者」の3つを出す |
| 公式の側が、利用者の値と同じになった | 今の公式の値 ＝ `set` の値 | 使い続けてよい。`redundant`（消してよい差分）に出す |
| 公式の id が変わった | id が見つからず、`anchor` の名前と300m以内で**1件だけ**当たる | 当たったスポットに重ねる。`moved` に出す |
| 公式から消えた | id も `anchor` も当たらない（2件以上当たったときも） | 重ねない。`orphans` に出し、差分はファイルに残す |
| 公式の収録の版が変わった | `base.stamp` が今の版と違う | `baseChanged` を立てる |

名前が同じかは、収録のまとめ（`js/dedupe.js` の `sameThing`）と同じ決まりで見ます。

## 移し替え・控え・戻しかた

**形の版。** `schema` を見て、古い形なら読み込むときに今の形へ直します（`migrateOverlay`）。旅さきより**新しい版で書かれたファイルは開きません**（`newer_schema`）。知らない欄を落として書き戻すと、こわしてしまうためです。

**控え。** 書くたびに、書く前の `overlay.json` を `backups/<日時>.json` に写します。30個を超えたら古いものから消します。控えから戻すときも、戻す前の中身を控えに残します。

**消すとき。** ユーザーKBを消しても、フォルダは `~/.tabisaki/trash/` へ動かすだけです。

```text
~/.tabisaki/
├── current-kb                  ← kb switch で決めた名前（1行）
├── kbs/
│   ├── mine/
│   │   ├── overlay.json
│   │   ├── history.jsonl       ← 履歴（書くたびに1行）
│   │   ├── history-head.json   ← 最後に履歴へ書いたときの中身
│   │   ├── backups/
│   │   │   ├── 20261027T044100000Z.json
│   │   │   └── 20261027T051200000Z.json
│   │   ├── snapshots/
│   │   │   └── before-trip.json  ← 名前を付けて取っておいた中身
│   │   ├── bases/
│   │   │   └── family.json     ← family と最後に同じ中身だったときの控え（統合の土台）
│   │   └── .git/               ← kb git init をしたときだけ
│   └── family/
│       ├── overlay.json        ← parent: { name: "mine" }
│       ├── bases/mine.json
│       └── MERGE.json          ← 途中の統合があるあいだだけ
└── trash/
```

まるごと持ち出すときは、このフォルダを写せば足ります（中身はただの JSON です）。足したスポットだけを CSV・GeoJSON などで持ち出すときは「[取り込み・書き出し](#取り込み書き出し)」を見てください。別の端末で育てたユーザーKB は、`overlay.json` を持ってきて `kb merge ./overlay.json` でまとめられます。

## 安全のための決まり

| 心配 | 決まり |
|---|---|
| 名前に `../` を入れて、置き場の外に書く | 名前は `^[a-z0-9][a-z0-9_-]{0,39}$` だけ。解決した場所が `kbs/` の直下かも確かめる |
| シンボリックリンクで、ほかのファイルを読ませる・書かせる | フォルダと `overlay.json`・控えは `lstat` で、リンクなら断る |
| 書いている途中で落ちて、半端なファイルが残る | 隣の一時ファイルに書いて `fsync` してから `rename` で差し替える |
| 2つの処理が同時に書く | `.lock` を `O_EXCL` で作る。30秒より古い鍵は落ちた処理の残りとみなす |
| ほかの利用者に読まれる | フォルダは `0700`、ファイルは `0600` |
| 大きすぎるファイル・多すぎる差分 | ファイルは20MB、差分は5万件まで |
| `__proto__` 入りの JSON | 読むときに `__proto__`・`constructor`・`prototype` の鍵を捨てる |
| `current-kb` をリンクや変な中身にすり替える | ふつうのファイルで、名前の決まりに合う1行だけを読む。合わなければ「決めていない」として扱う |
| 取り込むファイル（別の端末の `overlay.json`）に、決まりに合わない差分 | 読むときに1件ずつ確かめ、合わなければ全体を断る。まとめた結果も、書く前にもう一度確かめる |
| 手で壊した `overlay.json` | おかしい差分だけを使わず（`invalid`）、残りは重ねる。書き戻すときは断る |
| 文字に制御文字・`javascript:` の URL | 制御文字は外す。URL は `http(s)` だけ |
| 一括編集のスクリプトが、ファイルを読み書きする・止まらない・メモリを食いつぶす | 別スレッドの中の `node:vm` で動かし、道具を渡さない。時間・メモリ・変更の数に上限。書くのは旅さきで、決まりに合わない変更が1つでもあれば書かない（[スクリプトでまとめて直す](#スクリプトでまとめて直すspot-batch)） |
| 写してきたフォルダの `.git` に、プログラムを動かす設定やフック | フックは止めて呼ぶ。`.git/config` に知らない設定があれば、git を呼ばない |
| スナップショット・履歴のファイルをすり替える | スナップショットは指紋が合わなければ戻さない。履歴はリンクなら読まず、こわれた行は飛ばす。名前は決まった文字だけ |

置き場の根は、環境変数 `TABISAKI_HOME` で変えられます（既定は `~/.tabisaki`）。

## Node.js から

```js
import { createCore, userkb } from "./packages/core/index.mjs";

const store = userkb.openStore();
await store.create("mine", { title: "自分の旅" });

const official = await createCore();
const doc = await store.load("mine");
userkb.addSpot(doc, { name: "裏高尾の湧き水", lat: 35.64, lng: 139.25, genres: ["nature"] });
userkb.patchSpot(doc, official.kb.spotsById.get("takao-1"), "takao-1", { set: { fee: 300 } });
await store.save("mine", doc, { kb: official.kb });

const core = await createCore({ userKb: "mine" });
console.log(core.overlayReport);
```

`applyOverlay(kb, doc)` は、渡した知識ベースもその中のスポットも書き換えません。直したスポットは写しを作り、一覧と索引は作り直して返します。

違い・統合・点検・集計は `kbmerge` にあります。どれも計算だけで、ファイルは読み書きしません。

```js
import { kbmerge, userkb } from "./packages/core/index.mjs";

const store = userkb.openStore();
const ours = await store.load("mine");
const theirs = await store.load("family");
const base = (await store.commonBase("mine", "family"))?.overlay ?? null;

kbmerge.diffOverlays(ours, theirs);                       // [{ id, name, kind, fields }]
const merged = kbmerge.mergeOverlays(base, ours, theirs); // { spots, taken, conflicts, counts }
const { spots, unresolved } = kbmerge.resolveMerge(merged, theirs, { "takao-1#fee": "theirs" });
if (!unresolved.length) await store.save("mine", kbmerge.checkMerged({ ...ours, spots }));
```

履歴・取り消し・出どころは `kbhistory`（計算）と、置き場（`openStore`）の `history`・`snapshot…` にあります。

```js
import { kbhistory, userkb } from "./packages/core/index.mjs";

const store = userkb.openStore();
const doc = await store.load("mine");
const records = await store.history("mine");            // [{ seq, at, cmd, note, changes, reverts? }]

kbhistory.blameSpot(records, "takao-1").fields.fee;     // { seq, at, cmd, note }
const plan = kbhistory.planUndo(records, doc.spots);    // { target, apply, conflicts, already, partial }
if (plan.target && !plan.conflicts.length) {
  kbhistory.applyUndo(doc, plan);
  await store.save("mine", doc, { log: { cmd: "spot undo", note: `#${plan.target.seq}`, reverts: plan.target.seq, undoes: plan.target.seq } });
}

const { ops } = await kbhistory.runBatchScript('edit("takao-1", { fee: 300 })', []);  // 頼まれた変更だけを受け取る
await store.snapshotSave("mine", "before-trip", { note: "旅の前" });
```
