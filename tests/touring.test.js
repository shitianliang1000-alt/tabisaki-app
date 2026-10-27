// 車の旅は、電車の旅とほしいものが違う。
//
// 「おもな移動手段」で車を選んでも、変わるのは所要時間の計算だけで、
// 行き先の選びかたは電車のときと同じでした。車で来ている人に駅前の
// 商店街を並べても、駐める場所を探すところから始まります。

import assert from "node:assert/strict";
import test from "node:test";

import { LONG_DRIVE_MIN, drivingAppeal, drivingMinutesByDay, drivingNote, isTouring, longDriveNote, restSlots } from "../packages/core/src/touring.js";

test("車かどうかを見分ける", () => {
  assert.equal(isTouring({ transport: "car" }), true);
  assert.equal(isTouring({ transport: "transit" }), false);
  assert.equal(isTouring({ transport: "any" }), false);
  assert.equal(isTouring(null), false);
});

test("走って気持ちのいい場所が、駅前より上に来る", () => {
  // 峠・岬・展望台は、その道を走ること自体が目的になります。
  for (const good of ["峠", "岬", "展望台", "湖", "海岸", "道の駅"]) {
    for (const hard of ["商店街", "市場", "町並み"]) {
      assert.ok(drivingAppeal({ category: good })
                > drivingAppeal({ category: hard }),
        `${good} が ${hard} より上に来ていません`);
    }
  }
});

test("表に無い分類は、ふつう扱い（消さない）", () => {
  assert.equal(drivingAppeal({ category: "存在しない分類" }), 0.5);
  assert.equal(drivingAppeal({}), 0.5);
  assert.equal(drivingAppeal(null), 0.5);
});

test("重みは 0〜1 に収まる", () => {
  for (const c of ["峠", "商店街", "寺院", "なにか"]) {
    const a = drivingAppeal({ category: c });
    assert.ok(a >= 0 && a <= 1, `${c}: ${a}`);
  }
});

test("車で嬉しい理由を、分類ごとに言う", () => {
  assert.match(drivingNote({ category: "峠" }), /峠道/);
  assert.match(drivingNote({ category: "海岸" }), /海沿い/);
  // 駐めにくい側は、断らずに事情だけ伝えます。
  assert.match(drivingNote({ category: "商店街" }), /駐める場所/);
  // どこにでも書ける文は書きません。
  assert.equal(drivingNote({ category: "寺院" }), "");
});

test("長い運転には、休憩のことを添える", () => {
  assert.equal(longDriveNote(60), "", "1時間なら何も言いません");
  assert.equal(longDriveNote(LONG_DRIVE_MIN - 1), "");
  const note = longDriveNote(190);
  assert.match(note, /3時間/);
  assert.match(note, /休憩/);
  assert.equal(longDriveNote(NaN), "");
});

test("日ごとの運転時間を数える（歩きは入れない）", () => {
  const at = (h, m = 0) => new Date(2026, 8, 16, h, m);
  const itin = { days: [{ items: [
    { kind: "transit", start: at(9), end: at(10, 30) },          // 90分
    { kind: "transit", start: at(11), end: at(11, 20), walk: true }, // 歩き
    { kind: "spot", start: at(11, 20), end: at(12) },
    { kind: "transit", start: at(12), end: at(13) },             // 60分
  ] }, { items: [
    { kind: "transit", start: at(9), end: at(9, 45) },            // 45分
  ] }] };
  assert.deepEqual(drivingMinutesByDay(itin), [150, 45]);
  assert.deepEqual(drivingMinutesByDay({}), []);
});

// --- 休憩の枠 ---------------------------------------------------------------
//
// 「2時間ごとに休憩を」と書いてはいましたが、**旅程はその時間を数えて
// いません**。3時間の運転が「3時間」のまま並び、休憩を入れるとそのぶん
// 全部が後ろへずれます。子ども連れなら、まず入れます。
//
// ここで確かめたいのは、**時刻を動かしていないこと**です。動かすと、
// 確かめ済みの旅程（帰りに間に合うか、施設が開いているか）をもう一度
// 確かめ直すことになります。代わりに「入れても間に合うか」を答えます。

const leg = (fromHm, toHm) => ({
  start: new Date(`2026-09-20T${fromHm}:00`),
  end: new Date(`2026-09-20T${toHm}:00`),
});

test("短い移動には、休憩の枠を出さない", () => {
  assert.equal(restSlots(leg("09:00", "10:30")), null);
});

test("3時間なら1回、5時間なら2回", () => {
  assert.equal(restSlots(leg("09:00", "12:00")).times.length, 1);
  assert.equal(restSlots(leg("09:00", "14:00")).times.length, 2);
  // 何分見ておくかも出します（1回15分）。
  assert.equal(restSlots(leg("09:00", "14:00")).minutes, 30);
});

test("休む時刻は、区間の中に入っている", () => {
  const r = restSlots(leg("09:00", "12:00"));
  const [h, m] = r.times[0].split(":").map(Number);
  const at = h * 60 + m;
  assert.ok(at > 9 * 60 && at < 12 * 60, `区間の外です: ${r.times[0]}`);
});

test("どこで休むかは、言わない", () => {
  // 店名も道の駅名も作りません（このアプリは店を持っていません）。
  const r = restSlots(leg("09:00", "12:00"));
  assert.doesNotMatch(r.note, /道の駅|サービスエリア|コンビニ|セブン|ローソン/);
});

test("時刻を動かさないことを、はっきり書く", () => {
  // 動かすと、確かめ済みの旅程をもう一度確かめ直すことになります。
  const r = restSlots(leg("09:00", "12:00"));
  assert.match(r.note, /入れていません/);
});

test("余裕に収まるかどうかを答える", () => {
  // 余裕が90分あれば、15分の休憩は入ります。
  const ok = restSlots(leg("09:00", "12:00"), 90);
  assert.equal(ok.fits, true);
  assert.match(ok.note, /収まります/);
  // 余裕が5分しかなければ、そう言います。
  const tight = restSlots(leg("09:00", "12:00"), 5);
  assert.equal(tight.fits, false);
  assert.match(tight.note, /超えます/);
  assert.match(tight.note, /削るか|遅らせて/);
  // 余裕が分からないときは、どちらとも言いません。
  assert.equal(restSlots(leg("09:00", "12:00")).fits, null);
});
