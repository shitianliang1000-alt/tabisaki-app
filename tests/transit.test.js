// 公共交通の区間を、乗り換えと待ち時間まで含めて読み解くテスト。
//
// 「1時間20分」とだけ出す旅程は、現地で使えません。どの駅から乗り、
// どこで乗り換え、何分待つのか。そこが分からないと、旅程どおりに
// 動けているかを本人が確かめられないためです。
//
// Routes API の応答は手に入らない環境なので、実際の形を写した
// 固定データで、読み解く側の挙動を決めます。

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTransit, summarizeTransitLeg, summarizeYahooRoute, transitFieldMask,
} from "../packages/core/src/transit.js";

/** 大阪 → 京都（乗り換え1回）を模した応答。 */
const LEG = {
  duration: "3600s",
  distanceMeters: 43000,
  steps: [
    { travelMode: "WALK", staticDuration: "300s", distanceMeters: 380 },
    {
      travelMode: "TRANSIT", staticDuration: "1740s", distanceMeters: 39000,
      transitDetails: {
        stopDetails: {
          departureStop: { name: "大阪駅" },
          departureTime: "2026-09-10T09:12:00Z",
          arrivalStop: { name: "京都駅" },
          arrivalTime: "2026-09-10T09:41:00Z",
        },
        headsign: "野洲方面",
        stopCount: 4,
        transitLine: {
          name: "JR京都線 新快速", nameShort: "新快速",
          agencies: [{ name: "JR西日本" }],
          vehicle: { name: { text: "電車" }, type: "HEAVY_RAIL" },
        },
      },
    },
    { travelMode: "WALK", staticDuration: "240s", distanceMeters: 300 },
    {
      travelMode: "TRANSIT", staticDuration: "600s", distanceMeters: 3500,
      transitDetails: {
        stopDetails: {
          departureStop: { name: "京都駅前" },
          departureTime: "2026-09-10T09:53:00Z",
          arrivalStop: { name: "清水道" },
          arrivalTime: "2026-09-10T10:03:00Z",
        },
        headsign: "祇園・清水寺方面",
        stopCount: 7,
        transitLine: {
          name: "京都市営バス 206号系統", nameShort: "206",
          agencies: [{ name: "京都市交通局" }],
          vehicle: { name: { text: "バス" }, type: "BUS" },
        },
      },
    },
    { travelMode: "WALK", staticDuration: "420s", distanceMeters: 520 },
  ],
};

test("乗る区間を、路線・乗車駅・降車駅つきで取り出す", () => {
  const s = summarizeTransitLeg(LEG);
  const rides = s.segments.filter((x) => x.kind === "ride");
  assert.equal(rides.length, 2);
  assert.equal(rides[0].line, "JR京都線 新快速");
  assert.equal(rides[0].from, "大阪駅");
  assert.equal(rides[0].to, "京都駅");
  assert.equal(rides[0].stops, 4);
  assert.equal(rides[0].vehicle, "電車");
  assert.equal(rides[1].line, "京都市営バス 206号系統");
  assert.equal(rides[1].from, "京都駅前");
});

test("乗り換え回数は、乗った本数から1を引いた数", () => {
  assert.equal(summarizeTransitLeg(LEG).transfers, 1);
  const single = { steps: [LEG.steps[0], LEG.steps[1]] };
  assert.equal(summarizeTransitLeg(single).transfers, 0);
});

test("乗り換えの待ち時間を出す（降りてから、歩いて、次に乗るまで）", () => {
  const s = summarizeTransitLeg(LEG);
  // 09:41 着 → 4分歩く → 09:53 発。待ちは 8分。
  const wait = s.segments.find((x) => x.kind === "wait");
  assert.ok(wait, "待ち時間の区間がありません");
  assert.equal(wait.minutes, 8);
  assert.equal(wait.at, "京都駅前");
  assert.equal(s.waitMinutes, 8);
});

test("出発時刻を渡すと、最初の待ち時間も出す", () => {
  // 09:00 に出て 5分歩けば 09:05。09:12発なので 7分待ちます。
  const s = summarizeTransitLeg(LEG, { startAt: new Date("2026-09-10T09:00:00Z") });
  const waits = s.segments.filter((x) => x.kind === "wait");
  assert.equal(waits.length, 2);
  assert.equal(waits[0].minutes, 7);
  assert.equal(waits[0].at, "大阪駅");
  assert.equal(s.waitMinutes, 15);
});

test("出発時刻が分からないときは、最初の待ちを作らない（0分と嘘をつかない）", () => {
  const s = summarizeTransitLeg(LEG);
  assert.equal(s.segments.filter((x) => x.kind === "wait").length, 1);
});

test("徒歩・乗車・待ちの内訳を持つ", () => {
  const s = summarizeTransitLeg(LEG, { startAt: new Date("2026-09-10T09:00:00Z") });
  assert.equal(s.walkMinutes, 16);   // 5 + 4 + 7
  assert.equal(s.rideMinutes, 39);   // 29 + 10
  assert.equal(s.waitMinutes, 15);
});

test("最初に乗る駅と、最後に降りる駅を持つ", () => {
  const s = summarizeTransitLeg(LEG);
  assert.equal(s.boardAt, "大阪駅");
  assert.equal(s.alightAt, "清水道");
  assert.equal(s.firstDepartAt.toISOString(), "2026-09-10T09:12:00.000Z");
  assert.equal(s.lastArriveAt.toISOString(), "2026-09-10T10:03:00.000Z");
});

test("乗る区間が無ければ、公共交通の情報は付けない", () => {
  const walkOnly = { steps: [{ travelMode: "WALK", staticDuration: "600s" }] };
  const s = summarizeTransitLeg(walkOnly);
  assert.equal(s.transfers, 0);
  assert.equal(s.boardAt, null);
  assert.equal(s.segments.filter((x) => x.kind === "ride").length, 0);
});

test("応答が空でも壊れない", () => {
  for (const bad of [null, undefined, {}, { steps: null }, { steps: [{}] }]) {
    const s = summarizeTransitLeg(bad);
    assert.ok(Array.isArray(s.segments));
  }
});

// --- 画面に出す言葉 ---------------------------------------------------------

test("そのまま読める日本語の行にする", () => {
  const lines = describeTransit(
    summarizeTransitLeg(LEG, { startAt: new Date("2026-09-10T09:00:00Z") }),
    { tz: "UTC" });
  assert.equal(lines.length, 7);
  assert.match(lines[0], /徒歩5分/);
  assert.match(lines[1], /大阪駅.*7分待ち/);
  assert.match(lines[2], /09:12/);
  assert.match(lines[2], /新快速|JR京都線/);
  assert.match(lines[2], /大阪駅.*京都駅/);
  assert.match(lines[2], /09:41/);
});

test("見出しに乗り換え回数と待ち時間を出す", () => {
  const s = summarizeTransitLeg(LEG, { startAt: new Date("2026-09-10T09:00:00Z") });
  assert.match(s.headline, /乗換1回/);
  assert.match(s.headline, /待ち15分/);
  const direct = summarizeTransitLeg({ steps: [LEG.steps[1]] });
  assert.match(direct.headline, /乗換なし/);
});

// --- APIに要求する項目 ------------------------------------------------------

test("必要な項目だけを、公共交通のときに要求する", () => {
  const mask = transitFieldMask();
  for (const f of ["transitLine.name", "stopDetails.departureStop.name",
                   "stopDetails.departureTime", "stopDetails.arrivalTime",
                   "steps.travelMode", "steps.staticDuration"]) {
    assert.ok(mask.some((m) => m.includes(f)), `${f} を要求していません`);
  }
  // 使わない重い項目は取りません（応答が大きくなるだけです）
  assert.ok(!mask.some((m) => /polyline|iconUri/.test(m)));
});

// --- Yahoo!路線情報の経路 ---------------------------------------------------
//
// 京都 → 銀閣寺道（2026-10-13 10:00発）を実際に引いた答えを、中継
// （server/worker.js の parseRouteDetail）に通したものです。地下鉄から
// 歩いて、市バスに乗り換えます。これまでは「10:02発→10:39着」としか
// 出ず、**どのバスに乗るのかが画面のどこにもありませんでした。**

const KYOTO_GINKAKUJI = {
  departure: "10:02", arrival: "10:39", transfers: 1, fareYen: 490,
  legs: [
    { kind: "ride", from: "京都", to: "今出川", departure: "10:02",
      arrival: "10:12", minutes: 10, line: "京都市営烏丸線 国際会館行" },
    { kind: "ride", from: "今出川", to: "烏丸今出川(地下鉄今出川駅)/京都市営バス",
      departure: "10:14", arrival: "10:18", minutes: 4, line: "徒歩" },
    { kind: "ride", from: "烏丸今出川(地下鉄今出川駅)/京都市営バス",
      to: "銀閣寺道/京都市営バス", departure: "10:24", arrival: "10:39",
      minutes: 15, line: "京都市営バス・２０３号・出町柳駅・銀閣寺 錦林車庫行" },
  ],
};

test("Yahoo!の経路から、乗るバスと乗り場を手順にする", () => {
  const t = summarizeYahooRoute(KYOTO_GINKAKUJI, { walkA: 5, walkB: 3 });
  assert.deepEqual(t.segments.map((s) => s.kind),
    ["walk", "ride", "walk", "wait", "ride", "walk"]);
  const bus = t.segments.filter((s) => s.kind === "ride")[1];
  assert.equal(bus.vehicleKind, "bus");
  assert.equal(bus.from, "烏丸今出川(地下鉄今出川駅)");
  assert.equal(bus.to, "銀閣寺道");
  assert.equal(t.transfers, 1);
  assert.equal(t.boardAt, "京都");
  assert.equal(t.alightAt, "銀閣寺道");
  // 行に足す一言は、何に乗るのか
  assert.equal(t.headline, "京都市営烏丸線 → 京都市営バス・２０３号・出町柳駅・銀閣寺");

  const lines = describeTransit(t);
  assert.ok(lines.some((l) => l.includes("10:24 烏丸今出川(地下鉄今出川駅) → 10:39 銀閣寺道")
    && l.includes("京都市営バス・２０３号")), lines.join("\n"));
  assert.ok(lines.includes("烏丸今出川(地下鉄今出川駅)で6分待ち"), lines.join("\n"));
});

test("Yahoo!の区間が無ければ手順は作らない（作り話をしない）", () => {
  assert.equal(summarizeYahooRoute({ legs: [] }), null);
  assert.equal(summarizeYahooRoute(null), null);
  // 歩くだけの答えは、乗る手順になりません
  assert.equal(summarizeYahooRoute({ legs: [
    { from: "祇園", to: "京都", departure: "10:00", arrival: "10:20",
      minutes: 20, line: "徒歩" }] }), null);
});

test("保存した旅程を開き直しても、手順の時刻が読める", () => {
  const t = summarizeYahooRoute(KYOTO_GINKAKUJI);
  const revived = JSON.parse(JSON.stringify(t));
  assert.deepEqual(describeTransit(revived), describeTransit(t));
});
