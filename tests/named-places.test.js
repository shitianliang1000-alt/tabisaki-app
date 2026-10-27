// 地方名が収録に当たっても、名指しされた場所は調べにいく。
//
// 「北海道の…宗谷岬、知床、青い池を巡りたい」で、北海道が当たった時点で
// 打ち切られ、宗谷岬は「収録がありません」で終わっていました。
// 当たったのは地方名で、名指しされた場所は何ひとつ調べていません。

import assert from "node:assert/strict";
import test from "node:test";

import { discoverArea, resolveDestination } from "../packages/core/src/discover.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

/** モデル呼び出しの差し替え。プロンプトの一部で応答を選びます。 */
function stubCall(map) {
  return async (prompt) => {
    for (const [needle, doc] of map) {
      if (prompt.includes(needle)) return JSON.stringify(doc);
    }
    throw new Error(`想定外のプロンプト: ${prompt.slice(0, 40)}`);
  };
}

const HOKKAIDO_NOTE = "北海道の有名な観光地を周遊したい。"
  + "宗谷岬、知床、青い池をめぐりたい。";

const HOKKAIDO_RESOLVED = {
  intent: "北海道の名所めぐり",
  places: [
    { name: "宗谷岬", country: "日本", kind: "spot", lat: 45.5228, lng: 141.9368 },
    { name: "知床", country: "日本", kind: "region", lat: 44.0700, lng: 145.0000 },
    { name: "青い池", country: "日本", kind: "spot", lat: 43.4922, lng: 142.6300 },
  ],
};

function hokkaidoArea(id, name, lat, lng, spots) {
  return { areas: [{
    id, name, country: "日本", prefecture: "北海道", lat, lng,
    station: `${name}周辺`, stationLat: lat, stationLng: lng,
    tagline: "", description: "",
    spots: spots.map(([n, cat, dlat, dlng]) => ({
      name: n, category: cat, lat: dlat, lng: dlng,
      dwell: 60, open: 0, close: 24, fee: 0, fame: "major", description: "",
    })),
  }] };
}

const HOKKAIDO_CALL = stubCall([
  ["どこへ行きたいのか", HOKKAIDO_RESOLVED],
  ["「宗谷岬」", hokkaidoArea("souya", "宗谷岬", 45.5228, 141.9368, [
    ["宗谷岬", "海岸", 45.5228, 141.9368],
    ["宗谷丘陵", "丘", 45.4900, 141.9200],
    ["稚内公園", "公園", 45.4150, 141.6700]])],
  ["「知床」", hokkaidoArea("shiretoko", "知床", 44.0700, 145.0000, [
    ["知床五湖", "湖", 44.1200, 145.0900],
    ["オシンコシンの滝", "滝", 44.0500, 144.9000],
    ["知床峠", "峠", 44.0300, 145.0500]])],
  ["「青い池」", hokkaidoArea("biei", "美瑛・青い池", 43.4922, 142.6300, [
    ["青い池", "湖", 43.4922, 142.6300],
    ["白ひげの滝", "滝", 43.5300, 142.6600],
    ["四季彩の丘", "丘", 43.5600, 142.4700]])],
]);

const hokkaidoWired = {
  resolve: (t, o) => resolveDestination(t, { ...o, call: HOKKAIDO_CALL }),
  discover: (t, o) => discoverArea(t, { ...o, call: HOKKAIDO_CALL, useCache: false }),
};

const hokkaidoTrip = () => makeTrip({
  origin: findPlace("札幌駅") ?? findPlace("東京駅"), budgetYen: 999999,
  note: HOKKAIDO_NOTE,
  departAt: new Date("2026-09-01T09:00"),
  arriveBy: new Date("2026-09-06T19:00"),
});

test("地方名が収録に当たっても、名指しされた場所を調べにいく", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: hokkaidoTrip(), ...hokkaidoWired });
  const said = itin.warnings.join("\n");
  assert.ok(!/宗谷岬.*収録がありません/.test(said),
    `調べずに「収録がありません」と言っています:\n${said}`);
  assert.match(said, /AIが検索して調べた/);
});

test("名指しされた場所が、実際に旅程へ入る", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: hokkaidoTrip(), ...hokkaidoWired });
  const names = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  const wanted = ["宗谷岬", "知床五湖", "青い池"];
  const hit = wanted.filter((w) => names.some((n) => n.includes(w)));
  assert.ok(hit.length >= 2,
    `名指しの場所が入っていません。立ち寄り: ${names.join("、")}`);
});

test("札幌・函館だけを選んで終わりにしない", async () => {
  const kb = await loadKnowledgeBase();
  const itin = await planTrip({ kb, trip: hokkaidoTrip(), ...hokkaidoWired });
  assert.notEqual(itin.regionName, "札幌・函館",
    "名指しを無視して収録済みのエリアだけで組んでいます");
});
