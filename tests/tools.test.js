// 道具の登録所（packages/core/src/tools.js。Issue #437）の試験。
// 外へは通信しません（経路・天気は mock か off、ネット検索は手元の関数）。

import assert from "node:assert/strict";
import test from "node:test";

import { createCore } from "../packages/core/index.mjs";
import {
  BUILTIN_TOOLS, TOOL_PRIORITY, cachedSearch, createDefaultTools, createToolRegistry, validate,
} from "../packages/core/src/tools.js";
import { useProviders, resetProviders } from "../packages/core/src/providers.js";

const core = await createCore();
const kb = core.kb;

test("決まりの道具が、優先順位の順に並ぶ", () => {
  const reg = createDefaultTools({ kb });
  const names = reg.list().map((t) => t.name);
  assert.deepEqual(names, ["search_spots", "search_special_journey", "search_historical_route",
    "calculate_route", "search_transit", "search_weather", "web_search", "ask_user"]);
  for (const t of reg.list()) assert.equal(t.priority, TOOL_PRIORITY[t.name]);
  // 収録 → 移動 → 天気 → ネット → 利用者 の順
  assert.ok(TOOL_PRIORITY.search_spots < TOOL_PRIORITY.search_transit);
  assert.ok(TOOL_PRIORITY.search_weather < TOOL_PRIORITY.web_search);
  assert.ok(TOOL_PRIORITY.web_search < TOOL_PRIORITY.ask_user);
});

test("どの道具も入出力を JSON Schema で持つ", () => {
  for (const t of BUILTIN_TOOLS) {
    assert.equal(t.input.type, "object", t.name);
    assert.equal(t.input.additionalProperties, false, t.name);
    assert.ok(Array.isArray(t.input.required), t.name);
    assert.equal(t.output.type, "object", t.name);
    assert.ok(t.description.length > 5, t.name);
  }
});

test("検索先が無ければ web_search は使えない。渡せば使える", () => {
  assert.ok(!createDefaultTools({ kb }).available().includes("web_search"));
  assert.ok(createDefaultTools({ kb, search: async () => [] }).available().includes("web_search"));
});

test("どの道具も同じ形で返り、投げない", async () => {
  const reg = createDefaultTools({ kb });
  const ok = await reg.call("search_spots", { keywords: ["温泉"], limit: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.tool, "search_spots");
  assert.equal(ok.data.spots.length, 3);
  assert.ok(Number.isFinite(ok.ms));

  const unknown = await reg.call("no_such_tool", {});
  assert.deepEqual([unknown.ok, unknown.error.code], [false, "unknown_tool"]);
  const bad = await reg.call("search_spots", { keywords: [] });
  assert.deepEqual([bad.ok, bad.error.code], [false, "invalid_args"]);
  const extra = await reg.call("search_spots", { keywords: ["城"], hack: 1 });
  assert.equal(extra.error.code, "invalid_args");
  const off = await reg.call("web_search", { query: "京都 紅葉" });
  assert.equal(off.error.code, "unavailable");
  const missing = await reg.call("calculate_route", { spotIds: ["nope"] });
  assert.equal(missing.error.code, "not_found");
});

test("search_spots は県で絞れる", async () => {
  const reg = createDefaultTools({ kb });
  const r = await reg.call("search_spots", { keywords: ["温泉"], prefecture: "大分県", limit: 5 });
  assert.ok(r.data.spots.length > 0);
  for (const s of r.data.spots) assert.equal(s.prefecture, "大分県");
});

test("calculate_route は回る順を、移動が短くなるように並べる", async () => {
  const reg = createDefaultTools({ kb });
  const ids = ["wd-Q11677247", "wd-Q2857960", "wd-Q8011484"]; // 鹿目の滝・青井阿蘇神社・人吉城（熊本県人吉市）
  for (const id of ids) assert.ok(kb.spotsById.has(id), id);
  const r = await reg.call("calculate_route", { spotIds: ids, start: { name: "人吉駅", lat: 32.2177, lng: 130.7553 } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.data.order.length, 3);
  // 鹿目の滝（街から10km南西）は最後
  assert.equal(r.data.order.at(-1).name, "鹿目の滝");
  assert.ok(r.data.totalMinutes > 0);
});

test("search_transit は経路が引けないとき、距離からの目安を返す", async () => {
  const reg = createDefaultTools({ kb });
  const est = await reg.call("search_transit", { from: { name: "東京駅" }, to: { name: "新大阪駅" } });
  assert.equal(est.data.estimated, true);
  assert.ok(est.data.minutes > 60);
  useProviders({ routing: "mock" });
  try {
    const r = await reg.call("search_transit", { from: { name: "東京駅" }, to: { name: "新大阪駅" } });
    assert.equal(r.data.estimated, false);
    assert.equal(r.data.provider, "mock");
  } finally {
    useProviders({ routing: "off" });
  }
});

test("search_weather は天気の取り口を使い、切っていれば使えない", async () => {
  const reg = createDefaultTools({ kb });
  assert.ok(!reg.available().includes("search_weather"));
  useProviders({ weather: "mock" });
  try {
    const r = await reg.call("search_weather", { place: { name: "京都駅" }, date: "2026-11-07" });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.deepEqual([r.data.maxRain, r.data.maxTemp], [20, 18]);
  } finally {
    useProviders({ weather: "off" });
  }
});

test("名のある旅・旧街道の受け口", async () => {
  const reg = createDefaultTools({ kb });
  const j = await reg.call("search_special_journey", { text: "最長片道切符で旅したい" });
  assert.equal(j.data.journey.name, "最長片道切符");
  const h = await reg.call("search_historical_route", { name: "中山道" });
  assert.ok(h.data.along.includes("馬籠"));
  const r1 = await reg.call("search_historical_route", { name: "国道1号" });
  assert.equal(r1.data.along[0], "東京");
  const none = await reg.call("search_historical_route", { name: "熊野古道" });
  assert.equal(none.data.found, false);
});

test("ask_user は聞きたいことを返す", async () => {
  const r = await createDefaultTools({ kb }).call("ask_user", { question: "どの県に行きたいですか", choices: ["京都", "奈良"] });
  assert.deepEqual(r.data, { question: "どの県に行きたいですか", choices: ["京都", "奈良"] });
});

test("道具を足せる。actionSchema で AI の出力をしばれる", async () => {
  const reg = createToolRegistry({});
  reg.register({ name: "echo", input: { type: "object", required: ["x"], properties: { x: { type: "integer", minimum: 1 } } },
    run: async ({ x }) => ({ x }) });
  assert.deepEqual((await reg.call("echo", { x: 2 })).data, { x: 2 });
  assert.equal((await reg.call("echo", { x: 0 })).error.code, "invalid_args");
  const schema = reg.actionSchema();
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.oneOf[0].properties.tool.const, "echo");
  assert.throws(() => reg.register({ name: "Bad Name", input: { type: "object" }, run() {} }));
  assert.throws(() => reg.register({ name: "noschema", run() {} }));
});

test("validate は型・必須・範囲・余分な項目を見る", () => {
  const s = { type: "object", additionalProperties: false, required: ["a"],
    properties: { a: { type: "string", maxLength: 3 }, b: { type: "array", maxItems: 1, items: { type: "number" } }, c: { enum: ["x"] } } };
  assert.deepEqual(validate(s, { a: "ab" }), []);
  assert.equal(validate(s, {}).length, 1);
  assert.equal(validate(s, { a: "abcd" }).length, 1);
  assert.equal(validate(s, { a: "a", b: [1, 2] }).length, 1);
  assert.equal(validate(s, { a: "a", b: ["x"] }).length, 1);
  assert.equal(validate(s, { a: "a", c: "y" }).length, 1);
  assert.equal(validate(s, { a: "a", z: 1 }).length, 1);
  assert.equal(validate(s, "x").length, 1);
});

test("cachedSearch は同じ語を控えから返す（期限つき）", async () => {
  let calls = 0;
  let t = 0;
  const search = cachedSearch(async () => { calls++; return [{ title: "a", url: "https://a.example", snippet: "" }]; },
    { ttlMs: 1000, now: () => t });
  await search("京都 紅葉");
  await search(" 京都  紅葉 ");
  assert.equal(calls, 1);
  assert.deepEqual(search.stats, { hits: 1, misses: 1 });
  t = 2000;
  await search("京都 紅葉");
  assert.equal(calls, 2);
});

test("後始末", () => resetProviders());
