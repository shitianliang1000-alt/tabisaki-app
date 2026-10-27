# tabisaki-core

旅さきの、旅程を組む部分です。Web 版・CLI（`./tabisaki plan`）・TUI・手元の API が、同じこのファイルを使います。

> 画面が変わっても、組まれる旅程は変わらない。

## Features

* ブラウザでも Node.js 22 でも、そのまま動く（組み立ての手順は要りません）
* `createCore()` → `core.plan({ wish, from, days })` だけで旅程になる
* 入力のまちがいは `CoreError` の `code`（`invalid_input` / `unknown_place` / `plan_failed`）で分かる
* Node.js からは外へ通信しない（AI・経路・天気は使わず、移動は距離からの目安）
* 書き出しは Markdown・ふつうの文・JSON（`format.mjs`）

## Usage

```js
import { createCore, toMarkdown } from "./packages/core/index.mjs";

const core = await createCore();          // 知識ベース（kb/）を読む。1回だけ
const result = await core.plan({ wish: "温泉と海", from: "東京駅", days: 2, date: "2026-11-07" });
console.log(toMarkdown(result));
```

中の部品だけを使うこともできます。

```js
import { haversineKm } from "./packages/core/src/feasibility.js";
```

## Layout

| 場所 | 中身 |
|---|---|
| `index.mjs` | Node.js から使う入口。入力を確かめ、kb/ をファイルから読みます |
| `format.mjs` | 旅程を Markdown・文・JSON にします |
| `src/` | 本体。`pipeline.js` が旅程を組む流れで、ほかはその部品です |
| `src/root.js` | アプリの一番上（kb/ のある場所）。公開用にまとめたあとでも正しく指します |

`src/` は `src/` の中だけを読みます。画面の部品（`js/`）は読みません。`tests/core-boundary.test.js` が毎回確かめます。

画面（`js/`）からは `../packages/core/src/pipeline.js` のように読みます。公開するときは `tools/build_site.sh` が `src/` もいっしょに入れ、`tools/optimize_site.mjs` が画面とまとめます。

## Development

```sh
node --test tests/core.test.js tests/core-boundary.test.js
```

設計の全体は [docs/architecture.md](../../docs/architecture.md)、CLI の使いかたは [docs/cli-usage.md](../../docs/cli-usage.md) です。

## License

[PolyForm Noncommercial 1.0.0](../../LICENSE)
