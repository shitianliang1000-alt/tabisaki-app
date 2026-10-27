// 行きは電車、現地は車。この形が選べなかった件のテスト。
//
// 遠出でいちばん多い形なのに、選択肢は「車」か「電車・バス」しか
// ありませんでした。
//   ・「車」を選ぶと、出発地から目的地まで運転する旅程になります
//     （東京から出雲まで、600kmを車で、という旅です）
//   ・「電車・バス」を選ぶと、バスが1日3本の土地を歩かされます
// 新幹線で行って駅でレンタカーを借りる旅は、そのどちらでもありません。
//
// 確かめたいのは「区間ごとに、聞く相手を変えていること」です。
// ひとつの手段で全部聞くと、どちらかが嘘になります。

import assert from "node:assert/strict";
import test from "node:test";

import { modeGroups } from "../packages/core/src/pipeline.js";
import { pickMode } from "../packages/core/src/routes.js";
import { isTouring } from "../packages/core/src/touring.js";
import { makeTrip } from "../packages/core/src/trip.js";
import { readIntent } from "../packages/core/src/intent.js";
import { tripReliability } from "../packages/core/src/reliability.js";

const p = (name, lat) => ({ name, lat, lng: 135.0 });

// 東京 → 松江（拠点）→ 立ち寄り2つ → 松江 → 東京
const POINTS = [p("東京駅", 35.68), p("松江駅", 35.47),
                p("松江城", 35.475), p("出雲大社", 35.40),
                p("東京駅", 35.68)];
const KINDS = ["origin", "station", "spot", "spot", "end"];
const TIMES = POINTS.map((_, i) => new Date(2026, 8, 12, 9 + i));

test("条件に、電車＋現地の車が入る", () => {
  assert.equal(makeTrip({ transport: "transit+car" }).transport, "transit+car");
  // 知らない値は、これまでどおりおまかせに丸めます
  assert.equal(makeTrip({ transport: "bike" }).transport, "any");
});

test("ほかの移動手段では、区間を分けない", () => {
  // 分けると経路検索の回数が増えます。分ける理由があるときだけ分けます。
  for (const t of ["any", "transit", "car", "walk"]) {
    const g = modeGroups(POINTS, TIMES, KINDS, t);
    assert.equal(g.length, 1, `${t} で分かれています`);
    assert.equal(g[0].points.length, POINTS.length);
  }
});

test("電車＋現地の車は、遠出と現地で分ける", () => {
  const g = modeGroups(POINTS, TIMES, KINDS, "transit+car");
  assert.equal(g.length, 3);
  // 出発地 → 拠点は電車
  assert.equal(g[0].mode, "TRANSIT");
  assert.deepEqual(g[0].points.map((x) => x.name), ["東京駅", "松江駅"]);
  // 拠点 → 立ち寄り → 立ち寄りは車
  assert.equal(g[1].mode, "DRIVE");
  assert.deepEqual(g[1].points.map((x) => x.name),
                   ["松江駅", "松江城", "出雲大社"]);
  // 帰りは電車
  assert.equal(g[2].mode, "TRANSIT");
  assert.deepEqual(g[2].points.map((x) => x.name), ["出雲大社", "東京駅"]);
});

test("区間が抜けない（境目の点は両方に入る）", () => {
  const g = modeGroups(POINTS, TIMES, KINDS, "transit+car");
  // つないだときに、元の並びに戻ること
  const joined = g.reduce((acc, x) =>
    acc.length ? [...acc, ...x.points.slice(1)] : [...x.points], []);
  assert.deepEqual(joined.map((x) => x.name), POINTS.map((x) => x.name));
  // 区間の数も同じこと
  const legs = g.reduce((n, x) => n + x.points.length - 1, 0);
  assert.equal(legs, POINTS.length - 1);
});

test("拠点を移す日は、拠点どうしを電車でつなぐ", () => {
  const pts = [p("東京駅", 35.68), p("松江駅", 35.47), p("松江城", 35.475),
               p("出雲市駅", 35.36), p("出雲大社", 35.40), p("東京駅", 35.68)];
  const kinds = ["origin", "station", "spot", "station", "spot", "end"];
  const g = modeGroups(pts, pts.map(() => new Date()), kinds, "transit+car");
  const modes = g.map((x) => x.mode);
  // 電車 → 車 → 電車 → 車 → 電車
  assert.deepEqual(modes, ["TRANSIT", "DRIVE", "TRANSIT", "DRIVE", "TRANSIT"]);
});

test("ひとつだけ答えるときは、遠出のほうを答える", () => {
  // 遠出を車の所要時間で置き換えると、新幹線が消えます。
  assert.equal(pickMode(POINTS, "transit+car"), "TRANSIT");
  assert.equal(pickMode(POINTS, "car"), "DRIVE");
});

test("現地で運転するなら、道の話は同じように出す", () => {
  // 峠や岬のおすすめ、長い運転の休憩。運転するのは同じことです。
  assert.equal(isTouring({ transport: "transit+car" }), true);
  assert.equal(isTouring({ transport: "transit" }), false);
});

test("希望文から読み取れる", () => {
  assert.equal(readIntent("新幹線で行って現地はレンタカー").transport,
               "transit+car");
  assert.equal(readIntent("駅レンタカーを借りたい").transport, "transit+car");
  // 「レンタカーで回りたい」だけなら、これまでどおり車です
  assert.equal(readIntent("レンタカーで回りたい").transport, "car");
  // 「電車で回りたい」を車と読まないこと
  assert.equal(readIntent("電車で回りたい").transport, "transit");
});

test("取れていない区間を、取れたように書かない", () => {
  // 「0区間は確認済み（遠出は実際の便…）」と出ていました。
  // 0区間しか取れていないのに、取れているように読めます。
  const moves = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
    kind: "transit", id: `t${i}`, routed: false, walk: false, ...over,
  }));
  const itin = {
    transport: "transit+car",
    days: [{ items: [...moves(2), ...moves(2, { drive: true })] }],
    hoursWarnings: [],
  };
  const row = tripReliability(itin).checks.find((c) => c.label === "移動時間");
  assert.match(row.detail, /すべて距離からの目安/);
  assert.doesNotMatch(row.detail, /0区間は確認済み/);
});
