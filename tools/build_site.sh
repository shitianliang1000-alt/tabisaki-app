#!/bin/sh
# 公開するもの（dist/）を組み立てます。
#
# tools/build_worker.sh（Cloudflare）・tools/build_php.sh（PHP 版）と test.yml（画面のテスト）が
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
#
# WEBAPP=0（公開サイト。tools/build_worker.sh・tools/build_php.sh が付けます）
#   2026-11-24 から、ブラウザで使う Web 版（index.html・js/・packages/・kb/…）は
#   公開サイトに置きません。サイトは旅さき（端末版・アプリ版）の紹介ページだけです。
#   前にホーム画面へ置いた人のために、sw.js は「自分を外して保存を消す」だけのものに
#   差し替えます。
# WEBAPP=1（既定。アプリ版の中身 mobile/build.sh と、画面のテスト test.yml）
#   今までどおり、Web 版の画面とエンジンを全部入れます。
set -eu
dist="${1:-dist}"
webapp="${WEBAPP:-1}"
rm -rf "$dist"
mkdir -p "$dist"
cp credits.html tour.html ssh.html mobile.html api.html icon.svg mark.svg og.svg og.png \
   icon-180.png icon-192.png icon-512.png icon-maskable-512.png \
   robots.txt sitemap.xml "$dist"/
# admin/ は入れません。認証が無く、置けば誰でも開けます。
# 管理画面は Worker が合言葉つきで配ります（server/admin.js）。
cp -r css spots "$dist"/
if [ "$webapp" = "0" ]; then
  # 前の Web 版の Service Worker を外します。VERSION の行は sw.js と同じにしておきます
  # （.github/workflows/deploy.yml が、上がったかをこの行で確かめます）。
  { grep -m1 'const VERSION' sw.js
    cat <<'SW'
// 2026-11-24: ブラウザで使う Web 版は終わりました（旅さきは端末版とアプリ版になりました）。
// 前にホーム画面へ置いた人の Service Worker を外し、残った保存を消して、開いている画面を
// 読み直します（/app はトップへ移ります）。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
SW
  } > "$dist"/sw.js
else
  cp index.html manifest.webmanifest sw.js "$dist"/
  cp -r js kb vendor "$dist"/
  # 旅程を組む部分（packages/core/src/）。画面の js/ がここを読みます。
  # Node.js 用の入口（index.mjs・format.mjs）は、ブラウザでは使わないので入れません。
  mkdir -p "$dist"/packages/core
  cp -r packages/core/src "$dist"/packages/core/src
fi
# Google Search Console の所有確認用ファイル（google<数字と英字>.html）。
# 消すと確認が外れます。
cp google[0-9a-f]*.html "$dist"/ 2>/dev/null || true
# エリア別のページ（areas/）と、それを含めた sitemap.xml。
# 収録から毎回作るので、リポジトリには入れていません。
WEBAPP="$webapp" node tools/build_area_pages.mjs "$dist"
# 注釈と空白を削ります（届く量を減らし、速く開くため）。
node tools/optimize_site.mjs "$dist"
# 作業の残骸（エディタの .orig など）は入れません
find "$dist" -type f \( -name '*.orig' -o -name '*.rej' -o -name '*.patch' \) -delete
touch "$dist"/.nojekyll
# 何かの拍子に紛れ込んだら、公開する前に止めます
if [ -e "$dist"/admin ]; then echo "dist/admin must not be published" >&2; exit 1; fi
# 公開サイトに Web 版（チャットの画面）が紛れ込んでいたら止めます
if [ "$webapp" = "0" ] && { [ -e "$dist"/index.html ] || [ -e "$dist"/js ]; }; then
  echo "WEBAPP=0 なのに Web 版が入っています" >&2; exit 1
fi
