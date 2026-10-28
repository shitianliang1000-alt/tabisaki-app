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

## 終了コード

| コマンド | 0 | 1 | 2 |
|---|---|---|---|
| `build`・`narrate` | できた | 組めなかった | ファイル・使いかたのまちがい |
| `test` | 条件をすべて守っている | 守れていない条件がある | ファイル・使いかたのまちがい |
| `diff` | 違いなし | 違いあり | ファイル・使いかたのまちがい |

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
```
