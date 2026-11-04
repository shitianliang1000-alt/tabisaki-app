# 控え（キャッシュ）の層

ネット検索のように、回数で枠やお金がかかり、1回が遅い問い合わせは、同じ語の答えを**1日覚えておき、聞き直しません**。Redis のような別のサーバーは使いません（[#438](https://github.com/shitianliang1000-alt/tabisaki-app/issues/438)）。

本体は [packages/core/src/cache.js](../packages/core/src/cache.js) です。Web 版・中継（Worker）・CLI が同じものを使います。

## どこで効いているか

| 場所 | 置き場 | 長さ | 中身 |
|---|---|---|---|
| アプリ（ブラウザ） | メモリ → `localStorage`（50件まで） | 1日 | 中継の `/web/search` の答え。**端末の外には出ません** |
| 中継（`server/worker.js`） | Worker のメモリ（300件まで）→ Cloudflare の Cache API | 1日 | Wikipedia・Tavily の答え。データセンターごと |
| Research Agent など | `cachedSearch(search, …)` に渡したもの | 指定 | どの検索先でも |

決まりごと:

* 鍵は検索語です。前後と続きの空白・大文字小文字・全角半角の違いはならします（`cacheKey`）
* **同じ語を同時に頼まれても、外へ聞くのは1回**です（待っていた側も同じ答えを受け取ります）
* 失敗は覚えません。何も見つからなかった答えも、アプリと `cachedSearch` では覚えません（次はまた聞きます）
* Tavily が使えず Wikipedia に切り替えて答えたときは、中継で覚えません（Tavily が戻れば、そちらで聞き直します）
* 置き場が壊れていても（容量切れ・読めない値）、外れとして聞き直すだけで、止まりません

## 使いかた

```js
import { createCache, memoryStore, webStorageStore, cacheApiStore } from "./cache.js";

const cache = createCache({
  ttlMs: 24 * 3600 * 1000,                       // 覚えておく長さ
  layers: [memoryStore({ maxEntries: 300 }),     // 前から順に見る。後ろで見つかったものは前へも入れる
           cacheApiStore(caches.default)],
  costPerCall: 0.005,                            // 1回聞くといくらか（費用の見積もり）
});

const { value, hit, ms } = await cache.fetch(key, () => askUpstream(q), { keep: (v) => v.length > 0 });
cache.stats();
// { hits, misses, shared, errors, storeErrors, requests, calls, saved, hitRate,
//   costSaved, costSpent, latency: { hit: {n, avgMs, p50Ms, p95Ms}, miss: {…} } }
```

検索先を包むだけなら `cachedSearch`（[packages/core/src/tools.js](../packages/core/src/tools.js)）が手短です。

```js
const search = cachedSearch(relaySearch(), { ttlMs: 24 * 3600 * 1000, costPerCall: 0.005 });
await search("箱根 紅葉");
search.stats.hitRate;
```

置き場は `get` / `set` / `delete` を持つもの（同期でも async でも）なら何でも使えます。Redis などを足すときも、この3つを持つ薄い包みを作って `layers` に並べるだけです。

## 測りかた

**中継の数（本番）** … `/web/search` の返事に `X-Cache: HIT` / `MISS` と `Server-Timing: cache;dur=…` が付きます。中継はこれを件数（`cache`）と時間の合計（`cache_ms`）として数え、管理画面の「使われかた」に**控え（キャッシュ）の当たり**（当たりの割合・当たりと外れの平均時間）として出します。件数はほかの件数と一緒に30秒ごとにまとめて書くので、Durable Object の書き込みは増えません。

**手元で試す** … [tools/cache_bench.mjs](../tools/cache_bench.mjs)

```sh
node tools/cache_bench.mjs                                # 外へは行かない試し（Zipf 分布で 1,000 回）
node tools/cache_bench.mjs --n 2000 --distinct 150 --latency 700 --cost 0.005 --md
node tools/cache_bench.mjs --url https://<中継>/web/search --n 30   # 本物の中継で X-Cache と往復時間を数える
```

外へ行かない試しの結果（既定の値。1回 700 ms・1回 0.005 の検索先を想定したもので、本番の数ではありません）:

| 項目 | 値 |
|---|---|
| 検索の回数 | 1,000 回（違う語 120 種） |
| 外へ聞いた回数 | 109 回 |
| 当たりの割合 | 89.1% |
| 全体の平均時間 | 77 ms（控え無しなら 700 ms） |
| 減った呼び出し・費用 | 89.1% |

当たりの割合は、どれだけ同じ語が聞かれるかで決まります。本番の数は管理画面で見てください。

## まだしていないこと

* Brave LLM Context API への切り替えと Redis は入れていません。足すときは、検索先の関数と置き場の包みを作って、上の形で差し込みます
