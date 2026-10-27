// 「書いてある時刻」と「調べた時刻」が食い違っていた件の回帰テスト。
//
// 画面に、こう出ていました。
//
//   3日目 4:00  名古屋駅 → 難波駅
//               拠点を移します・12:16 発→ 13:40 着 ｜ 時刻表・Yahoo!路線情報
//         5:51  法楽寺のくす（1か所だけ）
//
// 3つ壊れています。
//
//   ・行の時刻（4:00）と、中身の時刻（12:16発）が違う
//   ・その便を調べた日時が、そもそも3日目ではなかった
//   ・難波の周りに146か所あるのに、その日の立ち寄りが1か所
//
// ここでは、直した3点をそれぞれ固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { buildItinerary } from "../packages/core/src/planner.js";
import { computeRoute, resetRoutesBreaker, resetTransitPacing } from "../packages/core/src/routes.js";

const d = (s) => new Date(s);

const NAGOYA = { name: "名古屋駅", lat: 35.1709, lng: 136.8815 };
const NAMBA = { name: "難波駅", lat: 34.6659, lng: 135.5017 };
const REGION = { id: "osaka-minami", name: "大阪・ミナミ",
                 lat: 34.6659, lng: 135.5017,
                 stationLat: 34.6659, stationLng: 135.5017, station: "難波駅" };

const trip = {
  origin: NAGOYA, departAt: d("2026-09-08T04:00"),
  arriveBy: d("2026-09-10T20:00"),
  dayStartHour: 4, dayEndHour: 20, pace: "balanced",
};

// ---------------------------------------------------- 拠点を移す区間の時刻 --

test("拠点を移す区間は、実際に乗れる便の時刻に置かれる", () => {
  const move = {
    day: 2, from: NAGOYA, to: NAMBA, minutes: 85,
    start: d("2026-09-10T04:00"), end: d("2026-09-10T05:25"),
  };
  const leg = {
    minutes: 85, rideMinutes: 84, waitMinutes: 130, routed: true,
    line: "12:16 発→ 13:40 着 1時間24分",
    yahoo: { departure: "12:16", arrival: "13:40" },
  };
  const itin = buildItinerary({
    trip, region: REGION, visits: [], reasons: new Map(),
    stays: [{ region: REGION, days: 3, dayFrom: 0, dayTo: 2,
              station: NAMBA }],
    moves: [move],
    legDetail: () => leg,
    legs: { outbound: { minutes: 85, routed: true } },
  });
  const item = itin.days.flatMap((x) => x.items)
    .find((i) => i.title?.includes("難波駅") && i.kind === "transit"
                 && i.detail?.includes("拠点を移します"));
  assert.ok(item, "拠点を移す区間が見当たりません");
  assert.equal(item.start.getHours(), 12, `${item.start}`);
  assert.equal(item.start.getMinutes(), 16, `${item.start}`);
  // 中身が実測なら、行も実測として扱われます（1日目だけ実測、の逆）。
  assert.equal(item.routed, true);
});

test("便に合わせて遅れたぶん、その日の立ち寄りも後ろへずれる", () => {
  const move = {
    day: 0, from: NAGOYA, to: NAMBA, minutes: 85,
    start: d("2026-09-08T04:00"), end: d("2026-09-08T05:25"),
  };
  const spot = { id: "x1", name: "通天閣", category: "展望台",
                 lat: 34.6524, lng: 135.5063, dwell: 60, open: 9, close: 21 };
  const visits = [{ spot, day: 0, arrive: d("2026-09-08T06:00"),
                    end: d("2026-09-08T07:00"), travel: 20, wait: 0, km: 3 }];
  const itin = buildItinerary({
    trip, region: REGION, visits, reasons: new Map(),
    stays: [{ region: REGION, days: 1, dayFrom: 0, dayTo: 0, station: NAMBA }],
    moves: [move],
    legDetail: () => ({
      minutes: 85, rideMinutes: 84, waitMinutes: 130, routed: true,
      line: "12:16 発→ 13:40 着", yahoo: { departure: "12:16" },
    }),
    legs: { outbound: { minutes: 85, routed: true } },
  });
  const visit = itin.days.flatMap((x) => x.items).find((i) => i.kind === "spot");
  assert.ok(visit.start >= d("2026-09-08T13:40"),
    `着く前に見学しています: ${visit.start}`);
});

// -------------------------------------------------- 区間ごとの「いつ」問い --

test("区間ごとに、その区間を通る日時で調べる", async () => {
  resetRoutesBreaker();
  resetTransitPacing();
  const asked = [];
  const fetchStub = async (url, init) => {
    asked.push(JSON.parse(init.body));
    return { ok: true, status: 200,
             json: async () => ({ routed: false, minutes: 0 }) };
  };
  const real = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    const times = [d("2026-09-08T09:00"), d("2026-09-10T09:00")];
    await computeRoute([NAGOYA, NAMBA, NAGOYA], {
      mode: "TRANSIT", departAt: times[0], departTimes: times,
    });
  } finally {
    globalThis.fetch = real;
    resetRoutesBreaker();
  resetTransitPacing();
  }
  // 中継へ届いていれば、2区間それぞれの日付で聞いているはずです。
  if (asked.length >= 2) {
    assert.notEqual(asked[0].departAt.slice(0, 10),
      asked.at(-1).departAt.slice(0, 10),
      `同じ日で聞いています: ${asked.map((a) => a.departAt)}`);
  }
});

// ------------------------------------------------ 拠点の周りの立ち寄り件数 --
//
// 立ち寄りは「滞在先のエリアIDと完全に一致するもの」だけを残していました。
// 収録のエリアは1,370あり、難波なら「大阪・ミナミ」と「大阪市」に
// 分かれています。AIが両方から選ぶと片方が黙って消え、その日は
// 1か所になります。収録を増やすほどひどくなる壊れ方でした。

import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { assignToStays, planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const kb = await loadKnowledgeBase();

test("拠点の周りに候補があるなら、その日の立ち寄りは1か所で終わらない",
     async () => {
  const itin = await planTrip({
    trip: makeTrip({
      origin: findPlace("東京駅"),
      departAt: new Date("2026-09-08T08:00"),
      arriveBy: new Date("2026-09-10T20:00"),
      note: "大阪をゆっくり見たい",
      interests: [], budgetYen: 999999,
    }),
    kb,
  });
  const spotDays = itin.days
    .map((day) => day.items.filter((i) => i.kind === "spot").length)
    .filter((n) => n > 0);
  assert.ok(spotDays.length >= 2, `立ち寄りのある日が少なすぎます: ${spotDays}`);
  assert.ok(spotDays.every((n) => n >= 2),
    `1か所しかない日があります: ${spotDays}`);
});

test("隣り合うエリアの立ち寄りも、いちばん近い拠点のぶんとして残る", () => {
  const stays = [
    { region: { id: "nagoya", name: "名古屋" },
      station: { name: "名古屋駅", lat: 35.1709, lng: 136.8815 } },
    { region: { id: "osaka-minami", name: "大阪・ミナミ" }, station: NAMBA },
  ];
  const picks = [
    // 「大阪・ミナミ」ではなく「大阪市」の立ち寄り。以前はここで消えました。
    { id: "a", regionId: "n0144", name: "通天閣", lat: 34.6524, lng: 135.5063 },
    { id: "b", regionId: "osaka-minami", name: "道頓堀",
      lat: 34.6687, lng: 135.5013 },
    { id: "c", regionId: "aichi", name: "名古屋城", lat: 35.1856, lng: 136.8996 },
    // どの拠点からも遠い立ち寄りは、その日のうちに往復できません。
    { id: "d", regionId: "far", name: "知床", lat: 44.0, lng: 145.0 },
  ];
  const byStay = assignToStays(picks, stays);
  assert.deepEqual(byStay.map((list) => list.map((s) => s.id)),
    [["c"], ["a", "b"]]);
});

// ------------------------------------------ 調べる先は、書いてある駅である --
//
// Yahoo!に渡す駅名は、いつでも「その地点にいちばん近い停留所」を引いて
// いました。東京駅の半径5kmには何十もの停留所があるので、たまたま近い
// バス停が選ばれます。旅程には「東京駅 →」と書いてあるのに調べたのは
// 別の場所、という食い違いが起き、名前が解決できずに時刻が取れないことも
// ありました。自分の名前で通るなら、そのまま使います。

test("駅から出るときは、その駅の名前で調べる", async () => {
  resetRoutesBreaker();
  resetTransitPacing();
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ routed: false }) };
  };
  try {
    await computeRoute([{ name: "東京駅", lat: 35.681236, lng: 139.767125 },
                        { name: "難波駅", lat: 34.6659, lng: 135.5017 }],
                       { mode: "TRANSIT", departAt: d("2026-09-15T09:00") });
  } finally {
    globalThis.fetch = real;
    resetRoutesBreaker();
  resetTransitPacing();
  }
  if (asked.length) {
    assert.equal(asked[0].from, "東京駅", `別の場所で調べています: ${asked[0].from}`);
    assert.equal(asked[0].to, "難波駅");
  }
});

// ------------------------------------------------------------ 無駄な移動 --
//
// 「1回の入れ替えにつき6kmまで」を何度も通せば、いくらでも遠回りできます。
// 拠点のすぐ隣に4か所あるのに、7.3km先の寺から始めて6.6km戻ってくる
// 1日が、実際に出ていました。1回ぶんはどれも上限の中でした。

import { orderByRoute } from "../packages/core/src/crowd.js";

test("混雑を避けるためでも、道順から大きく離れない", () => {
  const base = { lat: 35.451, lng: 139.632, name: "桜木町駅" };   // 拠点
  const near = (i, extra = {}) => ({
    id: `n${i}`, name: `近く${i}`, category: "公園",
    lat: 35.451 + i * 0.003, lng: 139.632, fame_tier: "hidden", ...extra,
  });
  // 遠くにある、いちばん混みやすい場所（早く閉まる）。
  const far = { id: "far", name: "遠くの寺", category: "寺院",
                lat: 35.508, lng: 139.678, fame_tier: "major", close: 16 };
  const ordered = orderByRoute([near(1), near(2), near(3), far], base, null,
                               { useCrowd: true });
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111,
                                  (a.lng - b.lng) * 90);
  let total = km(base, ordered[0]);
  for (let i = 0; i + 1 < ordered.length; i++) {
    total += km(ordered[i], ordered[i + 1]);
  }
  // 拠点から遠い順に往復すると20kmを超えます。近いところから回れば10km台。
  assert.ok(total < 18, `遠回りしています: ${Math.round(total)}km / `
    + ordered.map((s) => s.name).join(" → "));
});

// ------------------------------------------------------------ 1日の中身 --
//
// 4泊5日で、2日目の立ち寄りが1か所という旅程が出ていました。周りに
// 候補が146か所あっても、AIが選ばなければ旅程には出ません。足りない日は
// 近くの収録から埋めます。

test("立ち寄りが日数に足りないときは、近くの収録から埋める", async () => {
  const itin = await planTrip({
    trip: makeTrip({
      origin: findPlace("東京駅"),
      departAt: new Date("2026-09-13T08:00"),
      arriveBy: new Date("2026-09-15T19:00"),
      note: "東京をゆっくり見たい",
      interests: [], budgetYen: 999999,
    }),
    kb,
  });
  const perDay = itin.days
    .map((day) => day.items.filter((i) => i.kind === "spot").length)
    .filter((n) => n > 0);
  assert.ok(perDay.every((n) => n >= 2), `少なすぎる日があります: ${perDay}`);
});

// ------------------------------------------------------- 1行の読みやすさ --
//
// Yahoo!の要約をそのまま出すと、旅程の1行がこうなります。
//
//   04:49 発→ 05:19 着 30分 （乗車 17分 ） / 乗換： 1 回 /
//   IC優先： 375 円 / 8.2km（4:00出発で、次に乗れる便です）

test("電車・バスの一行は、発着と乗換と運賃だけにする", async () => {
  resetRoutesBreaker();
  resetTransitPacing();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      routed: true, minutes: 30, rideMinutes: 17, waitMinutes: 13,
      summary: "04:49 発→ 05:19 着 30分 （乗車 17分 ） / 乗換： 1 回 "
        + "/ IC優先： 375 円 / 8.2km",
      meta: { departure: "04:49", arrival: "05:19", transfers: 1,
              fareYen: 375, distanceKm: 8.2 },
    }),
  });
  let route;
  try {
    route = await computeRoute(
      [{ name: "東京駅", lat: 35.681236, lng: 139.767125 },
       { name: "浅草駅", lat: 35.7106, lng: 139.7986 }],
      { mode: "TRANSIT", departAt: d("2026-09-13T04:00") });
  } finally {
    globalThis.fetch = real;
    resetRoutesBreaker();
  resetTransitPacing();
  }
  const line = route.legs[0].line;
  // 出すのは「乗っている時間」です。yahoo.minutes（30分）は4:00から
  // 数えた時間で、便を待つ13分を含みます。それを出すと、発着の時刻と
  // 引き算が合いません。
  assert.equal(line, "04:49発→05:19着（17分）・乗換1回・375円", line);
  assert.ok(!line.includes("km"), line);
});

// -------------------------------------------------------- 空いている時間 --
//
// 「10:51に見学が終わって、次は17:30の夕食」という日が出ていました。
// 予定表としては成立していますが、6時間半をどう過ごすのかは書いて
// ありません。書いていない時間は、旅程ではありません。

import { longestGap } from "../packages/core/src/score.js";

test("その日の予定が尽きたら、近くから足して埋める", async () => {
  const itin = await planTrip({
    trip: makeTrip({
      origin: findPlace("東京駅"),
      departAt: new Date("2026-09-13T08:00"),
      arriveBy: new Date("2026-09-16T19:00"),
      note: "東京をゆっくり見たい",
      interests: [], budgetYen: 999999,
    }),
    kb,
  });
  const gap = longestGap(itin);
  assert.ok(gap <= 300, `${Math.round(gap / 60)}時間の空白があります`);
});

test("空白は、宿のあとを数えない", () => {
  const day = { items: [
    { kind: "spot", start: new Date("2026-09-13T09:00"),
      end: new Date("2026-09-13T10:00") },
    { kind: "lodging", start: new Date("2026-09-13T19:30"),
      end: new Date("2026-09-14T09:00") },
  ] };
  assert.equal(longestGap({ days: [day] }), 0);
});

// ------------------------------------------------ 着いた時刻から始める --
//
// 画面にこう出ていました。
//
//   6:28  東京駅 → 長野原草津口駅
//         06:28発→08:49着（4時間49分）
//   11:17 常布の滝へ移動          ← 着いてから2時間28分、何も無い
//
// Yahoo!が返す minutes は「頼んだ時刻から着くまで」で、便を待つ時間を
// すでに含んでいます（4:00発で頼んで6:28発の便なら4時間49分）。そこへ
// waitMinutes をもう一度足していました。

import { arrivalAfter } from "../packages/core/src/pipeline.js";

test("着く時刻は、待ち時間を二度数えない", () => {
  const depart = d("2026-09-13T04:00");
  const leg = { minutes: 289, rideMinutes: 141, waitMinutes: 148 };
  const arrive = arrivalAfter(depart, leg);
  assert.equal(arrive.getHours(), 8, `${arrive}`);
  assert.equal(arrive.getMinutes(), 49, `${arrive}`);
});
