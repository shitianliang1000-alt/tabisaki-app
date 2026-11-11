#!/usr/bin/env bash
# データから合否まで、一巡する（Issue #434）。GPU の機械（Colab・RunPod など）で動かします。
#
#   bash training/pipeline.sh                 # 既定: Gemma 4 E2B、LoRA r=64、Q4_K_M、Ollama、採点、合否
#   TAG=e2b-try2 EPOCHS=2 bash training/pipeline.sh
#   BASE_EVAL=runs/base-eval.json bash training/pipeline.sh   # 学習前の採点と比べる
#
# 1. 学習データを書き出す        node tools/export_training_data.mjs
# 2. LoRA をかける                python training/train_lora.py（Unsloth があれば Unsloth）
# 3. GGUF Q4_K_M にして Ollama へ  Unsloth なら 2 の中で。PEFT なら training/to_gguf.sh（LLAMA_CPP が要る）
# 4. 採点                         node tools/model_eval.mjs（Ollama の OpenAI 互換の入口）
# 5. 合否                         node training/eval_gate.mjs（training/baseline.json）
#
# 不合格なら終了コード 1。どの段の結果も runs/<TAG>/ に残ります（run.json・eval.json・gate.md）。
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=${TAG:-$(date +%Y%m%d-%H%M)}
RUN=runs/$TAG
BASE=${BASE:-unsloth/gemma-4-E2B-it}
NAME=${NAME:-tabisaki-gemma}
EPOCHS=${EPOCHS:-1}
EVAL_LIMIT=${EVAL_LIMIT:-0}
OLLAMA=${OLLAMA:-http://127.0.0.1:11434}
mkdir -p "$RUN"

echo "== 1. 学習データ"
node tools/export_training_data.mjs ${EXPORT_ARGS:-}

echo "== 2. LoRA（$BASE → $RUN）"
python training/train_lora.py --base "$BASE" --out "$RUN" --epochs "$EPOCHS" --gguf q4_k_m ${TRAIN_ARGS:-}

echo "== 3. GGUF と Ollama"
# Unsloth は版によって GGUF の置き場所・名前が変わるので、runs/<TAG> の下を探して gguf/ にそろえる
GGUF=$(find "$RUN" -name '*.gguf' 2>/dev/null | grep -i q4_k_m | head -1 || true)
if [ -z "$GGUF" ]; then
  bash training/to_gguf.sh "$RUN" "$NAME"
else
  mkdir -p "$RUN/gguf"
  [ "$(dirname "$GGUF")" = "$RUN/gguf" ] || mv "$GGUF" "$RUN/gguf/$NAME-Q4_K_M.gguf"
  GGUF=$(ls "$RUN"/gguf/*.gguf | grep -i q4_k_m | head -1)
  # Modelfile は旅さきのもの（会話の形と止める印）を使う
  sed "s|@GGUF@|./$(basename "$GGUF")|" training/Modelfile.in > "$RUN/gguf/Modelfile"
  ( cd "$RUN/gguf" && sha256sum "$(basename "$GGUF")" > SHA256SUMS && ollama create "$NAME" -f Modelfile )
fi

echo "== 4. 採点"
node tools/model_eval.mjs --url="$OLLAMA" --model="$NAME" --limit="$EVAL_LIMIT" --out="$RUN/eval.json"

echo "== 5. 合否"
set +e
node training/eval_gate.mjs --after="$RUN/eval.json" ${BASE_EVAL:+--before="$BASE_EVAL"} | tee "$RUN/gate.md"
code=${PIPESTATUS[0]}
set -e
echo "結果: $RUN"
exit "$code"
