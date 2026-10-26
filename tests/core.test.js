// packages/core（Node.js から旅程を組む入口）の試験。
// 外へは通信しません。時刻は日本時間で割り付けられることも見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { CoreError, createCore, jstDate, normalizeRequest, offlineFetch, toJson, toMarkdown, toPlainText }
  from "../packages/core/index.mjs";

const core = await createCore();
const jstHour = (d) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false }).format(new Date(d)));

test("希望の文と出発地から、日本時間の旅程が組める", async () => {
  const r = await core.plan({ wish: "温泉と海をゆっくり楽しみたい", from: "東京駅", days: 2, date: "2026-11-07" });
  const days = r.itinerary.days;
  assert.ok(days.length >= 2, `日数 ${days.length}`);
  const spots = days.flatMap((d) => d.items).filter((i) => i.kind === "spot");
  assert.ok(spots.length >= 3, `立ち寄り ${spots.length}`);
  // 立ち寄りは昼の時間に入る（UTC で割り付けると夜中になる）
  for (const s of spots) assert.ok(jstHour(s.start) >= 6 && jstHour(s.start) < 22, `${s.title} ${s.start}`);
  assert.equal(jstHour(days[0].items[0].start), 8);
});

test("同じ条件なら、同じ旅程になる", async () => {
  const req = { wish: "京都で歴史を感じたい", from: "新大阪駅", date: "2026-11-03" };
  const a = toJson(await core.plan(req));
  const b = toJson(await core.plan(req));
  assert.equal(a, b);
});

test("入力のまちがいは CoreError の code で分かる", async () => {
  const code = async (req) => {
    try { await normalizeRequest(req); } catch (e) { assert.ok(e instanceof CoreError); return e.code; }
    return "ok";
  };
  assert.equal(await code({ wish: "" }), "invalid_input");
  assert.equal(await code({ wish: "温泉", days: 0 }), "invalid_input");
  assert.equal(await code({ wish: "温泉", days: 1.5 }), "invalid_input");
  assert.equal(await code({ wish: "温泉", from: "どこにもない駅" }), "unknown_place");
  assert.equal(await code({ wish: "温泉", transport: "rocket" }), "invalid_input");
  assert.equal(await code({ wish: "温泉", date: "11/3" }), "invalid_input");
  assert.equal(await code({ wish: "温泉", start: "19:00", back: "20:00" }), "invalid_input");
  assert.equal(await code({ wish: "温泉", from: "新宿" }), "ok");
});

test("日付と時刻は日本時間で読む", () => {
  assert.equal(jstDate("2026-11-03", "08:00").toISOString(), "2026-11-02T23:00:00.000Z");
});

test("外へは通信しない。リポジトリの外も読まない", async () => {
  const f = offlineFetch();
  await assert.rejects(f("https://example.com/api"), /通信を切っています/);
  await assert.rejects(f("../../etc/passwd"), /リポジトリの外/);
  const kb = await f("https://tabisaki.example/kb/index.json");
  assert.ok((await kb.json()).shards.length > 10);
  assert.equal((await f("kb/nai.json")).ok, false);
});

test("Markdown・文・JSON に書き出せる", async () => {
  const r = await core.plan({ wish: "温泉", from: "東京駅", date: "2026-11-07" });
  const md = toMarkdown(r);
  assert.match(md, /^# /);
  assert.match(md, /## 1日目/);
  assert.match(md, /\| 08:00〜/);
  assert.match(toPlainText(r), /1日目/);
  const j = JSON.parse(toJson(r));
  assert.equal(j.version, 1);
  assert.equal(j.request.from, "東京駅");
  assert.ok(j.days[0].items.length > 0);
});
