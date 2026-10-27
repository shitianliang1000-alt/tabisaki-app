// 「その時期ならではのもの」を旅程に入れるテスト。
//
// 9月の京都と11月の京都は、同じ場所でも別の旅です。紅葉、桜、祭り、
// ライトアップ。場所×時間だけを見ていると、これが全部こぼれます。
//
// ここで扱うのは**時期で決まるもの**だけです。個別の催しの日程は
// 毎年変わるので、こちらでは持ちません（AIが調べたぶんを受け取ります）。

import assert from "node:assert/strict";
import test from "node:test";

import { SEASONS, seasonalFor, eventNotesFor, validateEvents }
  from "../packages/core/src/events.js";

const d = (s) => new Date(s);

const spot = (over = {}) => ({
  id: "s1", name: "嵐山", category: "渓谷", lat: 35.01, lng: 135.67,
  genres: ["nature"], ...over,
});

test("時期の一覧がある（紅葉・桜・新緑…）", () => {
  assert.ok(SEASONS.length >= 4);
  for (const s of SEASONS) {
    assert.ok(s.key && s.label && s.from && s.to);
    assert.ok(Array.isArray(s.categories));
  }
});

test("紅葉の時期に、紅葉の場所なら教えてくれる", () => {
  const r = seasonalFor(spot(), d("2026-11-20T10:00"));
  assert.ok(r.some((x) => x.key === "autumn"), JSON.stringify(r));
  assert.match(r.find((x) => x.key === "autumn").text, /紅葉/);
});

test("時期が違えば、何も言わない", () => {
  const r = seasonalFor(spot(), d("2026-07-20T10:00"));
  assert.ok(!r.some((x) => x.key === "autumn"));
});

test("その時期でも、関係ない分類には言わない", () => {
  const museum = spot({ category: "美術館", genres: ["art"] });
  const r = seasonalFor(museum, d("2026-11-20T10:00"));
  assert.ok(!r.some((x) => x.key === "autumn"),
    "美術館に紅葉の話をしています");
});

test("桜の時期は年をまたがないが、冬は年をまたぐ", () => {
  assert.ok(seasonalFor(spot({ category: "公園" }), d("2026-04-02T10:00"))
    .some((x) => x.key === "sakura"));
  const ski = spot({ category: "スキー場", genres: ["nature"] });
  assert.ok(seasonalFor(ski, d("2027-01-15T10:00"))
    .some((x) => x.key === "winter"), "年をまたぐ期間を扱えていません");
});

test("旅程ぜんぶぶんの注意にまとめられる", () => {
  const itin = { days: [{ date: d("2026-11-20T09:00"), items: [
    { kind: "spot", place: spot(), start: d("2026-11-20T10:00") },
    { kind: "spot", place: spot({ id: "s2", name: "美術館",
                                  category: "美術館", genres: ["art"] }),
      start: d("2026-11-20T13:00") },
  ] }] };
  const notes = eventNotesFor(itin);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /嵐山/);
  assert.match(notes[0], /紅葉/);
});

test("同じ注意を、何度も並べない", () => {
  const itin = { days: [{ date: d("2026-11-20T09:00"), items: [
    { kind: "spot", place: spot(), start: d("2026-11-20T10:00") },
    { kind: "spot", place: spot(), start: d("2026-11-20T14:00") },
  ] }] };
  assert.equal(eventNotesFor(itin).length, 1);
});

// --- AIが調べたイベントの検証 -----------------------------------------------

test("AIが返したイベントを、日付と場所で確かめる", () => {
  const ok = validateEvents([
    { name: "嵐山花灯路", from: "2026-12-11", to: "2026-12-20",
      place: "嵐山", note: "夜のライトアップ" },
  ], { from: d("2026-12-12"), to: d("2026-12-14") });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, "嵐山花灯路");
});

test("旅の期間とかぶらないイベントは、落とす", () => {
  const out = validateEvents([
    { name: "夏祭り", from: "2026-08-01", to: "2026-08-03", place: "京都" },
  ], { from: d("2026-12-12"), to: d("2026-12-14") });
  assert.deepEqual(out, []);
});

test("日付が読めないイベントは、落とす（それらしい日付を作らない）", () => {
  const out = validateEvents([
    { name: "たぶん祭り", from: "いつか", to: "そのうち", place: "どこか" },
    { name: "名前だけ" },
  ], { from: d("2026-12-12"), to: d("2026-12-14") });
  assert.deepEqual(out, []);
});

test("壊れた入力でも落ちない", () => {
  for (const bad of [null, undefined, "x", [null], [{}]]) {
    assert.ok(Array.isArray(validateEvents(bad,
      { from: d("2026-01-01"), to: d("2026-01-02") })));
  }
});
