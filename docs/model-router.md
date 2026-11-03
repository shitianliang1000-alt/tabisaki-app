# 手元とクラウドのモデルを使い分ける（ハイブリッドモデルルーター）

手元の LLM（Ollama などで動かす小さな Gemma）で答え、自信が無いときと Web 検索が要るときだけ、
クラウドのモデルに聞き直します。品質・費用・オフラインでの使いやすさを両立させるためのしくみです。

```bash
export GEMINI_API_KEY=…                       # クラウドの入口（または --cloud-url=<中継の URL>）
./tabisaki plan "温泉と海をゆっくり" --hybrid
./tabisaki router stats                       # どちらに何件回したか・閾値の目安
```

この文書は Issue #439 で決めたことをまとめています。手元の LLM の用意は [local-llm.md](./local-llm.md) を見てください。

## 目次

* [振り分けの決まり](#振り分けの決まり)
* [確信度の測りかた](#確信度の測りかた)
* [クラウドの入口](#クラウドの入口)
* [記録](#記録)
* [閾値を調整する](#閾値を調整する)
* [送るもの・送らないもの](#送るもの送らないもの)
* [Node.js から使う](#nodejs-から使う)
* [まだやらないこと](#まだやらないこと)

## 振り分けの決まり

頼みごと（希望文の読み取り・行き先の選定・スポットの説明・質問への答え）の1回ごとに、次の順で決めます。

| 順 | 条件 | 回す先 | 記録の理由（`reason`） |
|---|---|---|---|
| 1 | クラウドにつながらない（入口が無い・端末がオフライン） | 手元 | `cloud_unavailable`（検索が要る頼みなら `web_needed_but_offline`） |
| 2 | Web 検索が要る（検索の抜き書きを渡す・検索させる） | クラウド | `web_search` |
| 3 | それ以外 | まず手元 | — |
| 3a | 手元の確信度が閾値**以上** | 手元の答えを使う | `local_first` |
| 3b | 手元の確信度が閾値**未満** | 同じ頼みをクラウドに聞き直す | `low_confidence` |
| 3c | 手元が答えない（つながらない・時間切れ） | クラウド | `local_failed` |

片方が答えないときは、もう片方の答えを使います（`low_confidence_cloud_failed`・`web_search_cloud_failed`）。
どちらも答えないときは `both_failed` と記録し、いままでと同じく収録データだけで組み直します。

Web 検索が要る頼みをクラウドに回すのは、手元のモデルが検索できないからです。調べずに推測で答えさせると、
「調べたつもりの推測」になります。

## 確信度の測りかた

手元のモデルに、トークンごとの確率（OpenAI 互換の `logprobs: true`）を頼みます。

* **確信度 = トークンの確率の幾何平均**（`exp(logprob の平均)`）。0〜1 です
* 確率が 5% を下回ったトークンが1つでもあれば、1割下げます（数字や地名の言い切りで大きく迷った印です）
* JSON を頼んだのに読めない答えは、確率にかかわらず 0 です（使えない答えだからです）
* logprobs を返さない実行環境では、空でないか・JSON が読めるかだけで決めます（読めれば 0.8）。
  記録の `method` が `heuristic` になり、閾値の目安の計算には入れません

新しい版の Ollama と llama.cpp の `llama-server` は、OpenAI 互換の口で logprobs を返します。返さない版でも動きます（上の目安に落ちます）。

## クラウドの入口

| 指定 | 行き先 | 使うモデル |
|---|---|---|
| 環境変数 `GEMINI_API_KEY`（または `TABISAKI_GEMINI_KEY`） | Google の Gemini API へ直接 | `packages/core/src/config.js` の `MODEL`・`FALLBACK_MODELS`（いまは Gemma 4 の 26B・31B） |
| `--cloud-url=<URL>`（または `TABISAKI_PROXY_URL`） | 自分で立てた中継（Cloudflare Worker。[self-hosting.md](./self-hosting.md)） | 同じ |

両方あるときは `--cloud-url` を使います。どちらも無いと `--hybrid` は使えません（終了コード 2）。
クラウドのモデルも Gemma に限っています。有料の Gemini は使いません。

公開サイトの中継は、ブラウザから開いたサイトだけを受け付けます（`ALLOW_ORIGIN`）。端末からは、
自分のキーか自分の中継を使ってください。

## 記録

1回ごとに `~/.tabisaki/router-log.jsonl`（`TABISAKI_HOME` があればその下）に1行書き足します。

```json
{"at":"2026-11-03T06:22:58.857Z","task":"understand","threshold":0.75,"promptChars":1173,
 "localModel":"gemma4:e2b","route":"cloud","reason":"low_confidence","cloudModel":"gemma-4-26b-a4b-it",
 "confidence":0.62,"method":"logprobs","handedOver":true,"ms":5230}
```

| 項目 | 意味 |
|---|---|
| `task` | 頼みの種類（`understand` 希望文の読み取り・`plan` 行き先の選定・`describe` スポットの説明・`qa` 質問） |
| `route` | 答えを使った先（`local` / `cloud`。どちらも答えなければ `none`） |
| `reason` | 上の表の理由 |
| `confidence` / `method` | 手元の確信度と、その測りかた（`logprobs` / `heuristic`）。手元に聞かなかったときは `null` |
| `handedOver` | 手元に聞いたあと、クラウドに回したか |
| `promptChars` | 頼みの文の長さ（文そのものは書きません） |
| `cloudError` | クラウドが答えなかったときの理由（状態コードなど） |

旅程を組むたびに、何件をどちらに回したかを1行で出します（`使い分け: 手元 3件・クラウド 1件…`）。
`--output=json` の結果にも `ai.routes` として入ります。

```bash
./tabisaki router log --limit=20          # 新しい順に
./tabisaki router log --output=json
./tabisaki router stats                   # まとめ（どちらへ何件・聞き直した割合・確信度の分布）
```

## 閾値を調整する

既定は **0.75** です。次の順に決まります。

1. `--threshold=<0〜1>`
2. 環境変数 `TABISAKI_ROUTER_THRESHOLD`
3. `~/.tabisaki/router.json` の `threshold`（`tabisaki router threshold <値>` で書きます）
4. 既定（0.75）

上げるほどクラウドに回る数が増えます（品質寄り）。下げるほど手元で済みます（費用・オフライン寄り）。

`tabisaki router stats --target=0.2` は、記録した確信度から「手元の答えの2割をクラウドへ回す」閾値を出します。
確信度（logprobs）の記録が20件たまるまでは出しません。

```bash
./tabisaki router stats --target=0.2
#   閾値の目安: 0.712（手元の答えの 20% をクラウドへ回す値。tabisaki router threshold 0.712 で変えられます）
./tabisaki router threshold 0.712
```

## 送るもの・送らないもの

| | `--local` | `--hybrid` |
|---|---|---|
| 手元の LLM へ | 頼みの文 | 頼みの文 |
| クラウドへ | 送らない | **聞き直すときと Web 検索のときだけ**、同じ頼みの文（希望文と、選ぶ元になる候補の一覧） |
| 記録 | なし | 端末の `router-log.jsonl`（文そのものは書かない） |

希望の文を端末の外へ出したくないときは、`--hybrid` ではなく `--local` を使ってください。

## Node.js から使う

```js
import { createCore } from "./packages/core/index.mjs";
import { fileRecorder, resolveThreshold } from "./packages/core/router-log.mjs";

const core = await createCore({
  hybrid: {
    local: { baseUrl: "http://127.0.0.1:11434", model: "gemma4:e2b" },
    threshold: resolveThreshold().threshold,
    cloud: { geminiKey: process.env.GEMINI_API_KEY },   // または { proxyUrl: "https://…" }
    onRecord: fileRecorder(),                            // 記録をファイルへ。省けば結果の ai.routes だけ
  },
});
const { ai } = await core.plan({ wish: "温泉と海をゆっくり" });
// ai = { provider: "hybrid", model, used, error, threshold, routes: [...] }
```

判断だけを持つ部品は `packages/core/src/router.js` です（通信しません。ブラウザでも動きます）。

| 関数 | すること |
|---|---|
| `confidenceFromLogprobs(logprobs)` | logprobs から確信度を出す |
| `scoreReply({text, logprobs}, {expectJson, parse})` | 確信度と測りかたを決める |
| `planRoute({needsWeb, cloudAvailable, localAvailable, force})` | はじめにどちらへ回すか |
| `shouldHandOver(confidence, threshold)` | クラウドへ聞き直すか |
| `summarizeRoutes(entries)` / `suggestThreshold(entries, {target})` | 記録のまとめと閾値の目安 |

`packages/core/src/ai.js` の `useHybrid()` で切り替え、`routeEntries()`・`lastRoute()` で記録を読めます。

## まだやらないこと

* **Web 版での使い分け。** ブラウザから手元の LLM（`localhost`）へは、いまの CSP では届きません。
  Web 版はいままでどおりクラウド（中継）だけを使います
* **旅行向けに調整した Gemma。** 手元のモデルは、いまは素の `gemma4:e2b` です（調整は Phase 4 の別の Issue）
* **答えの中身で比べる確信度。** 手元とクラウドの答えを突き合わせて閾値を自動で直すことはしません。
  閾値は記録を見て人が決めます
