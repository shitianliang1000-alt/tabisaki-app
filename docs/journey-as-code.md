# 旅程をファイルに書く（Journey as Code）

旅の条件を YAML のファイルに書いて、旅程を組む・確かめる・比べる・文にします。
ファイルなので、Git で残したり、PR で見比べたり、CI で確かめたりできます。

```sh
./tabisaki build examples/trips/hakone.yaml          # 組む
./tabisaki test examples/trips/hakone.yaml           # 条件を守っているか確かめる
./tabisaki diff examples/trips/hakone.yaml examples/trips/hakone-quick.yaml   # 2つを比べる
./tabisaki narrate examples/trips/hakone.yaml --style=diary                   # 旅の文にする
```

要るものは `./tabisaki plan` と同じです（Node.js 22 以上だけ。外へは通信しません）。
組むのは Web 版と同じエンジンなので、移動時間は距離からの目安です（[cli-usage.md](./cli-usage.md)）。

## 書きかた

```yaml
version: 1
title: 秋の箱根で温泉と美術館
wish: 箱根で温泉と美術館をゆっくり楽しみたい
from: 東京駅
date: "2026-11-07"
days: 2
start: "08:00"
back: "20:00"
transport: transit
constraints:
  must_visit: [ポーラ美術館]
  budget_yen: 60000
  max_spots_per_day: 6
output:
  format: markdown
```

| 項目 | 要る | 既定 | 意味 |
|---|---|---|---|
| `version` | ✅ | | 書きかたの版。今は `1` |
| `title` | ✅ | | 旅程の名前（80字まで） |
| `wish` | ✅ | | 希望の文。チャットに書くのと同じ（500字まで） |
| `from` | | 東京駅 | 出発地。収録の駅・空港の名前 |
| `date` | | 明日 | 出発日 `YYYY-MM-DD`。書いておくと、いつ組んでも同じ旅程になります |
| `days` | | 1 | 日数（1〜14） |
| `start` | | 08:00 | 出発の時刻 |
| `back` | | 20:00 | 最終日に出発地へ帰り着く時刻 |
| `transport` | | any | `any` / `transit` / `car` / `walk` / `local` |
| `constraints.must_visit` | | | 必ず立ち寄るスポットの名前の並び |
| `constraints.avoid` | | | 使わないスポットの名前の並び |
| `constraints.budget_yen` | | | 費用の上限（円） |
| `constraints.max_leg_minutes` | | | 1回の移動の長さの上限（分） |
| `constraints.max_spots_per_day` | | | 1日に立ち寄る数の上限 |
| `constraints.respect_hours` | | true | 営業時間の外に立ち寄らない |
| `output.format` | | markdown | `build` の出しかた（`markdown` / `text` / `json`） |
| `output.file` | | | `build` の書き出し先（このファイルからの相対）。無ければ端末に出します |
| `output.narrate` | | blog | `narrate` の文体 |

- 時刻と日付は `"08:00"` のように引用符で囲むと確かです（ほかの YAML の道具は、`08:00` を数として読むことがあります）
- 知らない項目はエラーにします。書きまちがい（`whish`）に気づけるように、近い名前も出します
- スポットの名前は、収録の名前と同じに書きます。同じ名前が複数あれば、よく知られた方を使います（そのことを stderr に出します）。無ければ、近い名前を出してエラーにします

読める YAML は、旅程を書くのに要る分だけです（字下げの入れ子、`- ` の並び、`[a, b]`、`"…"`・`'…'`、`|`・`>` の複数行、`#` の注釈）。
アンカー（`&`・`*`）、型の指定（`!!`）、`{ a: 1 }`、1つのファイルに複数の旅程（`---`）は、行の番号つきでエラーにします。
依存パッケージを増やさないためで、読み込みは [packages/journey/yaml.mjs](../packages/journey/yaml.mjs) にあります。

### 版（version）

書きかたを変えるときは `version` を上げます。新しい tabisaki は古い版のファイルも読めるように、読んだときに今の版の形へ直します。
古い tabisaki で新しい版のファイルを読むと、「新しい tabisaki にしてください」と出して止まります。

## コマンド

### `tabisaki build <trip.yaml>`

旅程を組んで出します。`--output=markdown|text|json` を付けると、ファイルの `output` より優先して端末に出します。
JSON の形は `tabisaki plan --output=json` と同じです（[cli-usage.md](./cli-usage.md)）。

### `tabisaki test <trip.yaml>`

旅程を組み、次のことを確かめます。

| 確かめること | もとにする項目 |
|---|---|
| 日数 | `days` |
| 帰りの時刻に間に合う | `back` |
| 予定の時刻が重ならない | （いつも） |
| 必ず立ち寄る・使わない | `constraints.must_visit`・`avoid` |
| 費用 | `constraints.budget_yen` |
| 1回の移動の長さ | `constraints.max_leg_minutes` |
| 1日の立ち寄りの数 | `constraints.max_spots_per_day` |
| 営業時間・最終入場 | `constraints.respect_hours` |

```text
examples/trips/hakone.yaml: 秋の箱根で温泉と美術館
  ✓ 日数: 2日（書いたのは 2日）
  ✓ 帰りの時刻: 19:50 に着く（20:00 まで）
  ✓ 必ず立ち寄る: ポーラ美術館
  - 移動の長さ: 上限なし
  ✓ 営業時間: 6か所とも営業時間の内です（うち 6か所は分類ごとの目安）
```

`✓` は守っている、`✗` は守れていない、`-` は条件を書いていないので確かめていない、です。
営業時間が「分類ごとの目安」のスポットは、目安の時間で確かめています。

### `tabisaki diff <a> <b>`

2つの旅程の違いを、日ごとに出します。`a`・`b` は旅程ファイル（`.yaml`）でも、`build --output=json` で出した JSON でもかまいません。
拡張子は省けます（`tabisaki diff plan-a plan-b` は `plan-a.yaml` を探します）。

```text
--- plan-a（秋の箱根で温泉と美術館）
+++ plan-b（箱根を日帰りで）
2日目
  - 09:17 大涌谷
  + 10:00 箱根神社
  ~ 芦ノ湖: 13:43〜14:46 → 14:10〜15:10
費用: 18,800円 → 2,200円（-16,600円）
```

`-` は a だけ、`+` は b だけ、`~` は両方にあって時刻か日が違うものです。比べるのは立ち寄りと宿で、移動と食事は合計（移動の分・費用）だけを比べます。

### `tabisaki narrate <trip.yaml> [--style=…]`

組んだ旅程を文にします。

| 文体 | 中身 |
|---|---|
| `blog` | 見出しと段落の、旅の記事（Markdown） |
| `diary` | 日ごとに時刻を追った日記 |
| `guide` | スポットごとの時間・営業・説明・雨のときの代わりの案内 |
| `haiku` | 日ごとの3行（季語は出発の月から）。音の数は数えていません |

今は AI を使わず、決まったひな形で書きます。手元の AI（#352）で書く文体は、そのあとに足します。

### `tabisaki simulate <trip.yaml>`（模擬実行）

組んだ旅程を、時計を進めながら頭から順にたどります。通信はしません。
「電車が2割遅れたら」「15分寝坊したら」「この美術館が休みだったら」を、出かける前に確かめられます。

```sh
./tabisaki simulate trip.yaml                       # 予定どおりにたどる
./tabisaki simulate trip.yaml --delay=20% --late=15 # 移動が2割長く、毎朝15分遅く出たら
./tabisaki simulate trip.yaml --closed=ポーラ美術館   # 行ったら休みだったら
./tabisaki simulate trip.yaml --on=2026-11-10       # 同じ旅程で、別の日に行ったら（定休日に当たらないか）
./tabisaki simulate trip.yaml --runs=500 --seed=1   # 長さをばらつかせて500回たどる
```

```text
2日目（11月8日(日)）
    14:50〜16:43 冠ヶ岳（予定より 27分遅れ）
    16:43〜16:43 自由時間（予定より 7分遅れ） — 遅れを 20分 吸いました
    16:43〜20:36 冠ヶ岳 → 東京駅（予定より 46分遅れ）

✓ 時刻の並び: 重なりはありません
✓ 移動の速さ: 9回の移動とも、ありえる速さです
✗ 帰り: 20:36（20:00 まで。36分 過ぎます）
✓ 立ち寄り: すべて入れます
```

| オプション | 意味 | 範囲 |
|---|---|---|
| `--delay=20%` | 移動が何割長くかかるか（`0.2` とも書ける） | -50%〜500% |
| `--late=15` | 毎日の出発が何分遅れるか | 0〜720 |
| `--dwell=1.2` | 立ち寄りの長さの倍率 | 0.1〜3 |
| `--closed=<名前>,…` | 休みだったことにするスポット（旅程に入っている名前） | |
| `--on=<日付>` | 旅程を丸ごとその日からにずらす（組み直しはしない） | YYYY-MM-DD |
| `--runs=<回数>` | 長さを毎回ばらつかせて、何度もたどる | 0〜10000 |
| `--seed=<数>` | 乱数の種（同じ種なら同じ結果） | |
| `--jitter=15%` | ばらつきの大きさ（移動。立ち寄りはその半分） | 0〜100% |
| `--output=json` | 機械が読む形（時刻は ISO 8601） | text / json |

#### 時間の決まり

| もの | たどりかた |
|---|---|
| 全体 | 予定より早くは動きません（早く着いたら、予定の時刻まで待つ）。遅れは後ろへずれます |
| 移動 | 予定の長さ × (1 + `--delay`) |
| 立ち寄り | 開く前に着いたら、開くまで待つ。最終入場・閉まる時刻を過ぎていたら入れない（✗）。閉まる時刻で切り上げ、予定の半分も居られなければ「短い」（✗） |
| 食事・荷物預け | 長さは変えず、後ろへずれるだけ |
| 自由時間 | 遅れを吸います（押したぶんだけ縮む） |
| 宿 | 着いたらその日は終わり。次の日は予定の時刻（+ `--late`）から始まります |
| 帰り | 最終日の最後が `back` を過ぎたら成り立ちません |

営業時間と休みは、旅程を組むときと同じ決まり（定休日・休業日・休業期間・季節ごとの時間・最終入場）で見ます。
収録に時間の無い場所は分類ごとの目安なので、✗ の行に「目安の営業時間」と出します。

動く前に、旅程そのものも点検します。時刻が重なっていないか、直線の距離で時速 320km を超える移動が無いか、
`max_leg_minutes` を書いていればそれを超える移動が無いか、です。

「余裕」は、ほかをそのままにして、出発の遅れだけ・移動の遅れだけを増やしたときに、どこまで成り立つかです。

`--runs` を付けると、移動の長さに対数正規のばらつき（`--jitter`）を掛けて何度もたどり、成り立った割合と、
帰りの時刻（ふつう＝まん中の値、遅いとき＝10回に1回の遅さ）、つまずいた場所を出します。
ばらつきは目安で、実際の遅れの統計から作ったものではありません。

### `tabisaki replan [trip.yaml] --weather-check`（天気での組み直し）

旅程を組み、日ごとの予報を取り、**雨の時間（降水確率 55% 以上）に屋外へ行く予定**があれば、
屋内の代わりに入れ替えた旅程を作って、違いを出します。ファイルを書かなければ `./trip.yaml` を見ます。

```sh
./tabisaki replan trip.yaml --weather-check           # 見るだけ
./tabisaki replan trip.yaml --weather-check --apply   # 入れ替えた旅程を trip.replanned.yaml に書く
./tabisaki replan trip.yaml --weather-check --provider=mock --rain=80   # 通信せずに試す
```

```text
雨の時間に屋外へ行く予定:
  2日目 14:23「冠ヶ岳」 → 屋内の「姥子温泉」に入れ替え

--- いまの旅程（秋の箱根で温泉と美術館）
+++ 組み直した旅程（秋の箱根で温泉と美術館）
2日目
  - 14:23 冠ヶ岳
  + 13:52 岡田美術館
```

守ること:

- **通信は `--weather-check` を付けたときだけ**です。行き先は `api.open-meteo.com` だけで、送るのは立ち寄る場所の
  緯度・経度（小数4桁に丸めたもの）と日付です。キーも名前も送りません。予報は3時間、
  `~/.tabisaki/cache/weather.json` に控えます。
- **天気が取れなければ、旅程は変えません。** 取れなかったと言うだけです（終了コード 0。`--strict` なら 3）。
  つながらない・混んでいる（429・5xx）ときは、0.5秒・1.5秒あけて2回まで取り直します。1回の待ちは20秒までです。
- **`must_visit` に書いた場所は、雨でも入れ替えません**（知らせるだけ）。
- 入れ替えの先は、旅程を組むときに見ていた候補の中から、近くの屋内の場所を選びます。見つからなければ入れ替えません。
- **組み直した旅程が `constraints` を守れなければ、元のままにします**（`tabisaki test` と同じ点検をします）。
- 組み直しで別の屋外の場所が入ってきたら、それも外して組み直します（3回まで）。
- **元のファイルは書き換えません。** `--apply` は別のファイル（既定は `trip.replanned.yaml`、`--out=` で変えられる）に、
  `must_visit` と `avoid` を書き足した旅程を書きます。元の注釈は写りません。
- 予報が出ているのは16日先までです。それより先の旅程は「まだ出ていません」、過ぎた日付は「見ていません」と出します。

#### 決まった時刻に動かす（cron）

`--quiet` は、知らせることが無いときに何も出しません。cron は出力があったときだけメールを送るので、
そのまま通知になります。`--state=<ファイル>` を付けると、前に知らせた内容を控えておき、同じ内容は2度知らせません。

```cron
MAILTO=you@example.com
# 毎朝6時に見る。雨で入れ替えの案が出たとき・案が変わったとき・心配がなくなったときだけ、メールが届く
0 6 * * * cd $HOME/trips && tabisaki replan autumn.yaml --weather-check --quiet --state=.autumn.state
```

メールでなく別の通知にしたいときは、終了コードで分けます（通知の送り先は旅さきの中に持たせていません。
送り先の URL や鍵を、旅さきに預けなくて済むようにです）。

```sh
tabisaki replan autumn.yaml --weather-check --quiet --state=.autumn.state --output=json > /tmp/replan.json
case $? in
  1) your-notify-command < /tmp/replan.json ;;   # 見直しの案・雨の心配あり
  3) echo "天気が取れていません" | your-notify-command ;;
esac
```

| 起きたこと | `--state` があるとき |
|---|---|
| 入れ替えの案が出た・雨の心配がある | 知らせる（終了コード 1）。次からは、内容が変わるまで黙る（0） |
| 雨の心配がなくなった | 1度だけ知らせる（0） |
| 天気が取れなかった | 黙って回数を数える（0）。`--max-failures`（既定 3）回つづいたら知らせる（3）。取れたら数え直す |
| 予報がまだ出ない先の日付 | 黙る（0）。16日前になれば、見はじめます |

控えは `{version, fingerprint, failures, lastRunAt, lastOkAt, notifiedAt}` の小さな JSON で、
書くときは別名で書いてから置き換えます（途中で止まっても壊れません）。同じ旅程を同時に2つ動かしても
困るのは「同じ知らせが2通届く」ことだけなので、ロックは取っていません。壊れた控えは、新しく作り直します。

#### 天気の取り口を選んだ理由

| 取り口 | 鍵 | 条件（2026-11-11 に確かめた） | 判断 |
|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/en/terms) | 不要 | 無料の API は**非商用だけ**。1日 10,000回・1時間 5,000回・1分 600回まで。データは CC BY 4.0（出どころを書く） | **採用**。時間ごとの降水確率が、場所を指して取れる。鍵が要らないので端末に置くものが無い |
| [気象庁](https://www.jma.go.jp/jma/kishou/info/coment.html) の予報 | 不要 | 公共データ利用規約（第1.0版）。出典を書けば使える。予報の JSON は公式の API ではなく、形が変わることがある。降水確率は6時間ごと・地域ごと | 見送り。「14時に屋外」を見るには粗い。警報・注意報には使っています（[data-licenses.md](./data-licenses.md)） |
| 鍵の要る天気 API（OpenWeather など） | 要る | 鍵を端末か中継に置くことになる | 見送り。鍵を増やさない |

旅さきを商用にするとき（広告・課金）は、Open-Meteo の有料の枠か別の取り口に替える必要があります
（[governance.md](./governance.md)）。出どころは [credits.html](../credits.html) に書いてあります。
`replan` は1回の実行で、旅程の日数ぶん（組み直しても同じ場所・同じ日は控えから読むので、多くて数回）しか呼びません。

## 終了コード

| コマンド | 0 | 1 | 2 |
|---|---|---|---|
| `build`・`narrate` | できた | 組めなかった | ファイル・使いかたのまちがい |
| `test` | 条件をすべて守っている | 守れていない条件がある | ファイル・使いかたのまちがい |
| `diff` | 違いなし | 違いあり | ファイル・使いかたのまちがい |
| `simulate` | 成り立つ | 成り立たない（入れない場所がある・帰りが遅い） | ファイル・使いかたのまちがい |
| `replan` | 知らせることなし | 見直しの案・雨の心配あり | ファイル・使いかたのまちがい |

`replan` には 3（天気が取れない。`--strict` のとき、または `--state` で続けて取れなかったとき）もあります。

エラーは stderr に `tabisaki: <ファイル>:<行>: <項目>: <理由>` の形で1件1行で出します。

```text
tabisaki: trip.yaml:3: whish: 知らない項目です（もしかして wish）
tabisaki: trip.yaml:4: days: 1以上にしてください
```

## CI で使う

`test` の終了コードで止められます。

```yaml
- run: ./tabisaki test trips/autumn.yaml
```

## Node.js から使う

```js
import { createCore } from "./packages/core/index.mjs";
import { loadJourney, buildJourney, checkJourney } from "./packages/journey/index.mjs";

const core = await createCore();
const built = await buildJourney(core, await loadJourney("trip.yaml"));
for (const c of checkJourney(built)) console.log(c.ok ? "✓" : "✗", c.name, c.detail);

// 模擬実行（通信しません）
import { simulateOnce, slack } from "./packages/journey/simulate.mjs";
const { itinerary, request } = built.result;
const run = simulateOnce(itinerary, request, { delay: 0.2, late: 15 });
console.log(run.ok, run.problems.map((p) => p.message), slack(itinerary, request));
```
