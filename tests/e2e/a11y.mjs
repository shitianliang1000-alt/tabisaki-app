/**
 * 読み上げ・色・構造のテスト。
 *
 * 画面のテスト（run.mjs）は「操作したらどうなるか」を見ます。ここは
 * **「読める状態か」**を見ます。目が見えにくい人、色の見分けがつき
 * にくい人、マウスを使わない人にとって、画面が使いものになるか。
 *
 * 旅行のアプリは、明るい屋外の、日の当たる画面で読まれます。
 * 薄い灰色の注意書きは、そこでいちばん先に消えます。
 *
 * axe-core（Deque）に判定させます。自分で「たぶん読める」と決めるより、
 * 比率を測ってもらうほうが確かです。
 *
 * 動かしかた（playwright-core と axe-core が要ります）:
 *
 *     npm i -D playwright-core axe-core
 *     python3 -m http.server 8000 &
 *     node tests/e2e/a11y.mjs
 *
 * CSP（script-src 'self'）があるので、axe は**同じ出どころから**配ります。
 * CSP を緩めて通すと、試しているものが本番と違うものになります。
 * Service Worker は止めます（間に入ると、配った axe が届きません）。
 */

import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");

const BASE = process.env.BASE_URL ?? "http://localhost:8000";
const EXE = process.env.CHROME
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? undefined;

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--no-sandbox"],
});

let failures = 0;

/**
 * 1つの画面を測ります。
 *
 * @param {string} name 画面の名前（落ちたときに出ます）
 * @param {{dark?:boolean, plan?:boolean, width?:number, today?:boolean}} opts
 *   today … 旅の当日として組みます（「今日の旅」の一画が出ます）。
 *   ここには押せるものが3つ（案内・着いた・お知らせ）並ぶので、
 *   読み上げと色を別に測ります。
 */
async function audit(name, { dark = false, plan = false, width = 1280,
                             today = false, areaMap = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: dark ? "dark" : "light",
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  await page.route("**/__axe.js", (route) =>
    route.fulfill({ path: AXE, contentType: "application/javascript" }));
  // 外へは出ません。鍵が無くても旅程はできるので、測るには足ります。
  const origin = new URL(BASE).origin;
  await page.route((u) => u.origin !== origin,
    (route) => route.abort("connectionrefused"));

  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  const until = Date.now() + 90_000;
  while (await page.$eval("#make-plan", (e) => e.disabled)) {
    if (Date.now() > until) throw new Error("知識ベースの読み込みが終わりません");
    await page.waitForTimeout(200);
  }

  if (plan) {
    // 旅のきっかけは、記述欄の下の札にまとまりました（以前はここで
    // 色の面のカードを押していました）。
    await page.click(".note-examples .md-chip");
    // 旅の当日として組みます。欄に直に書かず、画面の「今日」を押します。
    // 日付の近道は「旅の条件」のシートの中です。
    if (today) {
      await page.click("#pill-when");
      await page.click('[data-day-preset="today"]');
      await page.keyboard.press("Escape");
    }
    await page.click("#make-plan");
    // 「もう少し詳しく調べますか」には、利用者として答え続けます。
    const answering = setInterval(() => {
      page.evaluate(() => {
        const dlg = document.getElementById("quota-dialog");
        if (dlg?.open) document.getElementById("quota-go")?.click();
      }).catch(() => {});
    }, 500);
    await page.waitForSelector("#result:not([hidden])", { state: "attached", timeout: 120_000 });
    // 旅程の細かい板は「詳細を確認する」の奥です。開いて、そこも測ります。
    await page.click("#details-toggle");
    await page.waitForTimeout(1500);
    clearInterval(answering);
  }

  if (areaMap) {
    // エリアを地図で探す画面。ピンを1本押して、吹き出しまで出した形で測ります。
    // 狭い画面では、入口は旅の一覧（引き出し）の中です。
    if (width < 1100) await page.click("#side-open");
    await page.click("#open-area-map");
    await page.waitForSelector("#area-dialog .area-pin", { timeout: 15_000 });
    await page.evaluate(() => {
      document.querySelector('#area-dialog .area-pin[title="札幌"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector("#area-dialog .area-pop", { timeout: 5000 });
    // 吹き出しは薄い色から出てきます（Leaflet のフェード）。出きってから測ります。
    await page.waitForTimeout(800);
  }

  await page.addScriptTag({ url: "/__axe.js" });
  const { violations } = await page.evaluate(async () =>
    await window.axe.run(document, { resultTypes: ["violations"] }));

  if (!violations.length) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  NG   ${name}`);
    for (const v of violations) {
      console.log(`       [${v.impact}] ${v.id}: ${v.help}`);
      for (const n of v.nodes.slice(0, 4)) {
        console.log(`         ${n.target.join(" ")}`);
        const why = (n.any[0] ?? n.all[0] ?? n.none[0])?.message;
        if (why) console.log(`           → ${why.split("\n")[0]}`);
      }
      if (v.nodes.length > 4) console.log(`         … ほか ${v.nodes.length - 4} 件`);
    }
  }
  await ctx.close();
}

/** 読むだけのページ（著作権表記など）。スクリプトは無いので、開いてすぐ測ります。 */
async function auditStatic(name, path, { dark = false, width = 1280 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: dark ? "dark" : "light",
    serviceWorkers: "block",
    // このページの CSP は script を一切止めます（止まるのが正しい）。
    // axe はテストの側から差し込むので、ここだけ CSP を外して開きます。
    bypassCSP: true,
  });
  const page = await ctx.newPage();
  await page.route("**/__axe.js", (route) =>
    route.fulfill({ path: AXE, contentType: "application/javascript" }));
  const origin = new URL(BASE).origin;
  await page.route((u) => u.origin !== origin,
    (route) => route.abort("connectionrefused"));
  await page.goto(`${BASE}/${path}`, { waitUntil: "load" });
  await page.addScriptTag({ url: "/__axe.js" });
  const { violations } = await page.evaluate(async () =>
    await window.axe.run(document, { resultTypes: ["violations"] }));
  if (!violations.length) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  NG   ${name}`);
    for (const v of violations) {
      console.log(`       [${v.impact}] ${v.id}: ${v.help}`);
      for (const n of v.nodes.slice(0, 4)) console.log(`         ${n.target.join(" ")}`);
    }
  }
  await ctx.close();
}

/**
 * axe が見ないところの、字と地の明るさの差を測ります。
 *
 * axe の色のきまりは、**見えていて、操作できて、読み上げにも出る**
 * ものだけを見ます。次の3つは、そのどれでもないので飛ばされます。
 *
 *   ・aria-hidden を付けたもの（まぜかたの帯。数は下の文に書いてあり、
 *     帯は絵なので読み上げには出しません）
 *   ・disabled のボタン（読み込み中の「旅程をつくる」）
 *   ・畳んだ <details> の中（こだわりのチップ）
 *
 * ところが、そこにこそ**主色の上に置いた白い字**が集まっていました。
 * 暗い配色では主色が明るい水色へ反転するので、白のままだと 1.7〜2.2
 * しかありません（必要なのは 4.5）。axe は黙ったままでした。
 * 飛ばされる場所は、自分で測ります。
 */
async function contrast(name, dark) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: dark ? "dark" : "light",
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  // 畳んであるものを開き、チップを1つ選んで、選ばれた状態も測ります。
  // シートを開いて、畳んであるものも開き、チップを1つ選びます。
  await page.click("#plus").catch(() => {});
  await page.click("#pill-tune").catch(() => {});
  await page.click('[data-genre="onsen"]').catch(() => {});
  await page.waitForTimeout(300);

  const bad = await page.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const spots = [
      ["まぜかたの帯（定番）", "#mix-seg-major"],
      ["まぜかたの帯（知る人ぞ知る）", "#mix-seg-known"],
      ["まぜかたの帯（穴場）", "#mix-seg-hidden"],
      ["この条件で旅程をつくる", "#cond-make"],
      ["旅程をつくる（送る）", ".send-btn"],
      ["塗りつぶしのボタン", ".md-btn--filled"],
      ["選んだチップ", '.md-chip[aria-pressed="true"]'],
      ["手順の番号", ".home-steps li > i"],
    ];
    const out = [];
    for (const [label, sel] of spots) {
      const e = document.querySelector(sel);
      if (!e) continue;
      const st = getComputedStyle(e);
      if (st.backgroundColor.startsWith("rgba(0, 0, 0, 0")) continue;
      const r = ratio(st.color, st.backgroundColor);
      if (r < 4.5) out.push(`${label}（${sel}）: ${r.toFixed(2)}（${st.color} / ${st.backgroundColor}）`);
    }
    return out;
  });
  await ctx.close();

  if (!bad.length) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  NG   ${name}`);
    for (const line of bad) console.log(`       4.5 に足りません: ${line}`);
  }
}

console.log(`旅さき — 読み上げ・色・構造のテスト（${BASE}）\n`);

// 条件の画面と旅程の画面を、明暗それぞれと、携帯の幅で。
// 色は配色で変わり、重なりは幅で変わるので、1つでは足りません。
await audit("条件の画面（明るい配色）");
await audit("条件の画面（暗い配色）", { dark: true });
await audit("条件の画面（携帯の幅）", { width: 390 });
await audit("旅程の画面（明るい配色）", { plan: true });
await audit("旅程の画面（暗い配色）", { dark: true, plan: true });
await audit("旅程の画面（携帯の幅）", { width: 390, plan: true });
await audit("旅の当日の画面（携帯の幅）",
            { width: 390, plan: true, today: true });
await audit("旅の当日の画面（暗い配色）",
            { dark: true, plan: true, today: true });

await audit("エリアを地図で探す画面（携帯の幅）", { width: 390, areaMap: true });
await audit("エリアを地図で探す画面（暗い配色）", { dark: true, areaMap: true });

await auditStatic("著作権表記のページ（明るい配色）", "credits.html");
await auditStatic("著作権表記のページ（暗い配色・携帯の幅）", "credits.html",
                  { dark: true, width: 390 });

// axe が飛ばすところ（絵・押せないボタン・畳んだ中身）を、自分で測ります。
await contrast("主色の上の字（明るい配色）", false);
await contrast("主色の上の字（暗い配色）", true);

await browser.close();
console.log(failures ? `\n${failures} 画面に直すところがあります`
                     : "\nすべての画面で、指摘はありません");
process.exit(failures ? 1 : 0);
