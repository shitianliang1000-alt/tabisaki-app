// 出る時刻の、お知らせ。
//
// 旅行中モードは「あと12分で出発」と出しますが、**その画面を開いて
// いなければ何も起きません**。12分はあっという間に過ぎ、駅に着いたら
// 電車は出たあとです。
//
// ここで確かめたいのは3つです。
//
//   ① 乗り物で、何分前に鳴らすかが変わること。空港へは1時間前に
//      着く必要があり、15分前に知らせても保安検査は締まっています
//   ② 過ぎた予定を鳴らさないこと。開いた瞬間にまとめて鳴ると、
//      次から切られます
//   ③ **できないことを、できないと書いてあること**。このアプリには
//      サーバが無いので、閉じているあいだは鳴らせません

import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAD_MIN, NOTICE_LIMITS, armNotices, askNotifyPermission, leadFor,
  scheduleNotices,
} from "../js/notify.js";
import { BOARDING_LEAD_MIN } from "../packages/core/src/modes.js";

// 時差を書かずに作ります。書くと、試験を回す端末の時間帯によって
// getHours() の答えが変わり、UTC の機械では「0:00 出発です」になります。
const at = (hhmm) => new Date(`2026-09-19T${hhmm}:00`);
const item = (o) => ({ id: o.id, kind: o.kind, title: o.title,
                       start: at(o.start), end: at(o.end ?? o.start),
                       vehicle: o.vehicle });

// --- 何分前 -----------------------------------------------------------------

test("ふつうの予定は、種類ごとに決まった分だけ前に", () => {
  assert.equal(leadFor(item({ kind: "transit", start: "09:00" })),
    LEAD_MIN.transit);
  assert.equal(leadFor(item({ kind: "spot", start: "09:00" })), LEAD_MIN.spot);
  assert.equal(leadFor(item({ kind: "lodging", start: "09:00" })),
    LEAD_MIN.lodging);
});

test("空路は、搭乗手続きのぶんだけ早く知らせる", () => {
  // 15分前に鳴らしても、保安検査はもう締まっています。
  const air = item({ kind: "transit", start: "09:00",
                     vehicle: { kinds: ["air"] } });
  assert.equal(leadFor(air), BOARDING_LEAD_MIN.air + LEAD_MIN.transit);
  assert.ok(leadFor(air) > LEAD_MIN.transit);
});

test("航路も同じ。いちばん早い締切に合わせる", () => {
  const both = item({ kind: "transit", start: "09:00",
                      vehicle: { kinds: ["ferry", "bus"] } });
  assert.equal(leadFor(both), BOARDING_LEAD_MIN.ferry + LEAD_MIN.transit);
  // 空路と航路が混じるなら、遅いほう（早く締まるほう）に合わせます。
  const mixed = item({ kind: "transit", start: "09:00",
                       vehicle: { kinds: ["ferry", "air"] } });
  assert.equal(leadFor(mixed), BOARDING_LEAD_MIN.air + LEAD_MIN.transit);
});

test("知らせない種類がある", () => {
  // 自由時間に「あと10分で自由時間です」と鳴らしても、することは
  // ありません。着いた朝の目印も予定ではありません。
  assert.equal(leadFor(item({ kind: "free", start: "09:00" })), null);
  assert.equal(leadFor(item({ kind: "arrive", start: "09:00" })), null);
  assert.equal(leadFor(null), null);
  assert.equal(leadFor({ kind: "なにか", start: at("09:00") }), null);
});

// --- 一覧を作る -------------------------------------------------------------

function itin() {
  return { days: [{ date: at("00:00"), items: [
    item({ id: "a", kind: "transit", title: "東京 → 出雲市", start: "09:00" }),
    item({ id: "b", kind: "spot", title: "出雲大社", start: "13:00" }),
    item({ id: "c", kind: "free", title: "自由時間", start: "15:00" }),
    item({ id: "d", kind: "transit", title: "出雲 → 東京", start: "18:40",
           vehicle: { kinds: ["air"] } }),
  ] }] };
}

test("予定より前の時刻に、順に並ぶ", () => {
  const list = scheduleNotices(itin(), at("07:00"));
  assert.deepEqual(list.map((n) => n.itemId), ["a", "b", "d"]);
  // 09:00発の15分前 → 08:45
  assert.equal(list[0].at.getTime(), at("08:45").getTime());
  // 18:40の便（空路）は、60+15分前 → 17:25
  assert.equal(list[2].at.getTime(), at("17:25").getTime());
  assert.ok(list[0].at <= list[1].at && list[1].at <= list[2].at);
});

test("過ぎたものは作らない", () => {
  // 開いた瞬間にまとめて鳴ると、次から切られます。
  const list = scheduleNotices(itin(), at("14:00"));
  assert.deepEqual(list.map((n) => n.itemId), ["d"]);
});

test("遠すぎるものも作らない", () => {
  const far = { days: [{ items: [
    item({ id: "z", kind: "spot", title: "明後日", start: "09:00" }),
  ] }] };
  far.days[0].items[0].start = new Date("2026-09-25T09:00:00");
  assert.equal(scheduleNotices(far, at("07:00")).length, 0);
  // 広げれば作ります。
  assert.equal(
    scheduleNotices(far, at("07:00"), { horizonHours: 24 * 7 }).length, 1);
});

test("文には、何時に何をするかが入っている", () => {
  const list = scheduleNotices(itin(), at("07:00"));
  const ride = list.find((n) => n.itemId === "a");
  assert.equal(ride.title, "東京 → 出雲市");
  assert.match(ride.body, /9:00/);
  assert.match(ride.body, /15分/);
  // 空路は、空港へ向かうことまで書きます。
  const air = list.find((n) => n.itemId === "d");
  assert.match(air.body, /空港/);
  assert.match(air.body, /保安検査|搭乗手続き/);
});

test("時刻が壊れていても、作らない", () => {
  const bad = { days: [{ items: [
    { id: "x", kind: "spot", title: "壊れ", start: "あとで" },
    { id: "y", kind: "spot", title: "無し" },
  ] }] };
  assert.equal(scheduleNotices(bad, at("07:00")).length, 0);
  assert.equal(scheduleNotices(null, at("07:00")).length, 0);
});

// --- 仕掛ける ---------------------------------------------------------------

test("時間が来たら鳴る", () => {
  const timers = [];
  const shown = [];
  const list = scheduleNotices(itin(), at("07:00"));
  const armed = armNotices(list, {
    now: () => at("07:00"),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    show: (n) => shown.push(n.itemId),
  });
  assert.equal(armed.count, 3);
  // 08:45 は 07:00 の 105分後。
  assert.equal(timers[0].ms, 105 * 60000);
  timers[0].fn();
  assert.deepEqual(shown, ["a"]);
});

test("過ぎた知らせを、0秒後に鳴らさない", () => {
  // 待ち時間を 0 に丸めると、画面を開いた瞬間に過ぎたぶんが全部鳴ります。
  const timers = [];
  const armed = armNotices(
    [{ at: at("06:00"), title: "済み", body: "" },
     { at: at("08:00"), title: "これから", body: "" }],
    { now: () => at("07:00"),
      setTimer: (fn, ms) => { timers.push(ms); return timers.length; },
      clearTimer: () => {} });
  assert.equal(armed.count, 1);
  assert.deepEqual(timers, [60 * 60000]);
});

test("止められる", () => {
  const cleared = [];
  const armed = armNotices(scheduleNotices(itin(), at("07:00")), {
    now: () => at("07:00"),
    setTimer: () => cleared.length + 1,
    clearTimer: (id) => cleared.push(id),
  });
  armed.stop();
  assert.equal(cleared.length, 3);
  // 二度止めても壊れません。
  armed.stop();
  assert.equal(cleared.length, 3);
});

// --- 許可 -------------------------------------------------------------------

test("すでに許されていれば、聞き直さない", async () => {
  let asked = 0;
  const api = { permission: "granted",
                requestPermission: async () => { asked += 1; return "granted"; } };
  assert.deepEqual(await askNotifyPermission(api), { ok: true, why: "" });
  assert.equal(asked, 0);
});

test("断られていたら、どこで変えられるかを書く", async () => {
  const api = { permission: "denied", requestPermission: async () => "denied" };
  const r = await askNotifyPermission(api);
  assert.equal(r.ok, false);
  assert.match(r.why, /ブラウザの設定/);
});

test("通知の無い端末では、そう言う", async () => {
  const r = await askNotifyPermission(undefined);
  assert.equal(r.ok, false);
  assert.match(r.why, /使えません/);
});

test("聞いて、断られたらそう言う", async () => {
  const api = { permission: "default", requestPermission: async () => "denied" };
  const r = await askNotifyPermission(api);
  assert.equal(r.ok, false);
  assert.match(r.why, /使わない設定/);
  // 例外が出ても壊れません。
  const bad = { permission: "default",
                requestPermission: async () => { throw new Error("no"); } };
  assert.equal((await askNotifyPermission(bad)).ok, false);
});

// --- できないこと -----------------------------------------------------------

test("できないことが、はっきり書いてある", () => {
  // このアプリにはサーバがありません。閉じているあいだに鳴らすには
  // 鍵を持ったサーバが要ります。持っていないものを「お知らせします」と
  // 書くのは嘘になります。旅先で頼りにされて鳴らないのがいちばん困ります。
  assert.match(NOTICE_LIMITS, /この画面を開いているあいだだけ/);
  assert.match(NOTICE_LIMITS, /サーバが無い/);
  // 代わりの手も書きます。
  assert.match(NOTICE_LIMITS, /アラーム/);
});
