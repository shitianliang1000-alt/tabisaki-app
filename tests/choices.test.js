// 質問の選択肢を AI が作るテスト（packages/core/src/choices.js、#441）。
//
// AI の返事は偽物です。確かめるのは、こちら側の決まりです:
// 方向性だけ（スポット名・地名は捨てる）、答えとして読めるものだけ、
// 「上記以外（自由に書く）」は必ず最後、だめなら決め打ちへ戻る。

import test from "node:test";
import assert from "node:assert/strict";
import { OTHER, answerDialog, finishDialog, startDialog } from "../packages/core/src/slots.js";
import {
  MAX_CHOICES, buildChoicePrompt, generateChoices, mentionsPlace, placeChecker, readChoiceReply, sanitizeChoices,
} from "../packages/core/src/choices.js";

const NOW = new Date(2026, 10, 3, 10, 0);
// 画面では収録（detectAreas）で引きます。ここでは小さな名簿で代わりにします。
const KB_NAMES = ["嵐山", "箱根", "奥入瀬"];
const isPlace = (t) => KB_NAMES.some((n) => t.includes(n));
const fake = (reply) => async () => (typeof reply === "string" ? reply : JSON.stringify(reply));

const AUTUMN = {
  questions: [
    { id: "destination", choices: [
      { label: "紅葉の山", text: "紅葉がきれいな山へ" },
      { label: "嵐山", text: "嵐山へ" },                       // 地名 → 捨てる
      { label: "古い町並み", text: "古い町並みを歩けるところへ" },
      { label: "清水寺", text: "清水寺へ" },                   // スポット名 → 捨てる
      { label: "渓谷の遊歩道", text: "渓谷沿いを歩けるところへ" },
    ] },
    { id: "dates.start", choices: [
      { label: "今週末", text: "今週末に" },
      { label: "見ごろの時期", text: "見ごろの時期に" },       // 日付として読めない → 捨てる
      { label: "来週末", text: "来週の週末に" },
    ] },
    { id: "dates.nights", choices: [
      { label: "日帰り", text: "日帰りで" },
      { label: "1泊2日", text: "1泊2日で" },
    ] },
  ],
};

test("文脈に合った選択肢に差し替わり、「上記以外」は必ず最後", async () => {
  const d = startDialog("紅葉を見に行きたい", { now: NOW });
  assert.equal(d.phase, "asking");
  const g = await generateChoices(d, { call: fake(AUTUMN), now: NOW, isPlace });
  const dest = g.questions.find((q) => q.slot === "destination");
  assert.equal(dest.ai, true);
  const labels = dest.choices.map((c) => c.label);
  assert.deepEqual(labels, ["おまかせ", "紅葉の山", "古い町並み", "渓谷の遊歩道", OTHER.label]);
  for (const q of g.questions) assert.equal(q.choices.at(-1), OTHER, `${q.slot}.${q.part ?? ""} の最後`);
});

test("スポット名・地名は選択肢に出さない", () => {
  for (const s of ["嵐山へ", "清水寺", "箱根で", "京都の紅葉", "北海道へ", "旭山動物園", "金沢駅の近く"]) {
    assert.equal(mentionsPlace(s, isPlace), true, s);
  }
  for (const s of ["紅葉の山", "古い町並み", "お寺めぐり", "城下町", "海の見える宿", "静かな湖畔", "温泉地へ"]) {
    assert.equal(mentionsPlace(s), false, s);
  }
});

test("収録で引ける名前も捨てる（isPlace）", () => {
  const got = sanitizeChoices([
    { label: "奥入瀬", text: "奥入瀬へ" },
    { label: "渓流沿い", text: "渓流沿いへ" },
  ], { slot: "destination" }, { isPlace });
  assert.deepEqual(got.map((c) => c.label), ["渓流沿い"]);
});

test("日程・人数は、押したら本当に埋まる選択肢だけ", () => {
  const start = sanitizeChoices(AUTUMN.questions[1].choices, { slot: "dates", part: "start" }, { now: NOW });
  assert.deepEqual(start.map((c) => c.label), ["今週末", "来週末"]);
  const people = sanitizeChoices([
    { label: "2人で", text: "2人で" },
    { label: "大切な人と", text: "大切な人と" },          // 人数が読めない
    { label: "子どもと", text: "子どもと家族で" },
  ], { slot: "travelers" }, { now: NOW });
  assert.deepEqual(people.map((c) => c.label), ["2人で", "子どもと"]);
});

test("AI の選択肢を押すと、その文が希望文に入り、同じ質問は出ない", async () => {
  const d = await generateChoices(startDialog("紅葉を見に行きたい", { now: NOW }), { call: fake(AUTUMN), now: NOW, isPlace });
  const q = d.questions.find((x) => x.slot === "destination");
  const pick = q.choices.find((c) => c.label === "紅葉の山");
  const d2 = answerDialog(d, q, { choice: pick.id });
  assert.ok(!d2.questions.some((x) => x.slot === "destination"));
  // 読み直しても、残った質問は AI の選択肢のまま
  const start = d2.questions.find((x) => x.part === "start");
  assert.equal(start.ai, true);
  assert.ok(start.choices.some((c) => c.label === "今週末"));
  const d3 = answerDialog(d2, start, { choice: start.choices.find((c) => c.label === "今週末").id });
  assert.match(finishDialog(d3), /紅葉を見に行きたい。紅葉がきれいな山へ。今週末に/);
});

test("「上記以外」から自由記述でも答えられる", async () => {
  const d = await generateChoices(startDialog("紅葉を見に行きたい", { now: NOW }), { call: fake(AUTUMN), now: NOW });
  const q = d.questions.find((x) => x.slot === "destination");
  assert.ok(q.choices.some((c) => c.free));
  const d2 = answerDialog(d, q, { text: "滝のある渓谷" });
  assert.ok(!d2.questions.some((x) => x.slot === "destination"));
  assert.match(finishDialog(d2), /滝のある渓谷/);
});

test("だめなときは、決め打ちの選択肢のまま聞く", async () => {
  const d = startDialog("温泉でゆっくり", { now: NOW });
  const fixed = JSON.stringify(d.questions);
  for (const call of [
    async () => { throw new Error("429"); },
    fake("ごめんなさい、分かりません"),
    fake({ questions: [{ id: "destination", choices: [{ label: "箱根", text: "箱根へ" }] }] }),
    () => new Promise(() => {}),                                     // 返ってこない
  ]) {
    const g = await generateChoices(d, { call, now: NOW, timeoutMs: 50 });
    assert.equal(JSON.stringify(g.questions), fixed);
  }
  // 鍵が無い（call が無い）
  assert.equal(await generateChoices(d, {}), d);
});

test("前置きや ``` が付いた返事も読める", async () => {
  const raw = "はい。\n```json\n" + JSON.stringify(AUTUMN) + "\n```";
  const g = await generateChoices(startDialog("紅葉を見に行きたい", { now: NOW }), { call: fake(raw), now: NOW });
  assert.ok(g.questions.some((q) => q.ai));
});

test("選択肢は多すぎず、同じものは1つにする", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ label: `海辺${i % 3 === 0 ? "" : i}`, text: "海辺へ" }));
  const got = sanitizeChoices(many, { slot: "destination" });
  assert.ok(got.length <= MAX_CHOICES);
  assert.equal(new Set(got.map((c) => c.label)).size, got.length);
  // 「おまかせ」「上記以外」は AI に作らせない（こちらで足す）
  assert.deepEqual(sanitizeChoices([{ label: "おまかせ" }, { label: "上記以外" }], { slot: "destination" }), []);
});

test("使える選択肢が2つ未満の質問は、決め打ちのまま", () => {
  const got = readChoiceReply({ questions: [{ id: "destination", choices: [{ label: "海辺", text: "海辺へ" }] }] },
    [{ slot: "destination", question: "?" }]);
  assert.deepEqual(got, {});
});

test("頼みごとには、頼んだ文・分かっている条件・季節・方向性だけの決まりが入る", () => {
  const d = startDialog("子どもと動物を見たい", { now: NOW });
  const p = buildChoicePrompt(d.base, d.slots, d.questions, { now: NOW });
  assert.match(p, /子どもと動物を見たい/);
  assert.match(p, /人数: 子ども連れ/);
  assert.match(p, /秋/);
  assert.match(p, /スポット名・地名/);
  assert.match(p, /"destination"/);
  assert.doesNotMatch(p, /id: "travelers"/);  // 分かっている枠は聞かない
});

test("収録の名前で引く（種類を言うだけの名前は地名とみなさない）", () => {
  const kb = {
    regions: [{ id: "hakone", name: "箱根", prefecture: "神奈川県" }],
    names: ["嵐山", "奥入瀬渓流", "水族館", "道の駅", "離島", "登別温泉の地獄谷と多様な泉質の自然湧出源泉、浴場群"].join("\n"),
  };
  const check = placeChecker(kb);
  assert.equal(check("嵐山へ"), true);
  assert.equal(check("箱根でのんびり"), true);
  assert.equal(check("奥入瀬渓流を歩く"), true);
  assert.equal(check("水族館めぐり"), false);
  assert.equal(check("道の駅に寄る"), false);
  assert.equal(check("離島へ"), false);
  // names が無ければ、読み込み済みのスポット名で引く
  assert.equal(placeChecker({ regions: [], spots: [{ name: "金閣寺" }] })("金閣寺へ"), true);
  assert.equal(placeChecker(null), null);
});
