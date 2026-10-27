// 「三都心」は、書いた人の街で指す先が変わる（東京の新宿・渋谷・池袋）。
// 試験用の見本の収録には東京の区が無いので、ここだけ実際の収録を読む。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { detectAreas, originCity } from "../packages/core/src/areas.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => String(url).startsWith("file:")
  ? new Response(readFileSync(new URL(url))) : realFetch(url, ...rest);
const kb = await loadKnowledgeBase();
globalThis.fetch = realFetch;

const trip = (note, from = "東京駅") => makeTrip({
  origin: findPlace(from), note, budgetYen: 999999,
  departAt: new Date("2026-09-01T07:00"),
  arriveBy: new Date("2026-09-05T21:00"),
});
const namesOf = (itin) => itin.regionIds.map((id) => kb.regionsById.get(id).name);

test("「東京の三都心」は東京の新宿・渋谷・池袋。出発地が東京でも同じ", async () => {
  assert.equal(originCity(findPlace("東京駅")), "東京");
  assert.equal(originCity(findPlace("大阪駅")), null);
  const tokyo = ["新宿区", "渋谷区", "豊島区"];
  // 書かれた地名に合わせる（出発地は大阪でも東京の話）
  const named = detectAreas("東京の三都心で遊ぶ", kb);
  assert.deepEqual(named.map((a) => a.term), ["三都心"],
    "「東京」を東京全体の指定として残しています");
  assert.match(named[0].reading, /新宿・渋谷・池袋/);
  for (const [note, from] of [["東京の三都心で遊ぶ", "大阪駅"],
                              ["三都心を回りたい", "東京駅"]]) {
    const itin = await planTrip({ kb, trip: trip(note, from) });
    assert.deepEqual(namesOf(itin).sort(), [...tokyo].sort(), `${note}/${from}`);
    assert.ok(itin.warnings.some((w) => /新宿・渋谷・池袋として読みました/.test(w)));
  }
  // 出発地が東京でも、別の街が書かれていれば東京にしない
  const other = detectAreas("大阪の三都心", kb, { originCity: "東京" });
  assert.ok(!/新宿/.test(other[0]?.reading ?? ""), other[0]?.reading);
});
