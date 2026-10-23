#!/bin/sh
# PHP 版（InfinityFree などの PHP が動くサーバー）に上げるものを組み立てます。
#
#     sh tools/build_php.sh .php-site          # 組み立てるだけ
#     sh tools/build_php.sh .php-site --zip    # tabisaki-php.zip も作る
#
# 中身は、静的なサイト（tools/build_site.sh と同じもの）に、php/ の中身
# （index.php・about.php・.htaccess・inc/・assets/）と data/areas.json を
# 足したものです。そのままサーバーの htdocs/ に上げれば動きます。
#
# admin/ は入れません（認証が無いので、公開する場所には置きません）。
# 管理画面は、これまでどおり Cloudflare Worker が合言葉つきで配ります。
set -eu
out="${1:-.php-site}"
if ! node -e "require.resolve('esbuild')" >/dev/null 2>&1; then
  npm install --no-save --no-package-lock esbuild@0.25.10 >/dev/null
fi
REQUIRE_MINIFY=1 sh tools/build_site.sh "$out"
rm -f "$out"/.nojekyll
cp -r php/. "$out"/
node tools/build_php_data.mjs "$out"
# PHP の書きまちがいがあれば、上げる前に止めます。
if command -v php >/dev/null 2>&1; then
  for f in "$out"/*.php "$out"/inc/*.php; do php -l "$f" >/dev/null; done
fi
if [ -e "$out"/admin ]; then echo "admin must not be published" >&2; exit 1; fi
if [ "${2:-}" = "--zip" ]; then
  rm -f tabisaki-php.zip
  (cd "$out" && zip -qr ../tabisaki-php.zip . -x 'tests/*')
  echo "zip: tabisaki-php.zip ($(du -h tabisaki-php.zip | cut -f1))"
fi
echo "built $out ($(find "$out" -type f | wc -l) files)"
