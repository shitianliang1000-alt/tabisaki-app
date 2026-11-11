#!/usr/bin/env bash
# 足し込んだモデル（train_lora.py の merged/）を GGUF の Q4_K_M にして、Ollama に入れる（Issue #434）。
#
#   LLAMA_CPP=~/llama.cpp bash training/to_gguf.sh runs/e2b-r64 [tabisaki-gemma]
#
# 要るもの: llama.cpp（convert_hf_to_gguf.py と、組み立てた llama-quantize）。
#   git clone https://github.com/ggml-org/llama.cpp && cmake -B build -S llama.cpp && cmake --build build -j --target llama-quantize
#   pip install -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt
# Ollama があれば、そのまま `ollama create` まで。無ければ GGUF と Modelfile を作って止まります。
#
# Unsloth で学習したなら、train_lora.py --gguf q4_k_m が同じことを中でやります（このスクリプトは要りません）。
set -euo pipefail
RUN=${1:?"使いかた: LLAMA_CPP=<llama.cpp> bash training/to_gguf.sh <runs/…> [モデル名]"}
NAME=${2:-tabisaki-gemma}
QUANT=${QUANT:-Q4_K_M}
HERE=$(cd "$(dirname "$0")" && pwd)
: "${LLAMA_CPP:?LLAMA_CPP に llama.cpp の場所を入れてください}"
MERGED="$RUN/merged"
OUT="$RUN/gguf"
[ -f "$MERGED/config.json" ] || { echo "$MERGED がありません（train_lora.py を --no-merge なしで）" >&2; exit 1; }
QUANTIZE=""
for q in "$LLAMA_CPP/build/bin/llama-quantize" "$LLAMA_CPP/llama-quantize" "$(command -v llama-quantize || true)"; do
  [ -n "$q" ] && [ -x "$q" ] && QUANTIZE=$q && break
done
[ -n "$QUANTIZE" ] || { echo "llama-quantize が見つかりません（$LLAMA_CPP/build/bin/ を組み立てて）" >&2; exit 1; }
mkdir -p "$OUT"

F16="$OUT/$NAME-F16.gguf"
GGUF="$OUT/$NAME-$QUANT.gguf"
echo "1/3 GGUF（F16）に: $F16"
python3 "$LLAMA_CPP/convert_hf_to_gguf.py" "$MERGED" --outtype f16 --outfile "$F16"
echo "2/3 $QUANT に: $GGUF"
"$QUANTIZE" "$F16" "$GGUF" "$QUANT"
rm -f "$F16"
sed "s|@GGUF@|./$(basename "$GGUF")|" "$HERE/Modelfile.in" > "$OUT/Modelfile"
( cd "$OUT" && sha256sum "$(basename "$GGUF")" > SHA256SUMS )
ls -lh "$GGUF"

if command -v ollama >/dev/null 2>&1; then
  echo "3/3 Ollama に入れる: $NAME"
  ( cd "$OUT" && ollama create "$NAME" -f Modelfile )
else
  echo "3/3 Ollama が無いので、ここまで（cd $OUT && ollama create $NAME -f Modelfile）"
fi
