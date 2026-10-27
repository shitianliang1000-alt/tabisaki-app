// 旅の目的（デート・アクティブ…）のテスト（packages/core/src/purpose.js）。
//
// 目的は選ぶときの重みです。外しはしないこと、並びは目的で変わること、
// チャットの文から読めることを見ます。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isPurposeWord, purposeAppeal, purposeGenres, purposeHint, purposeNotes,
  purposePace, readPurposes, stripPurposeWords,
} from "../packages/core/src/purpose.js";
import { searchSpotsByKeyword } from "../packages/core/src/kb.js";
import { hasSubstance, readChat } from "../packages/core/src/chatread.js";
import { makeTrip } from "../packages/core/src/trip.js";

const spot = (id, category, name = id, description = "", fame = 50) =>
  ({ id, category, name, description, fame_score: fame, regionId: "r", genres: [] });

test("希望文から目的を読む", () => {
  assert.deepEqual(readPurposes("彼女とデートで横浜に行きたい"), ["date"]);
  assert.deepEqual(readPurposes("体を動かしたい。ハイキングとか"), ["active"]);
  assert.deepEqual(readPurposes("温泉でのんびりしたい"), ["relax"]);
  assert.deepEqual(readPurposes("子連れで行ける所"), ["kids"]);
  assert.deepEqual(readPurposes("社会科見学みたいに学べる旅"), ["learn"]);
  assert.deepEqual(readPurposes("鎌倉を日帰りで"), []);
  // 2つ書けば2つとも
  assert.deepEqual(readPurposes("デートでアクティブに過ごしたい"), ["date", "active"]);
});

test("デートでは、眺め・美術館が前、ダムや横穴墓は後ろ（外しはしない）", () => {
  const view = purposeAppeal(spot("a", "展望台", "夜景の丘", "夜景がきれい"), ["date"]);
  const art = purposeAppeal(spot("b", "美術館"), ["date"]);
  const dam = purposeAppeal(spot("c", "ダム", "宮ヶ瀬ダム"), ["date"]);
  const tomb = purposeAppeal(spot("d", "史跡", "宮ノ前横穴墓群"), ["date"]);
  const plain = purposeAppeal(spot("e", "観光名所"), ["date"]);
  assert.ok(view > art && art > plain, `${view} ${art} ${plain}`);
  assert.ok(plain > dam && plain > tomb);
  assert.ok(dam > 0 && tomb > 0, "0 にはしません（外さない）");
  assert.equal(purposeAppeal(spot("f", "ダム"), []), 0.5, "目的が無ければ何もしない");
});

test("アクティブでは山・渓谷が前、資料館は後ろ", () => {
  assert.ok(purposeAppeal(spot("a", "渓谷"), ["active"])
    > purposeAppeal(spot("b", "博物館", "郷土資料館"), ["active"]));
});

test("目的で並びが変わる（探す語が無いときも）", () => {
  const kb = { spots: [
    spot("dam", "ダム", "大きなダム", "", 70),
    spot("garden", "庭園", "湖畔の庭園", "眺めのいい庭", 55),
    spot("mtn", "山", "金時山", "ハイキングの人気の山", 55),
  ] };
  const none = searchSpotsByKeyword(kb, []).map((m) => m.spot.id);
  assert.equal(none[0], "dam", "目的が無ければ知名度順");
  const date = searchSpotsByKeyword(kb, [], { purposes: ["date"] }).map((m) => m.spot.id);
  assert.equal(date[0], "garden");
  assert.equal(date.at(-1), "dam");
  const active = searchSpotsByKeyword(kb, [], { purposes: ["active"] }).map((m) => m.spot.id);
  assert.equal(active[0], "mtn");
  assert.equal(date.length, 3, "外しません");
});

test("実際の収録（神奈川）で、デートの上位にダム・横穴墓・河川が来ない", () => {
  const data = JSON.parse(readFileSync(new URL("../kb/spots-jp14-kanagawa.json", import.meta.url)));
  const kb = { spots: data.spots ?? data };
  const top = searchSpotsByKeyword(kb, [], { purposes: ["date"], limit: 15 })
    .map((m) => `${m.spot.name}（${m.spot.category}）`);
  for (const t of top) {
    assert.ok(!/ダム|横穴|墓|河川/.test(t), `デートの上位に ${t}`);
  }
});

test("エリアの性格・ペース・添える一言・AIへの一言", () => {
  assert.ok(purposeGenres(["date"]).includes("view"));
  assert.ok(purposeGenres(["active"]).includes("nature"));
  assert.equal(purposePace(["active"]), "packed");
  assert.equal(purposePace(["relax", "date"]), "relaxed");
  assert.equal(purposePace(["relax", "active"]), null, "逆向きなら寄せない");
  assert.equal(purposePace(["learn"]), null);
  assert.match(purposeNotes(["date"])[0], /デート/);
  assert.match(purposeHint(["date", "active"]), /デート・アクティブ/);
  assert.equal(purposeHint([]), "");
});

test("目的を言うだけの語は探す語にしない", () => {
  assert.ok(isPurposeWord("デート"));
  assert.ok(isPurposeWord("子連れ"));
  assert.ok(!isPurposeWord("夜景"));
  assert.ok(!isPurposeWord("ハイキング"), "ハイキングは場所を探す語として残す");
});

test("チャット: 目的を札に出し、目的だけの返信は条件の言い直しとして扱う", () => {
  const r = readChat("デートで横浜に行きたい");
  assert.deepEqual(r.purposes, ["date"]);
  assert.ok(r.labels.includes("目的: デート"));
  assert.ok(hasSubstance(r.rest), "横浜は中身として残る");
  const again = readChat("デート向けにして");
  assert.deepEqual(again.purposes, ["date"]);
  assert.ok(!hasSubstance(again.rest), `残り: ${again.rest}`);
  assert.equal(stripPurposeWords("アクティブにしたい").includes("アクティブ"), false);
});

test("旅のモデルは正しい目的だけを持つ", () => {
  const t = makeTrip({
    origin: { name: "東京駅", lat: 35.68, lng: 139.77 },
    departAt: new Date(2026, 9, 20, 9), arriveBy: new Date(2026, 9, 20, 19),
    purposes: ["date", "date", "nope", "active"],
  });
  assert.deepEqual(t.purposes, ["date", "active"]);
  assert.deepEqual(makeTrip({
    origin: { name: "東京駅", lat: 35.68, lng: 139.77 },
    departAt: new Date(2026, 9, 20, 9), arriveBy: new Date(2026, 9, 20, 19),
  }).purposes, []);
});
