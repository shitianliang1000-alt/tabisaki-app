// ハイブリッドモデルルーター（Issue #439）の試験。
// 手元の LLM（OpenAI 互換）とクラウド（Gemini API の形）を、fetch の差し替えで演じます。

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  confidenceFromLogprobs, scoreReply, planRoute, shouldHandOver, createRouteLog,
  summarizeRoutes, suggestThreshold, normalizeThreshold, DEFAULT_THRESHOLD,
} from "../packages/core/src/router.js";
import { resolveThreshold, saveThreshold, fileRecorder, readRouteLog } from "../packages/core/router-log.mjs";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const lp = (...ps) => ({ content: ps.map((p) => ({ token: "x", logprob: Math.log(p) })) });

// --- 決まり（router.js）-----------------------------------------------------

test("確信度は、トークンの確率の幾何平均", () => {
  assert.equal(confidenceFromLogprobs(lp(0.9, 0.9, 0.9)), 0.9);
  assert.equal(confidenceFromLogprobs(lp(1, 0.25)), 0.5);
  // 1つでも大きく迷った（5% 未満）トークンがあれば、1割下げます。
  assert.ok(confidenceFromLogprobs(lp(0.99, 0.99, 0.99, 0.01)) < Math.exp((3 * Math.log(0.99) + Math.log(0.01)) / 4));
  // 素の配列でも読めます。読めないものは null。
  assert.equal(confidenceFromLogprobs([{ logprob: 0 }]), 1);
  assert.equal(confidenceFromLogprobs(null), null);
  assert.equal(confidenceFromLogprobs({ content: [] }), null);
  assert.equal(confidenceFromLogprobs({ content: [{ logprob: "x" }] }), null);
});

test("logprobs が無ければ、空か・JSON が読めるかで目安を出す", () => {
  const parse = (s) => JSON.parse(s);
  assert.deepEqual(scoreReply({ text: "" }), { confidence: 0, method: "heuristic" });
  assert.deepEqual(scoreReply({ text: "{壊れ" }, { expectJson: true, parse }), { confidence: 0, method: "heuristic" });
  assert.equal(scoreReply({ text: "{}" }, { expectJson: true, parse }).method, "heuristic");
  assert.ok(scoreReply({ text: "{}" }, { expectJson: true, parse }).confidence > 0);
  assert.deepEqual(scoreReply({ text: "{}", logprobs: lp(0.5) }, { expectJson: true, parse }), { confidence: 0.5, method: "logprobs" });
  // JSON が読めなければ、logprobs が高くても 0 です（形が壊れた答えは使えません）。
  assert.equal(scoreReply({ text: "{壊れ", logprobs: lp(0.99) }, { expectJson: true, parse }).confidence, 0);
});

test("Web 検索が要るならクラウド、つながらなければ手元、ほかは手元から", () => {
  assert.deepEqual(planRoute({ needsWeb: true }), { first: "cloud", reason: "web_search", mayHandOver: false });
  assert.equal(planRoute({ needsWeb: true, cloudAvailable: false }).first, "local");
  assert.equal(planRoute({ needsWeb: true, cloudAvailable: false }).reason, "web_needed_but_offline");
  assert.deepEqual(planRoute({}), { first: "local", reason: "local_first", mayHandOver: true });
  assert.equal(planRoute({ cloudAvailable: false }).mayHandOver, false);
  assert.equal(planRoute({ force: "cloud" }).first, "cloud");
  assert.equal(planRoute({ force: "local", needsWeb: true }).first, "local");
});

test("閾値未満ならクラウドへ回す", () => {
  assert.equal(shouldHandOver(0.5, 0.75), true);
  assert.equal(shouldHandOver(0.75, 0.75), false);
  assert.equal(shouldHandOver(0.9), false);
  assert.equal(shouldHandOver(NaN, 0.75), true);
  assert.equal(normalizeThreshold("abc"), DEFAULT_THRESHOLD);
  assert.equal(normalizeThreshold(2), 1);
  assert.equal(normalizeThreshold(-1), 0);
});

test("記録は上限で古いものから捨て、まとめと閾値の目安を出す", () => {
  const seen = [];
  const log = createRouteLog({ size: 3, onRecord: (e) => seen.push(e) });
  for (let i = 0; i < 5; i++) log.record({ route: "local", reason: "local_first", confidence: 0.5 + i / 10, method: "logprobs" });
  assert.equal(log.entries().length, 3);
  assert.equal(seen.length, 5);
  assert.deepEqual(log.entries().map((e) => e.seq), [3, 4, 5]);

  const entries = Array.from({ length: 40 }, (_, i) => ({
    route: i < 8 ? "cloud" : "local", reason: i < 8 ? "low_confidence" : "local_first",
    confidence: (i + 1) / 40, method: "logprobs", handedOver: i < 8,
  }));
  const sum = summarizeRoutes(entries);
  assert.equal(sum.total, 40);
  assert.equal(sum.byRoute.cloud, 8);
  assert.equal(sum.handOverRate, 0.2);
  assert.equal(sum.confidence.max, 1);
  // 2割を回すなら、下から2割の確信度のすぐ上が閾値になります。
  const t = suggestThreshold(entries, { target: 0.2 });
  assert.equal(entries.filter((e) => e.confidence < t).length, 8);
  // 記録が少ないうちは決めません。目安（heuristic）の値は数えません。
  assert.equal(suggestThreshold(entries.slice(0, 5)), null);
  assert.equal(suggestThreshold(entries.map((e) => ({ ...e, method: "heuristic" }))), null);
});

// --- ai.js の振り分け ---------------------------------------------------------

/** 手元とクラウドの両方を演じる fetch。calls に行き先が入ります。 */
function fakeNet({ local, cloud }) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u.endsWith("/v1/chat/completions")) {
      calls.push({ to: "local", logprobs: Boolean(body.logprobs), text: body.messages.at(-1).content });
      const r = typeof local === "function" ? local(body) : local;
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify({ choices: [{ message: { content: r.text }, logprobs: r.logprobs ?? null }] }));
    }
    calls.push({ to: "cloud", url: u });
    const r = typeof cloud === "function" ? cloud(body) : cloud;
    if (r?.status) return new Response("upstream", { status: r.status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: r.text }] } }] }));
  };
  return { fetch, calls };
}

async function withHybrid(net, fn, { threshold = 0.75 } = {}) {
  const ai = await import("../packages/core/src/ai.js");
  const real = globalThis.fetch;
  globalThis.fetch = net.fetch;
  ai.useHybrid({ local: { model: "gemma4:e2b", baseUrl: "http://local.test" }, threshold,
                 cloud: { geminiKey: "test-key", proxyUrl: "" } });
  try {
    return await fn(ai);
  } finally {
    ai.useHybrid(null);
    ai.useLocalModel(null);
    globalThis.fetch = real;
  }
}

test("確信度が高ければ手元の答えを使い、クラウドへは出さない", async () => {
  const net = fakeNet({ local: { text: '{"a":1}', logprobs: lp(0.95, 0.9) }, cloud: { text: '{"a":2}' } });
  await withHybrid(net, async (ai) => {
    const out = await ai.callModelJson("問い", { task: "understand" });
    assert.deepEqual(out, { a: 1 });
    assert.deepEqual(net.calls.map((c) => c.to), ["local"]);
    assert.equal(net.calls[0].logprobs, true, "確信度を測るのに logprobs を頼んでいません");
    const r = ai.lastRoute();
    assert.equal(r.route, "local");
    assert.equal(r.task, "understand");
    assert.equal(r.method, "logprobs");
    assert.ok(r.confidence >= 0.9);
    assert.equal(r.promptChars, 2);
    assert.ok(!("prompt" in r), "頼みの文そのものを記録しています");
  });
});

test("確信度が閾値未満なら、同じ頼みをクラウドに聞き直す", async () => {
  const net = fakeNet({ local: { text: '{"a":1}', logprobs: lp(0.4, 0.5) }, cloud: { text: '{"a":2}' } });
  await withHybrid(net, async (ai) => {
    assert.deepEqual(await ai.callModelJson("問い", { task: "plan" }), { a: 2 });
    assert.deepEqual(net.calls.map((c) => c.to), ["local", "cloud"]);
    assert.match(net.calls[1].url, /generativelanguage\.googleapis\.com/);
    const r = ai.lastRoute();
    assert.equal(r.route, "cloud");
    assert.equal(r.reason, "low_confidence");
    assert.equal(r.handedOver, true);
    assert.ok(r.confidence < 0.75);
  });
});

test("閾値を下げれば、同じ確信度でも手元で答える", async () => {
  const net = fakeNet({ local: { text: '{"a":1}', logprobs: lp(0.4, 0.5) }, cloud: { text: '{"a":2}' } });
  await withHybrid(net, async (ai) => {
    assert.deepEqual(await ai.callModelJson("問い"), { a: 1 });
    assert.equal(ai.routerThreshold(), 0.3);
  }, { threshold: 0.3 });
});

test("Web 検索の抜き書きを渡す頼みは、はじめからクラウドへ", async () => {
  const net = fakeNet({ local: { text: "手元", logprobs: lp(0.99) }, cloud: { text: "クラウド" } });
  await withHybrid(net, async (ai) => {
    assert.equal(await ai.callModel("調べた結果つきの問い", { web: true, task: "qa" }), "クラウド");
    assert.deepEqual(net.calls.map((c) => c.to), ["cloud"]);
    assert.equal(ai.lastRoute().reason, "web_search");
  });
});

test("クラウドが答えなければ手元の答えを使い、そのことを記録する", async () => {
  const low = fakeNet({ local: { text: '{"a":1}', logprobs: lp(0.3) }, cloud: { status: 429 } });
  await withHybrid(low, async (ai) => {
    assert.deepEqual(await ai.callModelJson("問い"), { a: 1 });
    assert.equal(ai.lastRoute().reason, "low_confidence_cloud_failed");
    assert.equal(ai.lastRoute().route, "local");
  });
  const web = fakeNet({ local: { text: "手元", logprobs: lp(0.99) }, cloud: { status: 429 } });
  await withHybrid(web, async (ai) => {
    assert.equal(await ai.callModel("問い", { web: true }), "手元");
    assert.equal(ai.lastRoute().reason, "web_search_cloud_failed");
  });
});

test("手元が答えなければクラウドへ回す", async () => {
  const net = fakeNet({ local: new Error("ECONNREFUSED"), cloud: { text: "クラウド" } });
  await withHybrid(net, async (ai) => {
    assert.equal(await ai.callModel("問い"), "クラウド");
    assert.equal(ai.lastRoute().reason, "local_failed");
  });
});

test("logprobs を返さない実行環境では、JSON が読めるかで決める", async () => {
  const ok = fakeNet({ local: { text: '{"a":1}' }, cloud: { text: '{"a":2}' } });
  await withHybrid(ok, async (ai) => {
    assert.deepEqual(await ai.callModelJson("問い"), { a: 1 });
    assert.equal(ai.lastRoute().method, "heuristic");
  });
  const broken = fakeNet({ local: { text: "JSON ではない" }, cloud: { text: '{"a":2}' } });
  await withHybrid(broken, async (ai) => {
    assert.deepEqual(await ai.callModelJson("問い"), { a: 2 });
    assert.equal(ai.lastRoute().reason, "low_confidence");
  });
});

test("使い分けをやめると、元の振る舞い（手元だけ・クラウドだけ）に戻る", async () => {
  const ai = await import("../packages/core/src/ai.js");
  ai.useHybrid({ local: { baseUrl: "http://local.test" }, cloud: { geminiKey: "k" } });
  assert.equal(ai.usingHybrid(), true);
  assert.equal(ai.usingLocalModel(), false);
  ai.useLocalModel({ baseUrl: "http://local.test" });
  assert.equal(ai.usingHybrid(), false, "useLocalModel で手元だけに戻りません");
  assert.equal(ai.usingLocalModel(), true);
  ai.useLocalModel(null);
  ai.useHybrid(null);
  assert.equal(ai.usingHybrid(), false);
  assert.equal(ai.routerThreshold(), null);
});

// --- 端末の記録と閾値（router-log.mjs と CLI）----------------------------------

test("閾値は --threshold → 環境変数 → router.json → 既定 の順に決まり、記録はファイルに残る", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tabisaki-router-"));
  const env = { TABISAKI_HOME: home };
  try {
    assert.deepEqual(resolveThreshold(undefined, env), { threshold: DEFAULT_THRESHOLD, from: "default" });
    await saveThreshold(0.6, env);
    assert.deepEqual(resolveThreshold(undefined, env), { threshold: 0.6, from: "file" });
    assert.deepEqual(resolveThreshold(undefined, { ...env, TABISAKI_ROUTER_THRESHOLD: "0.5" }), { threshold: 0.5, from: "env" });
    assert.deepEqual(resolveThreshold("0.9", env), { threshold: 0.9, from: "option" });
    assert.throws(() => resolveThreshold("2", env), /0〜1/);
    await assert.rejects(saveThreshold("x", env), /0〜1/);

    const rec = fileRecorder(env);
    rec({ seq: 1, at: "t", route: "local", confidence: 0.8 });
    rec({ seq: 2, at: "t", route: "cloud", confidence: 0.2 });
    const back = await readRouteLog(env);
    assert.equal(back.length, 2);
    assert.ok(!("seq" in back[0]));
    assert.match(await readFile(path.join(home, "router-log.jsonl"), "utf8"), /"route":"cloud"/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, TZ: "UTC", TABISAKI_LLM_URL: "", OLLAMA_HOST: "", GEMINI_API_KEY: "",
             TABISAKI_GEMINI_KEY: "", TABISAKI_PROXY_URL: "", TABISAKI_ROUTER_THRESHOLD: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => { stdout += c; });
    p.stderr.on("data", (c) => { stderr += c; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI: --hybrid はクラウドの入口が無ければ使いかたのまちがい", async () => {
  const r = await run(["plan", "温泉", "--hybrid"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GEMINI_API_KEY|--cloud-url/);
  const r2 = await run(["plan", "温泉", "--threshold=0.5"]);
  assert.equal(r2.status, 2);
  const r3 = await run(["plan", "温泉", "--hybrid", "--local", "--cloud-url=https://x.test"]);
  assert.equal(r3.status, 2);
});

test("CLI: --hybrid で組み、低い確信度の頼みはクラウドへ回し、router stats で目安が出る", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tabisaki-router-cli-"));
  let localHits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "gemma4:e2b" }] }));
      if (req.url === "/v1/chat/completions") {
        localHits++;
        // 迷った返事（確信度 0.3）。
        return res.end(JSON.stringify({ choices: [{ message: { content: "{}" },
          logprobs: { content: [{ token: "{", logprob: Math.log(0.3) }] } }] }));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await run(["plan", "温泉", "--hybrid", `--llm-url=${url}`, "--cloud-url=http://insecure.test"], { TABISAKI_HOME: home });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /https/);

    // クラウドの入口はつながらない先（外へは出しません）。聞き直せなければ、手元の答えで組みます。
    const r = await run(["plan", "温泉と海をゆっくり", "--hybrid", `--llm-url=${url}`, "--threshold=0.5",
      "--cloud-url=https://127.0.0.1:1", "--output=json"], { TABISAKI_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(localHits >= 1, "手元の LLM に聞いていません");
    assert.match(r.stderr, /使い分け: 手元 \d+件・クラウド \d+件/);
    const log = await readRouteLog({ TABISAKI_HOME: home });
    assert.ok(log.length >= 1, "記録が残っていません");
    assert.ok(log.every((e) => e.threshold === 0.5));
    // 確信度 0.3 < 0.5 なので、すべてクラウドへ聞き直そうとし、届かないので手元の答えを使っています。
    assert.ok(log.every((e) => e.confidence === 0.3 && e.reason === "low_confidence_cloud_failed"), JSON.stringify(log));

    const stats = await run(["router", "stats", "--output=json"], { TABISAKI_HOME: home });
    assert.equal(stats.status, 0, stats.stderr);
    const doc = JSON.parse(stats.stdout);
    assert.equal(doc.total, log.length);
    assert.equal(doc.suggestedThreshold, null);

    const set = await run(["router", "threshold", "0.65"], { TABISAKI_HOME: home });
    assert.equal(set.status, 0, set.stderr);
    const get = await run(["router", "threshold"], { TABISAKI_HOME: home });
    assert.match(get.stdout, /0\.65/);
    const logOut = await run(["router", "log", "--limit=1"], { TABISAKI_HOME: home });
    assert.match(logOut.stdout, /確信度 0\.3/);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
});
