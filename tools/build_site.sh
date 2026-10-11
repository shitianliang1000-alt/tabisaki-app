#!/bin/sh
# 公開するもの（dist/）を組み立てます。
#
# .github/workflows/pages.yml（公開）と test.yml（画面のテスト）の両方が
# これを呼びます。テストが見るのは、公開するのと同じ dist/ です。
#
#     sh tools/build_site.sh dist
#
# 公開するのは、ブラウザが読むものだけです。
#
# リポジトリをそのまま上げると、tests/ の固定データ、tools/ の
# Python、server/ の中継の実装、README や API_KEYS.md まで
# 同じ URL の下に公開されます。ブラウザが要るのは下の一覧だけで、
# それ以外は置く理由がありません（配信量も、探られる面も増えます）。
set -eu
dist="${1:-dist}"
rm -rf "$dist"
mkdir -p "$dist"
cp index.html credits.html icon.svg mark.svg og.svg og.png manifest.webmanifest \
   icon-180.png icon-192.png icon-512.png icon-maskable-512.png \
   robots.txt sitemap.xml sw.js "$dist"/
# admin/ は入れません。認証が無く、置けば誰でも開けます。
# 管理画面は Worker が合言葉つきで配ります（server/admin.js）。
cp -r css js kb vendor "$dist"/
# Google Search Console の所有確認用ファイル（google<数字と英字>.html）。
# 消すと確認が外れます。
cp google[0-9a-f]*.html "$dist"/ 2>/dev/null || true
# エリア別のページ（areas/）と、それを含めた sitemap.xml。
# 収録から毎回作るので、リポジトリには入れていません。
node tools/build_area_pages.mjs "$dist"
# 注釈と空白を削ります（届く量を減らし、速く開くため）。
node tools/optimize_site.mjs "$dist"
# 作業の残骸（エディタの .orig など）は入れません
find "$dist" -type f \( -name '*.orig' -o -name '*.rej' -o -name '*.patch' \) -delete
touch "$dist"/.nojekyll
# 何かの拍子に紛れ込んだら、公開する前に止めます
if [ -e "$dist"/admin ]; then echo "dist/admin must not be published" >&2; exit 1; fi
