// 旅さき — オフラインで旅程を開けるようにする。
//
// なぜ要るか
// ----------
// このアプリがいちばん役に立つのは、**旅行の当日**です。そして当日は、
// 電波の弱い場所にいます。山の中、地下、海沿い、国外のローミング。
// そこで「今日の旅」が開けないなら、作った意味が半分になります。
//
// 何を保存するか
// --------------
//   1. アプリそのもの（HTML/CSS/JS）… 変わらないので、先に入れておく
//   2. 知識ベース（kb/）          … 大きいので、読んだものだけ後から
//   3. 地図の部品（vendor/ の Leaflet） … アプリと同じく先に入れる
//   4. 地図のタイル                … **見たものだけ**、上限つきで
//   5. 写真                        … 保存しません
//
// タイルは、先回りして取りには行きません。量が読めないうえ、OSM の
// 利用方針は一括取得を禁じています。旅程の地図で**実際に表示した**
// タイルだけを、新しい順に TILE_MAX 枚まで残します。直近に作った旅程を
// 圏外で開くと、そのとき見ていた範囲の地図がそのまま出ます。
// 写真は1枚が大きく、旅程の役には立たないので入れません。

// 先に入れるものを増やしたので、版を上げます。上げないと、前の版の
// 殻（js/ の入っていないもの）を持っている端末は入れ直しません。
// 収録の入れ物が変わりました（出典ごと → 県ごと。tools/reshard_kb.py）。
// 版を上げないと、前の版で溜めた 4.8MB が端末に残り続けます。
// v5: 画面の記号を単線SVGに替え、js/ をぜんぶ先に入れるようにしました。
// 先に入れるものが増えたので、また上げます。
// v9: Leaflet を vendor/ から配るようにし、地図のタイルを取っておくように
// しました。
// v10: 画面の枠を組み替えました（js/shell.js を足し、css を大きく変えています）。
// v11: チャットの画面にしました（js/chat.js・packages/core/src/chatread.js を足しています）。
// v12: 質問に答える js/qa.js、晴れ・近場で選ぶ packages/core/src/sunny.js、見出しの字
//      （vendor/fonts/）、地を塗らないしるし（mark.svg）を足しました。
// v13: ホームを挨拶と入力欄だけにし、当日の札と共有を答えに出しました。
// v20: こだわりを入力欄の下へ出し、答えに動き（js/motion.js）を足しました。
// v22: 起動に要る js/ を app.js と chunk-*.js にまとめました（tools/optimize_site.mjs）。
// v26: 旅程を組む部分を js/ から packages/core/src/ へ移しました（#348）。
// v27: #396（感想の欄 js/feedback.js）と #398（src/ への移動）の合流で、
//      v26 のまま中身だけ変わるのを避けるため版を上げました。
// v28: 携帯アプリ用の js/native.js を足しました（#385）。
const VERSION = "tabisaki-v28";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
// タイルは版と関係なく残します。版を上げるたびに、見た地図が消える
// 理由はありません。
const TILES = "tabisaki-tiles";
/** 取っておくタイルの上限。1枚15KB前後なので、約6MBです。 */
const TILE_MAX = 400;
const TILE_HOST = /(^|\.)tile\.openstreetmap\.org$/;

/** 先に入れておくもの。ここが欠けるとアプリが開きません。 */
const SHELL_FILES = [
  "./",
  // チャットの画面の正式なアドレス（Worker・PHP 版とも /app）。ホーム画面に
  // 足したアプリもここから開きます（manifest.webmanifest の start_url）。
  // ファイルではなく Worker・PHP が返すので、静的に配るだけの場所では
  // 404 になりますが、allSettled なので他のものは入ります。
  "./app",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./mark.svg",
  "./icon-192.png",
  "./css/hig-tokens.css",
  "./css/hig.css",
  "./css/app.css",
  // 地図の部品。ここが欠けると、圏外では旅程の地図が出ません。
  // 見出しの字（css/app.css の @font-face）。
  "./vendor/fonts/noto-sans-jp-109-500-normal.woff2",
  "./vendor/fonts/noto-sans-jp-116-500-normal.woff2",
  "./vendor/fonts/noto-sans-jp-119-500-normal.woff2",
  "./vendor/leaflet.js",
  "./vendor/leaflet.css",
  "./vendor/images/marker-icon.png",
  "./vendor/images/marker-icon-2x.png",
  "./vendor/images/marker-shadow.png",
  "./vendor/images/layers.png",
  "./vendor/images/layers-2x.png",
  // **js/ は、ぜんぶ先に入れます。**
  //
  // ここは以前「これが欠けると起動しないものだけ」を手で並べていました。
  // 数えてみると、app.js が import で辿るものは72件あり、そのうち
  // **列挙されていたのは13件**でした。残る45件は「初回に読んだものが
  // 下の fetch で自然に入る」に任されていましたが、それが成り立つのは
  // 一度でも圏内で使ったときだけです。
  //
  //   ホーム画面に追加して、翌朝そのまま山へ行く
  //
  // これをやると、import が1つ解けずに真っ白な画面になります。旅の
  // 当日に、いちばんしてはいけないことです。
  //
  // 手で並べる形は、**黙って腐ります**（新しいモジュールを足した人が
  // ここを直し忘れても、圏内では何も起きないので気づけません）。
  // 全部並べて、tests/sw-shell.test.js が js/ と突き合わせます。
  //
  // 大きさは合計1.4MBです。圏外で開けることのほうが大事です。
  "./js/app.js",
  "./js/areamap.js",
  "./js/arrive.js",
  "./js/art.js",
  "./js/confidence.js",
  "./js/edit.js",
  "./js/errors.js",
  "./js/feedback.js",
  "./js/fit.js",
  "./js/follow.js",
  "./js/history.js",
  "./js/ical.js",
  "./js/icons.js",
  "./js/links.js",
  "./js/map.js",
  "./js/native.js",
  "./js/nextleg.js",
  "./js/notify.js",
  "./js/online.js",
  "./js/orderdiff.js",
  "./js/metrics.js",
  "./js/photos.js",
  "./js/reach.js",
  "./js/routemap.js",
  "./js/share.js",
  "./js/shell.js",
  "./js/chat.js",
  "./js/motion.js",
  "./js/boot-check.js",
  "./js/qa.js",
  "./js/sketch.js",
  "./js/snapshot.js",
  "./js/today.js",
  "./js/transfer.js",
  "./js/tripmode.js",
  "./js/typescale.js",
  "./js/ui.js",
  "./js/variants.js",
  // 旅程を組む部分（packages/core/src/）。画面の js/ が読みます。これも全部です。
  "./packages/core/src/access.js",
  "./packages/core/src/ai.js",
  "./packages/core/src/areas.js",
  "./packages/core/src/backup.js",
  "./packages/core/src/chatread.js",
  "./packages/core/src/config.js",
  "./packages/core/src/cost.js",
  "./packages/core/src/crowd.js",
  "./packages/core/src/dedupe.js",
  "./packages/core/src/discover.js",
  "./packages/core/src/endpoints.js",
  "./packages/core/src/events.js",
  "./packages/core/src/feasibility.js",
  "./packages/core/src/geo.js",
  "./packages/core/src/hours.js",
  "./packages/core/src/intent.js",
  "./packages/core/src/journeys.js",
  "./packages/core/src/kb.js",
  "./packages/core/src/keywords.js",
  "./packages/core/src/lasttrain.js",
  "./packages/core/src/lodging.js",
  "./packages/core/src/luggage.js",
  "./packages/core/src/match.js",
  "./packages/core/src/meals.js",
  "./packages/core/src/mix.js",
  "./packages/core/src/modes.js",
  "./packages/core/src/normals.js",
  "./packages/core/src/notaspot.js",
  "./packages/core/src/pipeline.js",
  "./packages/core/src/places.js",
  "./packages/core/src/planner.js",
  "./packages/core/src/purpose.js",
  "./packages/core/src/providers.js",
  "./packages/core/src/quota.js",
  "./packages/core/src/relax.js",
  "./packages/core/src/reliability.js",
  "./packages/core/src/replan.js",
  "./packages/core/src/romaji.js",
  "./packages/core/src/root.js",
  "./packages/core/src/ropeways.js",
  "./packages/core/src/routes.js",
  "./packages/core/src/sample-data.js",
  "./packages/core/src/scenic.js",
  "./packages/core/src/score.js",
  "./packages/core/src/settings.js",
  "./packages/core/src/shapes.js",
  "./packages/core/src/stays.js",
  "./packages/core/src/stops-data.js",
  "./packages/core/src/stops-worker.js",
  "./packages/core/src/stops.js",
  "./packages/core/src/story.js",
  "./packages/core/src/sun.js",
  "./packages/core/src/sunny.js",
  "./packages/core/src/tickets.js",
  "./packages/core/src/touring.js",
  "./packages/core/src/trains.js",
  "./packages/core/src/transit.js",
  "./packages/core/src/trip.js",
  "./packages/core/src/verify.js",
  "./packages/core/src/weather.js",
  "./packages/core/src/yahoo-transit.js",
];

self.addEventListener("install", (e) => {
  // 1つでも落とせないと install が失敗するので、個別に入れます
  // （allSettled。1件の取りこぼしで全部が無駄になりません）。
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // 古い版のキャッシュを捨てます。放っておくと端末に溜まります。
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => !k.startsWith(VERSION) && k !== TILES)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 地図のタイルは、見たものだけを取っておきます（上の説明）。
  if (TILE_HOST.test(url.hostname)) {
    e.respondWith(tileFirst(req));
    return;
  }
  // それ以外の外（写真・API）は触りません。そのまま通します。
  if (url.origin !== self.location.origin) return;

  // 知識ベースは「まずキャッシュ」。3.8MB を毎回取りにいく必要はありません。
  // 更新はバックグラウンドで取り込みます（次に開いたときに新しくなります）。
  if (url.pathname.includes("/kb/")) {
    e.respondWith(staleWhileRevalidate(req, DATA));
    return;
  }

  // 画面は「まずネット、だめならキャッシュ」。
  // 新しい版があるなら、そちらを見せたいためです。圏外のときだけ
  // 保存したものに落ちます。
  e.respondWith(networkFirst(req, SHELL));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // ページの要求で、何も持っていないとき。
    // 真っ白より、理由の書いてある画面のほうがましです。
    if (req.mode === "navigate") {
      const shell = (await cache.match("./app"))
        ?? (await cache.match("./index.html"));
      if (shell) return shell;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit ?? (await fresh) ?? Response.error();
}

/**
 * タイルは「まずネット、だめなら取っておいたもの」。
 *
 * 地図は描き変わるので、圏内では新しいものを見せます。取れたものは
 * 取っておき、上限を超えたら古いものから捨てます。
 */
async function tileFirst(req) {
  const cache = await caches.open(TILES);
  try {
    const res = await fetch(req);
    // opaque（CORS なしの応答）は取っておきません。中身が見えないうえ、
    // ブラウザは1枚を数MBとして容量に数えます。
    if (res.ok && res.type !== "opaque") {
      await cache.delete(req);   // 入れ直して「新しい」側へ寄せます
      await cache.put(req, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  // keys() は入れた順に返ります。先頭が古いものです。
  const extra = keys.length - TILE_MAX;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}
