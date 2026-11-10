// 帰りの時刻を守る（旅程を1本まるごと組んで確かめる）。
//
// 成立率のベンチマーク（tools/plan_bench.mjs）で不成立だった頼みごとを、
// 壊れかたごとに1本ずつ固定します。判定の関数はベンチマークと同じものです。
// 通信はしません（AI・経路・天気は使わず、距離からの目安で組みます）。
//
// どれも「検証は通ったのに、旅程にすると成り立たない」壊れかたでした。
// 検証（verify.js）と組み立て（planner.js）が、別の時計・別の所要時間を
// 見ていたためです。

import assert from "node:assert/strict";
import test from "node:test";

process.env.TZ = "Asia/Tokyo";
const { createCore } = await import("../packages/core/index.mjs");
const { hoursFor } = await import("../packages/core/src/hours.js");
const { auditItinerary, HARD_KINDS, tightRequests }
  = await import("../tools/plan_bench.mjs");

const core = await createCore();
const t = (x) => new Date(x).getTime();

async function plan(body) {
  const { request, itinerary } = await core.plan(body);
  const items = itinerary.days.flatMap((d) => d.items ?? []);
  const hard = auditItinerary(itinerary, request, { hoursFor })
    .filter((v) => HARD_KINDS.includes(v.kind));
  return { request, itinerary, items, hard };
}

const says = (hard) => hard.map((v) => `[${v.kind}] ${v.msg}`).join(" / ");

test("最終日の昼食が、帰りを遅らせない（函館を2日で、東京へ18:00まで）", async () => {
  // 10:20 に見学が終わり、12:00 に昼食、13:00 発で 19:30 着になっていました。
  const { request, itinerary, items, hard } = await plan({
    wish: "函館で寺と庭園を見たい", from: "東京駅", days: 2,
    date: "2026-11-30", start: "10:00", back: "18:00", transport: "car" });
  assert.deepEqual(hard, [], says(hard));
  const back = items.at(-1);
  assert.equal(back.kind, "transit");
  assert.ok(t(back.end) <= t(request.arriveBy), `帰着 ${back.end}`);
  // 最終日に昼食が無いなら、その理由が書いてあること。
  const lastDay = itinerary.days.at(-1).items;
  if (!lastDay.some((i) => i.kind === "meal")) {
    assert.ok(itinerary.warnings.some((w) => w.includes("昼食")),
      itinerary.warnings.join("/"));
  }
});

test("着く前に、次の予定が始まらない（札幌から箱根へ日帰り）", async () => {
  // 「06:30–11:28 札幌駅 → 箱根湯本駅」の下に「11:07 箱根湯本温泉へ移動」。
  // 実際の時刻で組み直したとき、古い立ち寄りと新しい往路が混ざっていました。
  const { request, items, hard } = await plan({
    wish: "箱根で景色のいい展望台", from: "札幌駅", days: 1,
    date: "2026-12-19", start: "06:30", back: "18:00", transport: "any" });
  assert.deepEqual(hard, [], says(hard));
  const out = items[0];
  for (const it of items.slice(1)) {
    assert.ok(t(it.start) >= t(out.end) - 60000,
      `${it.title} が、着く前（${out.end}）に始まる`);
  }
  assert.ok(t(items.at(-1).end) <= t(request.arriveBy));
});

test("着く前の時刻に、昼食を置かない（札幌から高知へ日帰り）", async () => {
  const { items, hard } = await plan({
    wish: "高知で美術館めぐり", from: "札幌駅", days: 1,
    date: "2026-12-03", start: "08:00", back: "21:00", transport: "transit" });
  assert.deepEqual(hard, [], says(hard));
  const out = items[0];
  for (const m of items.filter((i) => i.kind === "meal")) {
    assert.ok(t(m.start) >= t(out.end) - 60000, `昼食 ${m.start} が到着 ${out.end} より前`);
  }
});

test("帰りの所要時間は、最後の立ち寄りから測ったもの（広島から松本へ3日）", async () => {
  // 帰りを「出発地 → 拠点の駅」の時間で組んでいて、18:09 着になっていました。
  const { request, items, hard } = await plan({
    wish: "松本で景色のいい展望台", from: "広島駅", days: 3,
    date: "2026-12-21", start: "09:00", back: "18:00", transport: "any" });
  assert.deepEqual(hard, [], says(hard));
  const back = items.at(-1);
  const lastSpot = items.filter((i) => i.kind === "spot").at(-1);
  assert.equal(back.from?.id, lastSpot.place.id);
  assert.ok(t(back.end) <= t(request.arriveBy));
});

test("現地に2時間しかいられなくても、入る場所は入れる", async () => {
  // 東京から広島へ日帰り。昼食を先に取って、立ち寄りが1つも入らない
  // 旅程（行って、自由時間、帰る）になっていました。
  const a = await plan({
    wish: "広島で子どもと水族館", from: "東京駅", days: 1,
    date: "2026-11-30", start: "06:30", back: "21:00", transport: "any" });
  assert.deepEqual(a.hard, [], says(a.hard));
  assert.ok(a.items.some((i) => i.kind === "spot"));

  // 名古屋から天草へ日帰り。先頭の「下島（180分）」が入らないだけで、
  // 後ろの短い場所まで全部を外していました。
  const b = await plan({
    wish: "熊本で食べ歩き", from: "名古屋駅", days: 1,
    date: "2026-11-26", start: "08:00", back: "20:00", transport: "any" });
  assert.deepEqual(b.hard, [], says(b.hard));
  assert.ok(b.items.some((i) => i.kind === "spot"));
});

test("希望に合う場所が入らず近くの場所で組んだら、そう書く", async () => {
  const { itinerary, hard } = await plan({
    wish: "富山で山歩きと滝", from: "札幌駅", days: 1,
    date: "2026-12-23", start: "08:00", back: "19:00", transport: "any" });
  assert.deepEqual(hard, [], says(hard));
  if (itinerary.rescued) {
    assert.ok(itinerary.warnings.some((w) => w.includes("ご希望に合う場所は")),
      itinerary.warnings.join("/"));
  }
});

test("飛行機の速さで見積もった区間には、飛行機と書く（札幌から那覇へ）", async () => {
  const { items, hard } = await plan({
    wish: "那覇で山歩きと滝", from: "札幌駅", days: 4,
    date: "2026-11-03", start: "08:00", back: "20:00", transport: "any" });
  assert.deepEqual(hard, [], says(hard));
  assert.ok(items[0].vehicle?.kinds?.includes("air"), JSON.stringify(items[0].vehicle));
  assert.ok(items.at(-1).vehicle?.kinds?.includes("air"));
});

test("夕方に着く旅で、2日目が消えない（博多から名古屋へ4日、16:02 着）", async () => {
  // 1日目に閉まっていた場所をその場で全部外し、2日目に回るはずの場所まで
  // 消えて、4日の旅程が3日ぶんしか出ていませんでした。
  const { itinerary, hard } = await plan({
    wish: "名古屋で城と城下町", from: "博多駅", days: 4,
    date: "2026-11-29", start: "10:00", back: "20:00", transport: "any" });
  assert.deepEqual(hard, [], says(hard));
  assert.equal(itinerary.days.length, 4);
  for (const [i, d] of itinerary.days.entries()) {
    if (i === 0) continue;
    assert.ok(d.items.some((x) => x.kind === "spot"), `${i + 1}日目に立ち寄りが無い`);
  }
});

test("遠くへ短く行く頼みごとを20本組んで、どれも成り立つ", async () => {
  // 基準のシードとは別のシードです（基準に合わせただけの直しを防ぎます）。
  for (const { id, ...body } of tightRequests(2026, 20)) {
    let res;
    try {
      res = await plan(body);
    } catch (e) {
      // 「この日程では往復できません」と断るのは、正しい答えです。
      assert.equal(e?.code, "plan_failed", `${id}: ${e?.message}`);
      continue;
    }
    assert.deepEqual(res.hard, [], `${id} ${JSON.stringify(body)}: ${says(res.hard)}`);
  }
});
