// 泊まりの旅が壊れていた件の回帰テスト。
//
// 画面で「9泊10日 / 4スポット / 所要225時間45分 / 余裕12951分」という結果が
// 出ていました。10日間を1本の連続した時間として扱っていたため、夜通し
// 観光する計算になり、余裕も10日先の期限との差で出ていたためです。
//
// ここで固定するのは次の3点です。
//   ・訪問が日をまたいで分かれること
//   ・中日の訪問が行動時間（9:00〜18:30）の外に出ないこと
//   ・「余裕」が現実的な値であること

import assert from "node:assert/strict";
import test from "node:test";

import { REJECT } from "../packages/core/src/feasibility.js";
import { trimToFit, verifyOrder } from "../packages/core/src/verify.js";
import { allocateDays, capacityDays, orderRegions, planStays, suggestRegionCount }
  from "../packages/core/src/stays.js";

const d = (s) => new Date(s);
const BASE = { name: "高松駅", lat: 34.3506, lng: 134.0466 };

/** 徒歩圏に並んだ寺（9:00-17:00 / 60分）。日数を変えて振る舞いを見ます。 */
function spots(n, from = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `s${from + i}`, name: `寺${from + i}`, category: "寺院",
      lat: 34.3506 + (from + i) * 0.004, lng: 134.0466,
      dwell: 60, open: 9, close: 17, fee: 0,
    });
  }
  return out;
}

const ctx3 = {
  start: BASE, startAt: d("2026-08-31T10:00"),
  end: BASE, endBy: d("2026-09-03T19:00"),
  nights: 3, baseByDay: [BASE, BASE, BASE, BASE],
};

test("泊まりの旅では、訪問が日をまたいで分かれる", () => {
  const r = verifyOrder(spots(12), ctx3);
  const days = new Set(r.visits.map((v) => v.day));
  assert.equal(r.visits.length, 12);
  assert.ok(days.size >= 3, `1日に詰め込まれています: ${[...days]}`);
  assert.equal(r.issues.length, 0);
});

test("中日の訪問は、行動時間（9:00〜18:30）の外に出ない", () => {
  const r = verifyOrder(spots(12), ctx3);
  for (const v of r.visits) {
    if (v.day >= 3) continue;             // 最終日は帰りの期限が支配する
    const h = v.arrive.getHours() + v.arrive.getMinutes() / 60;
    const e = v.end.getHours() + v.end.getMinutes() / 60;
    assert.ok(h >= 9, `${v.spot.name} が ${v.arrive} に始まっています`);
    assert.ok(e <= 18.5, `${v.spot.name} が ${v.end} に終わっています`);
  }
});

test("「余裕」が10日ぶんの分数になったりしない", () => {
  const r = verifyOrder(spots(4), {
    start: BASE, startAt: d("2026-08-31T10:00"),
    end: BASE, endBy: d("2026-09-09T19:00"),
    nights: 9, baseByDay: Array(10).fill(BASE),
  });
  assert.ok(r.slackMin < 600, `余裕が現実的ではありません: ${r.slackMin}分`);
});

test("日数に対して立ち寄りが少なすぎると underfilled になる", () => {
  const r = verifyOrder(spots(4), {
    start: BASE, startAt: d("2026-08-31T10:00"),
    end: BASE, endBy: d("2026-09-09T19:00"),
    nights: 9, baseByDay: Array(10).fill(BASE),
  });
  assert.ok(r.underfilled, "9泊で4スポットが underfilled になっていません");
  assert.equal(r.underfilled.totalDays, 10);
  assert.ok(r.underfilled.days >= 7);
});

test("underfilled は削って直る問題ではないので、trimToFit は何も削らない", () => {
  const { spots: kept, dropped } = trimToFit(spots(4), {
    start: BASE, startAt: d("2026-08-31T10:00"),
    end: BASE, endBy: d("2026-09-09T19:00"),
    nights: 9, baseByDay: Array(10).fill(BASE),
  });
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 4);
});

test("日帰りの振る舞いは変わらない（1日に収まり、underfilled にもならない）", () => {
  const r = verifyOrder(spots(3), {
    start: BASE, startAt: d("2026-08-31T10:00"),
    end: BASE, endBy: d("2026-08-31T19:00"), nights: 0,
  });
  assert.equal(r.underfilled, null);
  assert.ok(r.visits.every((v) => v.day === 0));
  assert.equal(r.daysUsed, 1);
});

test("夕食は泊まる日にだけ入り、最終日の帰り際には入らない", () => {
  const r = verifyOrder(spots(12), ctx3);
  const dinners = r.meals.filter((m) => m.kind === "dinner");
  assert.ok(dinners.length >= 1);
  assert.ok(dinners.every((m) => m.day < 3), "最終日に夕食が入っています");
});

test("食事は日ごとに数え直す（2日目にも昼食が入る）", () => {
  const r = verifyOrder(spots(12), ctx3);
  const lunchDays = new Set(
    r.meals.filter((m) => m.kind === "lunch").map((m) => m.day));
  assert.ok(lunchDays.size >= 2, `昼食が入った日: ${[...lunchDays]}`);
});

test("拠点が変わる日は、朝の移動時間を使ってから回りはじめる", () => {
  const FAR = { name: "松山市駅", lat: 33.8391, lng: 132.7659 };
  const r = verifyOrder(spots(8), {
    start: BASE, startAt: d("2026-08-31T10:00"),
    end: FAR, endBy: d("2026-09-01T19:00"),
    nights: 1, baseByDay: [BASE, FAR],
  });
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].day, 1);
  assert.ok(r.moves[0].minutes > 30, "拠点移動が0分になっています");
});

// --- 滞在計画 ---------------------------------------------------------------

test("日数が増えると、拠点を移す前提になる", () => {
  assert.equal(suggestRegionCount(1), 1);
  assert.equal(suggestRegionCount(2), 1);
  assert.equal(suggestRegionCount(4), 2);
  assert.equal(suggestRegionCount(10), 5);
  // 長い旅は、長いなりに拠点が増えます。ただし2日にひとつまで。
  assert.equal(suggestRegionCount(30), 10);  // 上限
  assert.equal(suggestRegionCount(10, 4), 4);   // 呼び出し側の上限は効く
});

test("収録の少ないエリアに長く留めない", () => {
  assert.equal(capacityDays(4, 4), 2);
  assert.equal(capacityDays(12, 4), 4);
  const alloc = allocateDays([{}, {}], 6, [4, 20], 4);
  assert.equal(alloc.reduce((a, b) => a + b, 0), 6);
  assert.ok(alloc[1] > alloc[0], `収録の多い側に日数が寄っていません: ${alloc}`);
});

test("回る順は、出発地から終点へ向かって遠回りにならないように並べ替える", () => {
  const mk = (id, lat, lng) => ({ id, name: id, stationLat: lat, stationLng: lng });
  const tokyo = { lat: 35.681, lng: 139.767 };
  const hakata = { lat: 33.590, lng: 130.421 };
  // わざと 遠→近→中 の順で渡す（片道なので最短の並びは一通りに決まる）
  const ordered = orderRegions(
    [mk("far", 34.35, 134.04), mk("near", 35.32, 139.55), mk("mid", 34.98, 135.75)],
    { origin: tokyo, end: hakata });
  assert.deepEqual(ordered.map((r) => r.id), ["near", "mid", "far"]);
});

test("planStays は全日に拠点を割り当てる", () => {
  const region = (id, lat, lng, n) => ({
    region: { id, name: id, stationLat: lat, stationLng: lng, station: id },
    spots: Array(n).fill({ spot: {} }),
  });
  const { stays, baseByDay } = planStays(
    [region("a", 34.35, 134.04, 5), region("b", 33.84, 132.77, 5)],
    { days: 5, origin: { lat: 35.68, lng: 139.77 }, end: { lat: 35.68, lng: 139.77 } });
  assert.equal(baseByDay.length, 5);
  assert.equal(stays.reduce((a, s) => a + s.days, 0), 5);
  assert.equal(stays[0].dayFrom, 0);
  assert.equal(stays.at(-1).dayTo, 4);
});

test("閉館は理由つきで返り、日をまたげるときは翌日に回る", () => {
  // 15:00 到着で 16:00 閉館・120分見学 → その日は無理。翌日の朝なら入る。
  const late = {
    id: "late", name: "遅い館", category: "美術館",
    lat: 34.3506, lng: 134.0466, dwell: 120, open: 9, close: 16, fee: 0,
  };
  const one = verifyOrder([late], {
    start: BASE, startAt: d("2026-08-31T15:00"),
    end: BASE, endBy: d("2026-08-31T19:00"), nights: 0,
  });
  assert.equal(one.visits.length, 0);
  assert.equal(one.issues[0].reason, REJECT.TOO_LATE);

  const two = verifyOrder([...spots(3), late], {
    start: BASE, startAt: d("2026-08-31T10:00"),
    end: BASE, endBy: d("2026-09-01T19:00"),
    nights: 1, baseByDay: [BASE, BASE],
  });
  const visited = two.visits.find((v) => v.spot.id === "late");
  assert.ok(visited, "翌日に回せていません");
});
