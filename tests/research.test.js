// Research Agent（packages/core/src/research.js。Issue #436）の試験。
// ネット検索は手元の関数で置き換えます（外へは通信しません）。

import assert from "node:assert/strict";
import test from "node:test";

import { createCore } from "../packages/core/index.mjs";
import { createDefaultTools } from "../packages/core/src/tools.js";
import { MAX_SEARCHES, heuristicQuery, modelLlm, overseasWord, runResearch, spotsMentioned }
  from "../packages/core/src/research.js";

const core = await createCore();
const kb = core.kb;

// 「夏目友人帳」は収録に無い語です。調べると、熊本県人吉市の名所が出てきます。
const HITOYOSHI = [
  { title: "夏目友人帳の聖地・熊本県人吉市を巡る", url: "https://example.com/natsume",
    snippet: "作者の出身地である人吉球磨地方がモデル。人吉城跡や青井阿蘇神社、鹿目の滝などに舞台のモデルがある。" },
  { title: "人吉旅行ガイド", url: "https://example.com/hitoyoshi", snippet: "人吉温泉と球磨川の町" },
];
const fixedSearch = (results) => {
  const asked = [];
  const fn = async (q) => { asked.push(q); return typeof results === "function" ? results(asked.length) : results; };
  fn.asked = asked;
  return fn;
};

test("未知の要望: 検索→統合→旅程生成が一巡する", async () => {
  const search = fixedSearch(HITOYOSHI);
  const r = await core.research({ wish: "夏目友人帳の舞台をめぐりたい", from: "博多駅", days: 1, date: "2026-11-07" }, { search });
  assert.equal(r.research.status, "answered");
  assert.equal(r.research.searches, 1, "1回で見つかれば、そこで打ち切る（Single-hop）");
  assert.equal(search.asked.length, 1);
  assert.equal(r.research.prefecture, "熊本県");
  const found = r.research.order.map((s) => s.name);
  for (const n of ["青井阿蘇神社", "鹿目の滝", "人吉城"]) assert.ok(found.includes(n), `${n} が見つかっていません: ${found}`);
  assert.deepEqual(r.research.sources.map((s) => s.url), HITOYOSHI.map((x) => x.url));
  // 旅程に入る
  const visited = r.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(visited.includes("青井阿蘇神社") && visited.includes("鹿目の滝"), visited.join(","));
  assert.equal(r.request.wish, "夏目友人帳の舞台をめぐりたい");
  // 記録（ReAct の考え→行い→結果）が残る
  const tools = r.research.trace.map((t) => t.action?.tool).filter(Boolean);
  assert.deepEqual([...new Set(tools)], ["search_special_journey", "search_spots", "web_search", "calculate_route"]);
});

test("見つからなければ語を変えて調べ直し、最大3回で止まる", async () => {
  const search = fixedSearch([{ title: "関係のない話", url: "https://example.com/x", snippet: "なにもない" }]);
  const tools = createDefaultTools({ kb, search });
  const r = await runResearch({ wish: "夏目友人帳の舞台をめぐりたい", tools, maxSearches: 10 });
  assert.equal(MAX_SEARCHES, 3);
  assert.equal(r.searches, 3, "上限は3回");
  assert.equal(new Set(search.asked).size, 3, `同じ語で聞き直さない: ${search.asked}`);
  assert.equal(r.status, "out_of_scope");
  assert.match(r.message, /3回調べましたが/);
  assert.ok(r.question?.question, "どのあたりかを聞く");
});

test("2回目で見つかれば、そこで止まる", async () => {
  const search = fixedSearch((n) => (n === 1 ? [] : HITOYOSHI));
  const tools = createDefaultTools({ kb, search });
  const r = await runResearch({ wish: "夏目友人帳の舞台をめぐりたい", tools });
  assert.equal(r.status, "answered");
  assert.equal(r.searches, 2);
});

test("収録で足りる要望は、調べずに組む", async () => {
  const search = fixedSearch(HITOYOSHI);
  const r = await core.research({ wish: "京都で紅葉を見たい", from: "新大阪駅", date: "2026-11-07" }, { search });
  assert.equal(r.research.status, "kb");
  assert.equal(search.asked.length, 0);
  assert.ok(r.itinerary.days.length >= 1);
  const j = await core.research({ wish: "東海道五十三次をたどりたい", from: "東京駅", date: "2026-11-07" }, { search });
  assert.equal(j.research.status, "kb");
  assert.equal(j.research.journey.name, "東海道五十三次");
});

test("海外は正直に断り、国内の代わりを出す", async () => {
  const r = await core.research({ wish: "ハワイで温泉とグルメ", from: "東京駅" }, { search: fixedSearch(HITOYOSHI) });
  assert.equal(r.research.status, "out_of_scope");
  assert.equal(r.itinerary, undefined, "旅程は作らない");
  assert.match(r.research.message, /ハワイ.*日本の外/);
  assert.ok(r.research.alternatives.length > 0);
  assert.equal(overseasWord("京都の寺"), null);
});

test("ネットで調べられないときも、正直に言って代わりを出す", async () => {
  const r = await core.research({ wish: "夏目友人帳の舞台をめぐりたい", from: "東京駅" });
  assert.equal(r.research.status, "out_of_scope");
  assert.equal(r.research.searches, 0);
  assert.match(r.research.message, /ネットで調べる手段も使えません/);
  assert.ok(r.research.alternatives.length > 0, "出発地の近くの知られた場所");
  assert.ok(!r.research.alternatives.some((s) => /舞台/.test(s.name)), "「舞台」の語で探さない");
});

test("AI（llm）は調べる語と場所の拾い出しだけを手伝う。壊れても止まらない", async () => {
  const search = fixedSearch([{ title: "旅の記事", url: "https://example.com/y", snippet: "モデル地を歩いた" }]);
  const tools = createDefaultTools({ kb, search });
  const llm = async (task) => (task === "query" ? { query: "夏目友人帳 モデル地 熊本" } : { places: ["青井阿蘇神社", "人吉城"] });
  const r = await runResearch({ wish: "夏目友人帳の舞台をめぐりたい", tools, llm });
  assert.equal(search.asked[0], "夏目友人帳 モデル地 熊本");
  assert.equal(r.status, "answered");
  assert.ok(r.order.some((s) => s.name === "青井阿蘇神社"));

  const broken = async () => { throw new Error("AI が答えません"); };
  const s2 = fixedSearch(HITOYOSHI);
  const r2 = await runResearch({ wish: "夏目友人帳の舞台をめぐりたい", tools: createDefaultTools({ kb, search: s2 }), llm: broken });
  assert.equal(r2.status, "answered");
  assert.equal(s2.asked[0], heuristicQuery(["夏目友人帳"], 0));
});

test("modelLlm は JSON を返すモデルを llm の形にする", async () => {
  const prompts = [];
  const llm = modelLlm(async (p) => { prompts.push(p); return { query: "x y" }; });
  assert.deepEqual(await llm("query", { wish: "w", unknown: ["a"], tried: [] }), { query: "x y" });
  await llm("extract", { wish: "w", results: [{ title: "t", snippet: "s" }] });
  assert.match(prompts[0], /"query"/);
  assert.match(prompts[1], /"places"/);
  assert.equal(await llm("other", {}), null);
});

test("spotsMentioned は長い名前を先に当てる", () => {
  const names = spotsMentioned(kb, "青井阿蘇神社と人吉城歴史館へ").map((s) => s.name);
  assert.ok(names.includes("青井阿蘇神社"));
  assert.ok(names.includes("人吉城歴史館"));
  assert.ok(!names.includes("人吉城"), "人吉城歴史館の中の人吉城は数えない");
});
