// 無いページを開いたときに、どちらのホストでも 404.html を見せること。
//
//   ・Cloudflare: Worker が、静的ファイルの 404 を 404.html に差し替える
//     （server/worker.js の withNotFoundPage）。状態は 404 のまま。
//   ・PHP 版: .htaccess の ErrorDocument（手元の php -S では tools/php_router.php）。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import worker, { withNotFoundPage } from "../server/worker.js";

const root = new URL("../", import.meta.url);
const W = "https://tabisaki.example.workers.dev";

const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/404") return new Response("<h1>ページが見つかりません</h1>", { headers: { "Content-Type": "text/html" } });
    if (p === "/js/app.js") return new Response("// js", { headers: { "Content-Type": "text/javascript" } });
    return new Response(null, { status: 404 });
  },
};

test("Worker: 無いページをブラウザで開くと、404.html の中身を 404 のまま返す", async () => {
  const res = await worker.fetch(new Request(`${W}/areas/nowhere.html`, { headers: { Accept: "text/html,*/*" } }),
    { ASSETS }, {});
  assert.equal(res.status, 404);
  assert.match(res.headers.get("Content-Type"), /text\/html/);
  assert.match(await res.text(), /ページが見つかりません/);
});

test("Worker: ページでないもの（画像・JS）の 404 と、ある静的ファイルはそのまま", async () => {
  const img = await worker.fetch(new Request(`${W}/nope.png`, { headers: { Accept: "image/*" } }), { ASSETS }, {});
  assert.equal(img.status, 404);
  assert.equal(await img.text(), "");
  const ok = await worker.fetch(new Request(`${W}/js/app.js`, { headers: { Accept: "text/html" } }), { ASSETS }, {});
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "// js");
});

test("Worker: 404.html が無い組み立てでは、もとの 404 を返す", async () => {
  const none = { async fetch() { return new Response(null, { status: 404 }); } };
  const req = new Request(`${W}/x`, { headers: { Accept: "text/html" } });
  const res = await withNotFoundPage(req, { ASSETS: none }, new Response(null, { status: 404 }));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "");
});

test("PHP 版: .htaccess と手元の道筋で、無い URL に 404.html を出す", async () => {
  const ht = await readFile(new URL("php/.htaccess", root), "utf8");
  assert.match(ht, /^ErrorDocument 404 \/404\.html$/m);
  const router = await readFile(new URL("tools/php_router.php", root), "utf8");
  assert.match(router, /404\.html/);
});
