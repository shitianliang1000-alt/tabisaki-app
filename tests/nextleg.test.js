// 次の区間だけを、いまの時刻で引き直す。
//
// 旅程は組んだときの時刻でできています。当日10分遅れると、行には
// まだ「13:52 出発」と書いてあります。知りたいのは1つだけです——
// **いまから駅へ行くと、次の電車は何時か。**
//
// これまでは旅程ぜんぶを組み直すしかありませんでした。1〜2分かかり、
// **残りの旅程が別のものに変わります**。10分遅れただけの人が払う
// 代償としては大きすぎます。
//
// ここで確かめたいのは、**旅程を書き換えないこと**と、**数えられる
// ことだけを書くこと**です。

import assert from "node:assert/strict";
import test from "node:test";

import {
  PUSH_MIN, nextRide, requeryNextLeg, requeryNote, restMinutesAfter,
  shiftMinutes,
} from "../js/nextleg.js";

const at = (hhmm) => new Date(`2026-09-19T${hhmm}:00`);

const ride = (o) => ({
  id: o.id, kind: "transit", title: o.title ?? "移動",
  start: at(o.start), end: at(o.end ?? o.start),
  walk: o.walk, drive: o.drive,
  yahoo: o.yahoo === null ? null : {
    departure: o.departure ?? o.start,
    legs: (o.legs ?? [["出雲大社前", "電鉄出雲市"]])
      .map(([from, to, line]) => ({ from, to, line })),
  },
});

function itin() {
  return { days: [{ date: at("00:00"), items: [
    ride({ id: "a", start: "09:00", end: "10:00", departure: "09:00" }),
    { id: "s1", kind: "spot", title: "出雲大社",
      start: at("10:00"), end: at("13:52") },
    ride({ id: "b", start: "13:52", end: "14:20", departure: "13:52" }),
    { id: "s2", kind: "spot", title: "博物館",
      start: at("14:20"), end: at("16:00") },
    ride({ id: "c", start: "16:00", end: "19:00", departure: "16:00" }),
  ] }] };
}

// --- どの区間を引き直すか ---------------------------------------------------

test("これから乗る、いちばん近い区間を選ぶ", () => {
  assert.equal(nextRide(itin(), at("11:00")).id, "b");
  assert.equal(nextRide(itin(), at("08:00")).id, "a");
  assert.equal(nextRide(itin(), at("14:30")).id, "c");
});

test("乗っている最中の区間は、引き直さない", () => {
  // 乗ってしまってから引き直しても、降りる先は変わりません。
  assert.equal(nextRide(itin(), at("13:55")).id, "c");
});

test("もう乗る区間が無ければ、何も返さない", () => {
  assert.equal(nextRide(itin(), at("20:00")), null);
  assert.equal(nextRide({ days: [] }, at("09:00")), null);
  assert.equal(nextRide(null, at("09:00")), null);
});

test("歩きと運転は、引き直さない", () => {
  // 便がありません。
  const i = { days: [{ items: [
    ride({ id: "w", start: "10:00", walk: true }),
    ride({ id: "d", start: "11:00", drive: true }),
    ride({ id: "r", start: "12:00" }),
  ] }] };
  assert.equal(nextRide(i, at("09:00")).id, "r");
});

test("目安だけで組んだ区間は、引き直せない", () => {
  // どの駅から乗るのかが分からないので、聞く相手がいません。
  const i = { days: [{ items: [
    { id: "x", kind: "transit", start: at("10:00"), detail: "約42分" },
  ] }] };
  assert.equal(nextRide(i, at("09:00")), null);
});

// --- 差を数える -------------------------------------------------------------

test("予定の便との差を、分で数える", () => {
  assert.equal(shiftMinutes("13:52", "14:17"), 25);
  assert.equal(shiftMinutes("13:52", "13:52"), 0);
  assert.equal(shiftMinutes("13:52", "13:40"), -12);
  // 日をまたぐ便。
  assert.equal(shiftMinutes("23:50", "00:10"), 20);
  assert.equal(shiftMinutes("13:52", ""), null);
});

// --- 書きかた ---------------------------------------------------------------

const planned = { departure: "13:52", station: "出雲大社前", to: "電鉄出雲市" };

test("同じ便なら、予定どおりと書く", () => {
  const n = requeryNote({ departure: "13:52", arrival: "14:20" }, planned);
  assert.equal(n.level, "same");
  assert.equal(n.shiftMin, 0);
  assert.match(n.text, /出雲大社前 13:52 発/);
  assert.match(n.text, /予定どおり/);
  assert.match(n.text, /Transit API/);
  assert.match(n.text, /遅延は含みません/);
});

test("早い便に乗れるなら、余裕ができると書く", () => {
  const n = requeryNote({ departure: "13:40", arrival: "14:08" }, planned);
  assert.equal(n.level, "early");
  assert.equal(n.shiftMin, -12);
  assert.match(n.text, /12分 早い便/);
  assert.match(n.text, /余裕ができます/);
});

test("少しだけ後ろなら、そう書くだけにする", () => {
  const n = requeryNote({ departure: "13:57" }, planned);
  assert.equal(n.level, "late");
  assert.equal(n.shiftMin, 5);
  assert.ok(n.shiftMin < PUSH_MIN);
  assert.match(n.text, /5分 あと/);
  // 5分で「まとめてずれます」と騒ぐと、次から読まれません。
  assert.ok(!/まとめて/.test(n.text));
});

test("大きく後ろなら、この先が押すことまで書く", () => {
  const n = requeryNote({ departure: "14:17" }, planned, { restMin: 300 });
  assert.equal(n.level, "push");
  assert.equal(n.shiftMin, 25);
  assert.match(n.text, /25分 あと/);
  assert.match(n.text, /5時間ぶん/);
  assert.match(n.text, /25分 後ろにずれます/);
});

test("路線の名前があれば、添える", () => {
  const n = requeryNote(
    { departure: "13:52", arrival: "14:20", line: "一畑電車北松江線" }, planned);
  assert.match(n.text, /一畑電車北松江線/);
});

test("時刻が読めなければ、何も書かない", () => {
  for (const bad of [null, {}, { departure: "" }, { departure: "あとで" }]) {
    assert.equal(requeryNote(bad, planned), null);
  }
});

test("予定の発車が分からなくても、次の便だけは書く", () => {
  const n = requeryNote({ departure: "13:52" }, { station: "出雲大社前" });
  assert.equal(n.level, "same");
  assert.equal(n.shiftMin, null);
  // 数えていないものを、数えたように書きません。
  assert.ok(!/分 あと|分 早い|予定どおり/.test(n.text));
});

// --- 残りの長さ -------------------------------------------------------------

test("その区間より後に、その日に残っている予定の長さを数える", () => {
  const i = itin();
  const b = i.days[0].items[2];
  // b は 14:20 に終わり、その日は 19:00 に終わります。
  assert.equal(restMinutesAfter(i, b), 280);
  const c = i.days[0].items[4];
  assert.equal(restMinutesAfter(i, c), 0);
  assert.equal(restMinutesAfter(i, null), 0);
});

test("翌日ぶんは数えない", () => {
  // 3泊の旅で「残り50時間ぶんが25分ずれます」と書いても意味が
  // ありません。押されるのは、その日の終わりまでです。
  const i = itin();
  i.days.push({ items: [
    ride({ id: "z", start: "09:00", end: "10:00" }),
  ] });
  i.days[1].items[0].start = new Date("2026-09-20T09:00:00");
  i.days[1].items[0].end = new Date("2026-09-20T19:00:00");
  const b = i.days[0].items[2];
  assert.equal(restMinutesAfter(i, b), 280, "翌日まで数えています");
});

// --- 引き直す ---------------------------------------------------------------

test("引き直しても、旅程の時刻は動かない", () => {
  // ここがいちばん大事です。黙って動かすと、同行者に送った旅程と
  // 手元の旅程が食い違います。
  const i = itin();
  const before = i.days[0].items.map((x) => [x.id, +new Date(x.start),
                                             +new Date(x.end)]);
  return requeryNextLeg(i, async () => ({
    routed: true, meta: { departure: "14:17", arrival: "14:45" },
  }), { now: at("13:40") }).then((got) => {
    assert.equal(got.item.id, "b");
    assert.equal(got.note.shiftMin, 25);
    const after = i.days[0].items.map((x) => [x.id, +new Date(x.start),
                                              +new Date(x.end)]);
    assert.deepEqual(after, before, "旅程の時刻が動いています");
    // 行には、説明だけが貼られます。
    assert.equal(i.days[0].items[2].requeried.departure, "14:17");
    assert.match(i.days[0].items[2].requeried.text, /25分 あと/);
  });
});

test("聞く相手は、場所ではなく駅。時刻はいま", async () => {
  const asked = [];
  await requeryNextLeg(itin(), async (from, to, when) => {
    asked.push([from, to, when.toISOString()]);
    return { routed: true, meta: { departure: "14:17" } };
  }, { now: at("13:40") });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], "出雲大社前");
  assert.equal(asked[0][1], "電鉄出雲市");
  assert.equal(asked[0][2], at("13:40").toISOString());
});

test("聞くのは1回だけ", async () => {
  // 旅程ぜんぶを組み直すと何十回も走ります。ここは1区間だけです。
  let n = 0;
  await requeryNextLeg(itin(), async () => {
    n += 1;
    return { routed: true, meta: { departure: "14:17" } };
  }, { now: at("09:00") });
  assert.equal(n, 1);
});

test("聞けなかったときは、黙って何も返さない", async () => {
  const i = itin();
  assert.equal(await requeryNextLeg(i, async () => {
    throw new Error("429 断られました");
  }, { now: at("13:40") }), null);
  assert.equal(await requeryNextLeg(i, async () => null,
    { now: at("13:40") }), null);
  assert.equal(await requeryNextLeg(i, async () => ({ routed: false }),
    { now: at("13:40") }), null);
  assert.equal(await requeryNextLeg(i, async () => ({ routed: true, meta: {} }),
    { now: at("13:40") }), null);
  for (const item of i.days[0].items) {
    assert.equal(item.requeried, undefined);
  }
});

test("聞く関数を渡さなければ、何もしない", async () => {
  assert.equal(await requeryNextLeg(itin(), null), null);
  assert.equal(await requeryNextLeg(null, async () => ({})), null);
});
