// tools/plan_bench.mjs（旅程の成立率ベンチマーク）の判定の試験。
// 旅程を本当に組むのは CI の「Itinerary benchmark」で、ここでは判定の関数だけを
// 手で作った旅程で確かめます（速く、知識ベースに左右されません）。

import assert from "node:assert/strict";
import test from "node:test";

process.env.TZ = "Asia/Tokyo";
const { hoursFor } = await import("../js/hours.js");
const {
  auditItinerary, randomRequests, rng, summarize, compare, loadFixedRequests, HARD_KINDS,
} = await import("../tools/plan_bench.mjs");

const J = (hm, day = "2026-11-16") => `${day}T${hm}:00+09:00`;
const request = { departAt: new Date(J("08:00")), arriveBy: new Date(J("20:00")), days: 1 };
const museum = { id: "m1", name: "美術館A", category: "美術館", lat: 35, lng: 135, open: 10, close: 17 };
const temple = { id: "t1", name: "寺B", category: "寺院", lat: 35.01, lng: 135.01, open: 9, close: 16 };
const item = (kind, s, e, extra = {}) => ({ kind, start: J(s), end: J(e), title: extra.place?.name ?? kind, ...extra });
const kinds = (v) => [...new Set(v.map((x) => x.kind))].sort();

test("成り立っている旅程には違反が無い", () => {
  const itin = { days: [{ items: [
    item("transit", "08:00", "09:30", { km: 40 }),
    item("spot", "10:00", "11:00", { place: museum }),
    item("meal", "11:30", "12:30"),
    item("spot", "13:00", "14:00", { place: temple }),
    item("transit", "14:00", "19:00", { km: 300 }),
  ] }] };
  assert.deepEqual(auditItinerary(itin, request, { hoursFor }), []);
});

test("営業時間の外・最終入場の後を拾う", () => {
  const itin = { days: [{ items: [
    item("spot", "09:00", "10:00", { place: museum }),          // 開く前
    item("spot", "16:50", "17:30", { place: { ...temple, id: "t2", lat: 36 } }), // 閉まった後
  ] }] };
  const v = auditItinerary(itin, request, { hoursFor });
  assert.equal(v.filter((x) => x.kind === "hours").length, 3, JSON.stringify(v));
});

test("目安の営業時間は hoursEstimated に分ける（不成立には数えない）", () => {
  const guess = { id: "g1", name: "城C", category: "城", lat: 35, lng: 135 };
  const itin = { days: [{ items: [item("spot", "18:00", "19:00", { place: guess })] }] };
  const v = auditItinerary(itin, request, { hoursFor });
  assert.deepEqual(kinds(v), ["hoursEstimated"]);
  assert.ok(!HARD_KINDS.includes("hoursEstimated"));
});

test("帰りの時刻を過ぎる・ありえない速さ・長すぎる移動を拾う", () => {
  const itin = { days: [{ items: [
    item("spot", "10:00", "11:00", { place: museum }),
    item("transit", "11:00", "12:00", { km: 900, title: "東京駅 → 博多駅" }),
    item("transit", "12:00", "20:30", { km: 10 }),
  ] }] };
  const msgs = auditItinerary(itin, request, { hoursFor }).filter((x) => x.kind === "travel").map((x) => x.msg).join("\n");
  assert.match(msgs, /時速 900km/);
  assert.match(msgs, /帰りの時刻 20:00 を過ぎる/);
  const long = { days: [{ items: [item("spot", "10:00", "11:00", { place: museum }), { kind: "transit", title: "タクシー", start: J("11:00"), end: J("11:00", "2026-11-18"), km: 1900 }] }] };
  assert.match(auditItinerary(long, { days: 1 }, { hoursFor }).map((x) => x.msg).join(), /1本で 48 時間/);
});

test("同じ場所に2回・予定の重なり・日数の違い・立ち寄りなしを拾う", () => {
  const near = { ...museum, id: "m2", name: "美術館A 別館", lat: 35.0003 };
  const itin = { days: [{ items: [
    item("spot", "10:00", "11:00", { place: museum }),
    item("meal", "10:45", "11:30"),
    item("spot", "12:00", "13:00", { place: museum }),
    item("spot", "13:30", "14:00", { place: near }),
  ] }, { items: [] }] };
  const v = auditItinerary(itin, request, { hoursFor });
  assert.deepEqual(kinds(v), ["constraint", "duplicate"]);
  assert.equal(v.filter((x) => x.kind === "duplicate").length, 3); // 同じ id ×1、100m 以内 ×2
  assert.ok(v.some((x) => /2 日（頼んだのは 1 日）/.test(x.msg)));
  const empty = auditItinerary({ days: [{ items: [item("transit", "08:00", "10:00", { km: 50 })] }] }, request, { hoursFor });
  assert.deepEqual(kinds(empty), ["empty"]);
});

test("ランダムの頼みごとは、シードが同じなら同じ並び", () => {
  assert.deepEqual(randomRequests(374, 20), randomRequests(374, 20));
  assert.notDeepEqual(randomRequests(374, 20), randomRequests(375, 20));
  const r = rng(1);
  assert.ok([r(), r(), r()].every((x) => x >= 0 && x < 1));
  for (const q of randomRequests(9, 50)) {
    assert.match(q.date, /^2026-1[12]-\d{2}$/);
    assert.ok(q.days >= 1 && q.days <= 4);
  }
});

test("決まった頼みごとの組は、id が重ならず必要な項目がそろう", () => {
  const reqs = loadFixedRequests();
  assert.ok(reqs.length >= 20);
  assert.equal(new Set(reqs.map((r) => r.id)).size, reqs.length);
  for (const r of reqs) for (const k of ["wish", "from", "days", "date"]) assert.ok(r[k], `${r.id} に ${k} がありません`);
});

test("集計と、基準との比較", () => {
  const results = [
    { id: "a", violations: [] },
    { id: "b", violations: [{ kind: "travel" }, { kind: "travel" }] },
    { id: "c", violations: [{ kind: "hoursEstimated" }] },
    { id: "d", violations: [{ kind: "unreachable" }] },
  ];
  const s = summarize(results);
  assert.equal(s.successRate, 0.75);
  assert.deepEqual(s.failed, ["b"]);
  assert.equal(s.itineraries.travel, 1);
  assert.equal(s.violations.travel, 2);

  const same = compare({ x: s }, { x: s });
  assert.deepEqual(same.worse, []);
  const worse = summarize([...results.slice(0, 3), { id: "d", violations: [{ kind: "duplicate" }] }]);
  assert.ok(compare({ x: s }, { x: worse }, { successRate: 0.3, itineraries: 5 }).worse.some((w) => /新しく不成立.*d/.test(w)));
  assert.ok(compare({ x: s }, { x: worse }, { successRate: 0.3, itineraries: 5 }).worse.length === 1);
  assert.ok(compare({ x: s }, { x: worse }, { successRate: 0, itineraries: 0 }).worse.some((w) => /成立率/.test(w)));
  assert.ok(compare({ x: s }, { x: summarize(results.slice(0, 2)) }).worse.some((w) => /件数が基準/.test(w)));
});
