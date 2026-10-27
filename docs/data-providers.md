# 外のデータの取り口（プロバイダー）

経路・天気・地名・スポットを「どこからもらうか」を、旅程を組む本体から切り離しています。取り口（API）が止まったり規約が変わったりしても、アダプタを1つ差し替えるだけで済み、本体（`packages/core/src/pipeline.js`・`packages/core/src/routes.js`）は書き直しません。

中身は [`packages/core/src/providers.js`](../packages/core/src/providers.js) にあります。

## 取り口の種類

| 種類 | 本体が使う関数 | 返す形 | 既定 | ほかに入っているもの |
|---|---|---|---|---|
| `routing`（経路） | `search(from, to, opts)` | `RouteResult` | `yahoo`（Yahoo!路線情報、中継経由） | `mock`・`off` |
| `weather`（天気） | `forecast(at, date, opts)` | `Forecast` | `open-meteo` | `mock`・`off` |
| `geocoding`（地名） | `lookup(query)`・`reverse(lat, lng)` | `Place[]` | `local`（手元の駅・空港） | `gsi`（国土地理院） |
| `spots`（スポット） | `load(opts)` | 知識ベース | `kb`（`kb/` の JSON） | `mock` |

* **`mock`** … キーも通信も要らず、決まった答えを返します。テストと、キーの無い手元での動作確認に使います。経路の `mock` は直線距離からの目安で、時刻表ではありません
* **`off`** … 通信しません。経路が `off` なら、本体は聞きに行かず距離からの目安で組みます。天気が `off` なら「分かりません」になります

## 返す形

### RouteResult（経路）

旅さきの中の形です。相手の応答（Yahoo!の HTML など）をそのまま渡さず、アダプタ（または中継 `server/worker.js`）でこの形にそろえます。

| 項目 | 意味 |
|---|---|
| `routed` | 経路が引けたか |
| `minutes` | 頼んだ時刻から着くまでの分（便を待つ時間を含む） |
| `rideMinutes`・`waitMinutes` | 乗っている分・便を待つ分（あれば） |
| `summary` | 「10:08 発→ 11:30 着 1時間22分」のような一行 |
| `meta` | `{legs, alternatives, fare, transfers}`（あれば） |
| `kinds` | 乗り物の種類（`train`・`bus`・`plane`・`ferry` など） |
| `preferMet` | 頼んだ種類で引けたか |
| `byLocation` | 位置で引いたか |
| `searchedAt` | 調べた出発時刻（ISO） |
| `provider` | どの取り口の答えか |

経路の取り口は、ほかに `cooldown()`（いま聞いてよいか）・`resetCooldown()`・`resetPace()` と、`available`（`false` なら本体は聞きに行かない）を持ちます。

### Forecast（天気）

失敗しても投げません。天気は旅程の本体ではないためです。

```js
{ ok: true, date: "2030-04-01", rows: [{ iso, at, rain, temp, code }] } // rain は降水確率（%）、temp は ℃
{ ok: false, reason: "利用者に見せる一行" }
```

### Place（地名）

```js
{ name: "東京駅", lat: 35.6812, lng: 139.7671, source: "local" }
```

## 失敗の形

取り口の失敗は、どれも `ProviderError` にそろえます。呼ぶ側は `code`・`retryable`・`retryAfter` だけを見れば足ります。

| `code` | 意味 | 待てば通るか |
|---|---|---|
| `not_configured` | 設定されていない（キー・中継が無い、`off` を選んでいる） | いいえ |
| `rate_limited` | 回数が多いと断られた（429） | はい（`retryAfter` 秒） |
| `timeout` | 返事が来なかった | はい |
| `network` | 届かなかった（圏外など） | はい |
| `upstream` | 相手の不調（5xx） | はい |
| `rejected` | 頼みかたが通らない（400・403） | いいえ |
| `bad_response` | 返ってきたが読めなかった | いいえ |

`status`（HTTP の番号）と `upstreamCode`（相手が付けた印）も残すので、診断の画面はこれまでどおり番号で見分けられます。呼ぶ側が止めたとき（`AbortError`）だけは、そのまま投げます。

## 切り替えかた

### 端末・Node.js（`packages/core`）

`createCore` は既定で経路・天気とも `off` です（外へ出ません）。

```js
import { createCore } from "./packages/core/index.mjs";
const core = await createCore({ providers: { routing: "mock", weather: "mock" } });
```

### Web 版・テスト

```js
import { useProvider, useProviders, resetProviders } from "./packages/core/src/providers.js";

useProvider("routing", "mock");
useProviders({ weather: "off", geocoding: "gsi" });
resetProviders(); // 既定に戻す
```

### 新しい取り口を足す

同じ形を返すアダプタを書いて、登録します。足りない関数があると `registerProvider` が断ります。

```js
import { registerProvider, toProviderError, useProvider } from "./packages/core/src/providers.js";

registerProvider({
  kind: "routing",
  name: "my-transit",
  available: true,
  async search(from, to, opts) {
    try {
      const raw = await callMyApi(from, to, opts);
      return { routed: true, minutes: raw.total, summary: raw.text,
        searchedAt: new Date(opts.departAt ?? Date.now()).toISOString(), provider: "my-transit" };
    } catch (e) {
      throw toProviderError(e, "my-transit");
    }
  },
  cooldown: () => ({ waiting: false, seconds: 0, reason: "", retryable: false }),
  resetCooldown() {},
  resetPace() {},
});
useProvider("routing", "my-transit");
```

キーの要る API は、ブラウザから直接呼ばず、中継（`PROXY_URL`）を通してください（[AI と API キー](ai-and-keys.md)）。画面から新しい相手へ通信するときは、`index.html` の CSP（`connect-src`）にも足します。

アダプタごとのテストは [`tests/providers.test.js`](../tests/providers.test.js) を見本にしてください。キーなしで、`fetchImpl` か `globalThis.fetch` を差し替えて確かめます。
