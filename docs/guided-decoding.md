# 道具の呼び出しを JSON Schema でしばる（Guided Decoding）

小さい Gemma（4B 級）に道具を選ばせると、自由に JSON を書かせたときは括弧の欠け・前置き・無い道具の名前・型の違う引数がよく出ます。
vLLM などの推論サーバーは、**JSON Schema に合わないトークンをそもそも出させない**（制約付きデコーディング）ことができるので、
道具の名前と引数の型を出力の段階で守らせます。

```bash
# 1. vLLM を立てる（GPU のある PC で）
vllm serve google/gemma-3-4b-it --port 8000 --guided-decoding-backend outlines

# 2. しばりの有無で、道具の呼び出しの崩れを比べる
node tools/tool_call_eval.mjs --url=http://localhost:8000 --model=google/gemma-3-4b-it
```

この文書は Issue #435 で決めたことをまとめています。道具の登録所（JSON Schema の定義）は [research-agent.md](./research-agent.md)（#437）、
手元の LLM の用意は [local-llm.md](./local-llm.md)、自前のモデルを中継から使う話は [own-model.md](./own-model.md) にあります。

## 目次

* [どこでしばるか](#どこでしばるか)
* [vLLM の立てかた](#vllm-の立てかた)
* [tool parser の設定](#tool-parser-の設定)
* [しばりの有無で比べる](#しばりの有無で比べる)
* [しばりを受けないサーバー](#しばりを受けないサーバー)
* [Node.js から使う](#nodejs-から使う)
* [まだやらないこと](#まだやらないこと)

## どこでしばるか

| 呼ぶところ | しばりかた | 中身 |
|---|---|---|
| 手元の LLM（`--local`・`--hybrid` の手元側） | `response_format: {type: "json_schema"}` | 希望の読み取り・行き先の選定・Research Agent の検索語と場所の拾い出し。Gemini の形の schema を JSON Schema に直して渡します |
| 中継 → 自前のモデル（`OWN_MODEL_URL`） | 同上 | 画面は Gemma に `responseSchema` を付けられない（Google が 400 を返す）ので、かわりに本文に `guidedSchema` を添えます。中継は **Google へは渡さずに落とし**、自前のモデルへ聞くときだけ使います |
| 道具の呼び出し（`guided.js` の `nextToolCall`） | `schema`（次の一手の JSON Schema）か `tools`（`tool_choice: "required"`） | 道具ごとに `tool` を `const` で固定し、`args` は登録所の `input`（`additionalProperties: false`）。無い道具の名前・余計な引数・型の違いは出せません |
| Google AI Studio の Gemma | しばれません | いままでどおり本文で「JSON だけ」と頼み、読めなければ聞き直します（`callModelJson`） |

鍵はブラウザに置きません。自前のモデルの鍵（`OWN_MODEL_KEY`）は中継の secret のままです。

「次の一手」の形はこうです（`packages/core/src/guided.js` の `actionJsonSchema`）。

```json
{ "anyOf": [
  { "type": "object", "additionalProperties": false, "required": ["tool", "args"],
    "properties": { "thought": { "type": "string", "maxLength": 200 },
                    "tool": { "const": "search_spots" },
                    "args": { "...": "search_spots の input" } } },
  { "...": "ほかの道具も同じ形" },
  { "type": "object", "additionalProperties": false, "required": ["final"],
    "properties": { "thought": { "type": "string" }, "final": { "const": true } } }
] }
```

登録所の `actionSchema()` は `oneOf` ですが、送るときは `anyOf` にします。道具ごとに `tool` の `const` が違うので意味は同じで、
`anyOf` のほうが推論サーバー（Outlines・xgrammar・llama.cpp の GBNF）で広く通ります。

## vLLM の立てかた

vLLM は OpenAI 互換の `POST /v1/chat/completions` を話します。`response_format: {type: "json_schema"}` を受け取ると、
構造化出力（structured outputs。以前の名前は guided decoding）の仕組みで出力をしばります。

```bash
pip install vllm
# Gemma の重みは Hugging Face で利用条件に同意してから落とします（huggingface-cli login）
vllm serve google/gemma-3-4b-it \
  --port 8000 \
  --max-model-len 8192 \
  --guided-decoding-backend outlines
```

* **しばりの部品（backend）**: 既定は `auto`（xgrammar を使い、受けない形なら guidance などへ落とす）。Issue のとおり Outlines に決めるなら上の `--guided-decoding-backend outlines` です。
  新しい vLLM では引数の名前が `--structured-outputs-config.backend outlines` に変わっています。どちらが使えるかは `vllm serve --help | grep -i -E "guided|structured"` で確かめてください
* **0.10 より前の vLLM** で `response_format: json_schema` が効かないときは、頼みの本文に `guided_json` を入れる古い書きかたにします（`TABISAKI_GUIDED=guided_json`、比べるときは `--style=guided_json`）
* **Gemma 4**: 同じ手順で、Hugging Face の Gemma 4 の名前に替えます。旅さきが手元で既定にしている `gemma4:e2b` は Ollama の名前です
* **Ollama・llama.cpp・LM Studio** も `response_format: json_schema` を受けます（中身は文法 GBNF でのしばり）。vLLM が無くても、手元ではそのまま効きます

旅さきから使うとき:

```bash
./tabisaki plan "温泉と海をゆっくり" --local --llm-url=http://localhost:8000 --model=google/gemma-3-4b-it
TABISAKI_GUIDED=off ./tabisaki plan "…" --local …        # しばりを切って比べる
```

Web 版から使うときは、vLLM を立てた PC を Cloudflare Tunnel などで出し、中継の `OWN_MODEL_URL` にします（[own-model.md](./own-model.md)）。

## tool parser の設定

道具の呼び出しの頼みかたは3通りあり、比べる道具（`tools/tool_call_eval.mjs`）は3つとも試します。

| 頼みかた | 送るもの | vLLM の設定 | 返ってくる形 |
|---|---|---|---|
| `free` | 本文に道具の説明と「この形の JSON で」 | なし | 本文の JSON（しばりなし。比べる基準） |
| `schema` | `response_format: json_schema`（次の一手の形） | なし（構造化出力は既定で使えます） | 本文の JSON（しばりあり） |
| `tools` | `tools` + `tool_choice: "required"` | なし。`required` と名前を指定した呼び出しは、vLLM が構造化出力でしばります | `message.tool_calls` |

`tool_choice: "auto"`（使うかどうかもモデルに任せる）にするときだけ、tool parser が要ります。Gemma は道具の呼び出しを
Python の関数呼び出しの形で書くので、vLLM の `pythonic` を使います。

```bash
vllm serve google/gemma-3-4b-it --enable-auto-tool-choice --tool-call-parser pythonic \
  --chat-template examples/tool_chat_template_gemma3_pythonic.jinja
```

`auto` は出力をしばらないので、構文の崩れは0になりません。旅さきは `schema` か `tools`（`required`）を使い、道具が要らない
ときは `final` を選ばせます。返事の読み取り（`parseToolCall`）は、本文の JSON・`tool_calls`・`[{name, arguments}]` の並びの
どれでも読み、崩れを `empty` / `syntax` / `shape` / `unknown_tool` / `invalid_args` に言い分けます（投げません）。

## しばりの有無で比べる

```bash
node tools/tool_call_eval.mjs --url=http://localhost:8000 --model=google/gemma-3-4b-it
node tools/tool_call_eval.mjs ... --repeat=3 --temperature=0.7 --out=tool-call-result.json
node tools/tool_call_eval.mjs --url=http://localhost:11434 --model=gemma4:e2b --modes=free,schema   # Ollama
```

旅の頼み24問（スポット探し・名のある旅・旧街道・乗り換え・天気・回る順・ネット検索・聞き返し）に、それぞれ1手だけ選ばせます。
道具は実際には呼びません（形だけを見ます）。数えるもの:

| 項目 | 意味 |
|---|---|
| 構文の崩れ | 空・JSON でない・形が違う・前置きや ``` 付き（読めても崩れに数えます）の割合。**完了条件はこれが実質 0** |
| 正しく呼べた | 道具の名前と引数の型まで登録所の JSON Schema に合った割合 |
| 期待どおりの道具 | 問いごとに決めた道具（どれでもよいものは複数）を選んだ割合。しばりは中身の正しさまでは守らないので、ここはモデルの力です |
| しばりを断られた | サーバーが `json_schema` を受けず、`json_object` に落として聞き直した回数 |

結果の表（Markdown）がそのまま出ます。手元の GPU で測ったら、ここに貼ってください。

| 頼みかた | 問い | 構文の崩れ | 正しく呼べた | 期待どおりの道具 |
|---|---:|---:|---:|---:|
| free | — | — | — | — |
| schema | — | — | — | — |
| tools | — | — | — | — |

> 2026-11-03 時点で、本物のモデルではまだ測っていません（この環境に GPU が無いため）。試験（`tests/guided.test.js`）は、
> しばりが無いと4回に1回ずつ前置き・閉じていない JSON・型違いを返す偽の vLLM で、数えかたと、`schema` / `tools` で崩れが 0 に
> なることを確かめています。

## しばりを受けないサーバー

* 手元の LLM: `json_schema` を 400 / 422 で断られたら、`json_object`（JSON であることだけ）に落として聞き直し、以後はそれを使います
* 中継の自前のモデル: 同じく、しばらずに1度だけ聞き直します。それでも答えなければ、いままでどおり AI Studio へ回します
* 道具の呼び出し（`nextToolCall`）: `json_object` に落として聞き直し、結果に `degraded: true` を付けます

## Node.js から使う

```js
import { createDefaultTools } from "./packages/core/src/tools.js";
import { nextToolCall } from "./packages/core/src/guided.js";

const tools = createDefaultTools({ kb, search });
const step = await nextToolCall({ url: "http://localhost:8000", model: "google/gemma-3-4b-it",
                                  wish: "東海道五十三次の宿場町をたどりたい", registry: tools, mode: "schema" });
if (step.ok && step.action.tool) {
  const r = await tools.call(step.action.tool, step.action.args);   // 登録所でもう一度確かめてから呼びます
}
```

`toolCallBody()` で頼みの本文だけを作ることもできます（別の HTTP の部品で送るとき）。

## まだやらないこと

* **Research Agent の中の手順を、モデルの選んだ道具で動かすこと。** いまの Agent は決まった順の状態機械で、モデルには検索語と場所の名前だけを頼みます（その2つは今回から JSON Schema でしばります）。道具の選択までモデルに任せるのは、上の比べる結果を見てから決めます
* **Google AI Studio の Gemma をしばること。** API に構造化出力がありません
* **Workers AI をしばること。** 中継の `cf:generate` は形の指定を渡していません
