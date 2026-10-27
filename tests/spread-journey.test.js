// 「日本全国」で1か所に固まらない。移動を楽しみたい人に、近場の旅程を返さない。
//
// 「日本全国の有名な観光地をめぐりたい」で7日の旅を組むと、
// 高知・広島・宮島・松山・道後・直島（瀬戸内だけ）になっていました。
// 「青春18きっぷで移動を楽しみたい」は、奈良公園・宇治・大阪の3つでした。

import assert from "node:assert/strict";
import test from "node:test";

import { areaScope, blockOf, detectAreas } from "../packages/core/src/areas.js";
import { wantsToEnjoyTravel, readIntent } from "../packages/core/src/intent.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip, spreadCandidates } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { scoreItinerary } from "../packages/core/src/score.js";
import { makeTrip } from "../packages/core/src/trip.js";

const kb = await loadKnowledgeBase();

const trip = (note, dep, arr, extra = {}) => makeTrip({
  origin: findPlace("東京駅"), note, budgetYen: 999999,
  departAt: new Date(dep), arriveBy: new Date(arr), ...extra,
});
const blocksOf = (itin) => new Set(itin.regionIds
  .map((id) => blockOf(kb.regionsById.get(id))));

test("「日本全国」は範囲の指定として読む（全国的に、は読まない）", () => {
  const nation = detectAreas("日本全国の名所をめぐりたい", kb);
  assert.equal(nation.length, 1);
  assert.equal(nation[0].kind, "nation");
  assert.ok(nation[0].regionIds.length >= kb.regions.length - 5);
  const scope = areaScope(nation);
  assert.equal(scope.spread, true);
  assert.ok(new Set(scope.groupById.values()).size >= 5,
    "地方ごとの内訳がありません");

  assert.deepEqual(detectAreas("全国的に有名な温泉に行きたい", kb), []);
  // ほかに地名があるなら、そちらが言いたいことです。
  const kyoto = detectAreas("全国の中でも京都がいい", kb);
  assert.ok(!kyoto.some((a) => a.kind === "nation"));
});

test("九州は県ごとに散らし、九州の別府は散らさない", () => {
  const wide = areaScope(detectAreas("九州をめぐりたい", kb));
  assert.equal(wide.spread, true);
  assert.ok(new Set(wide.groupById.values()).size >= 3);

  const pinned = areaScope(detectAreas("九州の別府に行きたい", kb));
  assert.equal(pinned.spread, false);
  assert.equal(pinned.groupById, null);
});

test("移動を楽しみたい、を希望文から読む", () => {
  for (const s of ["青春18きっぷで旅したい", "移動を楽しみたい",
                   "移動をできるだけしたい", "乗り鉄です", "ローカル線の車窓"]) {
    assert.ok(wantsToEnjoyTravel(s), s);
  }
  for (const s of ["温泉でゆっくり", "移動は少なめで", "京都で紅葉"]) {
    assert.ok(!wantsToEnjoyTravel(s), s);
  }
  assert.equal(readIntent("青春18きっぷで").transport, "local");
  assert.equal(readIntent("青春18きっぷで").enjoyTravel, true);
  assert.equal(makeTrip({ ...trip("", "2026-09-01T09:00", "2026-09-01T18:00"),
                          enjoyTravel: true }).enjoyTravel, true);
});

test("候補を地方ごとに1つずつ先に取り、ほかの案で使った地方は外す", () => {
  const r = (id, score) => ({ region: { id }, score });
  const ranked = [r("a1", 9), r("a2", 8), r("a3", 7), r("b1", 6), r("c1", 5)];
  const groups = new Map([["a1", "A"], ["a2", "A"], ["a3", "A"],
                          ["b1", "B"], ["c1", "C"]]);
  assert.deepEqual(spreadCandidates(ranked, 3, null).map((c) => c.region.id),
                   ["a1", "a2", "a3"]);
  assert.deepEqual(spreadCandidates(ranked, 3, groups).map((c) => c.region.id),
                   ["a1", "b1", "c1"]);
  assert.deepEqual(
    spreadCandidates(ranked, 3, groups, { avoidRegionIds: ["a1"] })
      .map((c) => c.region.id), ["b1", "c1"]);
  // 外すと足りないなら外しません。
  assert.equal(spreadCandidates(ranked, 3, groups,
    { avoidRegionIds: ["a1", "b1"], need: 2 }).length, 3);
});

test("日本全国の7日間が、1つの地方に固まらない", async () => {
  const itin = await planTrip({ kb, trip: trip("日本全国の有名な観光地をめぐりたい",
    "2026-09-01T09:00", "2026-09-07T19:00") });
  assert.ok(blocksOf(itin).size >= 3,
    `地方が少なすぎます: ${[...blocksOf(itin)].join("・")}`);
  assert.ok(itin.warnings.some((w) => /1か所に固めず/.test(w)));
});

test("日本全国の日帰りでは、2案目が1案目と別の地方になる", async () => {
  const t = trip("日本全国どこでもいい、温泉に行きたい",
                 "2026-09-01T08:00", "2026-09-01T21:00");
  const first = await planTrip({ kb, trip: t });
  assert.equal(first.spread, true);
  const second = await planTrip({ kb, trip: t,
                                  avoidRegionIds: first.regionIds });
  const a = [...blocksOf(first)];
  const b = [...blocksOf(second)];
  assert.ok(!b.some((x) => a.includes(x)),
    `同じ地方です: ${a.join("・")} / ${b.join("・")}`);
});

test("青春18きっぷで移動を楽しみたい人に、近場の1地方だけを返さない", async () => {
  const itin = await planTrip({ kb, trip: trip("青春18きっぷで移動を楽しみたい",
    "2026-09-01T07:00", "2026-09-05T21:00") });
  assert.equal(itin.enjoyTravel, true);
  assert.ok(blocksOf(itin).size >= 2,
    `地方が1つだけです: ${[...blocksOf(itin)].join("・")}`);
  assert.ok(itin.warnings.some((w) => /移動も旅のうち/.test(w)));
});

test("移動も楽しみたいを選ぶと、選ばない場合より広く回る", async () => {
  const dep = "2026-09-01T07:00";
  const arr = "2026-09-05T21:00";
  const plain = await planTrip({ kb, trip: trip("温泉でのんびり", dep, arr) });
  const enjoy = await planTrip({ kb,
    trip: trip("温泉でのんびり", dep, arr, { enjoyTravel: true }) });
  assert.ok(enjoy.regionIds.length > plain.regionIds.length,
    `${enjoy.regionIds.length} <= ${plain.regionIds.length}`);
  assert.equal(enjoy.score.parts.find((p) => p.key === "move").label,
               "移動と見学のつり合い");
});

test("移動を楽しむ旅では、移動が長いことを減点しない", () => {
  const at = (h, m = 0) => new Date(2026, 8, 1, h, m);
  const itin = { days: [{ items: [
    { kind: "transit", start: at(9), end: at(12) },
    { kind: "spot", start: at(12), end: at(14), spot: { genres: [] } },
    { kind: "transit", start: at(14), end: at(16) },
  ] }] };
  const move = (o) => scoreItinerary(itin, o).parts
    .find((p) => p.key === "move").score;
  assert.ok(move({ enjoyTravel: true }) > move({}) + 30,
    `${move({ enjoyTravel: true })} vs ${move({})}`);
});

test("「日本全国有名なところ」を、地名「日本全国有名」として扱わない", async () => {
  const { extractKeywords } = await import("../packages/core/src/keywords.js");
  assert.deepEqual(extractKeywords("日本全国有名なところに行きたい").keywords,
                   ["日本全国"]);
  assert.deepEqual(extractKeywords("四国観光地めぐり").keywords, ["四国"]);
  const itin = await planTrip({ kb, trip: trip("日本全国有名なところに行きたい",
    "2026-09-01T09:00", "2026-09-04T19:00") });
  assert.ok(!/日本全国有名/.test(itin.coverage?.text ?? ""),
    itin.coverage?.text);
});
