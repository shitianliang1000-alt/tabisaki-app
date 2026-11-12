// 旅程をカレンダーへ。
//
// 当日に開くのは、このアプリではなくカレンダーです。前日の夜に通知が
// 出て、朝に予定が並んでいる。そこまで届かないと、作った旅程は
// 使われません。.ics は Google・Apple・Outlook がどれも読める形式です。

import assert from "node:assert/strict";
import test from "node:test";

import { icsFilename, toIcs } from "../js/ical.js";

const d = (s) => new Date(s);
const NOW = d("2026-09-16T00:00:00Z");

const itin = {
  title: "草津温泉",
  prefecture: "群馬県",
  days: [{
    date: d("2026-09-17T09:00"),
    items: [
      { id: "t1", kind: "transit", title: "東京駅 → 長野原草津口駅",
        detail: "特急草津・四万1号", yahoo: {}, routed: true,
        to: { name: "長野原草津口駅" },
        start: d("2026-09-17T09:00"), end: d("2026-09-17T11:12") },
      { id: "f1", kind: "free", title: "自由時間",
        start: d("2026-09-17T11:12"), end: d("2026-09-17T11:30") },
      { id: "s1", kind: "spot", title: "草津温泉 湯畑",
        // 収録のスポットは座標を持っています。.ics にも入れます
        // （名前だけだと、カレンダーの「地図で開く」が別の場所を
        // 開くことがあります）。
        place: { name: "草津温泉 湯畑", lat: 36.6221, lng: 138.5966 },
        costYen: 900,
        start: d("2026-09-17T12:16"), end: d("2026-09-17T13:44") },
      { id: "m1", kind: "meal", title: "昼食",
        start: d("2026-09-17T13:44"), end: d("2026-09-17T14:44") },
    ],
  }],
};

test("カレンダーの器ができる", () => {
  const ics = toIcs(itin, { now: NOW });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /X-WR-CALNAME:草津温泉 · 群馬県/);
  // 行の区切りは CRLF です。LF だけの実装に弾かれます。
  assert.ok(!/[^\r]\n/.test(ics), "CRLF になっていない行があります");
});

test("立ち寄り・食事・移動が予定になり、空き時間は入らない", () => {
  const ics = toIcs(itin, { now: NOW });
  const count = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  // 3件＋前夜の1件。前夜は「明日から」の1つだけです。
  assert.equal(count, 4, "予定の数が合いません");
  assert.match(ics, /SUMMARY:草津温泉 湯畑/);
  assert.match(ics, /SUMMARY:昼食/);
  assert.doesNotMatch(ics, /自由時間/);
});

// --- 当日まで届くか ---------------------------------------------------------
//
// カレンダーに入れただけでは、**鳴りません**。予定が並ぶだけです。
// 旅の当日にこのアプリを開かない人（開かないのが普通です）には、
// 通知が唯一の届きかたでした。

test("予定に通知が付いている", () => {
  const ics = toIcs(itin, { now: NOW });
  const alarms = (ics.match(/BEGIN:VALARM/g) ?? []).length;
  assert.ok(alarms >= 3, `通知が ${alarms} 件しかありません`);
  // どのカレンダーでも通る種類であること。
  assert.match(ics, /ACTION:DISPLAY/);
  // 何分前かは、予定の種類で変わります。
  // 移動は10分前（乗り遅れると次の便まで待ちます）。
  assert.match(ics, /TRIGGER:-PT10M/);
  // 立ち寄りは20分前（入場券・最終入場があります）。
  assert.match(ics, /TRIGGER:-PT20M/);
});

test("出発の前夜に、荷造りの通知を1つ置く", () => {
  const ics = toIcs(itin, { now: NOW });
  assert.match(ics, /SUMMARY:明日から/);
  assert.match(ics, /荷造り/);
  // 前の日の20時です（終日にすると、通知が出ないカレンダーがあります）。
  assert.match(ics, /DTSTART:20260916T200000/);
  // 1つだけ。毎晩鳴らす必要はありません。
  assert.equal((ics.match(/SUMMARY:明日から/g) ?? []).length, 1);
});

test("予定に座標が入っている", () => {
  // 名前だけだと、カレンダーの「地図で開く」は名前で検索します。
  // 「出雲大社」なら当たりますが、「稲佐の浜入口」のような停留所名では
  // 別の場所が開きます。
  const ics = toIcs(itin, { now: NOW });
  assert.match(ics, /GEO:\d+\.\d+;\d+\.\d+/);
});

test("時刻は、その土地の時刻のまま書く", () => {
  // UTC に直すと、端末の時計が別の国に合っている人にはずれて並びます。
  const ics = toIcs(itin, { now: NOW });
  assert.match(ics, /DTSTART:20260917T121600\r?\n/);
  assert.match(ics, /DTEND:20260917T134400/);
  assert.ok(!/DTSTART:[0-9T]+Z/.test(ics), "DTSTART が UTC になっています");
  // 作った時刻だけは UTC で書きます（RFC の求めるところです）。
  assert.match(ics, /DTSTAMP:20260916T000000Z/);
});

test("記号を逃がす（説明文のカンマで壊れない）", () => {
  const ics = toIcs({
    title: "試験",
    days: [{ date: d("2026-09-17T09:00"), items: [{
      id: "x", kind: "spot", title: "A;B,C\\D",
      place: { name: "場所" },
      detail: "1行目\n2行目、カンマ, とセミコロン;",
      start: d("2026-09-17T10:00"), end: d("2026-09-17T11:00"),
    }] }],
  }, { now: NOW });
  assert.match(ics, /SUMMARY:A\\;B\\,C\\\\D/);
  assert.match(ics, /DESCRIPTION:1行目\\n2行目/);
  assert.match(ics, /カンマ\\, とセミコロン\\;/);
});

test("長い行は75オクテットで折り、文字の途中で切らない", () => {
  const long = "草津温泉".repeat(30);   // 360オクテット
  const ics = toIcs({
    title: "試験",
    days: [{ date: d("2026-09-17T09:00"), items: [{
      id: "x", kind: "spot", title: long, place: { name: "場所" },
      start: d("2026-09-17T10:00"), end: d("2026-09-17T11:00"),
    }] }],
  }, { now: NOW });
  const enc = new TextEncoder();
  for (const line of ics.split("\r\n")) {
    assert.ok(enc.encode(line).length <= 75,
      `${enc.encode(line).length} オクテットの行があります`);
  }
  // 折ったものを畳み直すと、元の題に戻ること（文字が割れていない証拠）。
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes(`SUMMARY:${long}`), "折り返しで文字が割れています");
});

test("移動の出どころを説明に書く", () => {
  // 説明文は75オクテットで折られるので、畳み直してから見ます。
  const unfold = (s) => s.replace(/\r\n /g, "");
  const ics = unfold(toIcs(itin, { now: NOW }));
  assert.match(ics, /Transit APIで調べた実際の便です。/);
  const est = toIcs({
    title: "試験",
    days: [{ date: d("2026-09-17T09:00"), items: [{
      id: "x", kind: "transit", title: "移動", routed: false,
      to: { name: "どこか" },
      start: d("2026-09-17T10:00"), end: d("2026-09-17T11:00"),
    }] }],
  }, { now: NOW });
  assert.match(unfold(est), /距離からの目安です/);
});

test("同じ時刻で始まって終わる予定は、長さを持たせる", () => {
  // 0分の予定は、カレンダーによっては消えます。
  const ics = toIcs({
    title: "試験",
    days: [{ date: d("2026-09-17T09:00"), items: [{
      id: "x", kind: "spot", title: "点", place: { name: "点" },
      start: d("2026-09-17T10:00"), end: d("2026-09-17T10:00"),
    }] }],
  }, { now: NOW });
  assert.match(ics, /DTSTART:20260917T100000/);
  assert.match(ics, /DTEND:20260917T101500/);
});

test("予定が1つも無ければ、空を返す（空のファイルを渡さない）", () => {
  assert.equal(toIcs({ days: [] }, { now: NOW }), "");
  assert.equal(toIcs({}, { now: NOW }), "");
  assert.equal(toIcs({ days: [{ items: [{ kind: "free" }] }] }, { now: NOW }), "");
});

test("ファイル名は ASCII だけで組む", () => {
  // download 属性に日本語を渡すと、環境によっては名前ごと捨てられ、
  // 拡張子まで失われます（拡張子の無い「download」で保存されました）。
  // 旅先の名前は X-WR-CALNAME で伝わるので、ファイル名は日付で足ります。
  assert.equal(icsFilename(itin), "tabisaki-20260917.ics");
  for (const name of Object.values({
    a: icsFilename(itin),
    b: icsFilename({ title: "A/B:C", days: [] }),
    c: icsFilename({}),
  })) {
    assert.match(name, /^[\x20-\x7E]+$/, `${name} に ASCII 以外が入っています`);
    assert.match(name, /\.ics$/, `${name} に拡張子がありません`);
  }
  // ローマ字で入力された旅は、その名前を残します。
  assert.equal(icsFilename({ title: "A/B:C", days: [] }), "tabisaki-ABC-itinerary.ics");
  assert.equal(icsFilename({}), "tabisaki-itinerary.ics");
});
