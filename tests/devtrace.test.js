// 開発者向けの見える化（packages/core/devtrace.mjs・tabisaki trace。Issue #444）の試験。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCore } from "../packages/core/index.mjs";
import { STAGES, createTraceRecorder, diagnose, evidenceRows, explain, formatExplain, stageTimeline }
  from "../packages/core/devtrace.mjs";
import { createDefaultTools } from "../packages/core/src/tools.js";
import { runResearch } from "../packages/core/src/research.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "packages/cli/bin/tabisaki-plan.mjs");
const SEARCH_FILE = path.join(ROOT, "examples/dev-trace/natsume-search.json");

const quiet = async (fn) => {
  const saved = [console.log, console.info, console.warn];
  console.log = console.info = console.warn = () => {};
  try { return await fn(); } finally { [console.log, console.info, console.warn] = saved; }
};
const core = await quiet(() => createCore({ userData: false }));

test("記録係は1件ごとに1行を流し、段ごとの時間をまとめる", () => {
  let t = 1000;
  const lines = [];
  const rec = createTraceRecorder({ now: () => t, write: (l) => lines.push(l) });
  rec.onStep({ state: "assess", thought: "収録にあるか", action: { tool: "search_spots", args: { keywords: ["温泉"] } }, observation: { ok: true, total: 3 } });
  t += 200; rec.onProgress(0);
  t += 300; rec.onProgress(1, "近いエリアを探しています");
  t += 100; rec.onProgress(2, "", { picks: new Array(400).fill({}) });
  t += 50; rec.finish();
  assert.equal(lines.length, 5, "起きるたびに1行");
  assert.match(lines[0], /調べもの assess: 収録にあるか → search_spots/);
  assert.match(lines[3], /候補 400件/);
  assert.equal(rec.events[3].picks, 400, "候補の一覧そのものは持たない");
  const rows = stageTimeline(rec.events);
  assert.deepEqual(rows.map((r) => r.key), ["research", "understand", "candidates", "propose"]);
  assert.deepEqual(rows.map((r) => r.ms), [200, 300, 100, 50]);
  assert.deepEqual(rows[2].notes, ["近いエリアを探しています"]);
});

test("core.plan の onProgress で6つの段が流れ、旅程の行に収録のIDと経路の出どころが付く", async () => {
  const rec = createTraceRecorder();
  const r = await quiet(() => core.plan({ wish: "京都で歴史を感じたい", from: "新大阪駅", date: "2026-11-10" }, { onProgress: rec.onProgress }));
  rec.finish();
  const steps = new Set(rec.events.filter((e) => e.kind === "stage").map((e) => e.step));
  for (const s of [0, 1, 2, 3, 5]) assert.ok(steps.has(s), `段${s}が流れる`);

  const report = explain(r, rec.events);
  const ids = new Set(core.kb.spots.map((s) => s.id));
  assert.ok(report.evidence.spots.length > 0);
  for (const s of report.evidence.spots) {
    assert.ok(ids.has(s.spotId), `${s.title} の ID ${s.spotId} は収録にある`);
    assert.equal(s.status, "verified");
  }
  assert.ok(report.evidence.legs.length > 0);
  for (const l of report.evidence.legs) assert.ok(l.source, "移動の行には出どころ（経路の取り口か目安か）が付く");
  assert.ok(report.grounding, "裏取りの結果を持つ");
  assert.deepEqual(report.stages.map((s) => s.key), STAGES.filter((s) => s.step !== null).map((s) => s.key));

  const text = formatExplain(report);
  for (const h of ["■ 工程", "■ 立ち寄り先と収録のID", "■ 移動", "■ 裏取り", "■ 見立て"]) assert.ok(text.includes(h), h);
  assert.ok(text.includes(report.evidence.spots[0].spotId));
});

test("見立ては、いちばん先の工程のいちばん重い問題を原因にする", () => {
  const itinerary = {
    title: "試し", spotCount: 1, fromModel: true, warnings: [], usedRoutesApi: true, slackMin: 60,
    days: [{ items: [
      { kind: "transit", start: "2026-11-10T00:00:00Z", end: "2026-11-10T00:30:00Z", title: "A → B", routed: false, km: 10,
        grounding: { status: "estimate", source: "estimate" } },
      { kind: "spot", start: "2026-11-10T00:30:00Z", end: "2026-11-10T01:30:00Z", title: "B寺", spotId: "x-1",
        grounding: { status: "verified", source: "kb" } },
    ] }],
    grounding: { checked: 2, verified: 1, estimated: 1, removed: [{ name: "まぼろし寺", why: "収録データで確かめられませんでした" }],
      rebound: [], trains: ["のぞみ999号"], rewritten: [], ok: true },
  };
  const d = diagnose({ itinerary });
  assert.equal(d.cause.stage, "propose", "AI の案に収録に無い場所が入っていた");
  assert.equal(d.cause.level, "error");
  assert.ok(d.findings.some((f) => f.stage === "route" && /のぞみ999号/.test(f.text)));
  assert.ok(d.findings.some((f) => f.stage === "route" && /1区間のうち1区間/.test(f.text)));
  // 並びは処理の順
  const order = STAGES.map((s) => s.key);
  const idx = d.findings.map((f) => order.indexOf(f.stage));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));

  const ok = diagnose({ itinerary: { ...itinerary, grounding: { ...itinerary.grounding, removed: [], trains: [] }, usedRoutesApi: false } });
  assert.equal(ok.cause, null, "目安の区間だけ（経路の取り口を使っていない）なら、直すべき工程は無い");

  const none = diagnose({ itinerary: { ...itinerary, grounding: undefined } });
  assert.equal(none.cause.stage, "grounding", "裏取りを通っていない旅程は見逃さない");

  const research = diagnose({ research: { status: "out_of_scope", message: "「パリ」は日本の外です", trace: [] } });
  assert.equal(research.cause.stage, "research");
  assert.ok(!research.findings.some((f) => /旅程がありません/.test(f.text)), "断ったときは旅程が無くて当然");
});

test("evidenceRows は宿や食事も別に残す", () => {
  const rows = evidenceRows({ days: [{ items: [{ kind: "lodging", title: "宿", start: "2026-11-10T09:00:00Z", place: { id: "h-1" } }] }] });
  assert.equal(rows.others[0].placeId, "h-1");
  assert.equal(rows.others[0].at, "18:00", "時刻は日本時間");
});

test("Research Agent の onStep は、記録（trace）と同じものを同じ順で受け取る", async () => {
  const search = async () => JSON.parse(readFileSync(SEARCH_FILE, "utf8"));
  const tools = createDefaultTools({ kb: core.kb, search });
  const seen = [];
  const r = await runResearch({ wish: "夏目友人帳の舞台をめぐりたい", tools, onStep: (s) => seen.push(s) });
  assert.equal(r.status, "answered");
  assert.equal(seen.length, r.trace.length);
  assert.deepEqual(seen, r.trace);
  assert.ok(r.trace.filter((s) => s.action).every((s) => typeof s.ms === "number"), "道具にかかった時間も残す");

  const broken = await runResearch({ wish: "夏目友人帳の舞台をめぐりたい", tools, onStep: () => { throw new Error("表示の失敗"); } });
  assert.equal(broken.status, "answered", "見る側が失敗しても止まらない");
});

const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args],
  { encoding: "utf8", env: { ...process.env, TABISAKI_NO_USER_DATA: "1", TABISAKI_PLUGINS: "0" }, ...opts });

test("tabisaki trace: 工程を stderr に流し、記録と見立てを stdout に出す", () => {
  const r = run(["trace", "京都で歴史を感じたい", "--from=新大阪駅", "--date=2026-11-10"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /段0 希望の読み取り/);
  assert.match(r.stderr, /段5 経路と時刻/);
  assert.match(r.stdout, /■ 見立て/);
  assert.match(r.stdout, /\[(lm|wd|it|n)[-\w]+\]/, "収録のIDが出る");
});

test("tabisaki trace --research --search-file で、ネットへ出ずに Agent の考えと道具を追える。--input で読み直せる", () => {
  const r = run(["trace", "夏目友人帳の舞台をめぐりたい", "--from=博多駅", "--date=2026-11-07",
    "--research", `--search-file=${SEARCH_FILE}`, "--output=json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /調べもの search: .*web_search/);
  const report = JSON.parse(r.stdout);
  assert.equal(report.research.status, "answered");
  assert.ok(report.research.steps.some((s) => s.tool === "web_search"));
  assert.ok(report.evidence.spots.some((s) => /人吉|青井阿蘇|鹿目/.test(s.title)));

  const dir = mkdtempSync(path.join(tmpdir(), "tabisaki-trace-"));
  const file = path.join(dir, "report.json");
  writeFileSync(file, r.stdout);
  const again = run(["trace", `--input=${file}`]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /■ 調べもの（Research Agent）: answered/);
});

test("trace 用のオプションは trace でだけ使える", () => {
  assert.equal(run(["plan", "温泉", "--research"]).status, 2);
  assert.equal(run(["trace", "温泉", "--search-file=x.json"]).status, 2, "--search-file は --research と");
  assert.equal(run(["trace", "温泉", "--output=markdown"]).status, 2);
});

test("開発者向けの表示は公開するもの（Web 版）に入らない", () => {
  // Web 版（js/）と本体（packages/core/src/）からは読まない
  for (const dir of ["js", "packages/core/src"]) {
    for (const f of readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith(".js"))) {
      assert.ok(!readFileSync(path.join(ROOT, dir, f), "utf8").includes("devtrace"), `${dir}/${f} は devtrace を読まない`);
    }
  }
  // dist/ に写すのは packages/core/src だけ
  const build = readFileSync(path.join(ROOT, "tools/build_site.sh"), "utf8");
  assert.ok(!/devtrace/.test(build));
  assert.match(build, /cp -r packages\/core\/src "\$dist"\/packages\/core\/src/);
  assert.ok(!readFileSync(path.join(ROOT, "sw.js"), "utf8").includes("devtrace"));
});
