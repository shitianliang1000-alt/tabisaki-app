#!/bin/sh
# PHP 版（InfinityFree などの PHP が動くサーバー）に上げるものを組み立てます。
#
#     sh tools/build_php.sh .php-site          # 組み立てるだけ
#     sh tools/build_php.sh .php-site --zip    # tabisaki-php.zip も作る
#
# 中身は、公開サイト（tools/build_site.sh を WEBAPP=0 で。旅さきの紹介ページだけで、
# ブラウザで使う Web 版は入れません）に、php/ の中身（index.php・version.php・
# .htaccess・assets/）を足したものです。そのままサーバーの htdocs/ に上げれば動きます。
#
# admin/ は入れません（認証が無いので、公開する場所には置きません）。
# 管理画面は、これまでどおり Cloudflare Worker が合言葉つきで配ります。
#
# 国土数値情報の「非商用」のデータ（観光資源・文化施設・バス停）も入れません。
# 複製物の再配布ができないためです（docs/data-licenses.md）。作業用の写しで
# kb/ から外し（tools/strip_noncommercial.mjs）、そこから組み立てます。
# エリアのページも、外したあとの kb/ から作ります。
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
(cd "$src" && WEBAPP=0 REQUIRE_MINIFY=1 sh tools/build_site.sh "$dest")
rm -f "$out"/.nojekyll
cp -r php/. "$out"/
if [ "${KEEP_NONCOMMERCIAL:-}" != "1" ]; then
  # 公開サイトに kb/ は置きません（Web 版をやめたので）。紛れ込んでいたら中身も見ます。
  if [ -e "$out"/kb/stops-bus ] || { [ -d "$out"/kb ] && grep -q '"src":"kokudo"' "$out"/kb/spots-*.json; }; then
    echo "非商用のデータが残っています" >&2; exit 1
  fi
fi
# PHP の書きまちがいがあれば、上げる前に止めます。
if command -v php >/dev/null 2>&1; then
  for f in "$out"/*.php "$out"/inc/*.php; do [ -e "$f" ] || continue; php -l "$f" >/dev/null; done
fi
if [ -e "$out"/admin ]; then echo "admin must not be published" >&2; exit 1; fi
# 上げた先で「古いファイルが残っていないか」を version.php で確かめられるように、
# 主なファイルの指紋（sha1）を manifest.json に書きます。
node -e '
const fs=require("fs"),c=require("crypto"),d=process.argv[1];
const files=["index.php","tour.html","sw.js",".htaccess","assets/tour.css","assets/tour.js","assets/site.css","assets/site.js"];
const o={built:new Date().toISOString(),files:{}};
for(const f of files){const p=d+"/"+f;if(fs.existsSync(p))o.files[f]=c.createHash("sha1").update(fs.readFileSync(p)).digest("hex");}
fs.writeFileSync(d+"/manifest.json",JSON.stringify(o,null,1));' "$dest"
if [ "${2:-}" = "--zip" ]; then
  rm -f tabisaki-php.zip
  (cd "$out" && zip -qr ../tabisaki-php.zip . -x 'tests/*')
  echo "zip: tabisaki-php.zip ($(du -h tabisaki-php.zip | cut -f1))"
fi
echo "built $out ($(find "$out" -type f | wc -l) files)"
