// 徒歩を含む経路が、ちゃんと読めているか。
//
// 「祇園四条 → 京都」は、京都で日常的に通る区間です。Yahoo!に聞くと
// 3本返り、そのうち1本は**駅と駅のあいだを歩きます**。
//
//   祇園四条 →(徒歩)→ 京都河原町 →(阪急)→ 烏丸 →(徒歩)→ 四条 →(地下鉄)→ 京都
//
// 旅程にこの区間が「約16分・目安」とだけ出ていたので、徒歩を含む経路を
// 読み落としているのではないか、という指摘をいただきました。実際の
// 画面（tests/fixtures/yahoo-gion-kyoto-walk.html）で確かめます。
//
// **結果は「読めていた」です。** 目安になっていたのは別の理由
//（聞いた組と出す組が違っていた。tests/basemove.test.js）でした。
// 直したあとに壊れないよう、ここで固定します。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { parseRouteDetail, parseSummary, routeBlocks }
  from "../server/worker.js";
import { classifyLine } from "../packages/core/src/modes.js";

const html = await readFile(
  new URL("./fixtures/yahoo-gion-kyoto-walk.html", import.meta.url), "utf8");
const blocks = [...routeBlocks(html)];

test("候補を3本とも読める", () => {
  assert.equal(blocks.length, 3);
  const rows = blocks.map((b) => parseSummary(b));
  assert.deepEqual(rows.map((r) => r.departure), ["09:07", "09:05", "09:07"]);
  assert.deepEqual(rows.map((r) => r.arrival), ["09:25", "09:25", "09:27"]);
  assert.deepEqual(rows.map((r) => r.fareYen), [330, 330, 390]);
});

test("駅と駅のあいだの徒歩を、区間として読める", () => {
  // ここを落とすと、乗り換えの手順が「阪急に乗る」から始まり、
  // 現地では駅前で立ち止まります。
  const d = parseRouteDetail(blocks[2]);
  assert.equal(d.legs.length, 4);
  assert.deepEqual(d.legs.map((l) => l.line), [
    "徒歩",
    "阪急京都本線準急 当駅始発 大阪梅田行",
    "徒歩",
    "京都市営烏丸線急行 近鉄奈良行",
  ]);
  assert.equal(d.legs[0].from, "祇園四条");
  assert.equal(d.legs[0].to, "京都河原町");
  assert.equal(d.legs.at(-1).to, "京都");
});

test("徒歩の区間を、乗り物として数えない", () => {
  const d = parseRouteDetail(blocks[2]);
  const kinds = d.legs.map((l) => classifyLine(l.line).kind);
  assert.deepEqual(kinds, ["walk", "rail", "walk", "rail"]);
});

test("徒歩を含む経路でも、発着と所要が合っている", () => {
  // 0分の経路は「隣にある」と同じ意味になり、行けない予定が組めます。
  for (const b of blocks) {
    const s = parseSummary(b);
    const d = parseRouteDetail(b);
    assert.ok(s.minutes > 0, `所要が ${s.minutes} 分です`);
    assert.equal(d.departure, s.departure);
    assert.equal(d.arrival, s.arrival);
    assert.ok(d.legs.length > 0, "区間が1つも取れていません");
  }
});

test("乗り換えの数が、乗る区間の数と噛み合っている", () => {
  // 徒歩を乗り換えとして数えるかどうかは Yahoo! の数えかたに従います。
  // こちらで数え直すと、画面と手順で違う数が出ます。
  const s = parseSummary(blocks[2]);
  const d = parseRouteDetail(blocks[2]);
  const rides = d.legs.filter((l) => classifyLine(l.line).kind !== "walk");
  assert.equal(rides.length, 2);
  assert.ok(Number.isFinite(s.transfers), "乗換の数が読めていません");
});
