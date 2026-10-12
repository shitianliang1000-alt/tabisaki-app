// チャットの質問に答えるテスト（js/qa.js）。
//
// 質問と、旅程を組む頼みを取り違えると、聞いたのに旅程が変わる・
// 頼んだのに文しか返らない、のどちらかになります。迷う言い方は
// 組むほうに倒すことを見ます。

import test from "node:test";
import assert from "node:assert/strict";
import { answerQuestion, isQuestion, itineraryContext, routeText } from "../js/qa.js";

test("旅の質問は、質問として読む", () => {
  for (const t of ["鶴岡八幡宮は何時まで？", "雨だったらどうする？", "この旅の費用はいくら",
                   "持ち物は何がいる？", "小町通りって混んでる?", "拝観料を教えて"]) {
    assert.equal(isQuestion(t), true, t);
  }
});

test("旅程を組む・直す頼みは、質問にしない", () => {
  for (const t of ["明日晴れている東京に近いところに行きたい(日帰り)", "もっとゆっくりにして",
                   "日帰りにして", "京都でおすすめの場所は？", "どこに行けばいい？",
                   "温泉でゆっくりしたい", "鎌倉", "箱根へ1泊2日で組んで？"]) {
    assert.equal(isQuestion(t), false, t);
  }
});

const ITIN = {
  title: "鎌倉", prefecture: "神奈川県",
  days: [{ date: new Date(2026, 9, 12), items: [
    { kind: "transit", title: "東京駅 → 鎌倉駅", start: new Date(2026, 9, 12, 9, 0) },
    { kind: "spot", title: "鶴岡八幡宮", start: new Date(2026, 9, 12, 10, 5) },
    { kind: "free", title: "自由時間", start: new Date(2026, 9, 12, 11, 0) },
  ] }],
};

test("いまの旅程を、時刻つきの短い文にして渡す", () => {
  const t = itineraryContext(ITIN);
  assert.match(t, /旅先: 鎌倉（神奈川県）/);
  assert.match(t, /1日目（10月12日）/);
  assert.match(t, /10:05 鶴岡八幡宮/);
  assert.doesNotMatch(t, /自由時間/);
  assert.match(itineraryContext(null), /まだ旅程はありません/);
});

test("答えは、AIの返した文をそのまま返し、旅程と質問を渡している", async () => {
  let seen = "";
  const got = await answerQuestion("鶴岡八幡宮は何時まで？", { itin: ITIN, history: [{ q: "前の質問", a: "前の答え" }] }, {
    call: async (prompt) => { seen = prompt; return { answer: "6時から20時までです。" }; },
  });
  assert.equal(got.ok, true);
  assert.equal(got.answer, "6時から20時までです。");
  assert.match(seen, /質問: 鶴岡八幡宮は何時まで？/);
  assert.match(seen, /10:05 鶴岡八幡宮/);
  assert.match(seen, /Q: 前の質問/);
});

test("答えが作れなかったら、そう言う（作り話で埋めない）", async () => {
  const got = await answerQuestion("何時まで？", {}, { call: async () => ({}) });
  assert.equal(got.ok, false);
  assert.match(got.answer, /うまく答えを作れませんでした/);
});

test("あいさつや旅行以外の質問も、答える側に回す", () => {
  for (const t of ["こんにちは", "東京タワーの高さは？", "富士山について", "ありがとう", "エベレストの標高"]) {
    assert.equal(isQuestion(t), true, t);
  }
  for (const t of ["鎌倉", "富士山に行きたい", "京都へ2泊3日で"]) {
    assert.equal(isQuestion(t), false, t);
  }
});

test("これまでのやりとりをAIに渡す（8件まで）", async () => {
  let seen = "";
  const history = Array.from({ length: 10 }, (_, i) => ({ q: `質問${i}`, a: `答え${i}` }));
  await answerQuestion("それはいつ建った？", { history }, { call: async (p) => { seen = p; return { answer: "x" }; } });
  assert.match(seen, /Q: 質問9/);
  assert.match(seen, /Q: 質問2/);
  assert.doesNotMatch(seen, /Q: 質問1\n/);
  assert.match(seen, /旅行以外の質問にも/);
});

test("旅程の頼みでない文は、話題を問わずふつうの会話として答える", () => {
  for (const t of ["最近疲れていて何もやる気が出ないんだよね", "好きな食べ物はありますか", "Pythonでリストを逆順にするには",
                   "こんにちは、元気？", "日本で一番高い山は富士山です"]) {
    assert.equal(isQuestion(t), true, t);
  }
  for (const t of ["鎌倉", "東京タワー", "来週の土曜にして", "もう少し安く", "京都で2泊3日", "鎌倉でおいしいものを食べたい"]) {
    assert.equal(isQuestion(t), false, t);
  }
});

test("案を求める頼みは、AIが案を挙げる側に回す", () => {
  for (const t of ["デートスポットを考えて", "東京の穴場を教えて", "雨の日に行ける場所を紹介して"]) {
    assert.equal(isQuestion(t), true, t);
  }
  for (const t of ["箱根へデートで1泊2日", "デートプランを組んで", "鎌倉でデートしたい"]) {
    assert.equal(isQuestion(t), false, t);
  }
});

test("決めきれない文は、AIに質問か旅程の頼みかを聞く", async () => {
  assert.equal(routeText("鎌倉"), "plan");
  assert.equal(routeText("京都で2泊3日"), "plan");
  assert.equal(routeText("こんにちは"), "ask");
  assert.equal(routeText("デートスポットを考えて"), "either");
  assert.equal(routeText("最近疲れていて何もやる気が出ないんだよね"), "either");
  let seen = "";
  const asked = await answerQuestion("週末ひとりで静かに過ごしたい気分", {}, {
    mayPlan: true, call: async (p) => { seen = p; return { plan: true }; },
  });
  assert.equal(asked.plan, true);
  assert.match(seen, /旅程づくりの頼みか判断/);
  const said = await answerQuestion("東京タワーの高さは？", {}, {
    mayPlan: true, call: async () => ({ answer: "333mです。" }),
  });
  assert.equal(said.plan, undefined);
  assert.equal(said.answer, "333mです。");
});
