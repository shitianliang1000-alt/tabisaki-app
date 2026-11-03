// 旅程の裏取り（ハルシネーション検証）。issue #447。
//
// 旅程に載るものは、収録（kb）か時刻表・経路の検索に根拠があること。
// 根拠の無いものは外すか、そう書くこと。そして、どの道で組んでも
// 必ずこの検証を通ること。

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { groundItinerary, properNames, unknownNames } from "../packages/core/src/grounding.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- 小さな収録 -------------------------------------------------------------

const KIYOMIZU = { id: "kyoto-1", name: "清水寺", region: "京都", prefecture: "京都府",
  category: "寺院", lat: 34.9949, lng: 135.785 };
const CLOSED = { id: "kyoto-2", name: "閉じた資料館", region: "京都", prefecture: "京都府",
  category: "博物館", lat: 35.0, lng: 135.76, status: "closed" };
const ASO = { id: "aso-1", name: "阿蘇山 中岳火口", region: "阿蘇", prefecture: "熊本県",
  category: "山", description: "活火山の火口を見下ろせる", lat: 32.884, lng: 131.104 };
const BEACH = { id: "shonan-1", name: "由比ヶ浜海水浴場", region: "鎌倉", prefecture: "神奈川県",
  category: "海水浴場", lat: 35.309, lng: 139.543 };
const SKI = { id: "hakuba-1", name: "八方尾根スキー場", region: "白馬", prefecture: "長野県",
  category: "スキー場", lat: 36.7, lng: 137.83 };

function kbOf(...spots) {
  return {
    spotsById: new Map(spots.map((s) => [s.id, s])),
    regions: [{ id: "kyoto", name: "京都", station: "京都駅" },
              { id: "aso", name: "阿蘇", station: "阿蘇駅" }],
  };
}

const at = (h, m = 0) => new Date(2026, 10, 13, h, m);

function spotItem(spot, extra = {}) {
  return { id: `i-${spot.id}`, kind: "spot", start: at(10), end: at(11),
           title: spot.name, spotId: spot.id, place: spot, costYen: 0,
           reason: "ご希望に近い場所です", ...extra };
}

function itinOf(items, extra = {}) {
  return { days: [{ key: 1, date: at(0), items }], warnings: [], ...extra };
}

// --- 固有名の見つけかた -------------------------------------------------------

test("固有名らしい語だけを拾う（ふつうの言葉は拾わない）", () => {
  assert.deepEqual(properNames("清水寺と伏見稲荷大社をめぐり、登山のあとに温泉へ"),
                   ["清水寺", "伏見稲荷大社"]);
  assert.deepEqual(properNames("名城と古寺、各駅停車の旅"), []);
});

test("旅程にも収録にも無い名前だけを、根拠が無いとみなす", () => {
  const known = { names: ["清水寺", "京都"], hay: "清水寺\n京都" };
  assert.deepEqual(unknownNames("清水寺から京都駅へ、そして金色架空寺へ", known), ["金色架空寺"]);
});

// --- 立ち寄り -------------------------------------------------------------------

test("収録に無い立ち寄りは外して、自由時間にし、そう書く", () => {
  const ghost = { id: "nope", name: "幻の黄金寺", lat: 35, lng: 135.7 };
  const itin = groundItinerary(itinOf([
    { id: "t1", kind: "transit", start: at(9), end: at(10), title: "京都駅 → 幻の黄金寺",
      to: ghost, detail: "約20分（推定）" },
    spotItem(ghost),
  ]), { kb: kbOf(KIYOMIZU) });
  const items = itin.days[0].items;
  assert.equal(items[1].kind, "free");
  assert.equal(items[1].grounding.status, "removed");
  assert.match(items[1].detail, /幻の黄金寺/);
  assert.doesNotMatch(items[0].title, /幻の黄金寺/, "移動の行に名前が残っています");
  assert.equal(itin.grounding.removed.length, 1);
  assert.equal(itin.grounding.ok, false);
  assert.match(itin.warnings[0], /確かめられなかった立ち寄り1か所/);
});

test("閉館した施設は、収録にあっても外す", () => {
  const itin = groundItinerary(itinOf([spotItem(CLOSED)]), { kb: kbOf(CLOSED) });
  assert.equal(itin.days[0].items[0].kind, "free");
  assert.match(itin.grounding.removed[0].why, /閉館/);
});

test("id が崩れていても、同じ名前で近くにある収録の場所に合わせ直す", () => {
  const typo = { ...KIYOMIZU, id: "kyoto-999" };
  const itin = groundItinerary(itinOf([spotItem(typo)]), { kb: kbOf(KIYOMIZU) });
  const item = itin.days[0].items[0];
  assert.equal(item.kind, "spot");
  assert.equal(item.spotId, "kyoto-1");
  assert.equal(item.place, KIYOMIZU);
  assert.equal(item.grounding.status, "verified");
});

test("id は合っていても名前も場所も違うなら、別物として外す", () => {
  const fake = { id: "kyoto-1", name: "大阪城", lat: 34.687, lng: 135.526 };
  const itin = groundItinerary(itinOf([spotItem(fake)]), { kb: kbOf(KIYOMIZU) });
  assert.equal(itin.days[0].items[0].kind, "free");
});

test("滞在時間だけ変えた写しは、収録どおりとみなす（言い換えない）", () => {
  const copy = { ...KIYOMIZU, dwell: 90 };
  const itin = groundItinerary(itinOf([spotItem(copy)]), { kb: kbOf(KIYOMIZU) });
  assert.equal(itin.days[0].items[0].place, copy);
  assert.equal(itin.grounding.rebound.length, 0);
  assert.equal(itin.grounding.ok, true);
});

// --- 移動 ---------------------------------------------------------------------

test("目安の区間に書かれた、時刻表に無い列車名は消す", () => {
  const itin = groundItinerary(itinOf([
    { id: "t1", kind: "transit", start: at(9), end: at(12), title: "東京駅 → 出雲市駅",
      detail: "特急まぼろし号・約180分（推定）", routed: false },
  ]), { kb: kbOf() });
  const t = itin.days[0].items[0];
  assert.doesNotMatch(t.detail, /まぼろし/);
  assert.equal(t.grounding.status, "estimate");
  assert.deepEqual(itin.grounding.trains, ["特急まぼろし号"]);
});

test("収録の時刻表にある列車名と、乗換検索で引いた区間はそのまま", () => {
  const itin = groundItinerary(itinOf([
    { id: "t1", kind: "transit", start: at(9), end: at(12), title: "東京駅 → 出雲市駅",
      detail: "サンライズ出雲・東京 21:50発", routed: false },
    { id: "t2", kind: "transit", start: at(13), end: at(14), title: "京都駅 → 清水寺",
      detail: "のぞみ123号", routed: true, yahoo: { departure: "13:00" } },
  ]), { kb: kbOf() });
  const [a, b] = itin.days[0].items;
  assert.match(a.detail, /サンライズ出雲/);
  assert.match(b.detail, /のぞみ123号/);
  assert.equal(b.grounding.status, "verified");
  assert.equal(b.grounding.source, "yahoo");
});

// --- AIの文 -------------------------------------------------------------------

test("AIの説明に根拠の無い名前があれば、その文を差し替える", () => {
  const itin = groundItinerary(itinOf([
    spotItem(KIYOMIZU, { reason: "金色架空寺の隣にあり、紅葉がきれいです" }),
  ], {
    fromModel: true,
    headline: "清水寺と架空タワーの旅",
    rationale: "京都の清水寺を朝いちばんに。",
  }), { kb: kbOf(KIYOMIZU) });
  assert.equal(itin.headline, "");
  assert.equal(itin.rationale, "京都の清水寺を朝いちばんに。", "根拠のある文まで消しています");
  assert.equal(itin.days[0].items[0].reason, "ご希望に近い場所です");
  assert.equal(itin.grounding.rewritten.length, 2);
});

test("AIが書いていない文（収録からの機械的な説明）は確かめない", () => {
  const itin = groundItinerary(itinOf([spotItem(KIYOMIZU)], {
    fromModel: false, rationale: "ほげ寺の近くです",
  }), { kb: kbOf(KIYOMIZU) });
  assert.equal(itin.rationale, "ほげ寺の近くです");
});

// --- 危険の判断 -------------------------------------------------------------------

test("火山・山・水辺には、判断せずに確かめ先を書く", () => {
  const itin = groundItinerary(itinOf([spotItem(ASO), spotItem(BEACH)]),
                               { kb: kbOf(ASO, BEACH) });
  const keys = itin.safety.map((s) => s.key);
  assert.deepEqual(keys, ["volcano", "mountain", "water"]);
  assert.ok(itin.warnings.some((w) => /気象庁/.test(w)));
  assert.ok(itin.warnings.some((w) => /登山届/.test(w)));
  assert.ok(itin.warnings.some((w) => /海上保安庁/.test(w)));
});

test("冬に車で山へ行くなら、道路の規制の確かめ先を書く", () => {
  const trip = { departAt: new Date(2026, 0, 10), transport: "car" };
  const itin = groundItinerary(itinOf([spotItem(SKI)]), { kb: kbOf(SKI), trip });
  assert.ok(itin.safety.some((s) => s.key === "winter_road"));
  const summer = groundItinerary(itinOf([spotItem(SKI)]),
                                 { kb: kbOf(SKI), trip: { ...trip, departAt: new Date(2026, 7, 1) } });
  assert.ok(!summer.safety.some((s) => s.key === "winter_road"));
});

test("2度通しても、注意書きは増えない", () => {
  const itin = groundItinerary(itinOf([spotItem(ASO)]), { kb: kbOf(ASO) });
  const n = itin.warnings.length;
  groundItinerary(itin, { kb: kbOf(ASO) });
  assert.equal(itin.warnings.length, n);
});

// --- 素通りする道が無いこと ---------------------------------------------------------

const kb = await loadKnowledgeBase();

for (const [label, init] of [
  ["日帰り", { note: "温泉でゆっくり", departAt: "2026-11-13T08:00", arriveBy: "2026-11-13T19:00" }],
  ["1泊", { note: "箱根で山と温泉", departAt: "2026-11-13T08:00", arriveBy: "2026-11-14T19:00" }],
  ["予算を厳しく", { note: "美術館めぐり", departAt: "2026-11-13T08:00", arriveBy: "2026-11-13T19:00",
                     budgetYen: 500, budgetMode: "strict" }],
]) {
  test(`planTrip の旅程は必ず裏取りを通る（${label}）`, async () => {
    const itin = await planTrip({ kb, trip: makeTrip({
      origin: findPlace("東京駅"), interests: [], budgetYen: 999999, ...init,
      departAt: new Date(init.departAt), arriveBy: new Date(init.arriveBy),
    }) });
    assert.equal(itin.grounding?.version, 1);
    const items = itin.days.flatMap((d) => d.items);
    assert.equal(itin.grounding.checked, items.length);
    for (const item of items) {
      assert.ok(item.grounding, `${item.kind}「${item.title}」が確かめられていません`);
      if (item.kind === "spot") {
        assert.equal(kb.spotsById.get(item.spotId)?.name, item.title,
                     `${item.title} が収録と合っていません`);
      }
    }
  });
}

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

test("旅程を組む本体（buildItinerary）を、pipeline.js の外から呼ぶ道が無い", () => {
  const offenders = [];
  for (const dir of ["js", "server", "packages", "tools"]) {
    for (const f of sourceFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, f);
      if (rel === path.join("packages", "core", "src", "pipeline.js")) continue;
      if (rel === path.join("packages", "core", "src", "planner.js")) continue;
      const src = readFileSync(f, "utf8");
      if (/import[^;]*\bbuildItinerary\b[^;]*from/s.test(src)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});

test("pipeline.js が外へ出す旅程は、裏取りを通った planTrip だけ", () => {
  const src = readFileSync(path.join(ROOT, "packages/core/src/pipeline.js"), "utf8");
  assert.match(src, /export async function planTrip\(args\) \{\s*(\/\/[^\n]*\n\s*)*const itin = await assembleTrip\(args\);\s*return groundItinerary\(/);
  assert.doesNotMatch(src, /export[^\n]*assembleTrip/);
  assert.doesNotMatch(src, /export \{[^}]*buildItinerary/);
});
