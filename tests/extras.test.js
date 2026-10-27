// 今回足した計算まわり（費用・日の入り）のテスト。
//
// どちらも「数字を出す」機能なので、根拠のない値を出していないかを
// 実際に検証できる値と突き合わせます。

import assert from "node:assert/strict";
import test from "node:test";

import { costBreakdown, fareFor } from "../packages/core/src/cost.js";
import { isScenic, sunNotes, sunTimes } from "../packages/core/src/sun.js";
import { nearestPlaceInfo } from "../packages/core/src/places.js";

// --- 日の出・日の入り -------------------------------------------------------
// 国立天文台の公表値（東京）と比べます。数分の差までを合格とします。

const TOKYO = [35.6812, 139.7671];
const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

test("夏至の東京の日の出・日の入りが、公表値とほぼ一致する", () => {
  const r = sunTimes(new Date("2026-06-21T12:00"), ...TOKYO);
  assert.ok(near(minutesOf(r.sunrise), 4 * 60 + 25), `日の出 ${hhmm(r.sunrise)}`);
  assert.ok(near(minutesOf(r.sunset), 19 * 60 + 0), `日の入り ${hhmm(r.sunset)}`);
});

test("冬至の東京の日の出・日の入りが、公表値とほぼ一致する", () => {
  const r = sunTimes(new Date("2026-12-22T12:00"), ...TOKYO);
  assert.ok(near(minutesOf(r.sunrise), 6 * 60 + 47), `日の出 ${hhmm(r.sunrise)}`);
  assert.ok(near(minutesOf(r.sunset), 16 * 60 + 32), `日の入り ${hhmm(r.sunset)}`);
});

test("西へ行くほど日の入りは遅い", () => {
  const tokyo = sunTimes(new Date("2026-09-05T12:00"), ...TOKYO).sunset;
  const naha = sunTimes(new Date("2026-09-05T12:00"), 26.2124, 127.6809).sunset;
  assert.ok(naha > tokyo, `東京 ${hhmm(tokyo)} / 那覇 ${hhmm(naha)}`);
});

test("眺めが目当てになる場所を見分ける", () => {
  assert.ok(isScenic({ category: "展望台" }));
  assert.ok(isScenic({ category: "海岸" }));
  assert.ok(isScenic({ category: "寺院", name: "夕日ヶ浦" }));
  assert.ok(!isScenic({ category: "美術館", name: "県立美術館", genres: [] }));
});

test("日没後に着く絶景スポットには、暗いと書く", () => {
  const itin = { days: [{ key: 1, items: [{
    kind: "spot", id: "x", title: "展望台",
    start: new Date("2026-12-22T17:30"), end: new Date("2026-12-22T18:10"),
    place: { category: "展望台", lat: 35.68, lng: 139.76 },
  }] }] };
  const notes = sunNotes(itin);
  assert.equal(notes[0].kind, "dark");
  assert.match(notes[0].text, /暗くなっています/);
});

test("日没に重なるときは、夕景の時間だと書く", () => {
  const itin = { days: [{ key: 1, items: [{
    kind: "spot", id: "x", title: "岬",
    start: new Date("2026-12-22T16:20"), end: new Date("2026-12-22T16:50"),
    place: { category: "海岸", lat: 35.68, lng: 139.76 },
  }] }] };
  const notes = sunNotes(itin);
  assert.equal(notes[0].kind, "golden");
});

// --- 費用 -------------------------------------------------------------------

test("運賃の見積もりは、距離が伸びるほど1kmあたりが安くなる", () => {
  const perKm = (km) => fareFor(km) / km;
  assert.ok(perKm(5) > perKm(30));
  assert.ok(perKm(30) > perKm(300));
});

test("徒歩圏は運賃0", () => {
  assert.equal(fareFor(0.8), 0);
  assert.equal(fareFor(20, { mode: "WALK" }), 0);
});

test("東京〜熱海のあたりが、現実の運賃とかけ離れない", () => {
  // 実際の在来線運賃は片道 約1,980円（104km）
  const f = fareFor(104);
  assert.ok(f > 1200 && f < 3200, `見積もり ¥${f}`);
});

test("費用は項目に分かれ、合計が一致する", () => {
  const itin = { days: [{ items: [
    { kind: "transit", km: 100, walk: false },
    { kind: "spot", costYen: 500 },
    { kind: "meal", costYen: 1500 },
    { kind: "lodging", costYen: 12000 },
  ] }] };
  const c = costBreakdown(itin);
  assert.deepEqual(c.rows.map((r) => r.key),
    ["transit", "meals", "admission", "lodging"]);
  assert.equal(c.total, c.rows.reduce((a, r) => a + r.yen, 0));
  assert.equal(c.estimated, true);
});

test("人数を増やすと費用も増える", () => {
  const itin = { days: [{ items: [
    { kind: "spot", costYen: 500 }, { kind: "meal", costYen: 1500 },
  ] }] };
  assert.equal(costBreakdown(itin, { people: 2 }).total,
               costBreakdown(itin).total * 2);
});

// --- いちばん近い駅と、そこまでの距離 -----------------------------------
// 距離を返さないと、100km 先の駅を「いちばん近い駅」として無言で
// 出発地に入れてしまいます。現在地を取った意味がなくなります。

test("現在地のすぐ近くなら、距離も小さい", () => {
  // 新宿のあたり
  const got = nearestPlaceInfo(35.690, 139.700);
  assert.ok(got, "近くの駅が見つかりません");
  assert.ok(got.km <= 5, `近いはずが ${got.km}km でした`);
});

test("遠いときは、距離でそれが分かる", () => {
  // 日本海の真ん中あたり（能登の沖）
  const got = nearestPlaceInfo(38.5, 136.5);
  if (got) assert.ok(got.km > 30, `遠いはずが ${got.km}km でした`);
});

test("収録の駅から遠すぎるところでは、何も返さない", () => {
  // 太平洋のまんなか。ここで「いちばんマシな駅」を返すと、
  // 現在地とまったく関係のない旅程が組まれます。
  assert.equal(nearestPlaceInfo(20, 170), null);
  assert.equal(nearestPlaceInfo(NaN, 139), null);
});

// --- タクシーの運賃 -------------------------------------------------------
// 初乗りと、そのあとの加算でできています。地域で幅がありますが、
// 「だいたいいくらか」を知るには足ります。

test("タクシーは初乗りから始まり、距離で増える", () => {
  assert.equal(fareFor(0.8, { mode: "TAXI" }), 500, "初乗りの内側");
  const short = fareFor(2, { mode: "TAXI" });
  const long = fareFor(6, { mode: "TAXI" });
  assert.ok(short > 500, `2kmで ¥${short}`);
  assert.ok(long > short, `2km ¥${short} / 6km ¥${long}`);
});

test("タクシーは、同じ距離の電車・バスより高い", () => {
  for (const km of [2, 5, 12]) {
    assert.ok(fareFor(km, { mode: "TAXI" }) > fareFor(km),
      `${km}km: タクシー ¥${fareFor(km, { mode: "TAXI" })} / `
      + `電車 ¥${fareFor(km)}`);
  }
});

test("タクシーの区間は、タクシーの運賃で数える", () => {
  const km = 6;
  const itin = { days: [{ items: [
    { kind: "transit", km, taxi: true, from: {}, to: {} },
  ] }] };
  const c = costBreakdown(itin);
  const row = c.rows.find((r) => r.key === "transit");
  assert.equal(row.yen, fareFor(km, { mode: "TAXI" }));
  // 実額ではないので、「距離からの概算」と言い続けること。
  assert.match(row.note, /概算/);
});
