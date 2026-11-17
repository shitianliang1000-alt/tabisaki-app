#!/usr/bin/env bash
# GTFS-JP の取得から OpenTripPlanner への反映までを、1本で回します（Issue #430、docs/gtfs-pipeline.md）。
#
#     bash tools/otp_pipeline.sh                 熊本（otp/regions/kumamoto.json）
#     bash tools/otp_pipeline.sh toyama          otp/regions/toyama.json
#     FORCE=1 bash tools/otp_pipeline.sh         時刻表が変わっていなくても組み立て直す
#
# 順番:
#   1. 時刻表の一覧（GTFS データリポジトリ）を見て、地域の時刻表を決める
#   2. 変わったものだけ落とし、検査する（通らないもの・期限切れは外して、理由を COVERAGE.md に）
#   3. 時刻表が前の組み立てと同じなら、組み立てを飛ばす
#   4. 経路網を組み立てる（docker compose --profile otp run --rm otp-build）
#   5. OTP を起こし直し、答えるまで待つ
#   6. 収録のスポットどうしで試しに引き、1組も返らなければ失敗にする
#
# 環境変数: PAIRS（試しに引く組の数。既定 20）、OTP_URL（既定 http://127.0.0.1:8080）、
#           WAIT（起動を待つ秒数。既定 300）、FORCE
set -euo pipefail

REGION="${1:-kumamoto}"
FILE="otp/regions/${REGION}.json"
DIR="data/otp/${REGION}"
URL="${OTP_URL:-http://127.0.0.1:8080}"
cd "$(dirname "$0")/.."
[ -f "$FILE" ] || { echo "地域のファイルがありません: $FILE" >&2; exit 2; }

echo "── 1・2. 時刻表を集めて検査する"
set +e
python3 tools/otp_fetch.py "$FILE" --if-changed
rc=$?
set -e
if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then exit "$rc"; fi

if [ "$rc" -eq 3 ] && [ -z "${FORCE:-}" ]; then
  echo "── 3. 時刻表が変わっていないので、組み立てを飛ばします（FORCE=1 で組み立て直し）"
else
  echo "── 4. 経路網を組み立てる"
  OTP_REGION="$REGION" docker compose --profile otp run --rm otp-build
  cp "$DIR/feeds.json" "$DIR/graph-feeds.json"
fi

echo "── 5. OTP を起こし直す"
OTP_REGION="$REGION" docker compose --profile otp up -d --force-recreate otp
for ((i = 0; i < ${WAIT:-300}; i += 5)); do
  if curl -fsS "$URL/otp/actuators/health" >/dev/null 2>&1; then break; fi
  sleep 5
done
curl -fsS "$URL/otp/actuators/health" >/dev/null || { echo "OTP が答えません（docker compose logs otp）" >&2; exit 1; }

echo "── 6. 試しに引く"
node tools/otp_bench.mjs --url "$URL" --region "$FILE" --pairs "${PAIRS:-20}" --check
echo "できました。カバー範囲: $DIR/COVERAGE.md"
