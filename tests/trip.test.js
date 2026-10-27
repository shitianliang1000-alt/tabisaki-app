// 旅の「かたち」と、AI に渡す前のふるい分けのテスト。
//
// ここは今回の設計変更の中心なので、指摘された失敗パターンを
// そのままテストにしています。
//   ・出発地に戻らない旅（片道・目的地で終了）が作れること
//   ・「17:30 到着・17:00 閉館」が候補の時点で落ちること
//   ・見学後に宿や帰着地へ間に合わないものが落ちること

import assert from "node:assert/strict";
import test from "node:test";

import {
  END_MODES, dayEnd, endPlace, makeTrip, nightsOf, returnsToStart,
  totalMinutes, validateTrip,
} from "../packages/core/src/trip.js";
import {
  REJECT, checkSpot, estimateMinutes, filterFeasible, haversineKm,
  isAlwaysOpen, profileOf, summarizeRejections,
} from "../packages/core/src/feasibility.js";
import { reachableRegions, travelEfficiency } from "../packages/core/src/kb.js";
import { extractKeywords } from "../packages/core/src/keywords.js";

const TOKYO = { name: "東京駅", lat: 35.681236, lng: 139.767125 };
const KAMAKURA = { name: "鎌倉駅", lat: 35.3190, lng: 139.5500 };
const OSAKA = { name: "大阪駅", lat: 34.702485, lng: 135.495951 };

const d = (s) => new Date(s);

function spot(over = {}) {
  return {
    id: over.id ?? "s1",
    name: over.name ?? "テスト美術館",
    category: over.category ?? "美術館",
    lat: over.lat ?? 35.3200,
    lng: over.lng ?? 139.5520,
    description: "説明。",
    fame_tier: "known",
    ...over,
  };
}

// =========================================================== 旅のかたち ===

test("既定では出発地に戻る", () => {
  const trip = makeTrip({ origin: TOKYO });
  assert.equal(trip.endMode, END_MODES.RETURN_TO_ORIGIN);
  assert.deepEqual(endPlace(trip), TOKYO);
  assert.equal(returnsToStart(trip), true);
});

test("最終目的地で終わる旅は、出発地に戻らない", () => {
  const trip = makeTrip({
    origin: TOKYO, destination: OSAKA,
    endMode: END_MODES.END_AT_DESTINATION,
  });
  assert.deepEqual(endPlace(trip), OSAKA);
  assert.equal(returnsToStart(trip), false);
});

test("別の場所へ帰る旅を表現できる", () => {
  const trip = makeTrip({
    origin: TOKYO, returnTo: OSAKA, endMode: END_MODES.RETURN_TO_OTHER,
  });
  assert.deepEqual(endPlace(trip), OSAKA);
  assert.equal(returnsToStart(trip), false);
});

test("泊数は暦日で数える", () => {
  assert.equal(nightsOf(makeTrip({
    departAt: d("2026-09-12T08:00"), arriveBy: d("2026-09-12T20:00") })), 0);
  assert.equal(nightsOf(makeTrip({
    departAt: d("2026-09-12T23:00"), arriveBy: d("2026-09-13T01:00") })), 1);
  assert.equal(nightsOf(makeTrip({
    departAt: d("2026-09-12T09:00"), arriveBy: d("2026-09-14T18:00") })), 2);
});

test("旅の長さを分で返す", () => {
  const trip = makeTrip({
    departAt: d("2026-09-12T08:00"), arriveBy: d("2026-09-12T20:00") });
  assert.equal(totalMinutes(trip), 720);
});

// ------------------------------------------------------------- 入力検証 ---

test("最終目的地で終了なのに目的地が無ければ、直し方を返す", () => {
  const errors = validateTrip(makeTrip({
    origin: TOKYO, endMode: END_MODES.END_AT_DESTINATION,
    departAt: d("2026-09-12T08:00"), arriveBy: d("2026-09-12T20:00"),
  }));
  assert.ok(errors.some((e) => e.includes("最終目的地")), errors.join(" / "));
});

test("別の場所へ帰るのに帰着地が無ければ弾く", () => {
  const errors = validateTrip(makeTrip({
    origin: TOKYO, endMode: END_MODES.RETURN_TO_OTHER,
    departAt: d("2026-09-12T08:00"), arriveBy: d("2026-09-12T20:00"),
  }));
  assert.ok(errors.some((e) => e.includes("帰着地")));
});

test("到着が出発より前なら弾く", () => {
  const errors = validateTrip(makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T18:00"), arriveBy: d("2026-09-12T09:00"),
  }));
  assert.ok(errors.some((e) => e.includes("後にしてください")));
});

test("宿泊数に対して宿が足りなければ指摘する", () => {
  const errors = validateTrip(makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"), arriveBy: d("2026-09-14T18:00"),
    lodging: [{ place: KAMAKURA }],
  }));
  assert.ok(errors.some((e) => e.includes("宿泊地")), errors.join(" / "));
});

test("問題のない日帰り条件はエラーなし", () => {
  assert.deepEqual(validateTrip(makeTrip({
    origin: TOKYO,
    departAt: d("2026-09-12T09:00"), arriveBy: d("2026-09-12T19:00"),
  })), []);
});

// ------------------------------------------------------- その日の終点 ---

test("最終日の終点は旅の終点", () => {
  const trip = makeTrip({
    origin: TOKYO, departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-12T19:00"),
  });
  const e = dayEnd(trip, 0);
  assert.equal(e.isFinal, true);
  assert.deepEqual(e.place, TOKYO);
  assert.deepEqual(e.by, trip.arriveBy);
});

test("途中日の終点は宿で、チェックイン期限が効く", () => {
  const checkIn = d("2026-09-12T17:30");
  const trip = makeTrip({
    origin: TOKYO, departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-13T19:00"),
    lodging: [{ place: KAMAKURA, checkInBy: checkIn }],
  });
  const e = dayEnd(trip, 0);
  assert.equal(e.isFinal, false);
  assert.deepEqual(e.place, KAMAKURA);
  assert.deepEqual(e.by, checkIn);
});

// ============================================== 到達可能性のふるい分け ===

test("開館時間内に着けるスポットは通る", () => {
  const r = checkSpot(spot(), {
    from: KAMAKURA, earliest: d("2026-09-12T10:00"),
    endPlace: TOKYO, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, r.reason);
});

test("閉館後にしか着けないスポットは、AI に渡す前に落ちる", () => {
  // 美術館の既定は 10:00-17:00
  const r = checkSpot(spot(), {
    from: KAMAKURA, earliest: d("2026-09-12T17:30"),
    endPlace: TOKYO, endBy: d("2026-09-12T23:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.TOO_LATE);
});

test("開いてはいても、最終入場を過ぎていれば落ちる", () => {
  // 美術館は 17:00 閉館・最終入場 16:30。16:50 に着いても入れません。
  // 「営業中」と「入場できる」は別です。
  const r = checkSpot(spot(), {
    from: KAMAKURA, earliest: d("2026-09-12T16:45"),
    endPlace: TOKYO, endBy: d("2026-09-12T23:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.AFTER_LAST_ENTRY);
});

test("開館まで少し待つのは許容する", () => {
  // 待ってよいのは20分までです（TUNING.maxWaitMin）。旅程に
  // 「開くまで約60分」と立つくらいなら、そのとき開いている別の場所を
  // 先に回ります。
  const r = checkSpot(spot(), {
    from: KAMAKURA, earliest: d("2026-09-12T09:45"),
    endPlace: TOKYO, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.wait > 0 && r.wait <= 20, `wait=${r.wait}`);
  assert.equal(r.arrive.getHours(), 10);
});

test("開館まで待ちすぎるものは落とす", () => {
  const r = checkSpot(spot(), {
    from: KAMAKURA, earliest: d("2026-09-12T06:00"),
    endPlace: TOKYO, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.WAIT_TOO_LONG);
});

test("見学後に帰着地へ間に合わないものは落とす（v2に無かった判定）", () => {
  const far = spot({ name: "遠方の館", lat: 34.70, lng: 135.50 }); // 大阪付近
  const r = checkSpot(far, {
    from: TOKYO, earliest: d("2026-09-12T10:00"),
    endPlace: TOKYO, endBy: d("2026-09-12T15:00"),
  });
  assert.equal(r.ok, false);
  assert.ok([REJECT.CANNOT_FINISH, REJECT.TOO_LATE].includes(r.reason),
    `unexpected reason: ${r.reason}`);
});

test("終点が遠くても、期限が十分なら通る", () => {
  const r = checkSpot(spot(), {
    from: KAMAKURA, earliest: d("2026-09-12T10:00"),
    endPlace: OSAKA, endBy: d("2026-09-13T20:00"),
  });
  assert.equal(r.ok, true, r.reason);
});

test("常時開放のスポットは営業時間で落ちない", () => {
  const shrine = spot({ category: "神社", name: "テスト神社" });
  assert.equal(isAlwaysOpen(profileOf(shrine)), true);
  const r = checkSpot(shrine, {
    from: KAMAKURA, earliest: d("2026-09-12T06:00"),
    endPlace: TOKYO, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, r.reason);
});

test("定休日のスポットは落ちる", () => {
  // 2026-09-12 は土曜。closedDays に 6（土）を入れる。
  const closed = spot({ closedDays: [6] });
  const r = checkSpot(closed, {
    from: KAMAKURA, earliest: d("2026-09-12T11:00"),
    endPlace: TOKYO, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECT.CLOSED_TODAY);
});

test("スポット自身が実データを持つ場合はそちらを優先する", () => {
  const withReal = spot({ open: 6, close: 23, fee: 0, dwell: 30 });
  const prof = profileOf(withReal);
  assert.equal(prof.open, 6);
  assert.equal(prof.close, 23);
  assert.equal(prof.fee, 0);
  assert.equal(prof.estimated, false, "実データなのに目安扱いになっている");
});

test("実データが無ければ目安として印を付ける", () => {
  assert.equal(profileOf(spot()).estimated, true);
});

test("ペースで滞在時間が変わる", () => {
  const relaxed = profileOf(spot(), "relaxed").dwell;
  const packed = profileOf(spot(), "packed").dwell;
  assert.ok(relaxed > packed, `${relaxed} vs ${packed}`);
});

// --------------------------------------------------------- まとめ処理 ---

test("ふるい分けは通過分と落選理由を両方返す", () => {
  const spots = [
    spot({ id: "ok", category: "神社" }),
    spot({ id: "late", category: "美術館" }),
  ];
  const { kept, rejected } = filterFeasible(spots, {
    from: KAMAKURA, earliest: d("2026-09-12T17:30"),
    endPlace: TOKYO, endBy: d("2026-09-12T21:00"),
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].spot.id, "ok");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].spot.id, "late");
  assert.ok(rejected[0].reason);
});

test("落選理由の内訳を集計できる", () => {
  const rejected = [
    { spot: spot(), reason: REJECT.TOO_LATE },
    { spot: spot(), reason: REJECT.TOO_LATE },
    { spot: spot(), reason: REJECT.CLOSED_TODAY },
  ];
  const summary = summarizeRejections(rejected);
  assert.equal(summary[0].reason, REJECT.TOO_LATE);
  assert.equal(summary[0].count, 2);
});

test("候補が空でも壊れない", () => {
  const { kept, rejected } = filterFeasible([], {
    from: TOKYO, earliest: d("2026-09-12T09:00"),
    endPlace: TOKYO, endBy: d("2026-09-12T19:00"),
  });
  assert.deepEqual(kept, []);
  assert.deepEqual(rejected, []);
});

// ------------------------------------------------------------- 距離 ---

test("haversine が既知の距離と合う", () => {
  const km = haversineKm(TOKYO, { lat: 35.4510, lng: 139.6314 });
  assert.ok(km > 25 && km < 30, `${km}km`);
});

test("近距離は徒歩、長距離は乗り物として見積もる", () => {
  const near = estimateMinutes({ lat: 35.0, lng: 139.0 },
                               { lat: 35.003, lng: 139.003 });
  assert.ok(near >= 5 && near <= 20, `${near}分`);

  const far = estimateMinutes(TOKYO, OSAKA);
  const walkOnly = (haversineKm(TOKYO, OSAKA) / 4.2) * 60;
  assert.ok(far < walkOnly / 5, `長距離が徒歩相当で見積もられている: ${far}分`);
});

// ================================================ 旅先の到達可能性の判定 ===

test("往復できない旅先は候補から外れる", () => {
  const near = { id: "near", stationLat: 35.32, stationLng: 139.55 };
  const far = { id: "far", stationLat: 34.70, stationLng: 135.50 };  // 関西
  // 関西往復は 236*2+90+15 = 577分。7時間(420分)の窓には収まらない。
  const { kept, rejected } = reachableRegions([near, far], {
    origin: TOKYO, totalMinutes: 420, nights: 0, travelFn: estimateMinutes,
  });
  assert.deepEqual(kept.map((k) => k.region.id), ["near"]);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].need > 420);
});

test("片道の旅では、終点までの時間で判定する（往復ではない）", () => {
  // 東京→名古屋の片道。名古屋寄りの旅先は、往復前提だと落ちてしまう。
  const midway = { id: "midway", stationLat: 34.97, stationLng: 138.38 }; // 静岡付近
  const nagoya = { name: "名古屋駅", lat: 35.170915, lng: 136.881537 };

  const roundTrip = reachableRegions([midway], {
    origin: TOKYO, endPlace: TOKYO, totalMinutes: 420,
    nights: 0, travelFn: estimateMinutes,
  });
  const oneWay = reachableRegions([midway], {
    origin: TOKYO, endPlace: nagoya, totalMinutes: 420,
    nights: 0, travelFn: estimateMinutes,
  });
  assert.ok(oneWay.kept.length >= roundTrip.kept.length,
    "片道のほうが厳しく判定されている");
  assert.equal(oneWay.kept.length, 1, "片道で行ける旅先が落ちている");
});

test("宿泊ありのほうが、必要な滞在時間の下限が長い", () => {
  const region = { id: "r", stationLat: 35.32, stationLng: 139.55 };
  // 近郊は片道74分。日帰りなら 74*2+90+15 = 253分、宿泊なら最低滞在240分で
  // 74*2+240+15 = 403分。300分の窓では日帰りだけが通る。
  const day = reachableRegions([region], {
    origin: TOKYO, totalMinutes: 300, nights: 0, travelFn: estimateMinutes });
  const night = reachableRegions([region], {
    origin: TOKYO, totalMinutes: 300, nights: 1, travelFn: estimateMinutes });
  assert.equal(day.kept.length, 1);
  assert.equal(night.kept.length, 0, "宿泊なのに最低滞在時間が緩い");
});

test("移動が旅の大半を占める旅先は、効率が低く評価される", () => {
  const efficient = travelEfficiency(120, 600);   // 移動2h / 10h
  const wasteful = travelEfficiency(480, 600);    // 移動8h / 10h
  assert.ok(efficient > wasteful, `${efficient} vs ${wasteful}`);
  assert.equal(wasteful, 0, "極端に非効率でも加点されている");
});

test("日本語の希望文から検索語が取れる（空白分割では取れなかったもの）", () => {
  const r = extractKeywords("歴史ある街を歩きたい");
  assert.ok(r.keywords.includes("歴史"), JSON.stringify(r));
  assert.ok(r.genres.includes("history"));
  assert.ok(r.genres.includes("city"));
});

test("カタカナ語を途中で切らない（誤マッチの原因になっていた）", () => {
  const r = extractKeywords("スキューバダイビングがしたい");
  assert.deepEqual(r.keywords, ["スキューバダイビング"],
    "カタカナ語が断片化している");
  // 以前は「ーバ」という断片が生まれ、「ハーバーランド」に誤一致していた
  assert.ok(!r.keywords.some((k) => k.length < 3 && /[ァ-ヶー]/.test(k)));
});

test("意味のある語が無い文では、無理に検索語を作らない", () => {
  // 断片で誤検索するくらいなら空のほうがよい。
  // 呼び出し側は候補ゼロにならないよう全件から選び直します。
  const r = extractKeywords("よくわからないことを書く");
  assert.deepEqual(r.keywords, []);
});

test("空文字では検索語も空", () => {
  assert.deepEqual(extractKeywords("").keywords, []);
  assert.deepEqual(extractKeywords("   ").keywords, []);
});

test("雰囲気の語を拾う", () => {
  const r = extractKeywords("人が少ない静かな場所でのんびりしたい");
  assert.ok(r.moods.length >= 2, JSON.stringify(r.moods));
});

// --- 1日のうち、動く時間帯 --------------------------------------------------
//
// 長さ（9時間）だけでは「いつ動くのか」が決まりません。同じ9時間でも
// 7時発と10時発では、開いている施設もその日に回れる場所も変わります。

import { formatHourField, parseHourField } from "../packages/core/src/trip.js";

test("時刻の欄を、内部で使う数に読み替える", () => {
  assert.equal(parseHourField("09:00"), 9);
  assert.equal(parseHourField("18:30"), 18.5);
  assert.equal(parseHourField("7:15"), 7.25);
  assert.equal(parseHourField(""), null);
  assert.equal(parseHourField("25:00"), null);
  assert.equal(parseHourField("09:70"), null);
  assert.equal(parseHourField(undefined), null);
});

test("内部の数を、時刻の欄に戻せる", () => {
  assert.equal(formatHourField(9), "09:00");
  assert.equal(formatHourField(18.5), "18:30");
  for (const v of ["06:00", "09:30", "22:45"]) {
    assert.equal(formatHourField(parseHourField(v)), v);
  }
});

test("時間帯を指定しなければ、これまでと同じ 9:00〜18:30", () => {
  const t = makeTrip({});
  assert.equal(t.dayStartHour, 9);
  assert.equal(t.dayEndHour, 18.5);
});

test("指定した時間帯が、そのまま旅の条件になる", () => {
  const t = makeTrip({ dayStartHour: 7, dayEndHour: 21 });
  assert.equal(t.dayStartHour, 7);
  assert.equal(t.dayEndHour, 21);
});

test("移動手段は、決めた通りに使う", async () => {
  const { pickMode } = await import("../packages/core/src/routes.js");
  const near = [{ lat: 35.68, lng: 139.76 }, { lat: 35.69, lng: 139.77 }];
  const far = [{ lat: 35.68, lng: 139.76 }, { lat: 34.69, lng: 135.50 }];

  // 決めていなければ、距離から選びます。
  assert.equal(pickMode(near), "WALK");
  assert.equal(pickMode(far), "TRANSIT");

  // 車で来ている人に「バスがないので行けません」と言わないために、
  // 指定があればそちらに従います。
  assert.equal(pickMode(near, "car"), "DRIVE");
  assert.equal(pickMode(far, "car"), "DRIVE");
  assert.equal(pickMode(far, "walk"), "WALK");
  assert.equal(pickMode(near, "transit"), "TRANSIT");
});

test("移動手段は、知らない値を受け取らない", () => {
  assert.equal(makeTrip({ transport: "helicopter" }).transport, "any");
  assert.equal(makeTrip({ transport: "car" }).transport, "car");
  assert.equal(makeTrip({}).transport, "any");
});

test("予算は、決めなければ見ない", () => {
  assert.equal(makeTrip({}).budgetYen, null);
  assert.equal(makeTrip({ budgetYen: 20000 }).budgetYen, 20000);
});

test("予算の扱いは、目安か厳守のどちらか", () => {
  assert.equal(makeTrip({}).budgetMode, "guide");
  assert.equal(makeTrip({ budgetMode: "strict" }).budgetMode, "strict");
  assert.equal(makeTrip({ budgetMode: "なんでも" }).budgetMode, "guide");
});

test("予算を超えたら、入場料の高い場所から外す", async () => {
  const { overBudgetSpots } = await import("../packages/core/src/pipeline.js");
  const itin = {
    cost: { total: 24000 },
    days: [{ items: [
      { kind: "spot", spotId: "a", title: "高い館", costYen: 3000 },
      { kind: "spot", spotId: "b", title: "ふつうの寺", costYen: 500 },
      { kind: "spot", spotId: "c", title: "中くらいの館", costYen: 2000 },
      { kind: "lodging", costYen: 12000 },
    ] }],
  };
  // 4,000円ぶん超えています。宿や特急ではなく、入場料から削ります
  // （宿を削ると、旅そのものが変わります）。
  const cut = overBudgetSpots(itin, 20000).map((s) => s.title);
  assert.deepEqual(cut, ["高い館", "中くらいの館"]);
  // 収まっていれば、何も外しません。
  assert.deepEqual(overBudgetSpots(itin, 30000), []);
  assert.deepEqual(overBudgetSpots(itin, null), []);
});
