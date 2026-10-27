// 営業時間・最終入場・定休日のテスト。
//
// 「営業中」と「入場できる」は別です。16:55 に着いた城は、17:00 まで
// 開いていても入れません（最終入場 16:30）。この差を無視した旅程は、
// 現地で「時間内のはずなのに入れない」になります。
//
// 休みも同じです。毎週月曜の休館、年末年始、冬期休業。どれも
// 「その日は行けない」であって「早く着けば大丈夫」ではありません。

import assert from "node:assert/strict";
import test from "node:test";

import { describeHours, hoursFor, lastEntryOffsetFor } from "../packages/core/src/hours.js";

const d = (s) => new Date(s);
const MON = "2026-09-07T10:00";   // 月曜
const SAT = "2026-09-12T10:00";   // 土曜
const hh = (x) => x ? `${String(x.getHours()).padStart(2, "0")}:`
  + String(x.getMinutes()).padStart(2, "0") : null;

// --- 最終入場 ---------------------------------------------------------------

test("実データの最終入場を、そのまま使う", () => {
  const spot = { category: "城", hours: { open: 9, close: 17, lastEntry: 16.5 } };
  const h = hoursFor(spot, d(SAT));
  assert.equal(hh(h.lastEntry), "16:30");
  assert.equal(hh(h.close), "17:00");
  assert.equal(h.estimated, false);
});

test("最終入場が無いときは、分類ごとの目安を引く（そして目安と明示する）", () => {
  const castle = hoursFor({ category: "城", hours: { open: 9, close: 17 } }, d(SAT));
  assert.equal(hh(castle.lastEntry), "16:30");
  assert.equal(castle.lastEntryEstimated, true);
  // 券を売らない場所は、閉まる時刻がそのまま最終入場です
  const park = hoursFor({ category: "公園" }, d(SAT));
  assert.equal(park.alwaysOpen, true);
  assert.equal(park.lastEntry, null);
});

test("入場を締める時間は、分類で違う", () => {
  assert.ok(lastEntryOffsetFor("美術館") > 0);
  assert.ok(lastEntryOffsetFor("テーマパーク") >= lastEntryOffsetFor("美術館"));
  assert.equal(lastEntryOffsetFor("神社"), 0);
});

test("最終入場が閉館より後になるデータは、閉館に丸める", () => {
  const h = hoursFor({ category: "城", hours: { open: 9, close: 17, lastEntry: 18 } },
                     d(SAT));
  assert.equal(hh(h.lastEntry), "17:00");
});

// --- 定休日 -----------------------------------------------------------------

test("毎週の定休日は、その日だけ閉める", () => {
  const spot = { category: "美術館", hours: { open: 10, close: 17, closedDays: [1] } };
  assert.equal(hoursFor(spot, d(MON)).closed, true);
  assert.match(hoursFor(spot, d(MON)).reason, /月曜/);
  assert.equal(hoursFor(spot, d(SAT)).closed, false);
});

test("年末年始のような日付の休みも見る", () => {
  const spot = { category: "博物館",
                 hours: { open: 9, close: 17, closedDates: ["12-29..01-03"] } };
  assert.equal(hoursFor(spot, d("2026-12-30T10:00")).closed, true);
  assert.equal(hoursFor(spot, d("2027-01-02T10:00")).closed, true,
    "年をまたぐ範囲を扱えていません");
  assert.equal(hoursFor(spot, d("2027-01-05T10:00")).closed, false);
});

test("冬期休業のような期間の休みも見る", () => {
  const spot = { category: "展望台",
                 hours: { open: 9, close: 17, closedSeasons: [["11-15", "04-20"]] } };
  assert.equal(hoursFor(spot, d("2026-12-20T10:00")).closed, true);
  assert.match(hoursFor(spot, d("2026-12-20T10:00")).reason, /期間/);
  assert.equal(hoursFor(spot, d("2026-06-20T10:00")).closed, false);
});

// --- 曜日ごとの時間 ---------------------------------------------------------

test("曜日で時間が変わる場所を、そのとおりに扱う", () => {
  const spot = { category: "美術館",
    hours: { open: 10, close: 17, byDay: { 6: { open: 10, close: 20 } } } };
  assert.equal(hh(hoursFor(spot, d(SAT)).close), "20:00");   // 土曜
  assert.equal(hh(hoursFor(spot, d("2026-09-11T10:00")).close), "17:00"); // 金曜
});

test("季節で時間が変わる場所を、そのとおりに扱う", () => {
  const spot = { category: "城",
    hours: { open: 9, close: 16.5, seasons: [{ from: "04-01", to: "09-30",
                                               open: 9, close: 18 }] } };
  assert.equal(hh(hoursFor(spot, d(SAT)).close), "18:00");
  assert.equal(hh(hoursFor(spot, d("2026-11-10T10:00")).close), "16:30");
});

// --- 実データかどうか -------------------------------------------------------

test("分類の目安しか無いときは、目安だと分かるようにする", () => {
  const h = hoursFor({ category: "博物館" }, d(SAT));
  assert.equal(h.estimated, true);
  assert.match(h.note, /目安/);
});

test("AIが調べただけのデータは、値があっても未確認として扱う", () => {
  const h = hoursFor({ category: "博物館", verified: false,
                       hours: { open: 9, close: 17, lastEntry: 16.5 } }, d(SAT));
  assert.equal(h.estimated, true);
  assert.match(h.note, /未確認|確認/);
});

test("いつでも見られる場所は、最終入場も定休日も持たない", () => {
  const h = hoursFor({ category: "神社" }, d(MON));
  assert.equal(h.alwaysOpen, true);
  assert.equal(h.closed, false);
  assert.equal(h.lastEntry, null);
});

// --- 言葉にする -------------------------------------------------------------

test("画面にそのまま出せる一文にする", () => {
  const s = describeHours({ category: "城",
    hours: { open: 9, close: 17, lastEntry: 16.5, closedDays: [1] } }, d(SAT));
  assert.match(s, /09:00/);
  assert.match(s, /17:00/);
  assert.match(s, /最終入場 16:30/);
  assert.match(s, /月曜/);
});

test("休みの日は、そのことを先に言う", () => {
  const s = describeHours({ category: "美術館",
    hours: { open: 10, close: 17, closedDays: [1] } }, d(MON));
  assert.match(s, /^休/);
});

// --- 旅程の判定に効いているか -----------------------------------------------
// ここが本題です。最終入場を知っていても、判定に使わなければ意味がありません。

test("最終入場を過ぎていたら、候補から落とす", async () => {
  const { REJECT, checkSpot } = await import("../packages/core/src/feasibility.js");
  const castle = { id: "c", name: "テスト城", category: "城",
                   lat: 35.0, lng: 135.0,
                   hours: { open: 9, close: 17, lastEntry: 16.5 } };
  const ctx = { from: { lat: 35.0, lng: 135.0 }, pace: "balanced",
                travelFn: () => 0 };

  // 16:55 着。まだ「営業中」ですが、入れません。
  const late = checkSpot(castle, { ...ctx, earliest: d("2026-09-12T16:55") });
  assert.equal(late.ok, false);
  assert.equal(late.reason, REJECT.AFTER_LAST_ENTRY);

  // 16:35 着も「営業中」ですが、最終入場を5分過ぎています。
  // 閉館だけを見ていると、ここが通ってしまいます。
  const edge = checkSpot(castle, { ...ctx, earliest: d("2026-09-12T16:35") });
  assert.equal(edge.reason, REJECT.AFTER_LAST_ENTRY);

  // 見学時間（城は80分）が取れる時刻なら入れます。
  const ok = checkSpot(castle, { ...ctx, earliest: d("2026-09-12T15:00") });
  assert.equal(ok.ok, true);
});

test("年末年始の休館日は、朝に着いても落とす", async () => {
  const { REJECT, checkSpot } = await import("../packages/core/src/feasibility.js");
  const museum = { id: "m", name: "テスト博物館", category: "博物館",
                   lat: 35.0, lng: 135.0,
                   hours: { open: 9, close: 17, closedDates: ["12-29..01-03"] } };
  const r = checkSpot(museum, { from: { lat: 35.0, lng: 135.0 },
    earliest: d("2026-12-30T09:30"), travelFn: () => 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.CLOSED_TODAY);
});

test("冬期休業の展望台は、その期間だけ落とす", async () => {
  const { checkSpot } = await import("../packages/core/src/feasibility.js");
  const spot = { id: "v", name: "テスト展望台", category: "展望台",
                 lat: 35.0, lng: 135.0,
                 hours: { open: 9, close: 17, closedSeasons: [["11-15", "04-20"]] } };
  const from = { lat: 35.0, lng: 135.0 };
  assert.equal(checkSpot(spot, { from, earliest: d("2026-12-20T10:00"),
                                 travelFn: () => 0 }).ok, false);
  assert.equal(checkSpot(spot, { from, earliest: d("2026-06-20T10:00"),
                                 travelFn: () => 0 }).ok, true);
});

test("土曜だけ遅くまで開く場所は、土曜に遅く着いても通す", async () => {
  const { checkSpot } = await import("../packages/core/src/feasibility.js");
  const spot = { id: "a", name: "テスト美術館", category: "美術館",
                 lat: 35.0, lng: 135.0,
                 hours: { open: 10, close: 17, byDay: { 6: { open: 10, close: 20 } } } };
  const from = { lat: 35.0, lng: 135.0 };
  // 2026-09-12 は土曜、2026-09-11 は金曜
  assert.equal(checkSpot(spot, { from, earliest: d("2026-09-12T17:30"),
                                 travelFn: () => 0 }).ok, true);
  assert.equal(checkSpot(spot, { from, earliest: d("2026-09-11T17:30"),
                                 travelFn: () => 0 }).ok, false);
});

// --- 旅程を組む側にも効いているか -------------------------------------------
// checkSpot（ふるい）と verifyOrder（並べて時刻を割り当てる）は別の判定です。
// 片方だけ直すと、ふるいを通ったものが旅程では閉館時刻で通ってしまいます。

test("旅程を組むときも、最終入場で判定する", async () => {
  const { verifyOrder } = await import("../packages/core/src/verify.js");
  const at = { lat: 35.0, lng: 135.0 };
  const castle = { id: "c", name: "テスト城", category: "城", ...at,
                   hours: { open: 9, close: 17, lastEntry: 16.5 } };
  const r = verifyOrder([castle], {
    start: at, startAt: d("2026-09-12T16:40"),
    end: at, endBy: d("2026-09-12T22:00"),
    travelFn: () => 0,
  });
  assert.equal(r.visits.length, 0, "最終入場を過ぎた城を旅程に入れています");
  assert.equal(r.issues[0].reason, "最終入場を過ぎている");
  assert.match(r.issues[0].detail, /最終入場/);
});

test("旅程を組むときも、期間の休業を見る", async () => {
  const { verifyOrder } = await import("../packages/core/src/verify.js");
  const at = { lat: 35.0, lng: 135.0 };
  const spot = { id: "v", name: "テスト展望台", category: "展望台", ...at,
                 hours: { open: 9, close: 17, closedSeasons: [["11-15", "04-20"]] } };
  const r = verifyOrder([spot], {
    start: at, startAt: d("2026-12-20T10:00"),
    end: at, endBy: d("2026-12-20T20:00"), travelFn: () => 0,
  });
  assert.equal(r.visits.length, 0);
  assert.match(r.issues[0].detail, /休業/);
});

// --- 目安しか無いときの扱い -------------------------------------------------
// 「美術館は月曜休みが多い」は事実ですが、その館が休みだとは言えません。
// 勝手に落とすと行けるはずの場所が消え、黙って通すと現地で閉まっています。
// どちらでもなく、注意として伝えます。

test("休みが多い曜日にあたるときは、確認をうながす", () => {
  const h = hoursFor({ category: "美術館" }, d(MON));   // 月曜・実データなし
  assert.equal(h.closed, false, "目安だけで休みと決めつけています");
  assert.equal(h.riskyDay, true);
  assert.match(h.riskyNote, /月曜/);
});

test("実データで定休日が分かっている場所には、注意を出さない", () => {
  const open = hoursFor({ category: "美術館", hours: { open: 10, close: 17,
                                                       closedDays: [2] } }, d(MON));
  assert.equal(open.riskyDay, false, "実データがあるのに目安の注意を出しています");
});

test("休みの曜日が決まっていない分類には、注意を出さない", () => {
  assert.equal(hoursFor({ category: "神社" }, d(MON)).riskyDay, false);
  assert.equal(hoursFor({ category: "公園" }, d(MON)).riskyDay, false);
});

// --- 夜景は、夜に ------------------------------------------------------------
//
// 「函館山からの函館市街地の夜景」が 10:37 に入っていました。時刻表も
// 営業時間も間違っていません。ただ、朝に見る夜景はありません。

test("夜景の場所は、日が暮れてからの時間帯にする", () => {
  const night = { id: "n", name: "函館山からの函館市街地の夜景",
                  category: "町並み", lat: 41.76, lng: 140.70 };
  const day = hoursFor(night, new Date("2026-09-01T09:00"));
  assert.ok(day.open, "いつでも見られる扱いのままです");
  assert.ok(day.open.getHours() >= 18,
    `${day.open.getHours()}時から開く扱いになっています`);
});

test("収録に時間が書いてあれば、そちらを使う", () => {
  const night = { id: "n", name: "◯◯の夜景", category: "展望台",
                  lat: 35.0, lng: 135.0, hours: { open: 10, close: 21 } };
  const day = hoursFor(night, new Date("2026-09-01T09:00"));
  assert.equal(day.open.getHours(), 10,
    "書いてある開館時刻を、推し量りで上書きしています");
});

test("夜景でない場所は、これまでどおり", () => {
  const plain = { id: "p", name: "函館山展望台", category: "展望台",
                  lat: 41.76, lng: 140.70 };
  const day = hoursFor(plain, new Date("2026-09-01T09:00"));
  assert.ok(!day.open || day.open.getHours() < 18);
});
