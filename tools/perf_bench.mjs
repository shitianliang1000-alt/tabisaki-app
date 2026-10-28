// 速さの計測（Issue #372）。CLI と知識ベース（kb/）の読み込みを測ります。
// Web の Core Web Vitals（LCP・INP・CLS）は tools/perf_web.mjs が測ります。
//
//     node tools/perf_bench.mjs                  # 測って表を出す
//     node tools/perf_bench.mjs --md             # Markdown（CI のまとめ欄に貼る用）
//     node tools/perf_bench.mjs --check          # 上限（bench/perf-budget.json）を超えたら終了コード 1
//     node tools/perf_bench.mjs --write-baseline # 今の値を基準（bench/perf-baseline.json）にする
//
// どれも別の node を立ち上げて測ります（読み込み済みのものを使い回すと、
// 2回目からは速く見えてしまうため）。回数を重ねて中央値を取ります。
//
// 上限（budget）を超えたら失敗、基準（baseline）より 1.5 倍を超えて遅く
// なったら「気になる点」として出します。機械が違うと時間も変わるので、
// 基準との比べは失敗にしません（docs/performance.md）。

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages", "cli", "bin", "tabisaki-plan.mjs");
const RSS = path.join(ROOT, "tools", "perf_rss.mjs");
const BUDGET_FILE = path.join(ROOT, "bench", "perf-budget.json");
const BASELINE_FILE = path.join(ROOT, "bench", "perf-baseline.json");

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// 計測に使う旅程。日付を固定し、同じ旅程が組まれるようにします。
export const PLAN_CASES = [
  ["温泉と海をゆっくり", "東京駅", 2],
  ["京都の寺を見たい", "東京駅", 3],
  ["北海道の自然", "東京駅", 4],
];

/** 別の node で走らせ、かかった時間（ms）と最大メモリ（MB）を返します。 */
function runNode(args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(RSS).href, ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, TZ: "Asia/Tokyo" }, maxBuffer: 64 << 20,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`node ${args.join(" ")} が失敗しました: ${r.stderr.slice(-500)}`);
  const m = /PERF_RSS_KB=(\d+)/.exec(r.stderr);
  return { ms: Math.round(ms), rssMb: m ? Math.round(Number(m[1]) / 1024) : null, stdout: r.stdout };
}

/** kb/ の読み込みを、この process の中で測ります（--kb-child で別の node から呼ばれます）。 */
async function kbChild() {
  process.env.TZ = "Asia/Tokyo";
  const t0 = performance.now();
  const kbDir = path.join(ROOT, "kb");
  const index = JSON.parse(readFileSync(path.join(kbDir, "index.json"), "utf8"));
  JSON.parse(readFileSync(path.join(kbDir, index.regionsFile ?? "regions.json"), "utf8"));
  const indexMs = performance.now() - t0;
  const shards = [];
  for (const sh of index.shards) {
    const s = performance.now();
    JSON.parse(readFileSync(path.join(kbDir, sh.file), "utf8"));
    shards.push({ file: sh.file, kb: Math.round(statSync(path.join(kbDir, sh.file)).size / 1024), ms: performance.now() - s });
  }
  // アプリと同じ読み込み（索引づくりと、場所でない記事の除外を含む）
  const { createCore } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "index.mjs")).href);
  const l = performance.now();
  await createCore();
  const loadMs = performance.now() - l;
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
  shards.sort((a, b) => b.ms - a.ms);
  process.stdout.write(JSON.stringify({
    indexMs, loadMs, heapMb,
    shardCount: shards.length,
    totalKb: shards.reduce((a, s) => a + s.kb, 0),
    shardMaxMs: shards[0]?.ms ?? 0,
    slowest: shards.slice(0, 5).map((s) => ({ ...s, ms: Math.round(s.ms) })),
  }));
}

/** 測ります。数字はすべて ms・MB・KB。 */
export async function measure({ runs = 5 } = {}) {
  const startup = [];
  for (let i = 0; i < runs + 1; i++) startup.push(runNode([CLI, "--version"]).ms);
  startup.shift(); // 1回目はファイルの読み込みが冷えているので捨てます

  const plans = [];
  let planRss = 0;
  for (const [wish, from, days] of PLAN_CASES) {
    const ms = [];
    for (let i = 0; i < Math.max(3, Math.ceil(runs / 2)); i++) {
      const r = runNode([CLI, "plan", wish, `--from=${from}`, `--days=${days}`, "--date=2026-11-14", "--output=json"]);
      ms.push(r.ms);
      planRss = Math.max(planRss, r.rssMb ?? 0);
    }
    plans.push({ wish, days, ms: median(ms) });
  }

  const kbRuns = [];
  for (let i = 0; i < 3; i++) kbRuns.push(JSON.parse(runNode([fileURLToPath(import.meta.url), "--kb-child"]).stdout));
  const kb = kbRuns.sort((a, b) => a.loadMs - b.loadMs)[1];

  return {
    cli: {
      startupMs: median(startup),
      planMs: Math.max(...plans.map((p) => p.ms)),
      planRssMb: planRss,
      plans,
    },
    kb: {
      indexMs: Math.round(kb.indexMs),
      loadMs: Math.round(kb.loadMs),
      shardMaxMs: Math.round(kb.shardMaxMs),
      heapMb: kb.heapMb,
      shardCount: kb.shardCount,
      totalKb: kb.totalKb,
      slowest: kb.slowest,
    },
  };
}

// 上限・基準と比べる項目（名前・取り出しかた・単位）
export const METRICS = [
  ["cli.startupMs", "CLI の起動（--version）", "ms"],
  ["cli.planMs", "CLI で旅程を組む（いちばん遅い例）", "ms"],
  ["cli.planRssMb", "CLI で旅程を組むときの最大メモリ", "MB"],
  ["kb.indexMs", "KB の索引（index.json・regions.json）", "ms"],
  ["kb.loadMs", "KB を全部読んで索引を作る", "ms"],
  ["kb.shardMaxMs", "KB のシャード1枚（いちばん遅いもの）", "ms"],
  ["kb.heapMb", "KB を読んだあとのメモリ（heap）", "MB"],
];

const get = (o, key) => key.split(".").reduce((a, k) => a?.[k], o);

/**
 * 上限と基準に照らします。
 * @returns {{over: string[], slower: string[]}} over = 上限超え（失敗）、slower = 基準の factor 倍超え（気になる点）
 */
export function judge(result, budget, baseline, factor = 1.5) {
  const over = [];
  const slower = [];
  for (const [key, label, unit] of METRICS) {
    const v = get(result, key);
    const b = get(budget, key);
    const base = get(baseline, key);
    if (typeof v !== "number") continue;
    if (typeof b === "number" && v > b) over.push(`${label}: ${v}${unit}（上限 ${b}${unit}）`);
    if (typeof base === "number" && base > 0 && v > base * factor) slower.push(`${label}: ${v}${unit}（基準 ${base}${unit} の ${(v / base).toFixed(1)} 倍）`);
  }
  return { over, slower };
}

export function toMarkdown(result, budget, baseline, verdict) {
  const out = ["## 速さ（CLI・知識ベース）", "", "| 項目 | 今回 | 基準 | 上限 |", "| --- | ---: | ---: | ---: |"];
  for (const [key, label, unit] of METRICS) {
    const f = (x) => (typeof x === "number" ? `${x}${unit}` : "-");
    out.push(`| ${label} | ${f(get(result, key))} | ${f(get(baseline, key))} | ${f(get(budget, key))} |`);
  }
  out.push("", `KB: シャード ${result.kb.shardCount} 枚・合計 ${Math.round(result.kb.totalKb / 1024)}MB。遅いシャード: `
    + result.kb.slowest.map((s) => `${s.file}（${s.kb}KB・${s.ms}ms）`).join("、"), "");
  if (verdict.over.length) out.push("### 上限を超えたもの", "", ...verdict.over.map((x) => `- ${x}`), "");
  if (verdict.slower.length) out.push("### 基準より遅くなったもの（気になる点）", "", ...verdict.slower.map((x) => `- ${x}`), "");
  if (!verdict.over.length && !verdict.slower.length) out.push("上限を超えたもの、基準より大きく遅くなったものはありません。", "");
  return out.join("\n");
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--kb-child")) {
    await kbChild();
  } else {
    const budget = readJson(BUDGET_FILE) ?? {};
    const baseline = readJson(BASELINE_FILE);
    const result = await measure();
    const verdict = judge(result, budget, baseline, budget.slowerFactor ?? 1.5);
    if (process.argv.includes("--write-baseline")) {
      const prev = baseline ?? {};
      writeFileSync(BASELINE_FILE, JSON.stringify({
        ...prev,
        note: "速さの基準。node tools/perf_bench.mjs --write-baseline（と tools/perf_web.mjs --write-baseline）で作り直します（docs/performance.md）。",
        measuredOn: `${process.platform} ${process.arch}・node ${process.version}`,
        cli: result.cli, kb: result.kb,
      }, null, 2) + "\n");
      console.log("基準を書きました: bench/perf-baseline.json");
    }
    if (process.argv.includes("--md")) console.log(toMarkdown(result, budget, baseline, verdict));
    else {
      for (const [key, label, unit] of METRICS) console.log(`${label}: ${get(result, key)}${unit}`);
      for (const x of verdict.over) console.log(`上限超え: ${x}`);
      for (const x of verdict.slower) console.log(`気になる点: ${x}`);
    }
    if (process.argv.includes("--check") && verdict.over.length) process.exitCode = 1;
  }
}
