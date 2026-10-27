// エリアを地図で探す（js/areamap.js）。
//
// 地図で選んだエリアは、「どんな旅にしたい？」の欄に入るだけです。
// 選び直したときに「鎌倉で、箱根で、…」と積み上がらないこと、
// 書いてあった希望が消えないことを見ます。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { curatedAreas, groupByBlock, noteWithArea } from "../js/areamap.js";
import { detectAreas } from "../packages/core/src/areas.js";

test("空の欄には「〇〇をめぐる」が入る", () => {
  assert.equal(noteWithArea("", "箱根"), "箱根をめぐる");
  assert.equal(noteWithArea("   ", "箱根"), "箱根をめぐる");
});

test("書いてあった希望は残して、前にエリアを足す", () => {
  assert.equal(noteWithArea("温泉でゆっくり", "箱根"), "箱根で、温泉でゆっくり");
});

test("もう書いてあるエリアは、二重に入れない", () => {
  assert.equal(noteWithArea("箱根で美術館", "箱根"), "箱根で美術館");
});

test("選び直すと、前に入れた分と入れ替わる", () => {
  let note = noteWithArea("温泉でゆっくり", "箱根");
  note = noteWithArea(note, "草津温泉", "箱根");
  assert.equal(note, "草津温泉で、温泉でゆっくり");
  assert.equal(noteWithArea("箱根をめぐる", "鎌倉", "箱根"), "鎌倉をめぐる");
});

test("地図に出すのは、説明と駅のある主なエリアだけ", () => {
  const got = curatedAreas([
    { id: "a", name: "箱根", tagline: "t", description: "d", station: "s", lat: 35, lng: 139 },
    { id: "b", name: "〇〇村", lat: 36, lng: 138 },
    { id: "c", name: "座標なし", tagline: "t", description: "d", station: "s" },
  ]);
  assert.deepEqual(got.map((r) => r.id), ["a"]);
});

test("一覧は地方ごと、北から並ぶ", () => {
  const groups = groupByBlock([
    { id: "naha", prefecture: "沖縄県", lat: 26.2 },
    { id: "kamakura", prefecture: "神奈川県", lat: 35.3 },
    { id: "nikko", prefecture: "栃木県", lat: 36.7 },
    { id: "sapporo", prefecture: "北海道", lat: 43 },
  ]);
  assert.deepEqual(groups.map((g) => g.block), ["北海道", "関東", "沖縄"]);
  assert.deepEqual(groups[1].areas.map((a) => a.id), ["nikko", "kamakura"]);
});

test("地図で選んだ文から、そのエリアが読み取れる（収録の全エリア）", () => {
  // 欄に入れた文を、旅程づくりが別の場所と読んでは意味がありません。
  const { regions } = JSON.parse(readFileSync(
    new URL("../kb/regions.json", import.meta.url), "utf8"));
  const areas = curatedAreas(regions);
  assert.ok(areas.length >= 30, `主なエリアが ${areas.length} しかありません`);
  const missed = areas.filter((r) => !detectAreas(noteWithArea("", r.name), { regions })
    .some((a) => a.regionIds?.includes(r.id)));
  assert.deepEqual(missed.map((r) => r.name), []);
});
