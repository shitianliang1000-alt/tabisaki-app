// 正式なアドレス（canonical）は workers.dev に揃えます（2026-10-23 に決定）。
// 同じサイトを PHP 版（tabisaki.site.je）でも配っているので、ページごとに名乗りがばらばらだと、
// 検索エンジンの評価が2つに割れます。ここでは、名乗る場所がすべて同じかを見ます。
// AI の中継（packages/core/src/config.js の PROXY_URL）は workers.dev のままです。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { SITE_ORIGIN } from "../server/landing.js";

const root = new URL("../", import.meta.url);
const read = (f) => readFile(new URL(f, root), "utf8");
const SITE = "https://tabisaki-github-io.shitianliang1000.workers.dev";

test("Worker と PHP 版は、同じ正式なアドレスを持つ", async () => {
  assert.equal(SITE_ORIGIN, SITE);
  assert.match(await read("php/inc/site.php"), /const SITE_ORIGIN = 'https:\/\/tabisaki-github-io\.shitianliang1000\.workers\.dev';/);
  assert.match(await read("tools/build_area_pages.mjs"), /const DEFAULT_BASE = "https:\/\/tabisaki-github-io\.shitianliang1000\.workers\.dev\/";/);
});

test("静的なページ・サイトマップ・robots.txt も、正式なアドレスを名乗る", async () => {
  const html = await read("index.html");
  assert.match(html, /<link rel="canonical" href="https:\/\/tabisaki-github-io\.shitianliang1000\.workers\.dev\/app">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/tabisaki-github-io\.shitianliang1000\.workers\.dev\/app">/);
  assert.match(await read("credits.html"), /<link rel="canonical" href="https:\/\/tabisaki-github-io\.shitianliang1000\.workers\.dev\/credits\.html">/);
  assert.match(await read("robots.txt"), /^Sitemap: https:\/\/tabisaki-github-io\.shitianliang1000\.workers\.dev\/sitemap\.xml$/m);
  const sitemap = await read("sitemap.xml");
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0);
  for (const u of locs) assert.ok(u.startsWith(`${SITE}/`), u);
});

test("AI の中継は workers.dev のまま（正式なアドレスとは別）", async () => {
  assert.match(await read("packages/core/src/config.js"), /workers\.dev/);
  assert.match(await read("index.html"), /connect-src[^"]*tabisaki-github-io\.shitianliang1000\.workers\.dev/);
});
