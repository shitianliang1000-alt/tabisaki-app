#!/bin/sh
# Cloudflare Worker が配るもの（.site/）を組み立てます。
#
# wrangler.jsonc の build から呼ばれます（Workers Builds でも手元でも）。
#
#     sh tools/build_worker.sh .site
#
# 中身は tools/build_site.sh（GitHub Pages に置いていたものと同じ）に、
# 管理画面（admin/）を __admin/ として、トップのひな形・CSS・JS・データを
# __site/・assets/・data/ として足したものです。__admin/ は
# Worker が合言葉を確かめてからしか渡しません（server/admin.js）。
set -eu
out="${1:-.site}"
# 注釈を削る道具（tools/optimize_site.mjs）。版は固定します。
if ! node -e "require.resolve('esbuild')" >/dev/null 2>&1; then
  npm install --no-save --no-package-lock esbuild@0.25.10 >/dev/null
fi
REQUIRE_MINIFY=1 sh tools/build_site.sh "$out"
rm -f "$out"/.nojekyll
mkdir -p "$out"/__admin
cp admin/*.* "$out"/__admin/
cp _headers "$out"/_headers
# トップ（/）。Worker が開いたときに作ります（server/landing.js）。
# ひな形とデータは PHP 版と同じものです。
mkdir -p "$out"/__site "$out"/assets
cp php/inc/landing.html "$out"/__site/landing.html
cp php/assets/landing.css php/assets/landing.js "$out"/assets/
node tools/build_php_data.mjs "$out"
echo "built $out ($(find "$out" -type f | wc -l) files)"
