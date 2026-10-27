// 混雑を避ける仕組みのテスト。
//
// 実測ではなく推定なので、当てにいくのではなく
// **「順序を変えれば混雑が下がる」という関係が壊れていないか** を見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { crowdLevel, itineraryCrowd, labelOf, orderByRoute, quietWindow,
         spreadCrowds }
  from "../packages/core/src/crowd.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const famous = { id: "a", name: "有名寺", category: "寺院", fame_tier: "major",
                 open: 9, close: 17 };
const hidden = { id: "b", name: "静かな寺", category: "寺院", fame_tier: "hidden",
                 open: 9, close: 17 };
const valley = { id: "c", name: "渓谷", category: "渓谷", fame_tier: "known",
                 open: 0, close: 24 };

const at = (h, day = "2026-09-08") => new Date(`${day}T${String(h).padStart(2, "0")}:00`);

test("同じ場所でも、朝いちは昼より空いている", () => {
  const morning = crowdLevel(famous, at(9)).score;
  const noon = crowdLevel(famous, at(13)).score;
  assert.ok(morning < noon, `朝${morning} / 昼${noon}`);
});

test("土日は平日より混む", () => {
  const tue = crowdLevel(famous, new Date("2026-09-08T13:00")).score;  // 火曜
  const sat = crowdLevel(famous, new Date("2026-09-12T13:00")).score;  // 土曜
  assert.ok(sat > tue, `火${tue} / 土${sat}`);
});

test("知る人ぞ知る場所は、有名な場所より空いている", () => {
  assert.ok(crowdLevel(hidden, at(13)).score < crowdLevel(famous, at(13)).score);
});

test("広い自然は、狭い施設より混雑しにくい", () => {
  assert.ok(crowdLevel(valley, at(13)).score < crowdLevel(famous, at(13)).score);
});

test("桜や紅葉の時期は上乗せし、理由も言う", () => {
  const normal = crowdLevel(famous, new Date("2026-09-08T13:00"));
  const sakura = crowdLevel(famous, new Date("2026-04-04T13:00"));
  assert.ok(sakura.score > normal.score);
  assert.ok(sakura.reasons.includes("桜の時期"));
});

test("目安の言葉は、点数と対応している", () => {
  assert.equal(labelOf(10), "ゆったり");
  assert.equal(labelOf(45), "ふつう");
  assert.equal(labelOf(65), "混雑");
  assert.equal(labelOf(90), "非常に混雑");
});

test("空いている時間帯は、開いてすぐを指す", () => {
  const w = quietWindow({ open: 9, close: 17 });
  assert.equal(w.from, 9);
  assert.ok(w.to <= 10.5);
});

test("並べ替えると、混みやすい場所が先に来る", () => {
  const order = spreadCrowds([hidden, valley, famous]);
  assert.equal(order[0].id, "a", `並び: ${order.map((s) => s.id)}`);
});

test("並べ替えは、日をまたいで混ぜない", () => {
  const floors = new Map([["a", 1], ["b", 0], ["c", 0]]);
  const order = spreadCrowds([famous, hidden, valley], { dayFloorById: floors });
  assert.equal(order.at(-1).id, "a", "2日目の予定が1日目に混ざっています");
});

test("混雑回避を入れると、旅程の混雑の見込みが下がる", async () => {
  const trip = (avoid) => makeTrip({
    origin: findPlace("東京駅"), budgetYen: 999999,
    note: "鎌倉で歴史ある街を歩きたい",
    departAt: new Date("2026-09-12T09:00"),   // 土曜
    arriveBy: new Date("2026-09-12T19:00"),
    avoidCrowds: avoid,
  });
  const on = await planTrip({ kb: await loadKnowledgeBase(), trip: trip(true) });
  const off = await planTrip({ kb: await loadKnowledgeBase(), trip: trip(false) });
  // 比べるのは、**両方の旅程に入った場所だけ**です。
  //
  // 並べ替えると、時間に入りきる場所が変わります。片方にだけ
  // 静かな漁港が入り、もう片方には長谷寺が入る、ということが起きます。
  // 全体の平均で比べると、混雑回避の効き目ではなく「何が入ったか」を
  // 比べることになります（鶴岡八幡宮の知名度を直したら、それで逆転しました）。
  const common = (a, b) => {
    const names = new Set(itineraryCrowd(b).perSpot.map((x) => x.name));
    return itineraryCrowd(a).perSpot.filter((x) => names.has(x.name));
  };
  const avg = (xs) => xs.reduce((a, x) => a + x.score, 0) / xs.length;
  const both = common(on, off);
  assert.ok(both.length >= 3, `共通の場所が少なすぎます（${both.length}か所）`);
  assert.ok(avg(both) <= avg(common(off, on)),
    `回避ON ${avg(both)} / OFF ${avg(common(off, on))}`);
  assert.ok(on.crowd, "混雑の評価が旅程に付いていません");
  assert.equal(off.crowd, null);
});

test("終日出入りできる場所に「開館直後」とは言わない", () => {
  const itin = { days: [{ items: [{
    kind: "spot", id: "x", title: "海岸", start: new Date("2026-09-12T13:00"),
    place: { name: "海岸", category: "海岸", fame_tier: "major",
             open: 0, close: 24 },
  }] }] };
  const r = itineraryCrowd(itin);
  assert.ok(!r.notes.some((n) => /開館直後/.test(n)), r.notes.join(" "));
});

// --- 道順を壊さない -------------------------------------------------------
// 混雑だけで並べていたときは、上高地の河童橋 → 市街の松本城 → また
// 上高地の大正池、という旅程が出ていました。松本城がいちばん混むので、
// 朝いちに引き上げられたためです。順番を変えれば移動距離は変わります。

const 河童橋 = { id: "kappa", name: "河童橋", category: "観光名所",
                 fame_tier: "known", lat: 36.2456, lng: 137.6353,
                 open: 0, close: 24 };
const 大正池 = { id: "taisho", name: "大正池", category: "湖",
                 fame_tier: "known", lat: 36.2226, lng: 137.6249,
                 open: 0, close: 24 };
const 松本城 = { id: "castle", name: "松本城", category: "城",
                 fame_tier: "major", lat: 36.2384, lng: 137.9690,
                 open: 8.5, close: 17 };

test("遠い場所が、混雑だけを理由に間へ割り込まない", () => {
  // 上高地の2つは 3km、松本城はそこから 30km。
  // 松本城がいちばん混みますが、あいだに挟むと往復60kmになります。
  const order = orderByRoute([河童橋, 松本城, 大正池],
    { lat: 36.2306, lng: 137.9653 });          // 松本駅から出発
  const ids = order.map((s) => s.id).join(" → ");
  assert.notEqual(ids, "kappa → castle → taisho",
    `上高地の間に松本城が挟まっています: ${ids}`);
  // 上高地の2つが隣り合っていること
  const i = order.findIndex((s) => s.id === "kappa");
  const j = order.findIndex((s) => s.id === "taisho");
  assert.equal(Math.abs(i - j), 1, `上高地の2つが離れています: ${ids}`);
});

test("出発地から近い順に始まる", () => {
  const order = orderByRoute([大正池, 松本城, 河童橋],
    { lat: 36.2306, lng: 137.9653 });          // 松本駅
  assert.equal(order[0].id, "castle",
    `松本駅から始めたのに ${order[0].name} が先です`);
});

test("近い場所どうしなら、混雑の順に整う", () => {
  // 距離の差が小さければ、混む場所を先に回せます。
  const near = (id, lat, tier) => ({ id, name: id, category: "寺院",
    fame_tier: tier, lat, lng: 139.0, open: 9, close: 17 });
  const order = orderByRoute(
    [near("q1", 35.000, "hidden"), near("q2", 35.002, "major"),
     near("q3", 35.004, "known")],
    { lat: 35.001, lng: 139.0 });
  assert.equal(order[0].id, "q2", `並び: ${order.map((s) => s.id)}`);
});

test("2つ以下なら、そのまま返す", () => {
  assert.deepEqual(orderByRoute([河童橋]).map((s) => s.id), ["kappa"]);
  assert.deepEqual(orderByRoute([]).length, 0);
});

// --- 早く閉まる場所・必ず行く場所を先に回す --------------------------------
// 道順だけで並べていたときに、「必ず行く」に指定した高徳院（17:30 閉門）が
// 5番目に回され、着いたときには閉まっている旅程が出ていました。
// 指定したのに入らない旅程は、指定しなかったのと同じです。

const 早く閉まる = { id: "early", name: "17時に閉まる館", category: "博物館",
                     fame_tier: "known", lat: 35.002, lng: 139.0,
                     open: 9, close: 17 };
const いつでも = { id: "any", name: "いつでも入れる浜", category: "海岸",
                   fame_tier: "known", lat: 35.001, lng: 139.0,
                   open: 0, close: 24 };
const いつでも2 = { id: "any2", name: "いつでも入れる通り", category: "商店街",
                    fame_tier: "known", lat: 35.003, lng: 139.0,
                    open: 0, close: 24 };

test("早く閉まる場所を、あとに回さない", () => {
  const order = orderByRoute([いつでも, いつでも2, 早く閉まる],
    { lat: 35.0, lng: 139.0 });
  assert.equal(order[0].id, "early",
    `並び: ${order.map((s) => s.id)}（着く前に閉まります）`);
});

test("「必ず行く」場所を、あとに回さない", () => {
  const order = orderByRoute([いつでも, いつでも2, 早く閉まる],
    { lat: 35.0, lng: 139.0 }, null, { pinnedIds: ["any2"] });
  assert.equal(order[0].id, "any2",
    `並び: ${order.map((s) => s.id)}（指定した場所が後ろにあります）`);
});

test("遠ければ、必ず行く場所でも順番は動かさない", () => {
  // 「必ず行く」でも、来た道を30km戻ってまで先に回すことはしません。
  // 道順は道順として守り、入るかどうかは verify が見ます。
  const far = { id: "far", name: "遠い館", category: "博物館",
                fame_tier: "known", lat: 35.3, lng: 139.4, open: 9, close: 17 };
  const order = orderByRoute([いつでも, いつでも2, far],
    { lat: 35.0, lng: 139.0 }, null, { pinnedIds: ["far"] });
  assert.notEqual(order[0].id, "far",
    `30km 先の場所が先頭に来ています: ${order.map((s) => s.id)}`);
});
