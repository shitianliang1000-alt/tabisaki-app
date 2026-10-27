// 切符のこと。
//
// 旅程には「08:32発→11:47着・乗換1回・15,290円」と書いてあります。
// 金額は合っています（Yahoo!の答えには特急料金も入っています）。
// それでも当日、みどりの窓口の前で立ち止まります。新幹線は乗車券と
// 特急券の2枚で、指定席か自由席かを買うときに決める必要があります。
//
// ここで確かめたいのは、**言いすぎないこと**です。
//
//   ・言い切れるのは新幹線だけ。私鉄の「特急」は、追加料金の要る
//     ものと要らないものが混ざっています（小田急ロマンスカーは要り、
//     京急の特急は要りません）
//   ・「◯◯フリーきっぷが得です」とは言わない。券の名前も値段も
//     持っておらず、毎年変わります。**得かどうかは数えられません**
//   ・会社が分からない路線は、数から外す

import assert from "node:assert/strict";
import test from "node:test";

import {
  PASS_RIDES, attachTickets, operatorOf, passNote, ridesByOperator,
  ticketNote,
} from "../packages/core/src/tickets.js";

// --- 会社を読む -------------------------------------------------------------

test("路線名の頭から、鉄道会社を読む", () => {
  // Yahoo!は全角で返します。
  assert.equal(operatorOf("ＪＲ東海道本線 品川行"), "JR");
  assert.equal(operatorOf("ＪＲ山手線内回り 東京・上野方面"), "JR");
  assert.equal(operatorOf("一畑電車北松江線"), "一畑電車");
  assert.equal(operatorOf("小田急小田原線 急行"), "小田急");
  assert.equal(operatorOf("江ノ島電鉄線"), "江ノ電");
});

test("会社が分からない路線は、数えない", () => {
  // 「大社線」だけでは、どこの会社か分かりません。推し量りません。
  assert.equal(operatorOf("大社線"), null);
  assert.equal(operatorOf(""), null);
  assert.equal(operatorOf(null), null);
});

test("バス・船・飛行機は、ここで数えない", () => {
  // 1日乗車券の話ではありません。
  assert.equal(operatorOf("一畑バス・大社線(南原経由)"), null);
  assert.equal(operatorOf("高速バス・広島〜松江線"), null);
  assert.equal(operatorOf("ＡＮＡ４６７便"), null);
  assert.equal(operatorOf("隠岐汽船フェリー"), null);
});

// --- 切符の断り書き ---------------------------------------------------------

test("新幹線は、言い切る", () => {
  const n = ticketNote("ＪＲ新幹線ひかり668号 東京行");
  assert.equal(n.kind, "shinkansen");
  assert.match(n.text, /乗車券のほかに特急券/);
  // 買うときに決めることも書きます。
  assert.match(n.text, /指定席|自由席/);
  // 繁忙期に売り切れることも。
  assert.match(n.text, /連休|お盆/);
});

test("私鉄の特急は、要るとは言わない", () => {
  // 小田急ロマンスカーは特急券が要りますが、京急の特急は要りません。
  // 路線名からは決まらないので、決めません。
  const n = ticketNote("小田急小田原線 特急ロマンスカーはこね");
  assert.equal(n.kind, "express");
  assert.match(n.text, /会社によっては/);
  assert.match(n.text, /要らない会社もあります/);
  // 「要ります」と言い切っていないこと。
  assert.ok(!/特急券が要ります。$/.test(n.text));
});

test("ふつうの電車には、何も書かない", () => {
  assert.equal(ticketNote("ＪＲ山手線内回り"), null);
  assert.equal(ticketNote("ＪＲ東海道本線 品川行"), null);
  assert.equal(ticketNote(""), null);
  assert.equal(ticketNote(null), null);
});

test("快速は、特急と読み違えない", () => {
  // 「快速マリンライナー3号」は追加料金の要らない快速です。
  assert.equal(ticketNote("ＪＲ快速マリンライナー3号"), null);
});

test("バスの便名を、特急券の話にしない", () => {
  // 「◯◯号」はバスの便名にもあります。
  assert.equal(ticketNote("高速バス・広島〜松江線 3号"), null);
  assert.equal(ticketNote("ＡＮＡ４６７便"), null);
});

// --- 1日乗車券 --------------------------------------------------------------

const ride = (...lines) => ({
  kind: "transit",
  yahoo: { departure: "09:00", legs: lines.map((line) => ({ line })) },
});

test("同じ会社に何回乗るかを数える", () => {
  const day = { items: [
    ride("一畑電車北松江線", "一畑電車大社線"),
    { kind: "spot" },
    ride("一畑電車大社線"),
    ride("ＪＲ山陰本線"),
  ] };
  assert.deepEqual(ridesByOperator(day), [
    { operator: "一畑電車", rides: 3 },
    { operator: "JR", rides: 1 },
  ]);
});

test("何回も乗る日には、確かめるきっかけを置く", () => {
  const day = { items: [ride("一畑電車北松江線", "一畑電車大社線",
                             "一畑電車北松江線")] };
  const note = passNote(day);
  assert.match(note, /一畑電車に3回/);
  assert.match(note, /1日乗車券/);
  // **「得です」とは言いません。**
  assert.ok(!/得|安い|お得/.test(note), `断定しています: ${note}`);
  // 確かめ先を書きます。
  assert.match(note, /公式サイト/);
  assert.match(note, /こちらでは分からない/);
});

test("2回までなら、何も書かない", () => {
  assert.equal(PASS_RIDES, 3);
  const day = { items: [ride("一畑電車北松江線", "一畑電車大社線")] };
  assert.equal(passNote(day), "");
  assert.equal(passNote({ items: [] }), "");
  assert.equal(passNote(null), "");
});

test("会社の分からない路線だけの日には、何も書かない", () => {
  const day = { items: [ride("大社線", "大社線", "大社線")] };
  assert.equal(passNote(day), "");
});

// --- 旅程に足す -------------------------------------------------------------

test("旅程に、切符の一言が付く", () => {
  const itin = { days: [{ items: [
    ride("ＪＲ東海道本線", "ＪＲ新幹線のぞみ21号"),
    { kind: "spot", title: "どこか" },
    ride("一畑電車北松江線"),
    ride("一畑電車大社線"),
    ride("一畑電車北松江線"),
  ] }] };
  const n = attachTickets(itin);
  assert.equal(n.legs, 1, "新幹線の区間に付いていません");
  assert.equal(n.days, 1);
  const items = itin.days[0].items;
  assert.equal(items[0].tickets.length, 1);
  assert.equal(items[0].tickets[0].kind, "shinkansen");
  assert.equal(items[2].tickets, undefined);
  assert.match(itin.days[0].passNote, /一畑電車に3回/);
});

test("同じ断り書きを、2つ出さない", () => {
  // 乗換で新幹線を2本乗り継いでも、特急券の話は1回で足ります。
  const itin = { days: [{ items: [
    ride("ＪＲ新幹線のぞみ21号", "ＪＲ新幹線さくら551号"),
  ] }] };
  attachTickets(itin);
  assert.equal(itin.days[0].items[0].tickets.length, 1);
});

test("調べた便が無い旅程では、何も足さない", () => {
  // 目安だけで組んだ区間には路線名がありません。
  const itin = { days: [{ items: [
    { kind: "transit", title: "移動", detail: "約42分" },
    { kind: "spot", title: "どこか" },
  ] }] };
  assert.deepEqual(attachTickets(itin), { legs: 0, days: 0 });
  assert.equal(itin.days[0].items[0].tickets, undefined);
  assert.equal(itin.days[0].passNote, undefined);
  assert.deepEqual(attachTickets(null), { legs: 0, days: 0 });
});
