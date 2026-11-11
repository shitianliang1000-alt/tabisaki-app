# 自前モデルの学習: データから GGUF まで一巡する

旅さきの自前モデル（Gemma 4 に LoRA をかけたもの）を、学習データから Ollama で動く GGUF まで、
1本の手順で作り、採点して、合格したものだけを配る仕組みです（Issue #434）。
なぜ自前のモデルを持つか、どこで動かすかは [own-model.md](own-model.md) にあります。

## 一巡の流れ

```sh
bash training/pipeline.sh          # GPU の機械で。全部の段を順に
```

| 段 | すること | 道具 | できるもの（`runs/<TAG>/`） |
| --- | --- | --- | --- |
| 1 | 学習データを書き出す（[datasets.md](datasets.md) の知恵・ReAct・未知の要望も入る） | `tools/export_training_data.mjs` | `.tabisaki/training/{train,eval}.jsonl`・`manifest.json` |
| 2 | LoRA をかける | `training/train_lora.py`（Unsloth。無ければ PEFT） | `adapter/`・`merged/`・`run.json` |
| 3 | GGUF Q4_K_M にして Ollama に入れる | Unsloth の `save_pretrained_gguf`（PEFT のときは `training/to_gguf.sh`） | `gguf/*.Q4_K_M.gguf`・`Modelfile`・`SHA256SUMS` |
| 4 | 採点 | `tools/model_eval.mjs`（Ollama の OpenAI 互換の入口） | `eval.json` |
| 5 | 合否 | `training/eval_gate.mjs`（`training/baseline.json`） | `gate.md`（不合格なら終了コード 1） |
| 6 | 配る | `training/publish_hf.py`（既定は見るだけ。`--push` で上げる） | Hugging Face Hub のリポジトリ |

**いちばん楽なのは Colab です。** [notebooks/train-lora.ipynb](../notebooks/train-lora.ipynb) を開き、
GPU を選んで「すべてのセルを実行」を押すと、学習の前の採点から合否まで回り、貼り付ける結果が出ます。

`runs/` は .gitignore 済みです。重みはリポジトリに入れません。

## GPU の機械（決めたこと）

**Gemma 4 E2B・E4B は Google Colab（Pro の L4）。26B-A4B を学習するときだけ RunPod を時間借り。**

| | Google Colab Pro | RunPod | Lambda |
| --- | --- | --- | --- |
| 料金（2026-11 時点の目安） | 月 $9.99 で 100 単位。L4 は 1時間 約1.7単位（約 $0.17）、A100 は約5.4単位（約 $0.54） | RTX 4090 約 $0.34〜0.69／時、L40S 48GB 約 $0.79〜0.99、A100 80GB 約 $1.19〜1.79 | A100 40GB 約 $1.99／時、H100 約 $3.99〜4.29 |
| E2B の LoRA（8〜10GB） | L4（24GB）で 40〜60分。無料の T4（16GB）でも回る | 4090 で足りる | 大きすぎる |
| 26B-A4B の QLoRA（24〜48GB） | A100 40GB なら回るが、つなぎ時間に上限がある | L40S・A100 を必要な時間だけ | 回るが割高 |
| 手間 | ブラウザだけ。ノートブックを「すべて実行」 | 機械を借りて SSH。終わったら止める（止め忘れに課金） | 同じ |

- ryo さんが手を動かす量がいちばん少ないのは Colab です。E2B の一巡なら月の単位の 1割も使いません
- RunPod は、26B-A4B を学習することになったとき（own-model.md の段4）に使います。手順は同じで、
  `bash training/pipeline.sh` を `BASE=unsloth/gemma-4-26B-A4B-it TRAIN_ARGS=--load-4bit` で回します
- Lambda は、ここで要る大きさでは割高なので使いません
- 料金の出典: runpod.io/pricing、Colab の単位あたりの目安（mccormickml.com、2024-04 の測定。L4・A100 の単位数）、
  Lambda の公開価格。Colab は単位の消費量が予告なく変わることがあります

## 学習の設定

| | 値 | わけ |
| --- | --- | --- |
| 元のモデル | `unsloth/gemma-4-E2B-it`（Google の `google/gemma-4-E2B-it` と同じ重み） | Apache-2.0。同意の手続きも要らない。Ollama・端末でも動く大きさ |
| LoRA | r=64、alpha=64、dropout 0、言葉の層の注意（q・k・v・o）と MLP（gate・up・down）だけ | Issue の指定。画像・音声の層には触らない |
| 学ぶところ | 答え（assistant）の部分だけ | 質問の言い回しまで覚えると、答えが崩れる（`training/sft_format.py`） |
| 学習率 | 2e-4、はじめの5歩で上げ、あとは直線で下げる | Unsloth の Gemma 4 の勧め |
| 1歩の大きさ | 1件 × 8回ためる（実質 8件） | E2B を 10GB 以内に収める |
| 周回 | 1周（`EPOCHS=2` で増やせる） | 約2,500件なので 310歩ほど。確かめの損失を見て決める |
| 長さ | 2,048 トークンまで | いまのデータはいちばん長くて 1,474 トークン（ReAct の行。道具の一覧を含む） |

答えの部分の切り出しは、チャットの型で「答えの手前まで」と「答えまで」を2回描き、その差で決めます。
Gemma 4 の `<|turn>model` のような目印を決め打ちしないので、型が変わっても使えます。型と合わない行は
数えて外します（データセットを足す前の 1,780件は全部合いました）。

`run.json` に、条件・データの sha256・損失の推移・git のコミットを残します。同じ条件で回せば同じ結果になります
（シード 3407）。

## GGUF と Ollama

- 量子化は **Q4_K_M**。Ollama の `gemma4:e2b` の本体が 3.5GB なので、同じくらいの大きさになります
  （Issue の見積もり 1.5GB より大きめです。E2B は層ごとの埋め込みが大きいため）
- `training/Modelfile.in` が Ollama の設定のひな形です。会話の形は Gemma 4 と同じ
  （`<|turn>user … <turn|>`）で、`<turn|>` で止めます。温度などは Google の勧め（1.0・top_k 64・top_p 0.95）
- Unsloth で学習したときは、学習のあとに Unsloth が GGUF まで作ります（中で llama.cpp を組み立てます）。
  PEFT で学習したときは `LLAMA_CPP=<llama.cpp の場所> bash training/to_gguf.sh runs/<TAG>` です

## 採点と合否

`tools/model_eval.mjs` の4つの点を、`training/baseline.json` の下限と比べます。学習の前の採点
（`BASE_EVAL=runs/base-eval.json`）を渡すと、学習で 0.02 より大きく下がった点も不合格にします。

| 点 | 下限（仮） | 見ること |
| --- | ---: | --- |
| fact.prefecture | 0.90 | スポットの都道府県を正しく書いたか |
| fact.grounded | 0.85 | 収録に無い固有名を書かなかったか |
| unknown.refused | 0.80 | 収録に無い場所に「見つかりません」と言えたか |
| list.known | 0.70 | 挙げた場所が収録にあるか |

下限は仮の値です。学習の前の Gemma 4 E2B の数字が Colab で取れたら、それを少し上回る線に引き直します。
採点できた数が 50 より少ない、または失敗が 5% を超えるときも不合格です。

## 配りかた（決めたこと）

**Hugging Face Hub に置きます。Git LFS には置きません。**

| | Hugging Face Hub | GitHub の Git LFS |
| --- | --- | --- |
| 無料の枠 | 置く量・落とす量に料金なし（公開・非公開とも） | 置く量 10GiB・落とす量 月 10GiB（GitHub Free） |
| 3.5GB の GGUF だと | 何人が落としても無料 | 月に 3回落とされると枠を使い切る。版を3つ残すと置く量も一杯 |
| 使う道具から | `ollama pull hf.co/<ユーザー>/<名前>`・llama.cpp・LM Studio がそのまま読める | clone のたびに重みも落ちる（`GIT_LFS_SKIP_SMUDGE` が要る） |
| 記録 | モデルカード（学習の条件・採点・データの出典）を同じ場所に置ける | README に書くしかない |

`training/publish_hf.py` が、置く前に次を確かめます。どれかに当たれば上げません。

- 合否（`gate.md`）が「合格」であること
- 学習データの出典（`manifest.json` の groups）が cc0・project・permissive だけであること。
  CC BY-SA・ODbL（継承が要る）と国土数値情報・Yahoo! 由来（非商用・条件が不明）が入ると、重みを Apache-2.0 で
  出せなくなるためです。既定の書き出しは、これらを外しています（Wikipedia 由来 8,838件・OSM 由来 4,177件などを除外）
- [own-model.md](own-model.md) の案どおり `--noncommercial --verify=high`（約3.8万スポット）で学習したときは、
  `--noncommercial` を付けたときだけ、**非公開に限って**上げます（モデルカードは非商用の扱い）。
  公開するか、どのライセンスにするかは ryo さんが決めることです（own-model.md「あなたにしかできないこと」4）
- 既定は非公開。公開（`--public`）は、取り消しても複製が残るので、ryo さんが採点を見てから決めます
- トークンは環境変数 `HF_TOKEN` からだけ読みます

## この環境で確かめたこと・確かめていないこと

| | 確かめた場所 | 結果 |
| --- | --- | --- |
| データの整形（答えだけを学ぶ） | 手元（GPU なし）。本物の Gemma 4 のトークナイザー | 1,780件すべて整形でき、学ぶ部分が答えだけになることを確認 |
| 学習・保存（PEFT） | 手元。Gemma 4 と同じ形の小さな試験用モデル（`tiny-random/gemma-4-e`、重みはでたらめ） | 学習・確かめ・LoRA の保存・足し込みまで通る。損失が下がる |
| 一巡（1〜5） | 手元。llama.cpp と Ollama の代わりに、何もしない代役を置いて | 段どうしのつながり・合否の判定が動く（不合格を正しく出す） |
| 合否・配る前の確かめ | 手元の単体試験（CI でも回ります） | 試験 13件 |
| **Unsloth での学習・GGUF・Ollama** | **まだ。Colab で回す** | この環境には GPU が無く、llama.cpp を手元で組み立てることも許されていないため |

最後の行は、`notebooks/train-lora.ipynb` を Colab で1回回すと埋まります。

## データを変えたとき

学習データの範囲は `EXPORT_ARGS` で変えます（ノートブックでは `EXPORT_ARGS` の設定）。

```sh
bash training/pipeline.sh                                          # 既定: Apache-2.0 で出せる 1,780件
EXPORT_ARGS="--noncommercial --verify=high" bash training/pipeline.sh   # own-model.md の案（約3.8万スポット。重みは非商用）
```

学習データ（`export_training_data.mjs` の出力）が変わったら、`bash training/pipeline.sh` をやり直します。
`run.json` のデータの sha256 で、どのデータで学習した重みかが分かります。
