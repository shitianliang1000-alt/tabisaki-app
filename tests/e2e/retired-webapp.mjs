// 2026-11-24: ブラウザで使う Web 版をやめ、公開サイトは旅さき（端末版・アプリ版）の紹介ページになりました。
// 前にホーム画面へ置いた人が開いたときに、迷わず紹介ページへ着くかを PHP 版で確かめます。
//
//   1. /app（前の start_url）を開くと、トップ（紹介ページ）に着き、「入れかた」（#get）がある
//   2. 前の Web 版の Service Worker が残っている人の代わりに /sw.js を入れてみる
//      → 自分で外れ、保存（Cache Storage）も消える
//
// 使いかた:
//   sh tools/build_php.sh .php-site
//   php -S 127.0.0.1:8090 -t .php-site tools/php_router.php &
//   BASE_URL=http://127.0.0.1:8090 node tests/e2e/retired-webapp.mjs

import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8090";
const EXE = process.env.CHROME
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? undefined;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.route((u) => u.origin !== new URL(BASE).origin, (r) => r.abort("connectionrefused"));

let failed = 0;
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);

console.log(`旅さき — やめた Web 版の入口（${BASE}）\n`);

try {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  // 1. /app → トップ
  const res = await page.goto(`${BASE}/app?q=%E6%B8%A9%E6%B3%89`, { waitUntil: "load" });
  const path = new URL(page.url()).pathname;
  if (!res || !res.ok()) fail(`/app を開くと ${res?.status() ?? "応答なし"}`);
  else if (path !== "/") fail(`/app がトップへ移りません（${page.url()}）`);
  else ok("/app はトップ（紹介ページ）へ移る");
  if (await page.$("#get")) ok("「入れかた」（#get）がある");
  else fail("紹介ページに #get がありません");
  if (await page.$('a[href*="/app"], a[href="app"], a[href^="app?"]')) fail("紹介ページに Web 版へのリンクが残っています");

  // 2. 前の Service Worker の代わりに /sw.js を入れる → 自分で外れて、保存も消える
  await page.evaluate(async () => {
    const c = await caches.open("tabisaki-old-shell");
    await c.put(new Request("/old"), new Response("old"));
  });
  const result = await within(page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    for (let i = 0; i < 100; i++) {
      const regs = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      if (regs.length === 0 && keys.length === 0) return "gone";
      await new Promise((r) => setTimeout(r, 100));
    }
    const regs = await navigator.serviceWorker.getRegistrations();
    return `regs=${regs.length} caches=${(await caches.keys()).join(",")}`;
  }).catch((e) => `error: ${e.message}`), 20_000);
  if (result === "gone") ok("前の Service Worker は自分で外れ、保存も消える");
  else fail(`Service Worker が外れません（${result}）`);

  // 読み直しのあとも紹介ページ
  await page.waitForLoadState("load");
  if (errs.length) fail(`例外: ${errs.join(" / ")}`);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} 件 失敗` : "\nすべて通りました");
process.exit(failed ? 1 : 0);
