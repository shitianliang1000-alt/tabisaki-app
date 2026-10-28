// Web の Core Web Vitals（LCP・INP・CLS）を測ります（Issue #372）。
//
// 組み立てたサイト（tools/build_site.sh）をブラウザで開き、
//   ・LCP … いちばん大きな中身が出るまで（読み込みから）
//   ・CLS … 読み込みと操作のあいだに、画面がずれた量
//   ・INP … 押したり打ったりしてから、画面が次に描かれるまで（いちばん遅いもの）
// を、携帯（幅 390・CPU 4 倍遅く）とパソコン（幅 1280）で測ります。
// 外へは出ません（AI・地図のタイル・写真は止めます）。
//
//     sh tools/build_site.sh dist && (cd dist && python3 -m http.server 8000 &)
//     BASE_URL=http://127.0.0.1:8000 node tools/perf_web.mjs [--md] [--check] [--write-baseline]
//
// 上限は bench/perf-budget.json の web（Google の「良い」の線: LCP 2.5秒・
// INP 200ms・CLS 0.1）。基準は bench/perf-baseline.json の web です。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8000";
const BUDGET_FILE = path.join(ROOT, "bench", "perf-budget.json");
const BASELINE_FILE = path.join(ROOT, "bench", "perf-baseline.json");

export const PROFILES = {
  phone: { viewport: { width: 390, height: 844 }, cpu: 4, isMobile: true, hasTouch: true },
  pc: { viewport: { width: 1280, height: 900 }, cpu: 1 },
};

// 測る画面と、INP を測るための操作
const PAGES = [
  {
    name: "app", path: "index.html",
    async act(page) {
      await page.click("#note");
      await page.keyboard.type("温泉と海", { delay: 30 });
      await page.click("#plus");
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.click("#pill-when");
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
    },
  },
  {
    name: "about", path: "about.html",
    async act(page) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(300);
      await page.click("body", { position: { x: 20, y: 200 } });
    },
  },
  {
    name: "area", path: "areas/kyoto/",
    async act(page) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(300);
      await page.click("body", { position: { x: 20, y: 200 } });
    },
  },
];

// ページの中で動かす計測。PerformanceObserver の buffered で、読み込み中の
// ものも拾います。CSP（script-src 'self'）があるので、page.evaluate で入れます。
function installObservers() {
  const w = /** @type {any} */ (window);
  w.__perf = { lcp: 0, cls: 0, inp: 0, events: 0 };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__perf.lcp = Math.max(w.__perf.lcp, e.renderTime || e.loadTime || e.startTime);
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) w.__perf.cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (!e.interactionId) continue;
      w.__perf.events++;
      w.__perf.inp = Math.max(w.__perf.inp, e.duration);
    }
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
}

async function measurePage(browser, pg, profileName) {
  const prof = PROFILES[profileName];
  const ctx = await browser.newContext({
    viewport: prof.viewport, isMobile: prof.isMobile, hasTouch: prof.hasTouch,
    serviceWorkers: "block", locale: "ja-JP", timezoneId: "Asia/Tokyo",
  });
  const page = await ctx.newPage();
  const origin = new URL(BASE).origin;
  await page.route((u) => u.origin !== origin, (route) => route.abort("connectionrefused"));
  if (prof.cpu > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
  }
  await page.goto(`${BASE}/${pg.path}`, { waitUntil: "load" });
  await page.evaluate(installObservers);
  await page.waitForTimeout(1500);           // 遅れて出る中身と、ずれを待ちます
  const lcp = await page.evaluate(() => /** @type {any} */ (window).__perf.lcp);
  await pg.act(page);
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => /** @type {any} */ (window).__perf);
  await ctx.close();
  return { lcpMs: Math.round(lcp), cls: Math.round(m.cls * 1000) / 1000, inpMs: Math.round(m.inp), interactions: m.events };
}

/** 3回測って、項目ごとの中央値を取ります。 */
export async function measureWeb({ runs = 3 } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? undefined,
    args: ["--no-sandbox"],
  });
  const out = {};
  try {
    for (const profile of Object.keys(PROFILES)) {
      for (const pg of PAGES) {
        const rs = [];
        for (let i = 0; i < runs; i++) rs.push(await measurePage(browser, pg, profile));
        const mid = (k) => [...rs.map((r) => r[k])].sort((a, b) => a - b)[Math.floor(rs.length / 2)];
        out[`${pg.name}.${profile}`] = { lcpMs: mid("lcpMs"), inpMs: mid("inpMs"), cls: mid("cls") };
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

const UNITS = { lcpMs: "ms", inpMs: "ms", cls: "" };

/** 上限（失敗）と、基準の factor 倍（気になる点）に照らします。 */
export function judgeWeb(result, budget = {}, baseline = {}, factor = 1.5) {
  const over = [];
  const slower = [];
  for (const [page, m] of Object.entries(result)) {
    for (const k of Object.keys(UNITS)) {
      const limit = budget[k];
      if (typeof limit === "number" && m[k] > limit) over.push(`${page} の ${k}: ${m[k]}${UNITS[k]}（上限 ${limit}${UNITS[k]}）`);
      const base = baseline?.[page]?.[k];
      // 小さな値どうしの比は揺れが大きいので、ある程度の大きさからだけ比べます
      const floor = k === "cls" ? 0.02 : 100;
      if (typeof base === "number" && m[k] > Math.max(base, floor) * factor) {
        slower.push(`${page} の ${k}: ${m[k]}${UNITS[k]}（基準 ${base}${UNITS[k]}）`);
      }
    }
  }
  return { over, slower };
}

export function toMarkdownWeb(result, budget = {}, baseline = {}, verdict) {
  const out = ["## 速さ（Web の Core Web Vitals）", "",
    `上限: LCP ${budget.lcpMs ?? "-"}ms・INP ${budget.inpMs ?? "-"}ms・CLS ${budget.cls ?? "-"}（携帯は CPU を 4 倍遅くして測ります）`, "",
    "| 画面 | LCP | INP | CLS | 基準（LCP / INP / CLS） |", "| --- | ---: | ---: | ---: | --- |"];
  for (const [page, m] of Object.entries(result)) {
    const b = baseline?.[page];
    out.push(`| ${page} | ${m.lcpMs}ms | ${m.inpMs}ms | ${m.cls} | ${b ? `${b.lcpMs}ms / ${b.inpMs}ms / ${b.cls}` : "-"} |`);
  }
  out.push("");
  if (verdict.over.length) out.push("### 上限を超えたもの", "", ...verdict.over.map((x) => `- ${x}`), "");
  if (verdict.slower.length) out.push("### 基準より遅くなったもの（気になる点）", "", ...verdict.slower.map((x) => `- ${x}`), "");
  return out.join("\n");
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const budget = readJson(BUDGET_FILE)?.web ?? {};
  const baselineDoc = readJson(BASELINE_FILE) ?? {};
  const result = await measureWeb();
  const verdict = judgeWeb(result, budget, baselineDoc.web, readJson(BUDGET_FILE)?.slowerFactor ?? 1.5);
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE_FILE, JSON.stringify({ ...baselineDoc, web: result }, null, 2) + "\n");
    console.log("基準を書きました: bench/perf-baseline.json（web）");
  }
  if (process.argv.includes("--md")) console.log(toMarkdownWeb(result, budget, baselineDoc.web, verdict));
  else {
    for (const [page, m] of Object.entries(result)) console.log(`${page}: LCP ${m.lcpMs}ms・INP ${m.inpMs}ms・CLS ${m.cls}`);
    for (const x of verdict.over) console.log(`上限超え: ${x}`);
    for (const x of verdict.slower) console.log(`気になる点: ${x}`);
  }
  if (process.argv.includes("--check") && verdict.over.length) process.exitCode = 1;
}
