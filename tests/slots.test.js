// 足りない条件だけを聞くテスト（packages/core/src/slots.js、#440）。
//
// いちばん大事なのは「書いたことを聞き直さない」ことです。詳しく書いた人に
// 質問が出たら、この仕組みは逆効果です。

import test from "node:test";
import assert from "node:assert/strict";
import {
  OTHER, SLOTS, answerDialog, composeNote, confirmLines, extractSlots,
  finishDialog, missingQuestions, replyDialog, startDialog,
} from "../packages/core/src/slots.js";

// 2026年11月3日（火）10時
const NOW = new Date(2026, 10, 3, 10, 0);
const asked = (d) => d.questions.map((q) => q.part ? `${q.slot}.${q.part}` : q.slot);

test("枠は issue の8つ", () => {
  assert.deepEqual(SLOTS.map((s) => s.id), [
    "destination", "dates", "travelers", "pace", "transport", "interests", "budget", "weather_constraint",
  ]);
});

test("はじめの文から、全部の枠を一度に読む", () => {
  const s = extractSlots("来週末から2泊3日、2人で金沢へ。電車で、ゆっくり温泉と海鮮。予算3万円、雨でも楽しめるところ", { now: NOW });
  assert.equal(s.destination.label, "金沢");
  assert.equal(s.dates.parts.start.filled, true);
  assert.equal(s.dates.value.nights, 2);
  assert.equal(s.travelers.value, 2);
  assert.equal(s.pace.value, "relaxed");
  assert.equal(s.transport.value, "transit");
  assert.ok(s.interests.value.includes("温泉"));
  assert.equal(s.budget.value, 30000);
  assert.equal(s.weather_constraint.value, "rain-ok");
});

test("詳しく書いた人には、何も聞かない", () => {
  for (const t of [
    "明後日から1泊2日、2人で金沢へ",
    "青春18きっぷで日本縦断、来週末から3泊、ひとり旅",
    "明日、日帰りで鎌倉をひとりで歩きたい",
    "今週末に1泊、家族で箱根に行きたい",
  ]) {
    const d = startDialog(t, { now: NOW });
    assert.equal(d.phase, "ready", `${t} で ${asked(d).join(",")} を聞いています`);
    assert.deepEqual(d.questions, []);
  }
});

test("足りない分だけ聞く（書いたことは聞き直さない）", () => {
  const d = startDialog("明後日から1泊2日で、名古屋から。温泉でゆっくり", { now: NOW });
  // 日程は書いてあるので聞かない。名古屋は出発地なので、行き先は聞く。
  assert.deepEqual(asked(d), ["destination", "travelers"]);
  const e = startDialog("箱根で温泉", { now: NOW });
  assert.deepEqual(asked(e), ["dates.start", "dates.nights", "travelers"]);
});

test("日程は「いつ」と「何日」の足りないほうだけ", () => {
  assert.deepEqual(asked(startDialog("明日、2人で京都", { now: NOW })), ["dates.nights"]);
  assert.deepEqual(asked(startDialog("1泊2日、2人で京都", { now: NOW })), ["dates.start"]);
});

test("画面で選んである欄は、文に無くても聞かない", () => {
  const d = startDialog("京都でお寺めぐり", { now: NOW, set: { start: true, nights: true, travelers: true } });
  assert.equal(d.phase, "ready");
});

test("収録から見つけた行き先を渡せば、それを使う", () => {
  const d = startDialog("あの有名な滝を見たい。明日から日帰り、ひとりで", { now: NOW, areas: [{ term: "日光" }] });
  assert.equal(d.slots.destination.label, "日光");
  assert.equal(d.phase, "ready");
});

test("どの質問にも「上記以外（自由に書く）」がある", () => {
  for (const q of missingQuestions(extractSlots("", { now: NOW }), { max: 99 })) {
    assert.ok(q.choices.some((c) => c.id === OTHER.id && c.free), `${q.slot} に自由記述がありません`);
  }
});

test("一度に聞くのは3つまで。答えると次の足りない分が出る", () => {
  let d = startDialog("どこか行きたい気分", { now: NOW });
  // 「どこか」は行き先おまかせの答え。日程と人数を聞く。
  assert.deepEqual(asked(d), ["dates.start", "dates.nights", "travelers"]);
  d = startDialog("旅行したい", { now: NOW });
  assert.equal(d.questions.length, 3);
  assert.deepEqual(asked(d), ["destination", "dates.start", "dates.nights"]);
  d = answerDialog(d, d.questions[0], { choice: "onsen" });
  assert.deepEqual(asked(d), ["dates.start", "dates.nights", "travelers"]);
});

test("札で答えると、その枠は埋まり、同じことは二度聞かない", () => {
  let d = startDialog("温泉でゆっくり", { now: NOW });
  d = answerDialog(d, d.questions.find((q) => q.slot === "destination"), { choice: "onsen" });
  d = answerDialog(d, d.questions.find((q) => q.part === "start"), { choice: "tomorrow" });
  d = answerDialog(d, d.questions.find((q) => q.part === "nights"), { choice: "1" });
  // 読み取れない自由記述でも、聞いた枠は埋まったことにする。
  d = answerDialog(d, d.questions.find((q) => q.slot === "travelers"), { text: "犬と" });
  assert.equal(d.phase, "ready");
  assert.equal(finishDialog(d, "露天風呂つきの宿"),
    "温泉でゆっくり。温泉地へ。明日から。1泊2日で。犬と。露天風呂つきの宿");
});

test("「おまかせ」を選んだ枠は、それ以上聞かない", () => {
  let d = startDialog("美味しいものが食べたい", { now: NOW });
  d = answerDialog(d, d.questions.find((q) => q.slot === "destination"), { choice: "any" });
  assert.ok(!asked(d).includes("destination"));
  d = answerDialog(d, d.questions.find((q) => q.part === "start"), { choice: "weekend" });
  assert.ok(!asked(d).includes("destination"), "読み直しで「おまかせ」が消えています");
  assert.equal(finishDialog(d), "美味しいものが食べたい。今週末に");
});

test("チャットへの返信からも、全部の枠を読み直す", () => {
  let d = startDialog("海が見たい", { now: NOW });
  d = replyDialog(d, "明日から日帰りで、2人で湘南へ");
  assert.equal(d.phase, "ready");
  assert.equal(d.slots.travelers.value, 2);
});

test("読み取れない返信は追加の要望として受け取り、聞き続けない", () => {
  let d = startDialog("のんびりしたい", { now: NOW });
  d = replyDialog(d, "よろしく");
  assert.equal(d.phase, "ready");
  assert.match(finishDialog(d), /よろしく/);
});

test("確かめの欄には、埋まっていない枠を「おまかせ」と出す", () => {
  const lines = confirmLines(extractSlots("2人で京都", { now: NOW }));
  assert.equal(lines.find((l) => l.slot === "travelers").value, "2人");
  assert.equal(lines.find((l) => l.slot === "budget").value, "おまかせ");
});

test("答えの言葉は、旅程を組む側が読める（chatread で日程になる）", async () => {
  const { readChat } = await import("../packages/core/src/chatread.js");
  for (const def of SLOTS.filter((s) => s.parts)) {
    for (const c of def.parts.nights.choices) {
      assert.equal(readChat(c.text, NOW).nights, Number(c.id), c.text);
    }
    for (const c of def.parts.start.choices) {
      assert.ok(readChat(c.text, NOW).start, `${c.text} が日付として読めません`);
    }
  }
});

test("composeNote は空の答えを足さない", () => {
  assert.equal(composeNote("箱根", ["", "明日から", " "], ""), "箱根。明日から");
});
