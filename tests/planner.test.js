// 組み立てた旅程が、実際に実行できる形になっているかのテスト。
// 検証は verify.js が済ませている前提なので、ここでは並びと欠落を見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { buildItinerary } from "../packages/core/src/planner.js";
import { verifyOrder } from "../packages/core/src/verify.js";
import { END_MODES, makeTrip } from "../packages/core/src/trip.js";
import { mixTargets, balanceByTier } from "../packages/core/src/mix.js";
import { linksForItem, restaurantsUrl, hotelsUrl } from "../js/links.js";
import { fittableSpots, rankRegions } from "../packages/core/src/kb.js";

const d = (s) => new Date(s);
const TOKYO = { name: "東京駅", lat: 35.681236, lng: 139.767125 };
const OSAKA = { name: "大阪駅", lat: 34.702485, lng: 135.495951 };

const REGION = {
  id: "r1", name: "テスト郷", prefecture: "神奈川県",
  station: "テスト駅", stationLat: 35.3190, stationLng: 139.5500,
  lat: 35.32, lng: 139.55, genres: ["history", "onsen"],
};

const spots = [
  { id: "s1", name: "神社A", category: "神社", lat: 35.3200, lng: 139.5520,
    description: "説明1。", fame_tier: "major" },
  { id: "s2", name: "寺B", category: "寺院", lat: 35.3210, lng: 139.5535,
    description: "説明2。", fame_tier: "known" },
  { id: "s3", name: "庭園C", category: "庭園", lat: 35.3220, lng: 139.5545,
    description: "説明3。", fame_tier: "hidden" },
];

function plan(over = {}) {
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-12T19:00"),
    ...over,
  });
  const startAt = d("2026-09-12T10:00");   // 駅到着後
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt,
    end: over.endPlaceOverride ?? TOKYO,
    endBy: trip.arriveBy,
  });
  return {
    trip, verification: v,
    itin: buildItinerary({
      trip, region: REGION, visits: v.visits,
      reasons: new Map(spots.map((s) => [s.id, `${s.name}を選んだ理由`])),
      legs: { outbound: { minutes: 60, routed: false },
              inbound: { minutes: 60, routed: false } },
    }),
  };
}

test("旅程は往路で始まり、復路で終わる", () => {
  const { itin } = plan();
  const items = itin.days.flatMap((x) => x.items);
  assert.equal(items[0].kind, "transit");
  assert.equal(items.at(-1).kind, "transit");
  assert.ok(items[0].title.includes("東京駅"));
});

test("帰りの行は、最後に立ち寄った場所から書く", () => {
  // 拠点の駅の名前を出していたので、宮島から広島駅へ戻る旅程が
  // 「広島駅 → 広島駅 約90分」と出ていました。所要時間は最後の
  // 立ち寄りから測っているので、名前もそこからにします。
  const { itin, verification } = plan();
  const last = itin.days.flatMap((x) => x.items).at(-1);
  const lastSpot = verification.visits.at(-1).spot.name;
  assert.equal(last.title, `${lastSpot} → 東京駅`);
});

test("項目が時系列に並び、重ならない", () => {
  const { itin } = plan();
  for (const day of itin.days) {
    let prev = null;
    for (const item of day.items) {
      assert.ok(item.end >= item.start, `${item.title} の終了が開始より前`);
      if (prev) {
        assert.ok(item.start >= prev,
          `${item.title} が前の項目より前に始まっている`);
      }
      prev = item.end;
    }
  }
});

test("復路は帰着期限までに到着する", () => {
  const { trip, itin } = plan();
  const last = itin.days.flatMap((x) => x.items).at(-1);
  assert.ok(last.end <= trip.arriveBy,
    `帰着 ${last.end.toISOString()} が期限を超えている`);
});

test("同じスポットが二度出てこない", () => {
  const { itin } = plan();
  const ids = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "spot").map((i) => i.spotId);
  assert.equal(ids.length, new Set(ids).size);
});

test("費用の合計が各項目の合計と一致する", () => {
  const { itin } = plan();
  const sum = itin.days.flatMap((x) => x.items)
    .reduce((a, i) => a + (i.costYen ?? 0), 0);
  assert.equal(itin.totalCostYen, sum);
});

test("最終目的地で終わる旅では、出発地に戻らない", () => {
  const { itin } = plan({
    endMode: END_MODES.END_AT_DESTINATION,
    destination: OSAKA,
    arriveBy: d("2026-09-12T22:00"),
    endPlaceOverride: OSAKA,
  });
  const last = itin.days.flatMap((x) => x.items).at(-1);
  assert.ok(last.title.includes("大阪駅"), last.title);
  assert.ok(last.title.includes("最終目的地"), last.title);
});

test("推定移動時間のときは、その旨が警告に出る", () => {
  const { itin } = plan();
  assert.ok(itin.warnings.some((w) => w.includes("推定")), itin.warnings.join(" / "));
});

test("スポットに選定理由が引き継がれる", () => {
  const { itin } = plan();
  const spot = itin.days.flatMap((x) => x.items).find((i) => i.kind === "spot");
  assert.ok(spot.reason.includes("選んだ理由"), spot.reason);
});

test("実データを持つスポットは「目安」警告の対象にならない", () => {
  const withReal = spots.map((s) => ({ ...s, open: 9, close: 18, fee: 500, dwell: 40 }));
  const v = verifyOrder(withReal, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"),
    end: TOKYO, endBy: d("2026-09-12T19:00"),
  });
  const itin = buildItinerary({
    trip: makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                     arriveBy: d("2026-09-12T19:00") }),
    region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: true },
            inbound: { minutes: 60, routed: true } },
  });
  assert.ok(!itin.warnings.some((w) => w.includes("目安です")),
    itin.warnings.join(" / "));
});

// ------------------------------------------------------------- 外部リンク --

test("食事の項目からレストラン検索が開ける", () => {
  const links = linksForItem(
    { kind: "meal", title: "昼食" },
    { lat: 35.32, lng: 139.55, regionName: "テスト郷" });
  assert.equal(links.length, 1);
  assert.ok(links[0].url.includes("google.com/maps"), links[0].url);
  assert.ok(decodeURIComponent(links[0].url).includes("レストラン"));
});

test("夕食は夕食向けのラベルになる", () => {
  const links = linksForItem(
    { kind: "meal", title: "夕食" },
    { lat: 35.32, lng: 139.55, regionName: "テスト郷" });
  assert.ok(links[0].label.includes("ディナー"), links[0].label);
});

test("宿泊の項目からホテル検索が、日付付きで開ける", () => {
  const links = linksForItem(
    { kind: "lodging", title: "宿泊" },
    { lat: 35.32, lng: 139.55, regionName: "テスト郷",
      checkIn: d("2026-09-12T19:00"), checkOut: d("2026-09-13T10:00") });
  assert.equal(links.length, 1);
  const url = links[0].url;
  assert.ok(url.includes("google.com/travel"), url);
  assert.ok(url.includes("checkin=2026-09-12"), url);
  assert.ok(url.includes("checkout=2026-09-13"), url);
});

test("スポットからは地図とWikipediaが開ける", () => {
  const links = linksForItem(
    { kind: "spot" },
    { place: { lat: 35.32, lng: 139.55, name: "神社A" }, wikipedia: "神社A" });
  const labels = links.map((l) => l.label);
  assert.ok(labels.some((l) => l.includes("地図")));
  assert.ok(labels.some((l) => l.includes("Wikipedia")));
  assert.ok(labels.some((l) => l.includes("OpenStreetMap")));
});

test("レストラン検索URLは座標を中心にする", () => {
  const url = restaurantsUrl({ lat: 35.32, lng: 139.55, regionName: "箱根" });
  assert.ok(url.includes("@35.32,139.55"), url);
});

test("ホテル検索は日付が無くても壊れない", () => {
  const url = hotelsUrl({ regionName: "箱根" });
  assert.ok(url.startsWith("https://www.google.com/travel/search"), url);
});

// --------------------------------------------------------- 定番と穴場 ---

test("穴場の枠は、定番寄り設定でも確保される", () => {
  for (let n = 3; n <= 12; n++) {
    assert.ok(mixTargets(n, 0).hidden >= 1, `n=${n}`);
  }
});

test("スライダーを穴場へ動かすほど、穴場が増えて定番が減る", () => {
  // 「スライダーが逆では？」の正体は、振り切っても定番が2割残り、
  // 穴場が4割で頭打ちだったことでした。端は端の結果になるべきです。
  let prev = mixTargets(10, 0);
  for (const b of [0.2, 0.4, 0.6, 0.8, 1]) {
    const t = mixTargets(10, b);
    assert.ok(t.hidden >= prev.hidden, `穴場が減っています b=${b}`);
    assert.ok(t.major <= prev.major, `定番が増えています b=${b}`);
    prev = t;
  }
  assert.ok(mixTargets(10, 0).major >= 7, "定番寄りで定番が少なすぎます");
  assert.ok(mixTargets(10, 1).hidden >= 6, "穴場寄りで穴場が少なすぎます");
});

test("層の合計は必ず指定数に一致する", () => {
  for (let n = 0; n <= 20; n++) {
    for (const b of [0, 0.5, 1]) {
      const t = mixTargets(n, b);
      assert.equal(t.major + t.known + t.hidden, n, `n=${n} b=${b}`);
    }
  }
});

test("balanceByTier は各層から取る", () => {
  const matches = [
    ...Array.from({ length: 4 }, (_, i) => ({
      spot: { id: `M${i}`, fame_tier: "major" }, score: 1 })),
    ...Array.from({ length: 4 }, (_, i) => ({
      spot: { id: `K${i}`, fame_tier: "known" }, score: 1 })),
    ...Array.from({ length: 4 }, (_, i) => ({
      spot: { id: `H${i}`, fame_tier: "hidden" }, score: 1 })),
  ];
  const tiers = new Set(balanceByTier(matches, 6, 0.5).map((m) => m.spot.fame_tier));
  assert.ok(tiers.has("hidden"), "穴場が選ばれていない");
  assert.ok(tiers.has("major"), "定番が選ばれていない");
});

// --------------------------------------------- 旅先の順位付け（回帰） ---

test("強い一致1件より、良い一致3件の旅先が上位に来る", () => {
  // 平均で評価していたときは、1件だけ一致した町が勝っていました。
  const regions = [
    { id: "one", name: "一件だけ", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
    { id: "many", name: "三件ある", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "自然",
    lat: 35.3, lng: 139.5, description: "" });
  const spots = [mk("o1", "one"), mk("m1", "many"), mk("m2", "many"), mk("m3", "many")];
  const spotsByRegion = new Map([
    ["one", [spots[0]]], ["many", spots.slice(1)],
  ]);
  const kb = { spots, regions, spotsByRegion,
               regionsById: new Map(regions.map((r) => [r.id, r])) };
  const matches = [
    { spot: spots[0], score: 1.0 },     // 一件だけ、満点
    { spot: spots[1], score: 0.95 },
    { spot: spots[2], score: 0.9 },
    { spot: spots[3], score: 0.85 },
  ];
  const ranked = rankRegions(kb, matches);
  assert.equal(ranked[0].region.id, "many",
    `一件だけの旅先が勝っている: ${ranked.map((r) => r.region.id)}`);
});

test("弱い一致を大量に持つ大都市が、数の力で勝つことはない", () => {
  const regions = [
    { id: "strong", name: "小さいが的確", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
    { id: "big", name: "大都市", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "自然",
    lat: 35.3, lng: 139.5, description: "" });
  const spots = [mk("s1", "strong"), mk("s2", "strong")];
  for (let i = 0; i < 20; i++) spots.push(mk(`b${i}`, "big"));
  const spotsByRegion = new Map([
    ["strong", spots.slice(0, 2)], ["big", spots.slice(2)],
  ]);
  const kb = { spots, regions, spotsByRegion,
               regionsById: new Map(regions.map((r) => [r.id, r])) };
  const matches = [
    { spot: spots[0], score: 1.0 }, { spot: spots[1], score: 0.95 },
    ...spots.slice(2).map((s) => ({ spot: s, score: 0.2 })),
  ];
  const ranked = rankRegions(kb, matches);
  assert.equal(ranked[0].region.id, "strong",
    "弱い候補を大量に持つ大都市が勝っている");
});

test("希望したジャンルを持つ旅先が優先される", () => {
  const regions = [
    { id: "onsen-town", name: "温泉街", stationLat: 35.3, stationLng: 139.5,
      genres: ["onsen", "nature"], prefecture: "X" },
    { id: "mountain", name: "山", stationLat: 35.3, stationLng: 139.5,
      genres: ["nature"], prefecture: "X" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "温泉",
    lat: 35.3, lng: 139.5, description: "" });
  const spots = [mk("a", "onsen-town"), mk("b", "mountain")];
  const kb = {
    spots, regions,
    spotsByRegion: new Map([["onsen-town", [spots[0]]], ["mountain", [spots[1]]]]),
    regionsById: new Map(regions.map((r) => [r.id, r])),
  };
  const matches = [
    { spot: spots[1], score: 1.0 },   // 山のほうがわずかに一致が強い
    { spot: spots[0], score: 0.95 },
  ];
  const plain = rankRegions(kb, matches);
  assert.equal(plain[0].region.id, "mountain", "前提: 素の一致では山が勝つ");

  const withGenre = rankRegions(kb, matches, 8, { wantedGenres: ["onsen"] });
  assert.equal(withGenre[0].region.id, "onsen-town",
    "温泉を希望しても温泉街が選ばれない");
});

// --- 公共交通の中身を旅程に載せる -------------------------------------------

test("往路に、路線・乗車駅・乗換・待ち時間を載せる", () => {
  const detail = {
    minutes: 60, routed: true, line: "JR東海道線",
    transit: {
      headline: "乗換1回・待ち8分・徒歩9分", transfers: 1,
      waitMinutes: 8, walkMinutes: 9, rideMinutes: 43,
      boardAt: "東京駅", alightAt: "テスト駅",
      segments: [{ kind: "ride", line: "JR東海道線", from: "東京駅",
                   to: "テスト駅", minutes: 43, stops: 6 }],
    },
  };
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: detail, inbound: { minutes: 60, routed: false } },
  });
  const out = itin.days[0].items.find((i) => i.kind === "transit");
  assert.ok(out.transit, "往路に公共交通の中身が載っていません");
  assert.equal(out.transit.boardAt, "東京駅");
  assert.match(out.detail, /乗換1回/);
});

test("区間の中身が引ければ、スポット間の移動にも載せる", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  // 神社A → 寺B の区間だけ、中身が分かっているとする
  const legDetail = (a, b) =>
    (a?.id === "s1" && b?.id === "s2")
      ? { minutes: 6, routed: true, line: "路線バス",
          transit: { headline: "乗換なし・待ち4分", transfers: 0,
                     waitMinutes: 4, boardAt: "神社前", alightAt: "寺入口",
                     segments: [] } }
      : null;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const withTransit = itin.days[0].items
    .filter((i) => i.kind === "transit" && i.transit);
  assert.ok(withTransit.some((i) => i.transit.boardAt === "神社前"),
    "スポット間の移動に公共交通の中身が載っていません");
});

test("駅もバス停も無い区間は、タクシーの区間として旅程に載る", () => {
  // 近くに乗り物が無い区間に、電車・バスの目安（待ちと乗り換えを含む
  // 数字）を当てると、**乗り物が来ない場所ほど長く出る**という逆のことが
  // 起きます。routes.js がタクシーとして見積もった区間は、旅程の行にも
  // タクシーとして出ること。
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false,
                        noTransit: true, taxi: true },
            inbound: { minutes: 60, routed: false } },
  });
  const first = itin.days.flatMap((x) => x.items)
    .find((i) => i.kind === "transit");
  assert.equal(first.taxi, true, "タクシーの印が載っていません");
  assert.equal(first.noTransit, true);
  assert.match(first.detail, /タクシー/);
});

test("歩ける区間は、タクシーを名乗らない", () => {
  // routes.js が近くに停留所を見つけられなくても、200m なら歩きます。
  // 行に「徒歩約7分」と書きながら、確からしさの印に「タクシー」と
  // 出すと、読む人はどちらを信じてよいか分かりません。
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const legDetail = (a, b) =>
    (a?.id === "s1" && b?.id === "s2")
      ? { minutes: 9, routed: false, noTransit: true, taxi: true }
      : null;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const between = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "transit" && /へ移動$/.test(i.title ?? ""));
  assert.ok(between.length, "立ち寄り間の移動がありません");
  for (const i of between) {
    if (!/徒歩/.test(i.detail)) continue;
    assert.notEqual(i.taxi, true, `${i.detail} にタクシーの印が付いています`);
    assert.notEqual(i.noTransit, true);
  }
});

test("中身が分からない移動には、何も足さない（推定を装わない）", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  for (const i of itin.days[0].items) {
    if (i.kind === "transit") assert.equal(i.transit, undefined);
  }
});

// --- 営業時間を旅程に載せる -------------------------------------------------

test("スポットに、その日の営業時間と最終入場を載せる", () => {
  const castle = { id: "c1", name: "テスト城", category: "城",
                   lat: 35.3200, lng: 139.5520, description: "城です。",
                   hours: { open: 9, close: 17, lastEntry: 16.5 } };
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder([castle], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const spotItem = itin.days[0].items.find((i) => i.kind === "spot");
  assert.match(spotItem.hoursText, /09:00/);
  assert.match(spotItem.hoursText, /最終入場 16:30/);
});

test("休みが多い曜日にあたるスポットは、注意として旅程に出す", () => {
  // 2026-09-07 は月曜。美術館は月曜休館が多い分類です。
  const museum = { id: "m1", name: "テスト美術館", category: "美術館",
                   lat: 35.3200, lng: 139.5520, description: "美術館です。" };
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-07T09:00"),
                          arriveBy: d("2026-09-07T19:00") });
  const v = verifyOrder([museum], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-07T11:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 120, routed: false },
            inbound: { minutes: 120, routed: false } },
  });
  assert.ok(itin.hoursWarnings?.some((w) => /月曜/.test(w)),
    `注意が出ていません: ${JSON.stringify(itin.hoursWarnings)}`);
});

test("自由時間が日をまたがない（23時間の「自由時間」を作らない）", () => {
  // 最終日の帰りまで間が空くと、そこに1つの大きな「自由時間」を
  // 置いていました。日をまたぐと 23時間41分 の自由時間になり、
  // 「いちばん長い1日は 29時間」という表示にもつながっていました。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-14T19:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 2, day0: trip.departAt,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals, moves: v.moves,
    reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind !== "free") continue;
      const minutes = (item.end - item.start) / 60000;
      assert.ok(minutes <= 8 * 60,
        `${Math.round(minutes)}分の自由時間があります（${item.title}）`);
      assert.equal(item.start.getDate(), item.end.getDate(),
        "自由時間が日をまたいでいます");
    }
  }
});

test("その日の行動終了時刻を越える自由時間は作らない", () => {
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-13T22:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 1, day0: trip.departAt,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals, moves: v.moves,
    reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const frees = itin.days.flatMap((x) => x.items).filter((i) => i.kind === "free");
  for (const f of frees) {
    assert.ok(f.end.getHours() <= 21,
      `自由時間が ${f.end.getHours()}時 まで続いています`);
  }
});

// --- 「その日、何か所まわれるか」を順位に効かせる ---------------------------
// 往復5時間の旅先は、行けはしても2〜3か所で終わります。時間の使いかたを
// 点にしないと、「せっかく行ったのに、ほとんど回れなかった」が起きます。

test("回れる件数は、移動を引いた残り時間から出す", () => {
  assert.equal(fittableSpots(60, 600), 5, "往復2時間・10時間なら5か所");
  assert.equal(fittableSpots(240, 600), 1, "往復8時間なら1か所");
  assert.equal(fittableSpots(320, 600), 0, "往復で使い切ったら0");
  assert.equal(fittableSpots(60, 30), 0, "そもそも足りない場合も0");
});

test("日帰りでは、遠くて数か所しか回れない旅先を上位にしない", () => {
  const regions = [
    { id: "near", name: "近い町", stationLat: 35.3, stationLng: 139.5,
      genres: [], prefecture: "X" },
    { id: "far", name: "遠い町", stationLat: 37.0, stationLng: 140.0,
      genres: [], prefecture: "Y" },
  ];
  const mk = (id, regionId) => ({ id, regionId, name: id, category: "自然",
    lat: 35.3, lng: 139.5, description: "", fame_score: 50 });
  const spots = ["n1", "n2", "n3", "n4", "n5"].map((n) => mk(n, "near"))
    .concat(["f1", "f2", "f3", "f4", "f5"].map((n) => mk(n, "far")));
  const kb = {
    spots, regions,
    spotsByRegion: new Map([["near", spots.slice(0, 5)], ["far", spots.slice(5)]]),
    regionsById: new Map(regions.map((r) => [r.id, r])),
  };
  // 遠いほうが、場所そのものの一致はわずかに強い。
  const matches = [
    ...spots.slice(5).map((s) => ({ spot: s, score: 0.92 })),
    ...spots.slice(0, 5).map((s) => ({ spot: s, score: 0.88 })),
  ];
  const opts = { oneWayByRegion: new Map([["near", 60], ["far", 250]]),
                 totalMinutes: 600 };

  const day = rankRegions(kb, matches, 8, { ...opts, days: 1 });
  assert.equal(day[0].region.id, "near",
    "日帰りなのに、往復8時間ちかい旅先が上位に来ています");

  // 泊まりなら話は別です。初日にかけた移動は、翌日以降で取り返せます。
  // 順位まで入れ替わるとは限らないので、遠さの不利が縮むことを見ます。
  const gapOf = (ranked) => {
    const by = new Map(ranked.map((c) => [c.region.id, c.score]));
    return by.get("near") - by.get("far");
  };
  const stay = rankRegions(kb, matches, 8, { ...opts, days: 3 });
  assert.ok(gapOf(stay) < gapOf(day),
    `泊まりでも移動を同じだけ嫌っています（日帰り ${gapOf(day).toFixed(2)} / `
    + `3日 ${gapOf(stay).toFixed(2)}）`);
});

test("宿泊だけの日は作らず、前の晩に連泊としてまとめる", () => {
  // 「12日目 21:30 寄居町に宿泊」だけの日が出ていました。予定の入らない
  // 日にも宿を置いていたためです。実際には前の晩の宿に連泊しています。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-16T19:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 4, day0: trip.departAt,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals, moves: v.moves,
    reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  for (const day of itin.days) {
    assert.ok(day.items.some((i) => i.kind !== "lodging"),
      `${day.date.toLocaleDateString("ja-JP")} が宿泊だけの日になっています`);
  }
  // 泊まった数は減らしません。連泊としてまとめるだけです。
  const lodgings = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "lodging");
  assert.equal(lodgings.reduce((n, i) => n + i.nights, 0), 4);
});

// --- AIに聞けなかったとき ---------------------------------------------------

test("AIに聞けなかったら、そう言う", async () => {
  const { aiStatus, noteAiError, resetAiStatus } = await import("../packages/core/src/ai.js");
  resetAiStatus();
  assert.equal(aiStatus().error, null);

  // 通信が止められたときに来る形（CSPで塞がれると Load failed になります）。
  noteAiError(new Error("Load failed"));
  assert.match(aiStatus().error, /Load failed/);

  // 最初の理由だけを残します。あとから来た理由で上書きすると、
  // 「本当に最初に何が起きたか」が分からなくなります。
  noteAiError(new Error("あとから来た別の理由"));
  assert.match(aiStatus().error, /Load failed/);

  resetAiStatus();
  assert.equal(aiStatus().error, null);
});

test("往路は、実際に乗れる便の時刻から始まる", () => {
  // 「4:00発・3時間55分」の行に「14:50発→18:40着」と書いてありました。
  // 同じ行の中で食い違っています。実際に乗るのは次の便なので、
  // 旅程の時刻もそちらに合わせます。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T04:00"),
    arriveBy: d("2026-09-12T22:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const built = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: {
      outbound: {
        minutes: 355, rideMinutes: 230, waitMinutes: 125, routed: true,
        line: "05:00 発→ 08:50 着 3時間50分", shifted: false,
        yahoo: { departure: "05:00", arrival: "08:50" },
      },
      inbound: { minutes: 60, routed: false },
    },
  });
  const first = built.days[0].items[0];
  assert.equal(first.kind, "transit");
  assert.equal(first.start.getHours(), 5, "始発の時刻になっていません");
  assert.match(first.detail, /発の次の便/);
});

test("待ち時間が無ければ、出発時刻は動かさない", () => {
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T04:00"),
    arriveBy: d("2026-09-12T22:00"),
  });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const built = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: {
      outbound: {
        minutes: 230, rideMinutes: 230, waitMinutes: 0, routed: true,
        line: "04:00 発→ 07:50 着 3時間50分",
        yahoo: { departure: "04:00", arrival: "07:50" },
      },
      inbound: { minutes: 60, routed: false },
    },
  });
  assert.equal(built.days[0].items[0].start.getHours(), 4);
});

test("拠点を移したあとの日に、前のエリアの場所を入れない", () => {
  // 実際に出ていた旅程:
  //   2日目 4:00 金沢駅 → 三ノ宮駅（拠点を移します）
  //         7:20 近江町市場へ移動（247km）  ← 金沢へ戻っている
  // 下限（何日目以降）しか無かったので、前が押すと拠点を移したあとへ
  // ずれ込みます。247km戻るのは、その日に回る場所ではありません。
  const far = { id: "far", name: "遠い市場", category: "市場",
                lat: 36.5719, lng: 136.6560, fame_tier: "known" };
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-13T20:00"),
  });
  const v = verifyOrder([far], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 1, day0: trip.departAt,
    // 1日目までのエリア。2日目は別のエリアにいます。
    dayFloorById: new Map([["far", 1]]),
    dayCeilById: new Map([["far", 0]]),
  });
  assert.equal(v.visits.length, 0, "移ったあとの日に入れています");
  assert.equal(v.issues.at(-1)?.reason, "その日はもう別のエリアに移っている");
});

test("行き先が散らばらないように選ぶ", async () => {
  const { coherentRegions } = await import("../packages/core/src/ai.js");
  const r = (name, lat, lng, score) =>
    ({ region: { id: name, name, lat, lng }, score });
  // 「3大都市の美術館と建築」で、鹿児島市・京都市・箱根が選ばれていました。
  // 一つひとつは希望に合っていても、並べると移動だけで2日が消えます。
  const pool = [
    r("京都市", 35.0116, 135.7681, 9.0),
    r("鹿児島市", 31.5966, 130.5571, 8.9),
    r("大阪市", 34.6937, 135.5023, 8.4),
    r("神戸市", 34.6901, 135.1955, 8.2),
  ];
  const chosen = coherentRegions(pool, 3).map((c) => c.region.name);
  assert.equal(chosen[0], "京都市", "いちばん合う場所は動かしません");
  assert.ok(!chosen.includes("鹿児島市"),
    `900km先が入っています: ${chosen.join("・")}`);

  // 「必ず行く」で入ったエリアは動かしません。
  const pinned = coherentRegions(
    [r("鹿児島市", 31.5966, 130.5571, 1), ...pool], 2, 1)
    .map((c) => c.region.name);
  assert.equal(pinned[0], "鹿児島市");
});

test("3.1kmを「徒歩」と書かない", () => {
  // 「徒歩約18分・約3.1km」と出ていました。時速10km、走っています。
  // 18分という数字は電車・バスの見積もりで、歩きの見積もりではありません。
  // 徒歩かどうかは、かかる分ではなく距離で決めます。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-12T20:00"),
  });
  const far = { id: "f1", name: "遠い館", category: "美術館",
                lat: 35.3480, lng: 139.5500, fame_tier: "known" };
  const v = verifyOrder([far], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const moves = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "transit" && /へ移動$/.test(i.title));
  assert.ok(moves.length, "移動の行がありません");
  for (const m of moves) {
    if (m.km > 1.4) {
      assert.ok(!/徒歩/.test(m.detail), `${m.km.toFixed(1)}km を徒歩と書いています`);
      assert.equal(m.walk, false);
    }
  }
});

test("「3大都市」のような言い回しを、言葉として分かる", async () => {
  const { detectAreas, areaScope } = await import("../packages/core/src/areas.js");
  const kb = { regions: [
    { id: "tokyo", name: "東京・浅草", prefecture: "東京都" },
    { id: "osaka", name: "大阪市", prefecture: "大阪府" },
    { id: "nagoya", name: "名古屋", prefecture: "愛知県" },
    { id: "kagoshima", name: "鹿児島市", prefecture: "鹿児島県" },
  ] };
  const areas = detectAreas("3大都市の美術館と建築をめぐりたい", kb);
  assert.equal(areas.length, 1, `拾いすぎ/拾えず: ${areas.map((a) => a.term)}`);
  const scope = areaScope(areas);
  assert.deepEqual([...scope.regionIds].sort(), ["nagoya", "osaka", "tokyo"]);
  // どのエリアがどの街に属するかも返します（1つずつ回るため）。
  assert.equal(scope.groupById.get("osaka"), "大阪");

  // 「3大都市」を拾ったあとで「大都市」も拾うと、指定が広がって消えます。
  assert.equal(detectAreas("大都市を回りたい", kb).length, 1);
});

test("名指しされた街は、1つずつ回る", async () => {
  const { coherentRegions } = await import("../packages/core/src/ai.js");
  const r = (id, name, lat, lng, score) =>
    ({ region: { id, name, lat, lng }, score });
  // 大阪の中に高い点が並んでいると、距離だけで選べば3つとも大阪になります。
  const pool = [
    r("osaka1", "大阪・ミナミ", 34.66, 135.50, 9.0),
    r("osaka2", "大阪市", 34.69, 135.50, 8.9),
    r("osaka3", "東大阪市", 34.68, 135.60, 8.8),
    r("nagoya", "名古屋", 35.17, 136.88, 8.0),
    r("tokyo", "東京・浅草", 35.71, 139.79, 7.9),
  ];
  const groups = new Map([["osaka1", "大阪"], ["osaka2", "大阪"],
                          ["osaka3", "大阪"], ["nagoya", "名古屋"],
                          ["tokyo", "東京"]]);
  const names = coherentRegions(pool, 3, 0, groups).map((c) => c.region.name);
  assert.equal(new Set(names.map((n) => groups.get(
    pool.find((p) => p.region.name === n).region.id))).size, 3,
    `1つの街に固まっています: ${names.join("・")}`);
});

test("移動して寝るだけの日を作らない", () => {
  // 実際に出ていた2日目:
  //   4:00  浅草駅 → 名古屋市中心部（拠点を移します・約160分）
  //   22:30 名古屋市に宿泊
  //   ……それだけ。
  // 人はそうしません。前の街にもう一晩いて、翌朝に移ります。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-15T20:00"),
  });
  const other = { id: "far", name: "名古屋城", category: "城",
                  lat: 35.1856, lng: 136.8997, fame_tier: "major" };
  const v = verifyOrder([...spots, other], {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 3, day0: trip.departAt,
  });
  const built = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals,
    // 2日目に拠点を移す指示。ただし2日目には立ち寄りがありません。
    moves: [{ day: 1, minutes: 160,
              start: d("2026-09-13T04:00"), end: d("2026-09-13T06:40"),
              from: { name: "テスト駅", lat: 35.319, lng: 139.55 },
              to: { name: "名古屋", lat: 35.1706, lng: 136.8816 } }],
    stays: [
      { region: REGION, days: 1, dayFrom: 0, dayTo: 0,
        station: { name: "テスト駅", lat: 35.319, lng: 139.55 } },
      { region: { id: "nagoya", name: "名古屋", prefecture: "愛知県",
                  lat: 35.1706, lng: 136.8816,
                  stationLat: 35.1706, stationLng: 136.8816 },
        days: 3, dayFrom: 1, dayTo: 3,
        station: { name: "名古屋", lat: 35.1706, lng: 136.8816 } },
    ],
    reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  for (const day of built.days) {
    const kinds = day.items.map((i) => i.kind);
    const onlyMoveAndSleep = kinds.every((k) => k === "transit" || k === "lodging")
      && kinds.includes("lodging");
    assert.ok(!onlyMoveAndSleep,
      `${day.date.toLocaleDateString("ja-JP")} が移動して寝るだけの日です`
      + `（${kinds.join(",")}）`);
  }
});

test("拠点を移す区間も、調べた結果があれば実測として出す", () => {
  // 「1日目は実測なのに、2日目から推定になる」の正体。
  // 拠点の移動だけ routed:false を決め打ちしていました。
  const trip = makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-14T20:00"),
  });
  const from = { name: "テスト駅", lat: 35.319, lng: 139.55 };
  const to = { name: "名古屋", lat: 35.1706, lng: 136.8816 };
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
    nights: 2, day0: trip.departAt,
  });
  const built = buildItinerary({
    trip, region: REGION, visits: v.visits, meals: v.meals,
    moves: [{ day: 1, minutes: 100,
              start: d("2026-09-13T09:00"), end: d("2026-09-13T10:40"),
              from, to }],
    stays: [
      { region: REGION, days: 1, dayFrom: 0, dayTo: 0, station: from },
      { region: { id: "nagoya", name: "名古屋", prefecture: "愛知県",
                  lat: 35.1706, lng: 136.8816,
                  stationLat: 35.1706, stationLng: 136.8816 },
        days: 2, dayFrom: 1, dayTo: 2, station: to },
    ],
    reasons: new Map(),
    // 区間の中身は引ける、という状況。
    legDetail: (a, b) => (a === from && b === to
      ? { routed: true, line: "09:00 発→ 10:40 着 1時間40分",
          yahoo: { departure: "09:00", arrival: "10:40" } }
      : null),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const move = built.days.flatMap((x) => x.items)
    .find((i) => i.kind === "transit" && /拠点を移します/.test(i.detail ?? ""));
  assert.ok(move, "拠点の移動が見つかりません");
  assert.equal(move.routed, true, "調べてあるのに推定と出しています");
  assert.match(move.detail, /09:00 発/);
  assert.ok(move.yahoo, "時刻表から取ったことが残っていません");
});

// --- 区間ごとに調べた結果を、そのまま出す ---------------------------------

test("区間ごとに調べた便を、その区間の印と一行に出す", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const legs = { outbound: { minutes: 60, routed: false },
                 local: { routed: false },
                 inbound: { minutes: 60, routed: false } };
  // その区間が旅程の何時に並ぶのかは、組んでみないと分かりません。
  // **調べた便が行の時刻と合っていること**が前提なので、まず素で組んで
  // 行の時刻を読み、その時刻に出る便を答えることにします。
  const bare = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legs,
  });
  const row = bare.days[0].items.find((i) => i.to?.id === "s2");
  const hm = (d) => `${String(d.getHours()).padStart(2, "0")}`
    + `:${String(d.getMinutes()).padStart(2, "0")}`;
  const dep = hm(new Date(row.start));
  const arr = hm(new Date(new Date(row.start).getTime() + 12 * 60000));

  // 神社A → 寺B だけ引けている。ほかは引けていない。
  const legDetail = (a, b) =>
    (a?.id === "s1" && b?.id === "s2")
      ? { minutes: 12, routed: true,
          line: `${dep}発→${arr}着（12分）・乗換なし・180円`,
          yahoo: { departure: dep, arrival: arr } }
      : null;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    // 日中の区間ぜんぶが引けたわけではない、という状態。
    legs,
  });
  const moves = itin.days[0].items.filter((i) => i.kind === "transit");
  const hit = moves.find((i) => i.to?.id === "s2");
  assert.ok(hit, "寺Bへの移動がありません");
  assert.equal(hit.routed, true,
    "引けた区間なのに「目安」の印のままです");
  assert.ok(hit.yahoo, "調べた便の中身が渡っていません");
  assert.match(hit.detail, new RegExp(`${dep}発`),
    "調べた時刻ではなく「移動約◯分」のままです");
  // 引けていない区間は、印も中身も付けません。
  const miss = moves.find((i) => i.to?.id === "s3");
  assert.equal(miss?.routed, false);
  assert.equal(miss?.yahoo, null);
});

test("往路がYahoo!の答えなら、Googleの経路とは書かない", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: {
      outbound: { minutes: 91, routed: true,
                  line: "09:38発→11:09着（1時間31分）・乗換1回・1,174円",
                  yahoo: { departure: "09:38", arrival: "11:09" } },
      inbound: { minutes: 60, routed: false },
    },
  });
  const out = itin.days[0].items.find((i) => i.kind === "transit");
  assert.ok(out.yahoo, "往路に調べた便の中身が渡っていません");
  assert.match(out.reason, /Yahoo/);
});

test("行より前の便は、出さない（調べたときの時刻のまま残っている）", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  // 「11:08 夢の島熱帯植物館へ移動／11:19発→11:21着」の逆向き。
  // 旅程が後ろへ動いたのに、調べたのは動く前の時刻、という状態です。
  // もう乗れない便なので、時刻は出しません。
  const legDetail = (a, b) =>
    (a?.id === "s1" && b?.id === "s2")
      ? { minutes: 12, routed: true,
          line: "04:00発→04:12着（12分）・乗換なし・180円",
          yahoo: { departure: "04:00", arrival: "04:12" } }
      : null;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const hit = itin.days[0].items.find((i) => i.to?.id === "s2");
  assert.ok(hit, "寺Bへの移動がありません");
  assert.ok(!/04:00発/.test(hit.detail),
    `もう乗れない便を出しています: ${hit.detail}`);
  assert.match(hit.detail, /約\d+分/, "所要時間も出ていません");
  assert.equal(hit.routed, false,
    "合っていない便なのに「時刻表」の印が付いています");
  assert.equal(hit.yahoo, null);
});

test("行より後の便は、そのまま出す（それは待ち時間）", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T19:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const legDetail = (a, b) =>
    (a?.id === "s1" && b?.id === "s2")
      ? { minutes: 20, rideMinutes: 12, waitMinutes: 8, routed: true,
          line: "18:00発→18:12着（12分）・乗換なし・180円",
          yahoo: { departure: "18:00", arrival: "18:12" } }
      : null;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const hit = itin.days[0].items.find((i) => i.to?.id === "s2");
  assert.match(hit.detail, /18:00発/);
  assert.equal(hit.routed, true);
  // 行の時刻も、その便に合わせます。
  const start = new Date(hit.start);
  assert.equal(start.getHours(), 18);
  assert.equal(start.getMinutes(), 0);
});

test("予定のあいだが長く空くなら、自由時間として書く", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T22:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  // 見学は昼過ぎに終わり、夕食は17:30。あいだが2時間以上あきます。
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    meals: [{ kind: "dinner", day: 0,
              start: d("2026-09-12T17:30"), end: d("2026-09-12T18:30") }],
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const items = itin.days[0].items.sort((a, b) => a.start - b.start);
  const dinner = items.find((i) => i.title === "夕食");
  const before = items.filter((i) => i.end <= dinner.start).at(-1);
  assert.equal(before.kind, "free",
    `夕食の前が ${before.kind}（${before.title}）です。空白のままです`);
  assert.ok(before.detail, "何をして過ごせるかが書かれていません");
});

test("短い空きには、自由時間の行を立てない", () => {
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T22:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const last = v.visits.at(-1).end;
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    meals: [{ kind: "dinner", day: 0, start: new Date(last.getTime() + 20 * 60000),
              end: new Date(last.getTime() + 80 * 60000) }],
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const frees = itin.days[0].items.filter((i) => i.kind === "free"
    && i.title === "自由時間" && (i.end - i.start) < 60 * 60000);
  assert.equal(frees.length, 0, "20分の空きに行を立てています");
});

test("駅まで歩く時間から、行を始める", () => {
  // 画面にこう出ていました。
  //
  //   8:53  八ッ場ダムへ移動   19分
  //         08:53発→08:58着（5分）…前後の徒歩14分を含めて23分
  //   9:12  八ッ場ダム
  //
  // 8:53に「移動」が始まることになっていますが、駅までの徒歩が先に
  // あるので、動き出すのは8:49です。行の長さ（19分）と中の数字（23分）も
  // 合いません。
  const trip = makeTrip({ origin: TOKYO, departAt: d("2026-09-12T08:00"),
                          arriveBy: d("2026-09-12T20:00") });
  const v = verifyOrder(spots, {
    start: { lat: REGION.stationLat, lng: REGION.stationLng },
    startAt: d("2026-09-12T10:00"), end: TOKYO, endBy: trip.arriveBy,
  });
  const bare = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(),
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const row = bare.days[0].items.find((i) => i.to?.id === "s2");
  const leave = new Date(row.start);
  const hm = (dt) => `${String(dt.getHours()).padStart(2, "0")}`
    + `:${String(dt.getMinutes()).padStart(2, "0")}`;
  // 動き出す10分後に出る電車。駅までの徒歩は6分。
  const dep = new Date(leave.getTime() + 10 * 60000);
  const legDetail = (a, b) => ((a?.id === "s1" && b?.id === "s2")
    ? { minutes: 20, rideMinutes: 5, waitMinutes: 4, walkA: 6, walkB: 8,
        routed: true, line: `${hm(dep)}発→…着（5分）`,
        yahoo: { departure: hm(dep), arrival: hm(dep) } }
    : null);
  const itin = buildItinerary({
    trip, region: REGION, visits: v.visits, reasons: new Map(), legDetail,
    legs: { outbound: { minutes: 60, routed: false },
            inbound: { minutes: 60, routed: false } },
  });
  const hit = itin.days[0].items.find((i) => i.to?.id === "s2");
  const started = new Date(hit.start);
  const board = new Date(dep);
  assert.ok(started < board,
    `行が電車の発車時刻（${hm(board)}）から始まっています。`
    + "駅までの徒歩が前にあります");
  assert.equal(Math.round((board - started) / 60000), 6,
    "駅までの徒歩ぶんだけ前へ戻していません");
});
