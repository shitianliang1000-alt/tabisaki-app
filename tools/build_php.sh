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
#
# 国土数値情報の「非商用」のデータ（観光資源・文化施設・バス停）も入れません。
# 複製物の再配布ができないためです（docs/data-licenses.md）。作業用の写しで
# kb/ から外し（tools/strip_noncommercial.mjs）、そこから組み立てます。
# エリアのページ・トップの件数も、外したあとの kb/ から作ります。
# どうしても入れるときだけ KEEP_NONCOMMERCIAL=1 を付けます。
set -eu
out="${1:-.php-site}"
if ! node -e "require.resolve('esbuild')" >/dev/null 2>&1; then
  npm install --no-save --no-package-lock esbuild@0.25.10 >/dev/null
fi
repo="$(pwd)"
case "$out" in /*) dest="$out" ;; *) dest="$repo/$out" ;; esac
src="$repo"
if [ "${KEEP_NONCOMMERCIAL:-}" != "1" ]; then
  src="$(mktemp -d)"
  trap 'rm -rf "$src"' EXIT
  # 組み立てに要るものだけを写します（.git・作ったものは写しません）。
  tar -C "$repo" --exclude=./.git --exclude=./node_modules --exclude=./.php-site \
    --exclude=./.site --exclude=./dist --exclude=./tabisaki-php.zip -cf - . | tar -C "$src" -xf -
  [ -d "$repo/node_modules" ] && ln -s "$repo/node_modules" "$src/node_modules"
  node "$src/tools/strip_noncommercial.mjs" "$src/kb"
fi
(cd "$src" && REQUIRE_MINIFY=1 sh tools/build_site.sh "$dest")
rm -f "$out"/.nojekyll
cp -r php/. "$out"/
(cd "$src" && node tools/build_php_data.mjs "$dest")
if [ "${KEEP_NONCOMMERCIAL:-}" != "1" ]; then
  if [ -e "$out"/kb/stops-bus ] || grep -q '"src":"kokudo"' "$out"/kb/spots-*.json; then
    echo "非商用のデータが残っています" >&2; exit 1
  fi
fi
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
