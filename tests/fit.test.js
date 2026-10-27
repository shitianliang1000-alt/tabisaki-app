// 「なぜこの場所が選ばれたのか」を、数字で説明できるようにするテスト。
//
// AIが「おすすめです」と言うだけでは、なぜそこなのかが分かりません。
// 希望した「海」にどれくらい合っているのか、移動は効率的なのか、
// 混雑は避けられているのか。どれも数えれば決まります。
//
// ここでもAIには採点させません。同じ場所でも聞くたびに点が変わると、
// 説明として成立しないからです。

import assert from "node:assert/strict";
import test from "node:test";

import { AXES, qualityOf, spotFit, tripFit } from "../js/fit.js";
import { makeTrip } from "../packages/core/src/trip.js";

const d = (s) => new Date(s);

const spot = (over = {}) => ({
  id: "s1", name: "由比ヶ浜", category: "海岸",
  lat: 35.31, lng: 139.53, genres: ["sea"], fame_tier: "known", ...over,
});

const TRIP = (over = {}) => makeTrip({
  origin: { name: "東京駅", lat: 35.681, lng: 139.767 },
  departAt: d("2026-09-12T09:00"),
  arriveBy: d("2026-09-12T19:00"),
  interests: ["sea", "history"],
  ...over,
});

// --- スポット1件の適合 ------------------------------------------------------

test("希望したジャンルに合う場所ほど、高く出る", () => {
  const t = TRIP();
  const sea = spotFit(spot({ genres: ["sea"] }), t, {});
  const city = spotFit(spot({ id: "s2", genres: ["city"], category: "商業施設" }), t, {});
  const wish = (f) => f.axes.find((a) => a.key === "wish").score;
  assert.ok(wish(sea) > wish(city),
    `希望に合わない場所のほうが高くなっています（${wish(sea)} vs ${wish(city)}）`);
});

test("軸ごとの点と、全体の点を返す", () => {
  const f = spotFit(spot(), TRIP(), {});
  assert.ok(f.total >= 0 && f.total <= 100);
  assert.ok(f.axes.length >= 3);
  for (const a of f.axes) {
    assert.ok(a.score >= 0 && a.score <= 100, `${a.key} が範囲外: ${a.score}`);
    assert.ok(a.label, `${a.key} に見出しがありません`);
    assert.ok(Number.isInteger(a.stars) && a.stars >= 0 && a.stars <= 5);
  }
});

test("軸の並びは決まっている（説明が毎回入れ替わらない）", () => {
  const a = spotFit(spot(), TRIP(), {}).axes.map((x) => x.key);
  const b = spotFit(spot({ id: "s9" }), TRIP(), {}).axes.map((x) => x.key);
  assert.deepEqual(a, b);
  for (const key of a) assert.ok(AXES[key], `${key} の定義がありません`);
});

test("近い場所ほど、移動効率が高い", () => {
  const t = TRIP();
  const near = spotFit(spot(), t, { fromKm: 3 });
  const far = spotFit(spot({ id: "s2" }), t, { fromKm: 90 });
  const eff = (f) => f.axes.find((a) => a.key === "move").score;
  assert.ok(eff(near) > eff(far));
});

test("空いている時間に回る場所ほど、混雑回避が高い", () => {
  const t = TRIP();
  const morning = spotFit(spot({ fame_tier: "major" }), t,
                          { at: d("2026-09-12T09:00") });
  const noon = spotFit(spot({ fame_tier: "major" }), t,
                       { at: d("2026-09-13T13:00") });   // 日曜の昼
  const calm = (f) => f.axes.find((a) => a.key === "crowd").score;
  assert.ok(calm(morning) > calm(noon));
});

test("説明の一文を返す（数字だけで終わらせない）", () => {
  const f = spotFit(spot(), TRIP(), {});
  assert.ok(f.summary.length > 0);
  assert.match(f.summary, /海|希望/);
});

test("希望を出していない旅では、希望の軸を出さない", () => {
  const f = spotFit(spot(), TRIP({ interests: [] }), {});
  assert.ok(!f.axes.some((a) => a.key === "wish"),
    "希望が無いのに「希望との一致」を出しています");
});

test("壊れた入力でも落ちない", () => {
  for (const bad of [null, undefined, {}]) {
    const f = spotFit(bad, TRIP(), {});
    assert.ok(Number.isFinite(f.total));
  }
});

// --- 旅全体の適合 -----------------------------------------------------------

const itin = (spots, over = {}) => ({
  days: [{ date: d("2026-09-12T09:00"), items: spots.map((s, i) => ({
    id: `i${i}`, kind: "spot", spotId: s.id, place: s,
    start: d("2026-09-12T10:00"), end: d("2026-09-12T11:30"),
  })) }],
  spotCount: spots.length,
  score: { total: 70, fatigue: 30, parts: [] },
  ...over,
});

test("旅全体の適合度を、軸つきで返す", () => {
  const f = tripFit(itin([spot(), spot({ id: "s2", genres: ["history"],
                                         category: "寺院" })]), TRIP());
  assert.ok(f.total >= 0 && f.total <= 100);
  assert.ok(f.axes.length >= 3);
  assert.ok(f.summary.length > 0);
});

test("希望したジャンルが揃うほど、旅全体の適合度が上がる", () => {
  const t = TRIP();          // 海・歴史
  const both = tripFit(itin([spot(),
    spot({ id: "s2", genres: ["history"], category: "寺院" })]), t);
  const one = tripFit(itin([spot(), spot({ id: "s2", genres: ["sea"] })]), t);
  assert.ok(both.total > one.total,
    `片方しか満たしていないほうが高くなっています（${both.total} vs ${one.total}）`);
});

test("立ち寄りが無ければ 0 になる（それらしい点を出さない）", () => {
  const f = tripFit(itin([]), TRIP());
  assert.equal(f.total, 0);
});

test("1か所目は「直前の場所から」と書かない（出発地からの距離だから）", () => {
  // 東京発の四国旅で、1か所目に「直前の場所から669km」と出ていました。
  // 直前の場所などありません。行きの移動です。
  const first = spotFit(spot(), TRIP(), {});          // fromKm を渡さない
  const move = first.axes.find((a) => a.key === "move");
  assert.ok(!/直前/.test(move.note), move.note);
  assert.match(move.note, /出発地/);

  const second = spotFit(spot(), TRIP(), { fromKm: 4 });
  assert.match(second.axes.find((a) => a.key === "move").note, /直前/);
});

test("行きの移動を、移動効率が悪いとして減点しすぎない", () => {
  // 遠くへ行く旅は、行きが長いのは当たり前です。そこを0点にすると、
  // 遠出の旅程がすべて「移動が悪い」と評価されます。
  const first = spotFit(spot(), TRIP(), {});
  const move = first.axes.find((a) => a.key === "move");
  assert.ok(move.score >= 40, `行きの移動が ${move.score} 点しかありません`);
});

// --- スポットの質の軸 -------------------------------------------------------
// 「知名度」だけでは、その場所がどういう場所かが分かりません。
// 歴史・自然・写真・食・体験の5軸で見ると、好みとの合いかたが出ます。

test("分類から、その場所の性格を5軸で出す", () => {
  const q = qualityOf({ category: "城", fame_tier: "major" });
  const keys = q.map((x) => x.key);
  assert.deepEqual(keys, ["history", "nature", "photo", "food", "activity"]);
  for (const a of q) {
    assert.ok(a.stars >= 0 && a.stars <= 5, `${a.key}: ${a.stars}`);
    assert.ok(a.label);
  }
});

test("城は歴史が高く、食は低い", () => {
  const q = Object.fromEntries(qualityOf({ category: "城" })
    .map((x) => [x.key, x.stars]));
  assert.ok(q.history >= 4, `歴史 ${q.history}`);
  assert.ok(q.food <= 2, `食 ${q.food}`);
});

test("渓谷は自然と写真が高い", () => {
  const q = Object.fromEntries(qualityOf({ category: "渓谷" })
    .map((x) => [x.key, x.stars]));
  assert.ok(q.nature >= 4);
  assert.ok(q.photo >= 4);
});

test("市場は食が高く、歴史は低い", () => {
  const q = Object.fromEntries(qualityOf({ category: "市場" })
    .map((x) => [x.key, x.stars]));
  assert.ok(q.food >= 4);
  assert.ok(q.history <= 2);
});

test("知らない分類でも、5軸そろって返る（真ん中に置く）", () => {
  const q = qualityOf({ category: "謎の分類" });
  assert.equal(q.length, 5);
  assert.ok(q.every((a) => a.stars >= 1 && a.stars <= 4));
});

test("空でも壊れない", () => {
  for (const bad of [null, undefined, {}]) {
    assert.equal(qualityOf(bad).length, 5);
  }
});
