#!/bin/sh
# Cloudflare Worker が配るもの（.site/）を組み立てます。
#
# wrangler.jsonc の build から呼ばれます（Workers Builds でも手元でも）。
#
#     sh tools/build_worker.sh .site
#
# 中身は tools/build_site.sh の公開サイト（WEBAPP=0。旅さきの紹介ページだけで、
# ブラウザで使う Web 版は入れません）に、管理画面（admin/）を __admin/ として、
# 紹介ページの CSS・JS・動画を assets/ として足したものです。__admin/ は
# Worker が合言葉を確かめてからしか渡しません（server/admin.js）。
set -eu
out="${1:-.site}"
# Workers Builds（Cloudflare が push ごとに組み立てて上げる仕組み。WORKERS_CI=1 が付きます）
# では、先に試験を通します。落ちたらここで止まり、公開されません（前の版が残ります）。
# 手元の wrangler dev では毎回は走らせません（./tabisaki deploy は自分で先に試験します）。
if [ "${WORKERS_CI:-}" = "1" ] && [ "${SKIP_TESTS:-}" != "1" ]; then
  node --test tests/*.test.js
fi
# 注釈を削る道具（tools/optimize_site.mjs）。版は固定します。
if ! node -e "require.resolve('esbuild')" >/dev/null 2>&1; then
  npm install --no-save --no-package-lock esbuild@0.25.10 >/dev/null
fi
WEBAPP=0 REQUIRE_MINIFY=1 sh tools/build_site.sh "$out"
rm -f "$out"/.nojekyll
mkdir -p "$out"/__admin
cp admin/*.* "$out"/__admin/
# 管理画面が読む旅さきの部品（../js/・../kb/・../packages/core/src/）。公開サイトには
# 置かないので、Worker が合言葉を確かめてから渡す __private/ に入れます（server/admin.js）。
mkdir -p "$out"/__private/packages/core
cp -r js kb "$out"/__private/
cp -r packages/core/src "$out"/__private/packages/core/src
cp _headers "$out"/_headers
# 紹介ページ（tour.html・spots/・ssh.html…）が読む CSS・JS・動画。
mkdir -p "$out"/assets
cp -r php/assets/. "$out"/assets/
echo "built $out ($(find "$out" -type f | wc -l) files)"
