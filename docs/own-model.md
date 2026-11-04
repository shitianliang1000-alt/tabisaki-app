# 自前でチューニングした Gemma を使う・公開する

旅さきの AI を、Google AI Studio の Gemma から、**自分でチューニングした Gemma 4** に切り替え、
その重みを公開するための計画と準備です。Web 版はこれまでどおり中継（Cloudflare Worker）経由の API で呼びます。

```bash
node tools/export_training_data.mjs                       # 学習データを .tabisaki/training/ に書き出す
node tools/model_eval.mjs --url=<入口> --model=<名前>      # 学習の前と後で同じ問題を採点する
npx wrangler secret put OWN_MODEL_URL                      # 中継の行き先を自前のモデルにする（AI Studio は予備に残る）
```

この文書は、2026-11-03 に「Google AI Studio を使い続けるのか、自分で作った Gemma を公開する形にしたい」という相談を受けてまとめました。
**まだ何も学習していませんし、重みも公開していません。** お金のかかる作業と、ライセンスの判断は、下の
[あなたにしかできないこと](#あなたにしかできないこと) に分けてあります。

## 目次

* [結論](#結論)
* [チューニングで何が良くなるか（RAG との分担）](#チューニングで何が良くなるかrag-との分担)
* [学習に使ってよいデータ](#学習に使ってよいデータ)
* [Gemma 4 のライセンスと公開の条件](#gemma-4-のライセンスと公開の条件)
* [かかる費用と機械の目安](#かかる費用と機械の目安)
* [学習データの書き出し](#学習データの書き出し)
* [採点（学習の前と後を比べる）](#採点学習の前と後を比べる)
* [どこで動かすか](#どこで動かすか)
* [中継の切り替え（OWN_MODEL_URL）](#中継の切り替えown_model_url)
* [進めかた](#進めかた)
* [あなたにしかできないこと](#あなたにしかできないこと)

## 結論

| 問い | 答え |
|---|---|
| Google AI Studio を使い続けるか | **すぐには外しません。予備として残します。** 自前のモデルの入口を設定すると、中継はまずそちらに聞き、答えないとき（落ちている・起動中・時間切れ）だけ AI Studio に聞き直します |
| Web 版はどう呼ぶか | いままでどおり中継の API（`/gemini/generate`）です。画面の側は変えません。中継が行き先を切り替えます |
| 自前のモデルは作れるか | 作れます。Gemma 4 は Apache License 2.0 なので、チューニングした重みの公開もできます |
| いちばんの壁は | **データのライセンス**です。動かすのは個人のパソコン（ryo さんの PC を中継の行き先にする・利用者が手元で動かす）なので、置き場所の費用はかかりません。学習は無料の枠〜数千円です |
| 公開の形 | 非商用でかまわない（2026-11-03 ryo さん）。国土数値情報・Yahoo! 由来も入れて、**重みを非商用ライセンスで出す**形にできます（`--noncommercial`）。国土数値情報は問い合わせない方針、Yahoo! は公開の前に確認します（下） |
| 「情報インプット」はどこで | 事実（場所・営業時間・料金）は、これまでどおり収録（`kb/`）から毎回渡します（RAG）。チューニングは「渡された候補だけを使う・知らない場所を作らない・決まった形で答える」を覚えさせるのに使います |

## チューニングで何が良くなるか（RAG との分担）

旅さきは、すでに **RAG**（調べてから答えさせる）の形です。行き先の候補とスポットを収録から選んでプロンプトに入れ、
返ってきた旅程は `packages/core/src/grounding.js`（#447）が収録と照らし合わせます。

| やりたいこと | チューニング | RAG（収録を渡す） |
|---|:---:|:---:|
| 決まった JSON の形で答える・余計な前置きを書かない | ◎ | — |
| 候補に無い場所・列車を作らない、知らない場所は「見つからない」と言う | ◎ | ○（渡す候補を絞る） |
| 旅さきらしい日本語の言い回し | ◎ | — |
| 営業時間・料金・休館日を正しく言う | △（古くなる・覚え違える） | ◎（収録を直せばすぐ直る） |
| 新しく足したスポットを知っている | ×（学習し直しが要る） | ◎ |

**事実を重みに覚えさせるのはやめておきます。** 収録を直しても、学習し直すまで古い答えが出るからです。
学習データの答えにも、収録にある値だけを書き、「出かける前に公式の案内で確かめてください」を付けています。

## 学習に使ってよいデータ

[ライセンスと外部データ](./data-licenses.md) で分かっている条件に合わせて、書き出しの段階で外します。
数は 2026-11-03 の `kb/`（スポット 54,100件）で `tools/export_training_data.mjs` を走らせた結果です。

| 出どころ（`src`） | 件数 | 条件 | 既定 |
|---|---:|---|:---:|
| 国土数値情報 観光資源（`kokudo`・P12）・文化施設（P27） | 13,101 | **非商用・複製物の再配布不可**（[kokudo-licenses.md](./kokudo-licenses.md)） | `--with-kokudo` で入れる |
| 座標つき観光地一覧（`tourlist-geocoded`） | 10,487 | 座標の9割が **Yahoo! JAPAN の API**。保存・再配布の可否が未確認 | `--with-yahoo` で入れる |
| Wikipedia（`wikipedia`・`wikipedia-tourlist`、説明文） | 8,838 | CC BY-SA 4.0（継承） | `--with-cc-by-sa` で入れる |
| OpenStreetMap（`osm-tourlist`） | 4,177 | ODbL 1.0（継承） | `--with-odbl` で入れる |
| 出どころ不明（`opendata`） | 1,081 | 条件が分からない | 入れない |
| Wikidata（`wikidata`） | 14,740 | CC0 1.0 | 入れる |
| Overture Maps（`overture-tourlist`） | 1,339 | CDLA-Permissive-2.0 / Apache-2.0（AI の学習・出力に制限なし） | 入れる |
| 旅さきの収録データ（手で確かめたもの） | 3,946 | プロジェクトのデータ | 入れる |

加えて、**裏取り（`kb/verification-*.json`）が済んだものだけ**を使います（既定 `--verify=verified`）。

| 書き出しの設定 | 使うスポット | 学習用の行 |
|---|---:|---:|
| 既定（ライセンスが安全・裏取り済みだけ） | 1,580 | 約1,800 |
| `--verify=high`（名前がよく合うものも） | 13,091 | 約13,500 |
| `--verify=high --with-cc-by-sa` | 21,929 | 約22,200 |
| `--verify=high --with-cc-by-sa --with-odbl` | 24,380 | 約24,600 |
| `--noncommercial`（上の4つ全部。裏取り済みだけ） | 23,810 | 約24,000 |
| `--noncommercial --verify=high` | 38,108 | 約37,700 |
| `--noncommercial --verify=any`（ほぼ全部） | 53,019 | 約51,900 |

`--noncommercial` は `--with-cc-by-sa --with-odbl --with-kokudo --with-yahoo` をまとめたものです。出どころ不明（`opendata`）だけは入れません。
`manifest.json` の `weightsLicense` に、入れたものから決まる重みのライセンスの下限（例「非商用に限る」）を書きます。

既定のままだと少なめです。**非商用で公開するなら `--noncommercial --verify=high` を勧めます**（名前がよく合うものまで。合いの低いものは作り話を覚える元になるので外します）。

利用者の会話は**使いません**。会話は端末の中にだけあり、集めていません（[feedback.md](./feedback.md)）。

## Gemma 4 のライセンスと公開の条件

Gemma 4 は **Apache License 2.0** です（Gemma 3 までの独自の利用規約から変わりました）。チューニングした重みを公開するときは:

* Apache License 2.0 の全文を付け、元が Gemma 4 であることと、手を加えたことを書きます（モデルカードと `NOTICE`）
* 「Google 公式」「Google と提携」と読める名前・書きかたはしません。名前に Gemma を入れるかは、Google の商標の案内を確かめて決めてください
* 重みのライセンスは、入れたデータで決まります。既定のデータだけなら Apache 2.0、国土数値情報・Yahoo! 由来を入れるなら**非商用**（アプリ本体と同じ PolyForm Noncommercial か CC BY-NC-SA など）です。Gemma 4 由来の部分は Apache 2.0 の条件（全文・NOTICE）を守れば、上に非商用の条件を重ねられます

**学習に入れたデータの条件は、重みにもついて回る可能性があります。**

| 入れたもの | 重みを公開するとき |
|---|---|
| 既定のもの（CC0・CDLA-Permissive・Apache・旅さきのデータ） | 出どころの表示をモデルカードに書けば、Apache 2.0 で出せます |
| CC BY-SA（Wikipedia の文） | 重みが「翻案」にあたるかは決着していません。安全側に倒すなら、重みとデータセットを CC BY-SA で出すか、入れないか |
| ODbL（OpenStreetMap） | 書き出したデータセットは ODbL の派生データベースです。重みは「Produced Work」として出典表示が要ると読むのが安全です |
| 国土数値情報 | 学習に入れるのは観光資源（P12）と文化施設（P27）で、どちらも使用許諾条件が**非商用**です（2026-11-03 に公式ページで確認。鉄道 N02 は商用可ですが学習には入れていません）。**方針（ryo さん）: 事務局には問い合わせず、元の JSON は公開せず、重みは加工したものとして扱います。** 重みに場所の名前と位置が覚え込まれるため、元データの複製物とみなされる可能性がゼロではない点は、承知のうえの判断として残します。学習データの JSON は配りません。公開するときは、モデルカードに出典（データ名・国土交通省・URL・「加工して作成」）を書きます |
| Yahoo! 由来の座標 | Yahoo! の API で取った座標を保存・再配布してよいかが未確認です（いまの `kb/` も同じ問題を抱えています）。Yahoo! デベロッパーネットワークの規約を確かめてから公開してください |

モデルカードには `manifest.json`（何を何件、どの条件で入れたか）と、下の採点の結果を載せます。

## かかる費用と機械の目安

数字は 2026-11 時点の目安です。借りる前に、その日の値段を確かめてください。

### 学習

| モデル | やりかた | 要る GPU のメモリ | 機械 | 1回の目安 |
|---|---|---|---|---|
| Gemma 4 E4B（小さい版） | LoRA | 16GB | Kaggle・Google Colab の無料枠（T4） | 無料・1〜3時間 |
| Gemma 4 26B-A4B | QLoRA（4bit） | 24〜48GB | A100 40GB／L40S 48GB などを時間借り | 数百円〜数千円・2〜6時間 |
| Gemma 4 26B-A4B | LoRA（16bit） | 80GB | A100／H100 80GB | 数千円・2〜6時間 |

26B-A4B は「全体 26B・1回に動くのは約4B」の MoE（専門家を切り替える形）です。学習の道具（Unsloth・PEFT など）が
Gemma 4 の MoE に対応しているかを、使う版で確かめてください。**はじめは E4B で、無料の枠で通しで試すのを勧めます。**
データ・手順・採点がうまく回ると分かってから、26B にお金を使います。

### 動かす機械

**個人のパソコンで動かします**（2026-11-03 ryo さん）。置き場所の費用はかかりません。26B-A4B を 4bit（GGUF の Q4）にすると、
メモリ（GPU か、Apple シリコンの共有メモリ）が **16〜24GB ほど**要ります。足りない PC には E4B（8GB 前後）を用意します。

| 使いかた | どう動くか |
|---|---|
| Web 版 | ryo さんの PC の Ollama を Cloudflare Tunnel で外から呼べるようにし、その URL を中継の `OWN_MODEL_URL` に入れます。PC が消えているあいだは AI Studio に回ります |
| 端末・アプリの利用者 | 公開した GGUF を自分の PC の Ollama に入れ、`tabisaki plan --local`（#406）か `--hybrid`（#439）で使います |

ほかの置き場所（参考。お金がかかります）:

| 置き場所 | 月の目安 | 待ち時間 |
|---|---|---|
| GPU を常に借りっぱなし | 数万円〜 | 速い |
| 使うときだけ起きる GPU（scale to zero） | 使ったぶん（数百円〜数千円） | 起きるまで1〜数分。そのあいだは中継が AI Studio に回します |
| 自分の PC（Ollama）＋ Cloudflare Tunnel | 電気代だけ | PC が点いているときだけ。消えていれば AI Studio に回ります |
| Cloudflare Workers AI の LoRA | Workers AI の料金（無料枠あり） | 速い。**ただし Gemma 4 26B に LoRA を載せられるかは未確認** |

## 学習データの書き出し

```bash
node tools/export_training_data.mjs                    # 既定（安全なものだけ）
node tools/export_training_data.mjs --verify=high      # 名前がよく合うものも入れる
node tools/export_training_data.mjs --no-plans         # 旅程の例を作らない（数秒で終わる）
node tools/export_training_data.mjs --out=dir          # 書く場所（既定 .tabisaki/training/、git には入りません）
```

| ファイル | 中身 |
|---|---|
| `train.jsonl` | 学習用。1行が `{"messages":[{"role":"user",…},{"role":"assistant",…}],"meta":{…}}`。Hugging Face の TRL・Unsloth がそのまま読める形です |
| `eval.jsonl` | 評価用。スポット単位で約5%。学習用と同じ場所は入りません（分けかたは毎回同じ） |
| `manifest.json` | 使った件数・ライセンスごとの件数・外した件数と理由・`kbHash` |

`meta` には、行ごとに `spotIds`（収録の id）・`sources`・`licenses`・`verified` を残します。あとから
「この行はどの条件のデータから作ったか」をたどれます。学習の道具が余計な列を嫌うときは `jq -c '{messages}'` で落としてください。

作る例は4種類です。

| `meta.task` | 問い | 答え |
|---|---|---|
| `spot_fact` | 「清水寺について教えてください。」 | 都道府県・エリア・分類・（あれば）見ごろ・時間・料金。収録の値だけで書く |
| `area_list` | 「箱根で行ける場所を教えて。」 | エリアの一言と、収録の場所を有名な順に8件まで |
| `unknown_place` | 収録に無い作った名前（「静岡市七色滝」など） | 「収録には見つかりませんでした。作って答えることはしません」 |
| `itinerary` | 出発地・日数・希望・日付・時刻 | プログラム（`core.plan`）が組んだ旅程の立ち寄り。外した出どころの場所が1つでも入る旅程は使いません |

旅程の例は、いまの収録だと多くが外れます（国土数値情報・Yahoo! 由来の場所が入るため）。外した出どころの代わりを
Wikidata・Overture・手で確かめたデータで埋めるほど、使える旅程が増えます。

## 採点（学習の前と後を比べる）

`tools/model_eval.mjs` は、`eval.jsonl` の問いを OpenAI 互換の入口（`POST /v1/chat/completions`）に1問ずつ聞いて採点します。

```bash
# 元の Gemma（手元の Ollama）
node tools/model_eval.mjs --url=http://localhost:11434 --model=gemma4:26b --out=before.json
# チューニングしたもの
OWN_MODEL_KEY=… node tools/model_eval.mjs --url=https://xxxx.endpoints.huggingface.cloud --model=tabisaki-gemma --out=after.json
# AI Studio のいまの Gemma（Google の OpenAI 互換の口。無料枠を使います。--limit で絞ってください）
OWN_MODEL_KEY=$GEMINI_API_KEY node tools/model_eval.mjs \
  --url=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions --model=gemma-4-26b-a4b-it --limit=100
```

| 指標 | 意味 |
|---|---|
| `fact.prefecture` | スポットの都道府県を正しく書けたか |
| `fact.grounded` | 収録に無い固有名（◯◯寺・◯◯駅…）を書かなかったか。判定は旅程の裏取り（`grounding.js` の `unknownNames`）と同じ |
| `unknown.refused` | 収録に無い場所を聞かれて「見つからない」と言えたか |
| `list.known` | エリア・旅程で挙げた名前が収録にあるか |

これに加えて、組んだ旅程の裏取りの数（`itin.grounding`。外した立ち寄り・差し替えた文の数）を、
手元の LLM の道（[local-llm.md](./local-llm.md)）で見ます: `./tabisaki plan "…" --local --llm-url=<入口> --model=<名前> --output=json`。
旅程の成立率（[benchmarks.md](./benchmarks.md)）は AI を使わないので、モデルを変えても動きません。

**公開・切り替えの目安**: 4つの指標が、元の Gemma より下がらないこと。`unknown.refused` と `fact.grounded` は上がっていること。

## どこで動かすか

| 置き場所 | どう呼ぶか | 向いているとき |
|---|---|---|
| **Hugging Face Inference Endpoints**（TGI・vLLM） | OpenAI 互換。`OWN_MODEL_URL` に入口、`OWN_MODEL_KEY` に HF のトークン | 手間を少なく。scale to zero で費用を抑えられる |
| RunPod・Modal などのサーバーレス GPU（vLLM） | OpenAI 互換。同上 | 安く。起動待ちは AI Studio が埋めます |
| 自分の PC の Ollama ＋ Cloudflare Tunnel | OpenAI 互換。同上 | 費用ゼロで試す |
| Cloudflare Workers AI の LoRA | 中継の中（`env.AI.run` に LoRA を渡す）。いまの `/cf/generate` を広げる形 | Gemma 4 26B が LoRA に対応していれば、いちばん安くて速い。**対応の確認が先** |
| 手元（CLI・オフライン） | GGUF を Hugging Face Hub に置き、`ollama create` で取り込み、`tabisaki plan --local --model=…`（#406） | 端末でだけ使う人 |
| 手元＋クラウドの使い分け | `tabisaki plan --hybrid`（#439）。手元に小さい自前モデル、クラウド側は中継（＝自前→AI Studio の順） | 費用とオフラインの両立 |

重みは Hugging Face Hub に置くのを勧めます（LoRA だけ・まとめた重み・GGUF の3つ）。どの置き場所も、そこから取れます。

## 中継の切り替え（OWN_MODEL_URL）

`server/own-model.js`。画面は何も変えずに、中継の `/gemini/generate` の行き先が変わります。

1. `OWN_MODEL_URL` があれば、Gemini の形の頼みを OpenAI 互換の形に直して、自前のモデルに聞く
2. 答えが取れれば、Gemini の形に戻して返す（見出し `X-Tabisaki-Model-Source: own`）
3. 落ちている・起動中・時間切れ・空の答えなら、**AI Studio に聞き直す**（`aistudio-fallback;own=<理由>`）
4. `OWN_MODEL_URL` が無ければ、いままでどおり AI Studio だけ

| 設定（Worker） | 種類 | 意味 |
|---|---|---|
| `OWN_MODEL_URL` | secret か var | 入口の土台（`https://…`。`/v1/chat/completions` は足します。末尾が `/v1` や `/chat/completions` でも可） |
| `OWN_MODEL_NAME` | var | 入口に渡すモデル名（既定 `tabisaki-gemma`） |
| `OWN_MODEL_KEY` | **secret** | 入口の鍵（要らない入口なら置かない） |
| `OWN_MODEL_TIMEOUT_MS` | var | 自前のモデルを待つ時間（既定 40000。最大 110000）。過ぎたら AI Studio へ |
| `OWN_MODEL_FALLBACK` | var | `off` にすると AI Studio に聞き直さない（自前だけで試すとき） |

AI Studio を待つ時間は、自前のモデルを待ったぶん縮めます（画面は 135 秒で諦めるため）。`/status` に `ownModel: true/false` が出ます（URL・鍵は出しません）。
鍵はブラウザに置きません（いままでと同じ決まりです）。

画面が JSON を頼むときは、本文に形（`guidedSchema`。JSON Schema）を添えます。中継はそれを Google へは渡さず、自前のモデルへ聞くときだけ
`response_format: json_schema` に使います。vLLM なら形に合わない出力が出なくなります（[guided-decoding.md](./guided-decoding.md)）。

## 進めかた

| 段 | やること | 誰が | お金 |
|---|---|---|---|
| 0 | 書き出し・採点・中継の切り替えを用意する（この PR） | Claude | なし |
| 1 | 重みのライセンス（非商用）と名前を決め、Yahoo! の規約を確かめる（国土数値情報は問い合わせない方針） | ryo | なし |
| 2 | 元の Gemma を採点して基準を作る（`model_eval.mjs`） | Claude（鍵か手元の Ollama があれば） | AI Studio の無料枠 |
| 3 | E4B を無料の枠で LoRA して、通しで試す | ryo のアカウントで | なし |
| 4 | 26B-A4B を QLoRA する | ryo の PC（GPU 24GB 以上）か時間借り | なし〜数千円 |
| 5 | 採点して、良ければ ryo の PC の Ollama ＋ Cloudflare Tunnel に載せ、`OWN_MODEL_URL` を入れる | ryo ＋ Claude（手順と確認） | なし |
| 6 | Hugging Face Hub に重みとモデルカードを公開する | ryo | なし |

学習の手順（Unsloth か TRL の SFT、LoRA の r=16 前後、2〜3周、`eval.jsonl` で過学習を見る）は、段3でアカウントと
機械が決まってから、そのノートブックに合わせて書きます。道具の版で書きかたが変わるためです。

## あなたにしかできないこと

1. **データの方針**: 非商用でよいとのことなので、`--noncommercial --verify=high`（約3.8万スポット）で進める案にしました。違えば言ってください
2. **国土数値情報**: 窓口には聞かない方針です（2026-11-03）。元の JSON を公開しないことだけ守ります（[kokudo-licenses.md](./kokudo-licenses.md)）
3. **Yahoo! の規約を確かめる**: API で取った座標を保存・再配布してよいか
4. **重みのライセンスと名前を決める**: 国土数値情報・Yahoo! 由来を入れるなら非商用（PolyForm Noncommercial か CC BY-NC-SA）。名前に「Gemma」を入れるかは Google の商標の案内を見て決めてください
5. **アカウントを作る**: Hugging Face（重みの置き場所）、学習に使う Kaggle か Google Colab
6. **学習の機械を決める**: E4B は無料の枠で足ります。26B は、自分の PC に GPU のメモリが 24GB 以上あればそこで、無ければ時間借り（数百〜数千円／回）です
7. **Web 用に PC を出す**: Ollama と Cloudflare Tunnel を入れ、その URL を `npx wrangler secret put OWN_MODEL_URL` で中継に入れます（手順は段5で書きます）
8. **公開ボタンを押す**: Hugging Face Hub への公開は、取り消しても複製が残ります。採点の結果と、2・3の答えを見てから押してください
