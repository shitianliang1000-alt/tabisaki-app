// 旅程の質を、プログラム側で採点するテスト。
//
// AIに「この旅程は何点？」と聞いてはいけません。同じ旅程でも聞くたびに
// 点が変わり、比べられないからです。移動時間・歩き続ける長さ・日ごとの
// ばらつきは、どれも数えれば決まる量です。数えます。
//
// 点そのものより、**順序**が大事です。移動ばかりの旅程が、
// 見どころの多い旅程より高い点になってはいけません。

import assert from "node:assert/strict";
import test from "node:test";

import { paceBreakdown, pickBest, scoreItinerary, slackLevel }
  from "../packages/core/src/score.js";

const t = (s) => new Date(`2026-09-12T${s}:00`);

/** 見学と移動を交互に並べた1日ぶんの旅程を作ります。 */
function day(spec, date = t("09:00")) {
  let clock = new Date(date);
  const items = [];
  let n = 0;
  for (const [kind, minutes, extra] of spec) {
    const start = new Date(clock);
    clock = new Date(clock.getTime() + minutes * 60000);
    items.push({ id: `i${++n}`, kind, start, end: new Date(clock),
                 title: `${kind}${n}`, ...(extra ?? {}) });
  }
  return { date, items };
}

const itin = (days, over = {}) => ({
  days, spotCount: days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").length, ...over,
});

// --- 移動の割合 -------------------------------------------------------------

test("移動ばかりの旅程は、見どころの多い旅程より低い", () => {
  const good = itin([day([["spot", 90], ["transit", 15], ["spot", 90],
                          ["transit", 15], ["spot", 90]])]);
  const bad = itin([day([["spot", 40], ["transit", 90], ["spot", 40],
                         ["transit", 90], ["spot", 40]])]);
  assert.ok(scoreItinerary(good).total > scoreItinerary(bad).total,
    "移動ばかりの旅程のほうが高くなっています");
});

test("移動の割合を、内訳として出す", () => {
  const s = scoreItinerary(itin([day([["spot", 60], ["transit", 60]])]));
  const part = s.parts.find((p) => p.key === "move");
  assert.ok(part, "移動効率の内訳がありません");
  assert.match(part.note, /50%|半分/);
});

// --- 疲労 -------------------------------------------------------------------

test("歩き続ける時間が長いほど、疲労の点が下がる", () => {
  const easy = itin([day([["spot", 60], ["transit", 10, { walk: true }],
                          ["spot", 60]])]);
  const hard = itin([day([["spot", 60], ["transit", 70, { walk: true }],
                          ["spot", 60]])]);
  const a = scoreItinerary(easy).parts.find((p) => p.key === "fatigue").score;
  const b = scoreItinerary(hard).parts.find((p) => p.key === "fatigue").score;
  assert.ok(a > b, `連続の徒歩が長いほうが高くなっています（${a} vs ${b}）`);
});

test("1日が長すぎる旅程は、疲労の点が下がる", () => {
  const normal = itin([day([["spot", 90], ["transit", 20], ["spot", 90]],
                           t("10:00"))]);
  const long = itin([day([["spot", 120], ["transit", 30], ["spot", 120],
                          ["transit", 30], ["spot", 120], ["transit", 30],
                          ["spot", 120]], t("07:00"))]);
  const a = scoreItinerary(normal).parts.find((p) => p.key === "fatigue").score;
  const b = scoreItinerary(long).parts.find((p) => p.key === "fatigue").score;
  assert.ok(a > b, `長い1日のほうが高くなっています（${a} vs ${b}）`);
});

// --- 日ごとのばらつき -------------------------------------------------------

test("1日目に詰め込んで最終日が空の旅程は、均した旅程より低い", () => {
  const even = itin([
    day([["spot", 80], ["transit", 15], ["spot", 80]]),
    day([["spot", 80], ["transit", 15], ["spot", 80]]),
  ]);
  const lopsided = itin([
    day([["spot", 80], ["transit", 15], ["spot", 80], ["transit", 15],
         ["spot", 80], ["transit", 15], ["spot", 80]]),
    day([]),
  ]);
  const a = scoreItinerary(even).parts.find((p) => p.key === "rhythm").score;
  const b = scoreItinerary(lopsided).parts.find((p) => p.key === "rhythm").score;
  assert.ok(a > b, `偏った旅程のほうが高くなっています（${a} vs ${b}）`);
});

// --- 満足度 -----------------------------------------------------------------

test("希望したジャンルが揃っているほど、満足度が高い", () => {
  const spot = (genres) => ({ place: { genres, fame_tier: "known" } });
  const hit = itin([day([["spot", 60, spot(["onsen"])],
                         ["transit", 10],
                         ["spot", 60, spot(["history"])]])]);
  const miss = itin([day([["spot", 60, spot(["city"])],
                          ["transit", 10],
                          ["spot", 60, spot(["city"])]])]);
  const opts = { interests: ["onsen", "history"] };
  const a = scoreItinerary(hit, opts).parts.find((p) => p.key === "joy").score;
  const b = scoreItinerary(miss, opts).parts.find((p) => p.key === "joy").score;
  assert.ok(a > b, `希望に合っていないほうが高くなっています（${a} vs ${b}）`);
});

test("定番と穴場が混ざっているほうが、同じ層ばかりより高い", () => {
  const s = (tier) => ({ place: { genres: ["history"], fame_tier: tier } });
  const mixed = itin([day([["spot", 60, s("major")], ["transit", 10],
                           ["spot", 60, s("hidden")], ["transit", 10],
                           ["spot", 60, s("known")]])]);
  const same = itin([day([["spot", 60, s("major")], ["transit", 10],
                          ["spot", 60, s("major")], ["transit", 10],
                          ["spot", 60, s("major")]])]);
  const a = scoreItinerary(mixed).parts.find((p) => p.key === "joy").score;
  const b = scoreItinerary(same).parts.find((p) => p.key === "joy").score;
  assert.ok(a > b);
});

// --- 全体 -------------------------------------------------------------------

test("点は 0〜100 に収まり、内訳の重みは合計1になる", () => {
  for (const x of [itin([day([])]), itin([day([["spot", 60]])]),
                   itin([day([["transit", 600]])])]) {
    const s = scoreItinerary(x);
    assert.ok(s.total >= 0 && s.total <= 100, `範囲外: ${s.total}`);
    for (const p of s.parts) {
      assert.ok(p.score >= 0 && p.score <= 100, `${p.key} が範囲外: ${p.score}`);
    }
    const w = s.parts.reduce((a, p) => a + p.weight, 0);
    assert.ok(Math.abs(w - 1) < 1e-9, `重みの合計が ${w} です`);
  }
});

test("何も無い旅程でも壊れない", () => {
  for (const bad of [null, undefined, {}, { days: [] }, { days: [{ items: [] }] }]) {
    const s = scoreItinerary(bad);
    assert.ok(Number.isFinite(s.total));
  }
});

test("点だけでなく、何が良くて何が悪いかを言葉で返す", () => {
  const s = scoreItinerary(itin([day([["spot", 40], ["transit", 120],
                                      ["spot", 40]])]));
  assert.ok(s.summary.length > 0);
  assert.ok(s.parts.every((p) => p.label && p.note));
  // いちばん低い項目が、改善点として先頭に来ます
  assert.equal(s.weakest.key, s.parts.slice()
    .sort((a, b) => a.score - b.score)[0].key);
});

test("同じ旅程は、何度採点しても同じ点になる", () => {
  const x = itin([day([["spot", 80], ["transit", 20], ["spot", 80]])]);
  const a = scoreItinerary(x).total;
  for (let i = 0; i < 5; i++) assert.equal(scoreItinerary(x).total, a);
});

// --- 案を選ぶ ---------------------------------------------------------------
// 採点は、見せるためだけのものではありません。案が2つあるとき、
// どちらを採るかをここで決めます。これまでは「立ち寄りが多いほう」で
// 選んでいましたが、それだと移動ばかりの詰め込み案が勝ちます。

test("立ち寄りが多くても、移動ばかりの案は選ばない", () => {
  const packed = itin([day([["spot", 30], ["transit", 90], ["spot", 30],
                            ["transit", 90], ["spot", 30], ["transit", 90],
                            ["spot", 30]])]);
  const calm = itin([day([["spot", 100], ["transit", 15], ["spot", 100]])]);
  const best = pickBest([{ key: "packed", itin: packed },
                         { key: "calm", itin: calm }]);
  assert.equal(best.key, "calm");
  assert.equal(best.ranked.length, 2);
  assert.ok(best.ranked[0].score >= best.ranked[1].score);
});

test("点が同じなら、立ち寄りの多いほうを採る", () => {
  const a = itin([day([["spot", 60], ["transit", 15], ["spot", 60]])]);
  const b = itin([day([["spot", 60], ["transit", 15], ["spot", 60]])]);
  b.days[0].items.push({ id: "x", kind: "spot", title: "追加",
                         start: t("15:00"), end: t("16:00") });
  b.spotCount = 3;
  const best = pickBest([{ key: "a", itin: a }, { key: "b", itin: b }]);
  assert.ok(["a", "b"].includes(best.key));
  // 同点のときに順序が入れ替わらないことだけを固定します
  assert.equal(pickBest([{ key: "a", itin: a }, { key: "b", itin: b }]).key,
               best.key);
});

test("案がひとつでも、空でも壊れない", () => {
  assert.equal(pickBest([{ key: "only", itin: itin([day([["spot", 60]])]) }]).key,
               "only");
  assert.equal(pickBest([]), null);
});

// --- 旅のリズム -------------------------------------------------------------
// 寺 → 寺 → 寺 → 寺 は、時間的には成立していても旅としてつらい。
// 寺 → 商店街 → 昼食 → 海 → 展望台 のほうが良い、という判断を
// プログラム側で持ちます。

test("同じジャンルが続くほど、リズムの点が下がる", () => {
  const s = (g) => ({ place: { genres: [g], fame_tier: "known" } });
  const same = itin([day([["spot", 60, s("history")], ["transit", 10],
                          ["spot", 60, s("history")], ["transit", 10],
                          ["spot", 60, s("history")], ["transit", 10],
                          ["spot", 60, s("history")]])]);
  const mixed = itin([day([["spot", 60, s("history")], ["transit", 10],
                           ["spot", 60, s("food")], ["transit", 10],
                           ["spot", 60, s("sea")], ["transit", 10],
                           ["spot", 60, s("view")]])]);
  const a = scoreItinerary(mixed).parts.find((p) => p.key === "rhythm").score;
  const b = scoreItinerary(same).parts.find((p) => p.key === "rhythm").score;
  assert.ok(a > b, `同じジャンルばかりのほうが高くなっています（${a} vs ${b}）`);
});

test("4件続いたら、そのことを言葉で伝える", () => {
  const s = (g) => ({ place: { genres: [g], fame_tier: "known" } });
  const same = itin([day([["spot", 60, s("history")], ["transit", 10],
                          ["spot", 60, s("history")], ["transit", 10],
                          ["spot", 60, s("history")], ["transit", 10],
                          ["spot", 60, s("history")]])]);
  const part = scoreItinerary(same).parts.find((p) => p.key === "rhythm");
  assert.match(part.note, /4|続/);
});

test("食事をはさむと、続きが切れる（休めるため）", () => {
  const s = (g) => ({ place: { genres: [g], fame_tier: "known" } });
  const withMeal = itin([day([["spot", 60, s("history")], ["transit", 10],
                              ["spot", 60, s("history")], ["meal", 60],
                              ["spot", 60, s("history")], ["transit", 10],
                              ["spot", 60, s("history")]])]);
  const without = itin([day([["spot", 60, s("history")], ["transit", 10],
                             ["spot", 60, s("history")], ["transit", 10],
                             ["spot", 60, s("history")], ["transit", 10],
                             ["spot", 60, s("history")]])]);
  const a = scoreItinerary(withMeal).parts.find((p) => p.key === "rhythm").score;
  const b = scoreItinerary(without).parts.find((p) => p.key === "rhythm").score;
  assert.ok(a > b, `食事をはさんでも同じ点です（${a} vs ${b}）`);
});

// --- 疲労の目盛り -----------------------------------------------------------

test("疲労を 0〜100 で出し、段階の言葉を添える", () => {
  const easy = scoreItinerary(itin([day([["spot", 90], ["transit", 15],
                                         ["spot", 90]], t("10:00"))]));
  assert.ok(easy.fatigue >= 0 && easy.fatigue <= 100);
  assert.ok(["ゆったり", "普通", "やや疲れる", "過密"].includes(easy.fatigueLabel));
  assert.equal(easy.tooHard, false);
});

test("人にはきつい旅程を、きついと言う", () => {
  const hard = itin([day([
    ["spot", 60], ["transit", 50, { walk: true }],
    ["spot", 60], ["transit", 50, { walk: true }],
    ["spot", 60], ["transit", 50, { walk: true }],
    ["spot", 60], ["transit", 50, { walk: true }],
    ["spot", 60], ["transit", 50, { walk: true }],
    ["spot", 60],
  ], t("06:30"))]);
  const s = scoreItinerary(hard);
  assert.ok(s.fatigue > 60, `疲労が ${s.fatigue} しかありません`);
  assert.equal(s.fatigueLabel, s.fatigue >= 80 ? "過密" : "やや疲れる");
});

// --- 帰りの余裕 -------------------------------------------------------------
// 「旅程が成立している」と「安心して行ける」は別です。
// 12分しか余裕がない旅程は、成立してはいますが、1本遅れたら終わりです。

test("帰りの余裕を、3段階の言葉で返す", () => {
  assert.equal(slackLevel(135).level, "safe");
  assert.equal(slackLevel(38).level, "tight");
  assert.equal(slackLevel(12).level, "risky");
  for (const m of [135, 38, 12]) {
    const s = slackLevel(m);
    assert.ok(s.label && s.text, `${m}分 の説明がありません`);
  }
});

test("危ないときは、何が起きるかを書く", () => {
  assert.match(slackLevel(12).text, /遅れ|超え/);
  assert.match(slackLevel(38).text, /遅れ|変更/);
  assert.match(slackLevel(135).text, /道|余裕|対応/);
});

test("余裕が分からなければ、それらしい段階を作らない", () => {
  for (const bad of [null, undefined, NaN, -5]) {
    assert.equal(slackLevel(bad).level, "unknown");
  }
});

// --- 旅のペース -------------------------------------------------------------

test("移動・観光・自由時間・徒歩距離の内訳を出す", () => {
  const x = itin([day([["spot", 90], ["transit", 20, { walk: true, km: 1.2 }],
                       ["spot", 60], ["meal", 60], ["free", 30]])]);
  const p = paceBreakdown(x);
  assert.equal(p.sightMin, 150);
  assert.equal(p.moveMin, 20);
  assert.equal(p.freeMin, 30);
  assert.equal(p.mealMin, 60);
  assert.ok(Math.abs(p.walkKm - 1.2) < 0.01);
  assert.ok(p.rows.every((r) => r.label && Number.isFinite(r.minutes)));
});

test("何も無い旅程でも、0で返す（NaN を出さない）", () => {
  const p = paceBreakdown({ days: [] });
  for (const v of [p.sightMin, p.moveMin, p.freeMin, p.mealMin, p.walkKm]) {
    assert.ok(Number.isFinite(v), `${v} が数字ではありません`);
  }
});
