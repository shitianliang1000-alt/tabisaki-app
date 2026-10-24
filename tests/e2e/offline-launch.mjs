// ホーム画面に足した直後に圏外になり、そのままアプリを開いたとき。
//
// manifest.webmanifest の start_url は ./app です。/app はファイルではなく
// Worker・PHP が返すページなので、静的に配るだけのサーバーでは試せません。
// そこで PHP 版（tools/build_php.sh で組み、php -S で配る）で確かめます。
//
//   1. 圏内で /app を1回だけ開く（service worker が入り、先読みが終わるまで待つ）
//   2. 通信を切る
//   3. もう一度 /app を開く（ホーム画面のアイコンから開くのと同じ）
//   4. 画面のモジュールが全部読めて（<html data-booted="1">）、入力欄が出るか
//
// 使いかた:
//   sh tools/build_php.sh .php-site
//   php -S 127.0.0.1:8090 -t .php-site tools/php_router.php &
//   BASE_URL=http://127.0.0.1:8090 node tests/e2e/offline-launch.mjs

import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8090";
const EXE = process.env.CHROME
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? undefined;

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
// 外（地図のタイル・天気・AI）へは出ません。圏外の試験なので、要りません。
await ctx.route((u) => u.origin !== new URL(BASE).origin, (r) => r.abort("connectionrefused"));

let failed = 0;
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

console.log(`旅さき — 圏外でホーム画面から開く（${BASE}）\n`);

try {
  // 1. 圏内で1回開く
  const first = await ctx.newPage();
  await first.goto(`${BASE}/app`, { waitUntil: "load" });
  // ready は、install（先読み）が終わって有効になってから返ります。
  await first.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const missing = await first.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.endsWith("-shell"));
    if (!shell) return ["（shell のキャッシュがありません）"];
    const c = await caches.open(shell);
    const want = ["./app", "./js/app.js", "./css/app.css", "./manifest.webmanifest"];
    const out = [];
    for (const f of want) if (!(await c.match(new URL(f, location.href)))) out.push(f);
    return out;
  });
  if (missing.length) fail(`先読みに無いもの: ${missing.join(" ")}`);
  else ok("/app と画面の部品が先読みされている");
  await first.close();

  // 2・3. 通信を切って、もう一度開く
  await ctx.setOffline(true);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const res = await page.goto(`${BASE}/app`, { waitUntil: "load" });
  if (!res || !res.ok()) fail(`圏外で /app が開けません（${res?.status() ?? "応答なし"}）`);
  else ok("圏外でも /app が開く");

  // 4. モジュールが全部読めたか（1つでも欠けると data-booted が付きません）
  const booted = await page.waitForFunction(
    () => document.documentElement.dataset.booted === "1", null, { timeout: 15_000 },
  ).then(() => true, () => false);
  if (!booted) fail("圏外で画面のモジュールが読めません（真っ白・押せない画面になります）");
  else ok("圏外でも画面のモジュールが全部読める");

  const visible = await page.isVisible("#note");
  if (!visible) fail("入力欄（#note）が出ていません");
  else ok("入力欄が出ている");

  const bootFail = await page.$(".boot-fail");
  if (bootFail) fail("「画面が動かない」の案内が出ています");
  if (errs.length) fail(`例外: ${errs.join(" / ")}`);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} 件 失敗` : "\nすべて通りました");
process.exit(failed ? 1 : 0);
