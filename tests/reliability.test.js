// 「どこまで裏が取れているか」を数える。
//
// このアプリの値打ちは「AIが旅程を書けること」ではありません。書くだけなら
// どこでもできます。実際に行けるかを確かめてあることが違いです。ところが
// 確かめた事実は旅程の中に散らばっていて、画面からは見えませんでした。
// 見えなければ、無いのと同じです。

import assert from "node:assert/strict";
import test from "node:test";

import { estimatedTravel, travelSource, tripReliability }
  from "../packages/core/src/reliability.js";

const move = (extra) => ({ kind: "transit", ...extra });
const spot = (extra) => ({ kind: "spot", ...extra });

test("移動の出どころを見分ける", () => {
  assert.equal(travelSource(move({ routed: true, yahoo: {} })).label,
               "Yahoo!路線情報");
  assert.equal(travelSource(move({ routed: true })).label, "Googleの経路");
  assert.equal(travelSource(move({ routed: false })).label, "距離からの推定");
  // 近くに駅・バス停が無い区間は、「調べそこねた区間」とは別ものです。
  // 作り直しても同じ答えなので、勧める手が変わります。
  assert.equal(travelSource(move({ routed: false, noTransit: true })).key,
               "no-transit");
  assert.match(travelSource(move({ routed: false, noTransit: true })).label,
               /タクシー/);
  assert.equal(travelSource(spot({})), null);
});

test("目安を、もう一度調べて直るものと直らないものに分ける", () => {
  const itin = { days: [{ items: [
    move({ routed: true, yahoo: {} }),
    move({ routed: false }),                    // 引けなかった → 直ることがある
    move({ routed: false, noTransit: true }),   // 駅もバス停も無い → 直らない
    move({ routed: false, walk: true }),        // 歩き → 目安ではありません
    spot({}),
  ] }] };
  const e = estimatedTravel(itin);
  assert.equal(e.total, 2, JSON.stringify(e));
  assert.equal(e.retryable, 1);
  assert.equal(e.noTransit, 1);
});

test("1区間も目安が無ければ、数は0", () => {
  const e = estimatedTravel({ days: [{ items: [
    move({ routed: true, yahoo: {} }),
    move({ routed: false, walk: true }),
  ] }] });
  assert.equal(e.total, 0);
  assert.equal(e.retryable, 0);
});

test("全部の裏が取れていれば、星は多い", () => {
  const r = tripReliability({
    slackMin: 200,
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      move({ routed: true, yahoo: {} }),
      spot({ estimated: false }),
      spot({ estimated: false }),
    ] }],
  });
  assert.equal(r.stars, 5);
  assert.equal(r.level, "high");
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
});

test("目安のままの区間があれば、そう言う", () => {
  const r = tripReliability({
    slackMin: 200,
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      move({ routed: false }),
      spot({ estimated: true }),
    ] }],
  });
  assert.ok(r.stars < 5, `星が ${r.stars} です`);
  const travel = r.checks.find((c) => c.label === "移動時間");
  assert.equal(travel.ok, false);
  assert.match(travel.detail, /2区間のうち1区間/);
  // 「残り1区間は目安です」で止めず、**もう一度調べれば入ることがある**
  // と書きます。読んだ人にできることが無い文は、書いていないのと同じです。
  assert.match(travel.detail, /1区間は時刻を引けませんでした/);
  assert.match(travel.detail, /もう一度調べると入ることがあります/);
  const hours = r.checks.find((c) => c.label === "営業時間");
  assert.match(hours.detail, /1か所のうち0か所/);
});

test("帰りが危ないときは、星を引く", () => {
  const base = {
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      spot({ estimated: false }),
    ] }],
  };
  const safe = tripReliability({ ...base, slackMin: 200 });
  const risky = tripReliability({ ...base, slackMin: 5 });
  assert.ok(risky.stars < safe.stars,
    `余裕5分でも ${risky.stars} 星のままです`);
  assert.equal(risky.checks.find((c) => c.label === "帰りの余裕").ok, false);
});

test("休みに当たりそうなら、そう言う", () => {
  const r = tripReliability({
    slackMin: 200,
    hoursWarnings: ["◯◯museum: 月曜が休みの可能性"],
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      spot({ estimated: false }),
    ] }],
  });
  const closed = r.checks.find((c) => c.label === "休みの日");
  assert.equal(closed.ok, false);
  assert.match(closed.detail, /1か所/);
});

test("駅もバス停も無い区間は、作り直しを勧めない", () => {
  const r = tripReliability({
    slackMin: 200,
    days: [{ items: [
      move({ routed: true, yahoo: {} }),
      move({ routed: false, noTransit: true }),
      spot({ estimated: false }),
    ] }],
  });
  const travel = r.checks.find((c) => c.label === "移動時間");
  assert.match(travel.detail, /1区間は近くに駅・バス停が無いので/);
  assert.match(travel.detail, /タクシーで行くものとして組んでいます/);
  // 直らないものに「もう一度調べると入ります」と書いてはいけません。
  assert.doesNotMatch(travel.detail, /もう一度調べる/);
});

// --- 車の旅 ---------------------------------------------------------------
// 車の旅に「便」も「時刻表」も出てきません。引くのは道のりです。

test("車の旅では、運転時間として数える", () => {
  const r = tripReliability({
    transport: "car",
    slackMin: 200,
    days: [{ items: [
      move({ routed: true }),
      move({ routed: false }),
      spot({ estimated: false }),
    ] }],
  });
  const row = r.checks.find((c) => c.label === "運転時間");
  assert.ok(row, `行の名前が ${r.checks.map((c) => c.label).join("/")} です`);
  assert.match(row.detail, /経路検索で確認/);
  assert.match(row.detail, /道のりが入ることがあります/);
  // 車の旅で「便」や「時刻」の話をしてはいけません。
  assert.doesNotMatch(row.detail, /便|時刻/);
});

test("電車の旅の言いかたは、これまでどおり", () => {
  const r = tripReliability({
    transport: "transit",
    slackMin: 200,
    days: [{ items: [move({ routed: true, yahoo: {} }), spot({})] }],
  });
  assert.ok(r.checks.find((c) => c.label === "移動時間"));
});
