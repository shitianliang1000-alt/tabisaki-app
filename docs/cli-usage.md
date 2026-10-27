# 端末から旅程を組む（CLI）

ブラウザを開かずに、端末（SSH の先でも）から旅程を組めます。

```sh
./tabisaki plan "温泉と海をゆっくり楽しみたい" --days=2
./tabisaki plan "京都で歴史を感じたい" --from=新大阪駅 --date=2026-11-03 --output=json
```

要るもの: Node.js 22 以上と、このリポジトリ（`kb/` の収録データを読みます）。依存パッケージは要りません。

```sh
git clone git@github.com:shitianliang1000-alt/tabisaki-app.git && cd tabisaki-app
```

SSH でつないだ先のサーバーで動かすときも同じです。出力は stdout だけなので、手元へ持ってくるなら
`ssh server 'cd tabisaki-app && ./tabisaki plan "温泉"' > trip.md` のようにもできます。
`./tabisaki` が使えない環境（Windows など）では `node packages/cli/bin/tabisaki-plan.mjs plan …` と同じです。

## できること・できないこと

| | |
|---|---|
| ✅ できる | 収録の約5万4千か所から行き先と立ち寄りを選び、営業時間・食事・宿・帰りの時刻を考えて時刻を割り付ける |
| ⚠ 目安 | 移動時間は**直線距離からの推定**です。実際の乗換・時刻表は調べません |
| ❌ しない | 外への通信（AI・経路・天気・写真）。希望の文の読み取りは、AI を使わない簡易なものです |
| ✅ 選べる | `--local` で、手元の LLM（Ollama など）に希望文を読ませ、行き先を選ばせる（[local-llm.md](./local-llm.md)） |
| ✅ できる | `tabisaki kb extract`・`tabisaki similar` で、地域の切り出しと似たスポットの検索（[kb-extract.md](./kb-extract.md)） |

Web 版と同じエンジン（`packages/core/src/`）で組むので、AI を使わないときの Web 版と同じ旅程になります。

## オプション

| オプション | 既定 | 意味 |
|---|---|---|
| `--from=<駅>` | 東京駅 | 出発地。収録の駅・空港の名前（`新宿` でも `新宿駅` に当たります） |
| `--days=<N>` | 1 | 日数（1〜14） |
| `--date=<YYYY-MM-DD>` | 明日 | 出発日 |
| `--start=<HH:MM>` | 08:00 | 出発の時刻 |
| `--back=<HH:MM>` | 20:00 | 最終日に出発地へ帰り着く時刻 |
| `--kb=<名前>` | なし | ユーザーKB（`~/.tabisaki/kbs/<名前>/`）を公式の収録に重ねて組む（[docs/user-kb.md](./user-kb.md)） |
| `--transport=<手段>` | any | `any` / `transit`（電車・バス）/ `car` / `walk` / `local`（普通列車だけ） |
| `--output=<形式>` | markdown | `markdown` / `text` / `json` |
| `--lang=<言語>` | ja | `ja` / `en`。環境変数 `TABISAKI_LANG` でも決められます（[i18n.md](i18n.md)）。地名やスポットの名前は原文のままです |

時刻はすべて日本時間です（端末の時間帯によりません）。

## 出力

- **stdout には旅程だけ**を出します。ファイルに保存したり、ほかの道具に渡したりできます
  （`./tabisaki plan "温泉" > trip.md`）
- エラーは stderr に `tabisaki: …` の1行で出します
- エンジンの途中経過を見たいときは `TABISAKI_DEBUG=1` を付けます（stderr に出ます）

`--output=json` の形（`version: 1`）:

```json
{
  "version": 1,
  "request": { "wish": "…", "from": "東京駅", "days": 2, "departAt": "…", "arriveBy": "…", "transport": "any" },
  "title": "熱海",
  "totalCostYen": 21700,
  "days": [
    { "n": 1, "date": "…", "items": [
      { "kind": "spot", "start": "…", "end": "…", "title": "MOA美術館", "detail": "…",
        "hours": "09:00〜16:00・最終入場 15:30", "estimated": false, "km": null }
    ] }
  ]
}
```

`kind` は `spot`（立ち寄り）・`transit`（移動）・`meal`（食事）・`lodging`（宿）などです。

## 終了コード

| コード | 意味 |
|---|---|
| 0 | 組めた |
| 1 | 組めなかった（エンジンの中のエラー） |
| 2 | 使いかたのまちがい（希望の文が無い、知らない駅、日数がおかしい、`--kb` の名前が無い、など） |

## 端末の中で見る（TUI）

```sh
./tabisaki tui "温泉と海をゆっくり楽しみたい" --days=2
```

オプションは `plan` と同じです（`--output` は使いません）。キーボードだけで動きます。

| キー | 動き |
|---|---|
| `j` / `↓`・`k` / `↑` | 次・前の予定 |
| `l` / `→`・`h` / `←` | 次・前の日 |
| `g` / `G` | その日の最初・最後 |
| `Enter` | 詳しく（営業時間・距離・説明）。もう一度で戻る |
| `?` | キーの一覧 |
| `q` / `Ctrl+C` | 終わる |

- 部品の本（blessed・Ink）は使わず、少しの制御文字だけで描きます。SSH の先や古い端末でも動き、依存も増えません
- `NO_COLOR=1` を付けると色を使いません。幅の狭い端末では長い名前を切って並べます
- パイプやファイルへ出すときは使えません（`tabisaki plan` を使ってください）

## Node.js から使う（packages/core）

```js
import { createCore, toMarkdown } from "./packages/core/index.mjs";

const core = await createCore();          // 知識ベースを読む（1回だけ）
const result = await core.plan({ wish: "温泉と海", from: "東京駅", days: 2, date: "2026-11-07" });
console.log(toMarkdown(result));
```

- 入力のまちがいは `CoreError` で、`code` が `invalid_input`（入力の形）・`unknown_place`（知らない駅）・`plan_failed`（組めなかった）のどれかです
- `createCore()` はその process の `fetch` を「リポジトリの中だけを読む」ものに差し替え、時間帯を日本時間にします
- 旅程を組む本体は `packages/core/src/` にあり、Web 版（`js/app.js`）も同じファイルを読みます。中の部品だけを使うときは `packages/core/src/feasibility.js` のように直に読めます（[packages/core/README.md](../packages/core/README.md)）
