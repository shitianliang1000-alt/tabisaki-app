// 「旅さきを見る」のページ（tour.html）の動画を作り直す道具です。
//
//     sh tools/build_php.sh .php-site
//     (cd .php-site && php -S 127.0.0.1:8090 ../tools/php_router.php) &
//     node tools/record_tour.mjs http://127.0.0.1:8090 php/assets/tour
//
// 動画はすべて自作です。
//   ・旅さきの画面そのものを、ブラウザ（Playwright の Chromium）で動かして録ったもの
//   ・tools/tour_scenes.html に、コードで描いた映像を1コマずつ撮ったもの
// 録画には地図（© OpenStreetMap contributors）が映ります。tour.html の出典の欄に書いてあります。
// AI の中継は手元のアドレスからは使えないので、録画の答えは旅さきのエンジンだけで組んだものです。
// ffmpeg が要ります。
import { chromium } from "playwright";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.argv[2] ?? "http://127.0.0.1:8090";
const OUT = resolve(process.argv[3] ?? "php/assets/tour");
const ONLY = process.argv.slice(4);
const TMP = resolve(".tour-frames");

/** 画面が止まっている間（考えている間など）は、1コマ最大この秒数に縮めます。 */
const MAX_HOLD = 0.4;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** CDP の screencast で録って、mp4 と止めた絵（webp）にします。 */
async function record(name, { viewport, dpr = 1, width, poster = 0.7, crf = 30, dark = true }, act) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: dpr, colorScheme: dark ? "dark" : "light",
    locale: "ja-JP", timezoneId: "Asia/Tokyo", reducedMotion: "no-preference",
  });
  const page = await ctx.newPage();
  const frames = [];
  let rec = false;
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    if (rec) frames.push({ data: f.data, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const start = async () => {
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
    rec = true;
  };
  const crop = await act(page, start);
  rec = false;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await browser.close();
  if (frames.length < 2) throw new Error(`${name}: コマが撮れませんでした`);

  const dir = join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let list = "ffconcat version 1.0\n";
  for (let i = 0; i < frames.length; i++) {
    const f = `${String(i).padStart(5, "0")}.jpg`;
    await writeFile(join(dir, f), Buffer.from(frames[i].data, "base64"));
    const next = frames[i + 1]?.t ?? frames[i].t + 0.6;
    list += `file ${f}\nduration ${Math.min(MAX_HOLD, Math.max(0.001, next - frames[i].t)).toFixed(4)}\n`;
  }
  list += `file ${String(frames.length - 1).padStart(5, "0")}.jpg\n`;
  await writeFile(join(dir, "list.txt"), list);
  await encode(name, join(dir, "list.txt"), { width, crf, poster, concat: true, crop: crop && { ...crop, dpr } });
}

/** コマの並びから mp4（H.264・音なし・頭出しが速い形）と webp の止めた絵を作ります。 */
async function encode(name, input, { width, crf, poster, concat = false, fps = 30, crop = null }) {
  await mkdir(OUT, { recursive: true });
  const mp4 = join(OUT, `${name}.mp4`);
  const c = crop && [crop.width, crop.height, crop.x, crop.y].map((v) => Math.round(v * crop.dpr / 2) * 2).join(":");
  const scale = `${c ? `crop=${c},` : ""}scale=${width}:-2:flags=lanczos`;
  const src = concat ? ["-f", "concat", "-safe", "0", "-i", input] : ["-framerate", String(fps), "-i", input];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...src,
    "-vf", `${scale},fps=${fps},format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
    "-profile:v", "high", "-an", "-movflags", "+faststart", mp4]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).toString());
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String((dur * poster).toFixed(2)), "-i", mp4,
    "-frames:v", "1", "-c:v", "libwebp", "-quality", "78", join(OUT, `${name}.webp`)]);
  console.log(`${name}: ${dur.toFixed(1)}秒`);
}

const SLOW = { delay: 70 };

/** 書いて、聞かれたことに答えて、組ませるところまで。 */
async function askAndPlan(page, prompt, picks) {
  await page.locator("#note").click();
  await page.keyboard.type(prompt, SLOW);
  await wait(500);
  await page.locator("#make-plan").click();
  for (const [slot, choice] of picks) {
    await page.locator(`.slot-choice[data-slot="${slot}"][data-choice="${choice}"]`).first().click({ timeout: 2500 }).catch(() => {});
    await wait(450);
  }
  await page.getByRole("button", { name: "この内容で組む" }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => (document.querySelector("#itinerary")?.children.length ?? 0) > 0, null, { timeout: 30000 }).catch(() => {});
}

/** チャットの欄を、少しずつ下へ送ります。 */
async function glide(page, sel, px, ms) {
  const steps = Math.round(ms / 33);
  for (let i = 0; i < steps; i++) {
    await page.evaluate(([s, d]) => { const el = document.querySelector(s); if (el) el.scrollBy(0, d); else window.scrollBy(0, d); }, [sel, px / steps]);
    await wait(33);
  }
}

const PROMPT = "古い町並みを歩いて、海も見たい";
const PICKS = [["destination", "near"], ["dates", "tomorrow"], ["dates", "0"], ["travelers", "2"]];

await rm(TMP, { recursive: true, force: true });

// 1. 書いて、組まれて、地図と時間割が出るまで（PC）
await record("plan", { viewport: { width: 1280, height: 800 }, width: 1280, poster: 0.62 }, async (page, start) => {
  await page.goto(`${BASE}/app`);
  await wait(1500);
  await start();
  await wait(600);
  await askAndPlan(page, PROMPT, PICKS);
  await wait(1800);
  await glide(page, "#chat-body", 1500, 6500);
  await wait(1200);
});

// 2. 携帯で同じことを
await record("phone", { viewport: { width: 390, height: 844 }, dpr: 2, width: 590, poster: 0.7 }, async (page, start) => {
  await page.goto(`${BASE}/app`);
  await wait(1500);
  await start();
  await wait(500);
  await askAndPlan(page, PROMPT, PICKS);
  await wait(1500);
  await glide(page, "#chat-body", 1800, 6000);
  await wait(1000);
});

// 3. 話しかけて直す
await record("refine", { viewport: { width: 1280, height: 800 }, width: 1280, poster: 0.85 }, async (page, start) => {
  await page.goto(`${BASE}/app`);
  await wait(1000);
  await askAndPlan(page, PROMPT, PICKS);
  await wait(2500);
  await start();
  await wait(800);
  await page.locator("#note").click();
  await page.keyboard.type("もっとゆっくりまわりたい", SLOW);
  await wait(500);
  await page.locator("#make-plan").click();
  await wait(4000);
  await glide(page, "#chat-body", 900, 4000);
  await wait(1200);
});

// 4. ＋の中（出発地・日時・こだわり）
await record("plus", { viewport: { width: 1280, height: 800 }, width: 1280, poster: 0.5 }, async (page, start) => {
  await page.goto(`${BASE}/app`);
  await wait(1500);
  await start();
  await wait(700);
  await page.locator("#plus").click();
  await wait(1600);
  const items = page.locator("#plus-menu [role=menuitem]");
  const n = await items.count();
  for (let i = 0; i < Math.min(n, 6); i++) { await items.nth(i).hover().catch(() => {}); await wait(320); }
  await page.keyboard.press("Escape");
  await wait(600);
  await page.locator("#pill-when").click();
  await wait(2200);
  await page.keyboard.press("Escape");
  await wait(600);
  await page.locator("#pill-from").click();
  await wait(2200);
  await page.keyboard.press("Escape");
  await wait(800);
});

// 5. 地図の順路（地図のところだけを切り抜きます）
await record("map", { viewport: { width: 1280, height: 900 }, width: 1000, poster: 0.3 }, async (page, start) => {
  await page.goto(`${BASE}/app`);
  await wait(1000);
  await askAndPlan(page, PROMPT, PICKS);
  await wait(2500);
  await page.evaluate(() => document.querySelector("#map")?.scrollIntoView({ block: "center" }));
  await wait(1500);
  const box = await page.locator("#map").boundingBox();
  await start();
  await wait(1200);
  // ホイールはチャットを送るので、地図の ＋ と − で寄って戻ります。
  for (const sel of [".leaflet-control-zoom-in", ".leaflet-control-zoom-in", ".leaflet-control-zoom-out", ".leaflet-control-zoom-out"]) {
    await page.locator(`#map ${sel}`).click().catch(() => {});
    await wait(1500);
  }
  await wait(800);
  return box && { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 };
});

// 6. エリアのページ
await record("areas", { viewport: { width: 1280, height: 800 }, width: 1280, poster: 0.3 }, async (page, start) => {
  await page.goto(`${BASE}/areas/kanagawa/index.html`);
  await wait(2000);
  await start();
  await wait(800);
  await glide(page, "html", 2200, 9000);
  await wait(1000);
});

// 7. コードで描いた映像（営業時間と移動時間を照らし合わせる）
async function scene(name, { w, h, seconds, fps = 30, width = w, crf = 28, poster = 0.8 }) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${pathToFileURL(resolve("tools/tour_scenes.html")).href}#${name}`);
  await page.waitForFunction(() => window.ready === true);
  const dir = join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const total = Math.round(seconds * fps);
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.draw(t), i / fps);
    await page.screenshot({ path: join(dir, `${String(i).padStart(5, "0")}.png`) });
  }
  await browser.close();
  await encode(name, join(dir, "%05d.png"), { width, crf, poster, fps });
}

await scene("hours", { w: 1280, h: 720, seconds: 9 });
await scene("weather", { w: 1280, h: 720, seconds: 8 });
await scene("mix", { w: 1280, h: 720, seconds: 8 });

await rm(TMP, { recursive: true, force: true });
console.log((await readdir(OUT)).join(" "));
