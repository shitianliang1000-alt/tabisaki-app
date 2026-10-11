import { test } from "node:test";
import assert from "node:assert/strict";
import { fitTargets } from "../js/map.js";

// 出発地まで入れて合わせると、東京駅から鎌倉では立ち寄りが1本のピンに
// 重なっていました。地図は立ち寄りに合わせます。
test("地図は立ち寄りに合わせる（出発地と終点は外す）", () => {
  const pts = [
    { kind: "origin", lat: 35.68, lng: 139.76 },
    { kind: "spot", lat: 35.31, lng: 139.55 },
    { kind: "spot", lat: 35.32, lng: 139.54 },
    { kind: "end", lat: 35.68, lng: 139.76 },
  ];
  assert.deepEqual(fitTargets(pts).map((p) => p.kind), ["spot", "spot"]);
});

test("立ち寄りが無いときは、全部に合わせる", () => {
  const pts = [{ kind: "origin", lat: 1, lng: 1 }, { kind: "end", lat: 2, lng: 2 }];
  assert.equal(fitTargets(pts).length, 2);
});
