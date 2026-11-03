# Research Agent と道具の登録所

収録（`kb/`）に無い要望を、ネットで調べてから旅程にする仕組みです（Issue #436・#437）。

> 手元で分かることは手元で調べ、分からないときだけネットに聞き、それでも分からなければ正直にそう言う。

中身は [`packages/core/src/research.js`](../packages/core/src/research.js)（Agent）と [`packages/core/src/tools.js`](../packages/core/src/tools.js)（道具）にあります。

## 流れ

ReAct（考える → 道具を使う → 結果を見る）を、決まった順の状態機械にしています。

| 状態 | すること | 使う道具 |
|---|---|---|
| `assess` | 海外でないか、名のある旅か、希望の語が収録にあるかを見る | `search_special_journey`・`search_spots` |
| `query` | 調べる語を作る（AI があれば AI、無ければ語の組み立て） | なし |
| `search` | ネットで調べる | `web_search` |
| `integrate` | 結果に出てくる場所を、収録のスポットに結び付ける | なし（AI があれば名前の拾い出しを手伝う） |
| `plan` | 見つけたスポットを回る順に並べる | `calculate_route` |
| `done` / `out_of_scope` | 答える／正直に断って代わりの案を出す | `ask_user` |

* **検索は最大3回**です。1回で場所が見つかれば、そこで打ち切ります（Single-hop が基本）。見つからなければ語を変えて調べ直します。同じ語では聞き直しません
* **収録で足りる要望は調べません**（`status: "kb"`）。いつもの流れ（`pipeline.js`）で組みます
* **AI は「調べる語」と「場所の名前の拾い出し」だけ**を手伝います。時刻・移動・営業時間の判定はプログラムが行います。AI が無くても、途中で失敗しても、最後まで進みます
* **対応できないときは旅程を作りません**。海外の要望、調べても収録の場所に結び付かない要望は `status: "out_of_scope"` で、理由（`message`）と代わりの案（`alternatives`）、利用者への問い（`question`）を返します

## 使いかた

```js
import { createCore } from "./packages/core/index.mjs";

const core = await createCore();
const search = async (q) => [/* {title, url, snippet} */];
const r = await core.research({ wish: "夏目友人帳の舞台をめぐりたい", from: "博多駅" }, { search });

r.research.status;   // "answered"（調べて見つけた）・"kb"（収録で足りた）・"quest"（一覧・道。下を参照）・"out_of_scope"
r.research.order;    // 見つけたスポット（回る順）
r.research.sources;  // 調べた先
r.research.trace;    // 考え・使った道具・結果の記録
r.itinerary;         // 見つけたスポットを「必ず立ち寄る」にして組んだ旅程
```

`search` を渡さなければ、ネットでは調べません（`createCore` は外へ通信しません）。`createCore({ local })` で手元の LLM を指していれば、その LLM が調べる語づくりを手伝います。

## 一覧を回る・道を通しで行く要望（汎用の流れ）

「日本100名城を回りたい」「中山道を自転車で走破したい」のように、決まった旅程（1つの土地を1〜数日）の形に入らない要望は、`assess` の最初で [`packages/core/src/quest.js`](../packages/core/src/quest.js) に回します（Issue #443）。専用の処理が無い要望でも、同じ順で答えます。

| 段 | すること | 使う道具 |
|---|---|---|
| 読む | 一覧を回る（`list`: ◯◯100名城・百名山・滝百選・全国の道の駅を全部…）か、道を通しで行く（`route`: ◯◯街道・古道・国道◯号を走破・自転車で・歩いて）か | なし |
| 集める | 一覧・沿う街をネットで取り、収録のスポット・街と照らす。中山道・東海道・国道は手元の沿う街を使う | `web_search`・`search_historical_route` |
| まとめる | 都道府県ごと（出発地に近い順）と、地方ごとの「全部回るなら何回の旅か」 | なし |
| 日程に落とす | 距離と日数から区切る（下の表）。一覧は出発地の近く（約60km）を最初の1回にする | `calculate_route` |
| 補う | 宿・レンタサイクルのような収録に無い情報を、検索結果から拾う（最大2回） | `web_search` |

| 移動のしかた | 1日の距離 | 1日に回る一覧の数 |
|---|---|---|
| 自転車 | 50km | 2 |
| 徒歩 | 20km | 2 |
| バイク | 200km | 4 |
| 車 | 250km | 4 |
| 電車・バス | 300km | 3 |

* 道のりは、沿う街どうしの直線距離 × 1.3 の目安です。上り下りは入っていません（答えにもそう書きます）
* 1日の距離は、街の切れ目に合わせるため 1.2 倍まで超えてよいことにしています。街と街の間が1日より長ければ、その途中にいちばん近い収録の街で泊まります
* 日数が足りなければ、日数ずつに分けた回（`rounds`）を出します（「3日ずつなら5回」）
* **一覧そのものは手元に持ちません**。公式の一覧は選び直されるので、調べて取れた分だけを使います。検索が使えないときは、収録の同じ分類（城など）から出し、「一覧に入っているかは確かめていません」と書きます（`verified: false`）
* 補った宿・レンタルは手がかり（題・URL・抜粋）だけです。空きや料金は確かめていない、と書きます
* 一覧を回る旅は、最初の1回を「必ず立ち寄る」にして旅程にします。入りきらなかった場所は答えに書きます。道を通しで行く旅（自転車で数百km）は、日ごとの区切り（`stages`）が答えで、旅程は組みません

```js
const r = await core.research({ wish: "中山道を自転車で走破したい", from: "東京駅", days: 3 }, { search });
r.research.status;          // "quest"
r.research.quest.stages;    // [{day, from, to, km, via, stops, midway}]
r.research.quest.rounds;    // 3日ずつに分けた回
r.research.quest.supplements; // [{need: "rental"|"lodging", place, found, sources, note}]
```

## 道具

`createDefaultTools({ kb, search })` で、次の道具が入った登録所ができます。どの道具も `registry.call(名前, 引数)` で呼び、`{ok, tool, data | error, ms}` の同じ形で返ります（投げません）。

| 優先 | 名前 | すること | 使えないとき |
|---|---|---|---|
| 10 | `search_spots` | 収録のスポットを語で探す（県で絞れる） | 収録が無い |
| 20 | `search_special_journey` | 最長片道切符・日本一周などの名のある旅 | |
| 25 | `search_historical_route` | 東海道五十三次・中山道・一桁国道の沿う街（ほかの街道はここに足す） | |
| 30 | `calculate_route` | 回る順を、移動が短くなるように並べる（最近傍＋2-opt） | 収録が無い |
| 40 | `search_transit` | 2地点の経路（経路の取り口。引けなければ距離からの目安） | |
| 50 | `search_weather` | 天気予報（天気の取り口。既定は Open-Meteo） | 天気が `off` |
| 80 | `web_search` | ネット検索 | `search` を渡していない |
| 100 | `ask_user` | 利用者に聞く（最後の手段） | |

経路と天気は [取り口（プロバイダー）](data-providers.md) を通るので、`useProviders({ routing: "transitous" })` のように切り替えたものがそのまま使われます。

### 入出力の形（JSON Schema）

道具はそれぞれ `input`・`output` を JSON Schema で持ちます。引数は呼ぶ前に確かめ、合わなければ `invalid_args` で返します。`registry.actionSchema()` は「次にどの道具をどの引数で呼ぶか」の JSON Schema で、AI に出力の形をしばらせる（Guided Decoding）ときに渡します。

### 道具を足す

```js
registry.register({
  name: "search_onsen",
  description: "温泉の泉質を調べる",
  input: { type: "object", additionalProperties: false, required: ["name"],
           properties: { name: { type: "string", maxLength: 40 } } },
  output: { type: "object" },
  run: async ({ name }, ctx) => ({ /* ... */ }),
});
```

## 検索先を替える

`search` は `async (query) → [{title, url, snippet}]` の関数なら何でも使えます。

* Web 版は `relaySearch()`（中継の `/web/search`。Wikipedia か Tavily）
* 控えを挟むときは `cachedSearch(search, { ttlMs, store })`。`store` は `get`・`set` を持つもの（`Map`、Redis の薄い包みなど）。当たり・外れの数は `search.stats` に入ります
* Brave LLM Context API と Redis（#438）も、この形の関数として差し込みます
