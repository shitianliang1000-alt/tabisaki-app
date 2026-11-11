// OpenStreetMap の opening_hours を、旅程で使う形に読み替える（osm_hours.js）。
//
// いちばん怖いのは、**読めていないのに読めたことにする**ことです。「第3水曜は
// 休み」を落とせば、閉まっている日に行く旅程ができます。読み切れた書きかた
// だけが通り、それ以外はまるごと使わない（null）ことを、実際に OSM に
// 入っている書きかたで固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { applyOsmHours, parseOpeningHours } from "../packages/core/src/osm_hours.js";
import { hoursFor } from "../packages/core/src/hours.js";
import { profileOf } from "../packages/core/src/feasibility.js";

const d = (s) => new Date(s);

test("毎日同じ時間", () => {
  assert.deepEqual(parseOpeningHours("09:00-17:00"), { open: 9, close: 17 });
  assert.deepEqual(parseOpeningHours("9:30-16:30"), { open: 9.5, close: 16.5 });
  assert.deepEqual(parseOpeningHours("Mo-Su 08:20-17:10"),
    { open: 8 + 20 / 60, close: 17 + 10 / 60 });
  assert.deepEqual(parseOpeningHours("24/7"), { open: 0, close: 24 });
});

test("定休日（書かれていない曜日も休み）", () => {
  assert.deepEqual(parseOpeningHours("Tu-Su 09:30-17:00; Mo off"),
    { open: 9.5, close: 17, closedDays: [1] });
  // 月〜金だけ書いてあれば、土日は休みです。
  assert.deepEqual(parseOpeningHours("Mo-Fr 09:00-17:00"),
    { open: 9, close: 17, closedDays: [0, 6] });
  // あとの決まりが、前の決まりに勝ちます。
  assert.deepEqual(parseOpeningHours("10:00-18:00; We off"),
    { open: 10, close: 18, closedDays: [3] });
  // 週をまたぐ範囲。
  assert.deepEqual(parseOpeningHours("Sa-Mo 10:00-16:00"),
    { open: 10, close: 16, closedDays: [2, 3, 4, 5] });
});

test("曜日で時間が違う", () => {
  const h = parseOpeningHours("Mo-Fr 09:00-17:00; Sa,Su 10:00-18:00");
  assert.equal(h.open, 9);
  assert.equal(h.close, 17);
  assert.deepEqual(h.byDay, { 0: { open: 10, close: 18 }, 6: { open: 10, close: 18 } });
  assert.equal(h.closedDays, undefined);
});

test("季節で時間が違う・年末年始の休み", () => {
  const h = parseOpeningHours("Apr-Oct 08:30-17:00; Nov-Mar 08:30-16:30; Dec 29-Jan 03 off");
  assert.equal(h.open, 8.5);
  assert.deepEqual(h.seasons, [
    { from: "04-01", to: "10-31", open: 8.5, close: 17 },
    { from: "11-01", to: "03-31", open: 8.5, close: 16.5 },
  ]);
  assert.deepEqual(h.closedDates, ["12-29..01-03"]);
  assert.equal(h.closedSeasons, undefined);

  // 実際にあった書きかた（高松市鬼ヶ島おにの館）。
  const oni = parseOpeningHours("Mo-Su,PH 08:20-17:10; Aug 01-Aug 20 08:20-18:10");
  assert.deepEqual(oni.seasons, [
    { from: "08-01", to: "08-20", open: 8 + 20 / 60, close: 18 + 10 / 60 }]);
});

test("夏だけ開く場所は、書かれていない月が休みになる", () => {
  const h = parseOpeningHours("Apr-Nov 09:00-17:00");
  assert.deepEqual(h.closedSeasons, ["01-01..03-31", "12-01..12-31"]);
  const spot = { name: "山の資料館", category: "博物館", hours: h };
  assert.equal(hoursFor(spot, d("2026-01-15T10:00")).closed, true);
  assert.equal(hoursFor(spot, d("2026-06-15T10:00")).closed, false);
});

test("季節の決まりに曜日が付いている書きかた", () => {
  // 毎日（Mo-Su）と書いてあるだけなら、曜日なしと同じです。
  assert.deepEqual(parseOpeningHours("Mar-Nov Mo-Su 09:00-17:00; Dec-Feb Mo-Su 09:00-16:30"), {
    open: 9, close: 17,
    seasons: [{ from: "03-01", to: "11-30", open: 9, close: 17 },
              { from: "12-01", to: "02-29", open: 9, close: 16.5 }] });
  // 季節の時間 ＋ 定休日。
  const a = parseOpeningHours("Apr-Sep 09:30-17:30; Oct-Mar 09:30-16:30; Mo off");
  assert.deepEqual(a.closedDays, [1]);
  assert.equal(a.seasons.length, 2);
  assert.equal(a.closedSeasons, undefined);
  // 季節ごとに「火〜日」と書いてある（月曜が休み）。コロンつき。
  const b = parseOpeningHours("Apr-Oct:Tu-Su 09:00-17:00; Nov-Mar:Tu-Su 09:00-16:00; Mo off");
  assert.deepEqual(b.closedDays, [1]);
  const spot = { name: "館", category: "博物館", hours: b };
  assert.equal(hoursFor(spot, d("2026-11-09T12:00")).closed, true);          // 月曜
  assert.equal(hoursFor(spot, d("2026-11-10T12:00")).closeHour, 16);         // 11月の火曜
  assert.equal(hoursFor(spot, d("2026-07-07T12:00")).closeHour, 17);         // 7月の火曜
  // 日付で区切った季節。1年をぜんぶ覆っていれば、休みの期間は出ません。
  const c = parseOpeningHours("Mar 20-Sep 30 Mo-Su 07:30-18:00; Oct 01 - Mar 19 Mo-Su 08:00-17:00");
  assert.equal(c.closedSeasons, undefined);
  assert.equal(c.seasons[1].from, "10-01");
  // 覆っていない日は休みです。
  const e = parseOpeningHours("Apr 29-Nov 03 09:00-16:00");
  assert.deepEqual(e.closedSeasons, ["01-01..04-28", "11-04..12-31"]);
  // 季節ごとに曜日が違う書きかたは、表せないので使いません。
  assert.equal(parseOpeningHours("Mar-Sep Mo-Fr 09:30-17:00; Oct-Feb 09:30-16:30"), null);
});

test("祝日の決まりは、休みだけを控えて読み飛ばす", () => {
  assert.deepEqual(parseOpeningHours("Tu-Su 09:00-17:00; PH off"),
    { open: 9, close: 17, closedDays: [1], closedOnHolidays: true });
  // 祝日の前日は遅くまで（実際にあった書きかた。屋島の「やしまーる」）。
  const h = parseOpeningHours("Mo,We-Th,Su,PH 09:00-17:00; Fr-Sa,PH -1 day 09:00-21:00");
  assert.equal(h.open, 9);
  assert.deepEqual(h.closedDays, [2]);
  assert.deepEqual(h.byDay, { 5: { open: 9, close: 21 }, 6: { open: 9, close: 21 } });
});

test("夜をまたぐ時間は、その日の終わりまで", () => {
  assert.deepEqual(parseOpeningHours("18:00-02:00"), { open: 18, close: 24 });
  assert.deepEqual(parseOpeningHours("11:00-26:00"), { open: 11, close: 24 });
});

test("読み切れない書きかたは、まるごと使わない", () => {
  for (const s of [
    "09:00-12:00,13:00-17:00",          // 昼に閉まる（1区間では表せない）
    "Mo-Fr 09:00-17:00; We[3] off",     // 第3水曜
    "sunrise-sunset",                   // 日の出から日の入り
    "09:00-17:00 \"要予約\"",            // 注記つき
    "Mo-Fr 09:00-17:00 || \"電話で確認\"", // 代わりの決まり
    "week 1-53/2 Mo 09:00-17:00",       // 隔週
    "Dec-Feb Mo off; 09:00-17:00",      // 月と曜日の組み合わせ
    "17:00+",                           // 終わりが書かれていない
    "Mo-Su off",                        // 毎日休み
    "営業中", "", "9時から17時",
  ]) {
    assert.equal(parseOpeningHours(s), null, s);
  }
});

test("全角で書かれていても読む", () => {
  assert.deepEqual(parseOpeningHours("０９：００-１７：００"), { open: 9, close: 17 });
});

test("収録に当てる。収録が自分で持っている時間が勝つ", () => {
  const a = { name: "A館", category: "美術館", verified: false,
              osmInfo: { opening_hours: "Tu-Su 10:00-18:00" } };
  assert.equal(applyOsmHours(a), true);
  assert.deepEqual(a.hours, { open: 10, close: 18, closedDays: [1], source: "osm" });

  const b = { name: "B館", category: "美術館", open: 9, close: 17,
              osmInfo: { opening_hours: "10:00-18:00" } };
  assert.equal(applyOsmHours(b), false);
  assert.equal(b.hours, undefined);

  const c = { name: "C館", category: "美術館",
              osmInfo: { opening_hours: "sunrise-sunset" } };
  assert.equal(applyOsmHours(c), false);
  assert.equal(c.hours, undefined);
});

test("OSM の時間は「目安」ではなくなり、出どころが注記に出る", () => {
  const spot = { name: "A館", category: "美術館", verified: false,
                 osmInfo: { opening_hours: "Tu-Su 10:00-18:00" } };
  // 当てる前は、分類の目安です。
  assert.equal(profileOf(spot).estimated, true);
  applyOsmHours(spot);
  assert.equal(profileOf(spot).estimated, false);
  const tue = hoursFor(spot, d("2026-11-10T12:00"));     // 火曜
  assert.equal(tue.closed, false);
  assert.equal(tue.openHour, 10);
  assert.equal(tue.closeHour, 18);
  assert.match(tue.note, /OpenStreetMap/);
  const mon = hoursFor(spot, d("2026-11-09T12:00"));     // 月曜
  assert.equal(mon.closed, true);
});

test("AIが調べた時間（出どころなし・未確認）は、これまでどおり目安のまま", () => {
  const spot = { name: "D館", category: "美術館", verified: false,
                 hours: { open: 9, close: 17 } };
  assert.equal(profileOf(spot).estimated, true);
});
