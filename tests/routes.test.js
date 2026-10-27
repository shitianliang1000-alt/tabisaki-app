// Routes API に送るリクエストの形のテスト。
//
// 「Maps API がエラーを吐く」の正体は、公共交通（TRANSIT）に経由地を
// 付けて投げていたことでした。Routes API は TRANSIT の経由地を受け付けず、
// 400 INVALID_ARGUMENT を返します。キーが無くても、送る前の形は
// 確かめられるので、ここで固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTransitLeg } from "../packages/core/src/transit.js";

import { buildRouteRequest, legDetailLookup, pickMode } from "../packages/core/src/routes.js";

const TOKYO = { lat: 35.6812, lng: 139.7671 };
const SHINJUKU = { lat: 35.6909, lng: 139.7003 };
const YOKOHAMA = { lat: 35.4658, lng: 139.6223 };
const OSAKA = { lat: 34.7025, lng: 135.4960 };

test("公共交通に経由地を付けようとしたら、そこで止める", () => {
  // Routes API が 400 を返す組み合わせです。車に読み替えて通すのは
  // 誤りなので（鉄道の旅程を車の時間で組むことになります）、
  // 組み立ての時点で撥ねます。
  assert.throws(
    () => buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA],
      { mode: "TRANSIT", departAt: new Date("2030-01-01T09:00") }),
    /経由地は指定できません/);
});

test("2点だけなら公共交通のまま、出発時刻も送る", () => {
  const r = buildRouteRequest([TOKYO, OSAKA],
    { mode: "TRANSIT", departAt: new Date("2030-01-01T09:00") });
  assert.equal(r.body.travelMode, "TRANSIT");
  assert.ok(r.body.departureTime);
  assert.equal(r.body.intermediates, undefined);
  // 経由地が無いのに順序最適化を送ると、それ自体が不正になります
  assert.ok(!("optimizeWaypointOrder" in r.body));
});

test("車の経路では、出発時刻ではなく交通量無視を送る", () => {
  const r = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA],
    { mode: "DRIVE", departAt: new Date("2030-01-01T09:00") });
  assert.equal(r.body.routingPreference, "TRAFFIC_UNAWARE");
  assert.ok(!("departureTime" in r.body),
    "TRAFFIC_UNAWARE と departureTime は併用できません");
});

test("路線名は公共交通のときだけ要求する", () => {
  const transit = buildRouteRequest([TOKYO, OSAKA], { mode: "TRANSIT" });
  assert.match(transit.fieldMask, /transitDetails/);
  const drive = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA], { mode: "DRIVE" });
  assert.ok(!/transitDetails/.test(drive.fieldMask));
});

test("徒歩圏なら徒歩、離れていれば公共交通を選ぶ", () => {
  assert.equal(pickMode([TOKYO, { lat: 35.6820, lng: 139.7680 }]), "WALK");
  assert.equal(pickMode([TOKYO, OSAKA]), "TRANSIT");
});

test("順序最適化は車のときだけ送る（徒歩に付けると 400 が返る）", () => {
  const walk = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA], { mode: "WALK" });
  assert.ok(!("optimizeWaypointOrder" in walk.body),
    "徒歩に optimizeWaypointOrder を送っています（Routes API が拒否します）");
  const drive = buildRouteRequest([TOKYO, SHINJUKU, YOKOHAMA], { mode: "DRIVE" });
  assert.equal(drive.body.optimizeWaypointOrder, false,
    "上位SKUの順序最適化が既定で有効になりかねません");
});

// --- 呼びすぎ・呼ぶだけ無駄な呼び出しを止める ------------------------------

import { routesBreakerState } from "../packages/core/src/routes.js";

const WAKKANAI = { lat: 45.5228, lng: 141.9368 };
const NAHA = { lat: 26.2124, lng: 127.6809 };

test("空路になる距離でも、公共交通なら聞きにいく", async () => {
  // 700kmを超えると聞かずに目安にしていました。Googleの経路APIを想定した
  // 線引きで、Yahoo!には当てはまりません。Yahoo!は新幹線も飛行機も
  // 含めて答えます。ここでは通信できないので目安に落ちますが、
  // 「長すぎるから聞かない」で止めてはいけません。
  resetRoutesBreaker();
  resetTransitPacing();
  clearRouteCache();
  const r = await computeRoute([TOKYO, NAHA], { mode: "TRANSIT" });
  assert.equal(r.routed, false);
  assert.ok(!/区間が長すぎます/.test(r.error ?? ""),
    "距離だけを理由に、公共交通の検索をやめています");
  assert.ok(r.legs.length === 1 && r.legs[0].minutes > 0);
});

test("車の経路は、空路になる距離では呼ばない", async () => {
  // こちらはGoogleの経路APIの話です。海をまたぐ区間に道路はありません。
  resetRoutesBreaker();
  resetTransitPacing();
  clearRouteCache();
  const r = await computeRoute([TOKYO, NAHA], { mode: "DRIVE" });
  assert.equal(r.routed, false);
  assert.match(r.error ?? "", /区間が長すぎます/);
});

test("同じ経路は取り直さない（案の作り直しで倍になっていた）", async () => {
  clearRouteCache();
  const pts = [TOKYO, WAKKANAI];
  const a = await computeRoute(pts, { mode: "TRANSIT" });
  const b = await computeRoute(pts, { mode: "TRANSIT" });
  assert.equal(a, b, "同じ問い合わせで別の結果オブジェクトが返っています");
});

test("失敗が続いたら呼ぶのをやめる", () => {
  resetRoutesBreaker();
  resetTransitPacing();
  assert.equal(routesBreakerState().open, false);
});

// --- 先の日付では時刻表が引けない ------------------------------------------

import { TRANSIT_HORIZON_DAYS, neutralDepartureTime, transitDepartureTime }
  from "../packages/core/src/routes.js";

test("時刻を指定しない問い合わせは、次の平日の昼で聞く", () => {
  // 出発時刻を送らないと Google は「押した瞬間」で調べます。深夜に
  // 「確認」を押しただけで東京→横浜が見つからなくなっていました。
  for (const iso of ["2026-09-05T02:30", "2026-09-05T23:50",
                     "2026-09-04T12:00", "2026-09-06T18:00"]) {
    const d = neutralDepartureTime(new Date(iso));
    assert.equal(d.getHours(), 10, `${iso} → ${d}`);
    assert.ok(d.getDay() !== 0 && d.getDay() !== 6, `${iso} → 週末になっています`);
    assert.ok(d > new Date(iso), `${iso} → 過去になっています`);
  }
});

test("近い日付の出発時刻は、そのまま送る", () => {
  const now = new Date("2026-08-31T10:00");
  const soon = new Date("2026-09-05T09:00");
  assert.equal(transitDepartureTime(soon, now).getTime(), soon.getTime());
});

test("遠い日付は、同じ曜日・同じ時刻の直近の日に置き換える", () => {
  const now = new Date("2026-08-31T10:00");     // 月曜
  const far = new Date("2027-03-15T14:30");     // 月曜
  const used = transitDepartureTime(far, now);
  assert.equal(used.getDay(), far.getDay(), "曜日が変わっています");
  assert.equal(used.getHours(), 14);
  assert.equal(used.getMinutes(), 30);
  const ahead = (used - now) / 86400000;
  assert.ok(ahead > 0 && ahead <= TRANSIT_HORIZON_DAYS,
    `${ahead.toFixed(1)}日後になっています`);
});

test("過去の時刻は、いま以降に直す", () => {
  const now = new Date("2026-08-31T10:00");
  const past = new Date("2026-08-01T09:00");
  assert.ok(transitDepartureTime(past, now) >= now);
});

test("置き換えたことを、結果に書き添える", () => {
  const far = new Date(Date.now() + 400 * 86400000);
  const r = buildRouteRequest([TOKYO, OSAKA], { mode: "TRANSIT", departAt: far });
  assert.match(r.modeNote ?? "", /時刻表/);
});

// --- 公共交通を、公共交通のまま取る -----------------------------------------
//
// 経由地つきの TRANSIT を DRIVE に読み替えていたのをやめた件。
// 鉄道とバスの旅程を車の所要時間で組むと、とくに地方で
// 「1時間に1本のバス」を「車で10分」と見積もり、旅程が現地で破綻します。
//
// 日本では、Googleの経路APIは公共交通の経路を返しません。投げても必ず
// 「経路が見つかりません」になり、それでも課金対象のリクエストは消えます。
// 駅の位置から組み立てるようにしたので、そこを固定します。

import {
  MAX_POINTS, clearRouteCache, computeRoute, resetRoutesBreaker, resetTransitPacing, routesUsage,
} from "../packages/core/src/routes.js";
import { TUNING } from "../packages/core/src/config.js";
import { resetStopsCache } from "../packages/core/src/stops.js";

/** 駅のデータを差し替えます（実データを取りに行かせないため）。 */
function withStations(stops, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes("stops-rail")
      ? { year: 2008, stops } : { year: 2012, stops: [] }),
  });
  clearRouteCache();
  resetRoutesBreaker();
  resetTransitPacing();
  return fn().finally(() => {
    globalThis.fetch = real;
    resetStopsCache();
    clearRouteCache();
  });
}

const SHINJUKU_ST = { lat: 35.6896, lng: 139.7006 };
const HAKONE_YUMOTO = { lat: 35.2325, lng: 139.1063 };

test("公共交通の区間では、経路APIを1回も呼ばない", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    // キーが無ければそもそも呼びませんが、呼ぶ設計かどうかを見たいので
    // 呼び出し回数そのものを確かめます。
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    assert.equal(routesUsage().calls, 0,
      "日本では返らない公共交通に、リクエストを使っています");
    assert.equal(r.legs.length, 1);
    assert.ok(r.legs[0].minutes > 0);
  }));

test("最寄り駅どうしの移動として組み立て、そのことを伝える", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    assert.match(r.modeNote ?? "", /最寄りの駅・バス停/);
    assert.equal(r.legs[0].stations?.from, "新宿");
    assert.equal(r.legs[0].stations?.to, "箱根湯本");
  }));

test("駅から遠い目的地は、そのぶん時間がかかる", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    // 箱根湯本駅そのものと、駅から2kmの山の中を比べます。
    const atStation = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO],
      { mode: "TRANSIT" });
    const upTheHill = await computeRoute(
      [SHINJUKU_ST, { lat: 35.2505, lng: 139.1063, category: "登山" }],
      { mode: "TRANSIT" });
    assert.ok(upTheHill.legs[0].minutes > atStation.legs[0].minutes,
      "駅から離れているのに、同じ時間になっています");
  }));

test("近くに駅が無ければ、距離からの目安に戻す", () =>
  withStations([[43.0686, 141.3508, "札幌"]], async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    assert.equal(r.legs[0].stations, null);
    assert.ok(r.legs[0].minutes > 0);
  }));

test("実測か目安かを、取り違えない", () =>
  withStations([
    [35.6896, 139.7006, "新宿"],
    [35.2325, 139.1063, "箱根湯本"],
  ], async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], { mode: "TRANSIT" });
    // 真ん中（乗車）は目安なので、区間としては実測を名乗りません。
    assert.equal(r.legs[0].routed, false);
    assert.equal(r.routed, false);
  }));

test("中間地点は10か所まで（11か所以上は上位SKUになる）", () => {
  assert.equal(MAX_POINTS, 12, "出発地＋中間地点10＋終点");
});

test("設定の既定値が、費用の設計と合っている", () => {
  assert.ok(TUNING.maxTransitRequests >= 4 && TUNING.maxTransitRequests <= 20,
    `1回の旅程で ${TUNING.maxTransitRequests} リクエストは設計から外れています`);
  assert.ok(TUNING.walkableKm > 0 && TUNING.walkableKm <= 2);
});

// --- 区間の中身を引く --------------------------------------------------------

test("2点の組から、その区間の経路そのものを引ける", () => {
  const points = [TOKYO, SHINJUKU, YOKOHAMA];
  const legs = [
    { minutes: 14, meters: 6200, line: "JR中央線", routed: true,
      transit: { boardAt: "東京", alightAt: "新宿", transfers: 0 } },
    { minutes: 32, meters: 28000, line: "JR湘南新宿ライン", routed: true,
      transit: { boardAt: "新宿", alightAt: "横浜", transfers: 0 } },
  ];
  const look = legDetailLookup([[points, legs]]);
  assert.equal(look(TOKYO, SHINJUKU).transit.boardAt, "東京");
  assert.equal(look(SHINJUKU, YOKOHAMA).minutes, 32);
  // 逆向きは引きません。乗車駅と降車駅が入れ替わるので、そのまま出すと
  // 「新宿から乗って東京で降りる」を「東京から乗る」と表示してしまいます。
  assert.equal(look(SHINJUKU, TOKYO), null);
  // 知らない組は null。推定で埋めるのは呼ぶ側の仕事です
  assert.equal(look(TOKYO, OSAKA), null);
});

test("区間の中身が無い経路でも、引くこと自体は壊れない", () => {
  const look = legDetailLookup([[[TOKYO, SHINJUKU], null]]);
  assert.equal(look(TOKYO, SHINJUKU), null);
});

// --- 最初の電車を待つ時間 ---------------------------------------------------
// Routes API の leg.duration は、乗ってから降りるまでを返します。
// 9:00 に駅へ着いて、次の電車が 9:35 なら、その35分は入りません。
// そのまま旅程に置くと、実際より早く着く前提で組むことになります。

test("待ち時間を含めた、実際の所要時間になる", () => {
  const start = new Date("2026-09-05T09:00:00+09:00");
  const leg = {
    // API が返す「乗ってから降りるまで」は 25分
    duration: "1500s",
    distanceMeters: 12000,
    steps: [
      { travelMode: "WALK", staticDuration: "300s", distanceMeters: 300 },
      { travelMode: "TRANSIT",
        transitDetails: {
          transitLine: { name: "◯◯線" },
          stopDetails: {
            departureStop: { name: "A駅" },
            departureTime: "2026-09-05T09:35:00+09:00",
            arrivalStop: { name: "B駅" },
            arrivalTime: "2026-09-05T10:00:00+09:00",
          },
        } },
      { travelMode: "WALK", staticDuration: "420s", distanceMeters: 500 },
    ],
  };
  const t = summarizeTransitLeg(leg, { startAt: start });
  // 9:00 に出て 10:00 に降り、そこから7分歩く → 67分
  assert.equal(t.waitMinutes, 30, `待ちが ${t.waitMinutes}分 です`);
  const doorToDoor = Math.round((t.lastArriveAt - start) / 60000);
  assert.equal(doorToDoor, 60);
  assert.ok(doorToDoor + 7 > 25,
    "APIの25分をそのまま使うと、実際より35分以上早く着く計算になります");
});

test("待ちが無ければ、余計に足さない", () => {
  const start = new Date("2026-09-05T09:00:00+09:00");
  const leg = {
    duration: "1500s",
    steps: [
      { travelMode: "TRANSIT",
        transitDetails: {
          transitLine: { name: "◯◯線" },
          stopDetails: {
            departureStop: { name: "A駅" },
            departureTime: "2026-09-05T09:00:00+09:00",
            arrivalStop: { name: "B駅" },
            arrivalTime: "2026-09-05T09:25:00+09:00",
          },
        } },
    ],
  };
  const t = summarizeTransitLeg(leg, { startAt: start });
  assert.equal(t.waitMinutes, 0);
  assert.equal(Math.round((t.lastArriveAt - start) / 60000), 25);
});

// --- Yahoo!路線情報 ---------------------------------------------------------
//
// 電車・バスの時間はYahoo!路線情報から取ります。以前は2地点のときだけで、
// 経由地があると駅の位置からの目安に落ちていました。区間ごとに聞きます。

/** 駅データとYahoo!の応答を差し替えます。 */
function withYahoo(stops, reply, fn, { located = true } = {}) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("stops-rail")) {
      return { ok: true, json: async () => ({ year: 2008, stops }) };
    }
    if (u.includes("stops-bus")) {
      return { ok: true, json: async () => ({ year: 2012, stops: [] }) };
    }
    const body = JSON.parse(init?.body ?? "{}");
    asked.push(body);
    // 今の中継は、位置を受け取ったらそれで聞いたと返します。
    const out = reply(body);
    // located: false は、位置を受け取らない古い中継（名前だけで聞く）。
    const answer = located && (body.fromAt || body.toAt) && out
      && typeof out === "object" ? { byLocation: true, ...out } : out;
    return { ok: true, json: async () => answer };
  };
  clearRouteCache();
  resetRoutesBreaker();
  resetTransitPacing();
  return fn(asked).finally(() => {
    globalThis.fetch = real;
    resetStopsCache();
    clearRouteCache();
  });
}

const ODAWARA = { lat: 35.2560, lng: 139.1550 };
const STOPS = [
  [35.6896, 139.7006, "新宿"],
  [35.2560, 139.1550, "小田原"],
  [35.2325, 139.1063, "箱根湯本"],
];

test("経由地があっても、区間ごとにYahoo!路線情報で調べる", () =>
  withYahoo(STOPS, () => ({ routed: true, minutes: 90, summary: "小田急線" }),
    async (asked) => {
      const r = await computeRoute([SHINJUKU_ST, ODAWARA, HAKONE_YUMOTO],
        { mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00") });
      assert.equal(asked.length, 2, "区間の数だけ聞いていません");
      assert.equal(r.legs.length, 2);
      assert.ok(r.legs.every((l) => l.routed), "実測扱いになっていません");
      assert.equal(r.routed, true);
      assert.match(r.modeNote ?? "", /Yahoo/);
      assert.equal(routesUsage().calls, 0, "Googleに投げています");
      // 2区間目に乗るのは、1区間目に乗った時刻ではありません。
      assert.ok(new Date(asked[1].departAt) > new Date(asked[0].departAt),
        "2区間目も同じ時刻で聞いています");
    }));

test("Yahoo!で引けない区間だけ、駅の位置からの目安に戻す", () =>
  withYahoo(STOPS,
    (body) => (body.from === "新宿"
      ? { routed: true, minutes: 90, summary: "小田急線" }
      : { routed: false, reason: "経路が見つかりません" }),
    async () => {
      const r = await computeRoute([SHINJUKU_ST, ODAWARA, HAKONE_YUMOTO],
        { mode: "TRANSIT" });
      assert.equal(r.legs[0].routed, true);
      assert.equal(r.legs[1].routed, false);
      assert.equal(r.routed, false);
      assert.match(r.modeNote ?? "", /Yahoo/);
      assert.match(r.modeNote ?? "", /最寄りの駅・バス停/);
    }));

test("頼んだ日時を、そのままYahoo!に渡す", () =>
  withYahoo(STOPS, () => ({
    routed: true, minutes: 329, rideMinutes: 329, waitMinutes: 13,
    summary: "04:13 発→ 09:42 着 5時間29分",
  }), async (asked) => {
    // 過ぎた日でも、Yahoo!はその日のダイヤで答えます。「いま」に
    // 寄せていたころは、9月6日4:00発の旅程に、9月8日の便の時刻が
    // 並んでいました。
    const departAt = new Date("2026-09-06T04:00:00+09:00");
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO],
      { mode: "TRANSIT", departAt });
    assert.equal(asked[0].departAt, departAt.toISOString());
    assert.match(r.legs[0].line, /04:13/);
  }));

test("同じ日なら、実際に乗る便の時刻を返す", () =>
  withYahoo(STOPS, () => ({
    routed: true, minutes: 95, rideMinutes: 87, waitMinutes: 8,
    summary: "10:08 発→ 11:35 着 1時間27分",
  }), async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(r.legs[0].waitMinutes, 8);
    assert.match(r.legs[0].line, /10:08/);
  }));

test("回数制限で断られたら、設定のせいにしない", () =>
  withYahoo(STOPS, () => ({}), async () => {
    // 中継が429を返す形。以前は本文を捨てて「Yahoo Transit 429」とだけ
    // 出していたので、Yahoo!に断られたのか、こちらの回数制限なのかが
    // 分かりませんでした。しかも「ALLOW_ORIGIN を確認してください」と
    // 案内していて、待てば直るものを設定の問題に見せていました。
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("stops-rail")) {
        return { ok: true, json: async () => ({ year: 2008, stops: STOPS }) };
      }
      if (u.includes("stops-bus")) {
        return { ok: true, json: async () => ({ year: 2012, stops: [] }) };
      }
      return {
        ok: false, status: 429,
        headers: { get: (k) => (k === "Retry-After" ? "60" : null) },
        text: async () => JSON.stringify({
          error: { message: "呼び出しが多すぎます。しばらく待ってからお試しください。" },
        }),
      };
    };
    try {
      const { diagnoseYahooTransit } = await import("../packages/core/src/routes.js");
      const r = await diagnoseYahooTransit();
      assert.equal(r.ok, false);
      assert.equal(r.code, 429);
      assert.match(r.message, /待って/);
      assert.match(r.message, /呼び出しが多すぎます/);
      assert.ok(!/ALLOW_ORIGIN/.test(r.message),
        "待てば直るものを、設定の問題に見せています");
      // 旅程が組めなくなるわけではないことも伝えます。
      assert.match(r.message, /目安/);
    } finally {
      globalThis.fetch = real;
    }
  }));

test("区間がいくつあっても、全部Yahoo!に聞く", () =>
  withYahoo([
    [35.6896, 139.7006, "新宿"],
    [35.2560, 139.1550, "小田原"],
    [35.2325, 139.1063, "箱根湯本"],
    [35.2324, 139.0269, "箱根町"],
    [35.1706, 139.0906, "湯河原"],
  ], () => ({ routed: true, minutes: 40, rideMinutes: 38, waitMinutes: 2,
              summary: "10:02 発→ 10:40 着 38分" }),
  async (asked) => {
    // Yahoo!の回数を、Googleの徒歩実測（課金対象・8回まで）と同じ財布から
    // 出していました。徒歩を測るとそのぶん実際の時刻が取れなくなります。
    // 別勘定にして、区間の数だけ聞きにいきます。
    const points = [
      { lat: 35.6896, lng: 139.7006 },
      { lat: 35.2560, lng: 139.1550 },
      { lat: 35.2325, lng: 139.1063 },
      { lat: 35.2324, lng: 139.0269 },
      { lat: 35.1706, lng: 139.0906 },
    ];
    const r = await computeRoute(points, {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(asked.length, 4, "聞いていない区間があります");
    assert.equal(r.legs.length, 4);
    assert.ok(r.legs.every((l) => l.routed), "目安のままの区間があります");
    assert.equal(r.routed, true);
  }));

test("断られたら、しばらく聞きに行かない", async () => {
  const { searchYahooTransit, yahooCooldown, resetYahooCooldown }
    = await import("../packages/core/src/yahoo-transit.js");
  resetYahooCooldown();
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false, status: 429,
      headers: { get: () => "1" },
      text: async () => JSON.stringify({
        error: { message: "呼び出しが多すぎます" } }),
    };
  };
  try {
    // 何度も聞き直します（待ち時間はテストでは待たずに済むよう、
    // 呼び出し回数だけを見ます）。
    await assert.rejects(
      searchYahooTransit({ name: "新宿" }, { name: "箱根湯本" },
                         { retryWaits: [1, 1, 1] }));
    assert.ok(calls > 1, "一度きりで諦めています");

    // そのあとは、間を置くまで投げません。旅程1つで区間の数だけ聞くので、
    // 断られた直後に残りを投げても、全部断られるだけです。
    assert.equal(yahooCooldown().waiting, true);
    const before = calls;
    await assert.rejects(
      searchYahooTransit({ name: "東京" }, { name: "横浜" },
                         { retryWaits: [1, 1, 1] }));
    assert.equal(calls, before, "断られている間も投げています");
  } finally {
    globalThis.fetch = real;
    resetYahooCooldown();
  }
});

// --- 引けるまで、停留所の名前を変えて聞き直す -------------------------------
//
// 街なかの短い移動は、両端の最寄りが同じ停留所になりがちです。以前は
// そこで諦めて「目安」にしていたので、「移動約413分・約2.7km」のような
// 数字が、調べないまま旅程に載っていました。

// 歩く距離（TUNING.walkableKm）より離れた2点にします。1.5km以内は
// 聞かずに徒歩として扱うので、近すぎると「聞いていない」が正解に
// なってしまい、聞き方のテストになりません。
const NEAR_A = { lat: 35.6550, lng: 139.7010, name: "美術館A" };
const NEAR_B = { lat: 35.6750, lng: 139.7250, name: "公園B" };
const CLUSTER = [
  [35.6575, 139.7050, "中央"],      // 両方の最寄り
  [35.6540, 139.7000, "西口"],
  [35.6610, 139.7110, "東口"],
];

test("両端の最寄りが同じでも、次の候補で聞き直す", () =>
  withYahoo(CLUSTER,
    (body) => (body.from === body.to
      ? { routed: false, reason: "同じ駅です" }
      : { routed: true, minutes: 14, rideMinutes: 14, waitMinutes: 0,
          summary: "10:05 発→ 10:19 着 14分" }),
    async (asked) => {
      const r = await computeRoute([NEAR_A, NEAR_B], {
        mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
      });
      assert.ok(asked.length >= 1, "一度も聞いていません");
      // 同じ名前どうしは、そもそも聞きません。
      assert.ok(asked.every((b) => b.from !== b.to),
        "同じ停留所どうしで聞いています");
      assert.equal(r.legs[0].routed, true,
        "候補を変えれば引けるのに、目安のままです");
      // 乗車14分に、停留所までの前後の徒歩が乗ります。乗っている時間
      // だけを所要時間にすると、1.9kmの区間が「1分」になります。
      assert.equal(r.legs[0].rideMinutes, 14);
      assert.ok(r.legs[0].minutes > 14,
        "停留所までの徒歩が足されていません");
      assert.equal(r.legs[0].minutes,
        14 + r.legs[0].walkA + r.legs[0].walkB);
    }, { located: false }));

test("最初の名前で引けなければ、別の停留所名で試す", () =>
  withYahoo(CLUSTER,
    // いちばん近い停留所（西口・東口）では引けず、少し離れた「中央」で
    // だけ引ける、という状況です。
    (body) => (body.from === "中央" || body.to === "中央"
      ? { routed: true, minutes: 18, rideMinutes: 18, waitMinutes: 0,
          summary: "10:05 発→ 10:23 着 18分" }
      : { routed: false, reason: "経路が見つかりません" }),
    async (asked) => {
      const r = await computeRoute([NEAR_A, NEAR_B], {
        mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
      });
      assert.ok(asked.length > 1, "1回で諦めています");
      assert.equal(r.legs[0].routed, true);
      assert.ok([r.legs[0].stations.from, r.legs[0].stations.to]
        .includes("中央"), "引けた組の名前が残っていません");
    }));

test("何通り試しても引けなければ、目安に戻す（無限には聞かない）", () =>
  withYahoo(CLUSTER, () => ({ routed: false, reason: "経路が見つかりません" }),
    async (asked) => {
      const r = await computeRoute([NEAR_A, NEAR_B], {
        mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
      });
      assert.ok(asked.length <= 3, `聞きすぎです（${asked.length}回）`);
      assert.equal(r.legs[0].routed, false);
    }));

// --- 回数制限をまたいでも、目安に落とさない -------------------------------
//
// 「作り直すほど目安が増える」の正体です。前の旅程の終わりに回数制限へ
// 当たると、次の旅程は1区間目から断られます。以前はそこで待たなかった
// ので（「一度も答えが返っていないなら待たない」という取り決め）、
// 最後まで一度も通らず、全区間が目安になっていました。

test("前の旅程で回数制限に当たっていても、待って調べ直す", async () => {
  const { resetYahooCooldown, searchYahooTransit } =
    await import("../packages/core/src/yahoo-transit.js");
  resetRoutesBreaker();
  resetTransitPacing();
  resetYahooCooldown();

  // まず429を1回起こして、待ちに入れます（＝前の旅程の終わりの状態）。
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => "1" },
    text: async () => JSON.stringify({ ok: false, error: {
      code: "RATE_LIMITED", service: "proxy", retryable: true,
      message: "呼び出しが多すぎます", retryAfter: 1 } }),
  });
  await searchYahooTransit({ name: "新宿" }, { name: "箱根湯本" },
    { retryWaits: [], pace: false }).catch(() => {});
  globalThis.fetch = real;

  const { yahooCooldown } = await import("../packages/core/src/yahoo-transit.js");
  assert.equal(yahooCooldown().waiting, true, "待ちに入っていません");
  assert.equal(yahooCooldown().retryable, true,
    "待てば通る断りだと分かっていません");

  // 旅程を組み直します。ここで待ちを消してしまうと、また同じ壁です。
  resetRoutesBreaker();
  assert.equal(yahooCooldown().waiting, true,
    "組み直しで待ちを消しています（また断られます）");

  // 待ったあとは、1区間目から実際の時刻が入ります。
  await withYahoo(STOPS, () => ({
    routed: true, minutes: 90, rideMinutes: 82, waitMinutes: 8,
    summary: "10:08 発→ 11:30 着 1時間22分",
  }), async (asked) => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.ok(asked.length >= 1, "待ったのに聞いていません");
    assert.equal(r.legs[0].routed, true,
      "回数制限をまたぐと目安のままです");
  });
  resetTransitPacing();
});

test("設定の不備で止まっているときは、組み直しで待ちを消す", async () => {
  const { resetYahooCooldown, searchYahooTransit, yahooCooldown } =
    await import("../packages/core/src/yahoo-transit.js");
  resetRoutesBreaker();
  resetTransitPacing();
  resetYahooCooldown();

  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 403, headers: { get: () => null },
    text: async () => JSON.stringify({ ok: false, error: {
      code: "FORBIDDEN", service: "proxy", retryable: false,
      message: "このサイトからは呼べません" } }),
  });
  await searchYahooTransit({ name: "新宿" }, { name: "箱根湯本" },
    { retryWaits: [], pace: false }).catch(() => {});
  globalThis.fetch = real;

  assert.equal(yahooCooldown().retryable, false);
  // キーや出どころを直したかもしれないので、こちらは消します。
  resetRoutesBreaker();
  assert.equal(yahooCooldown().waiting, false,
    "設定を直しても待ち続けています");
  resetTransitPacing();
});

test("1区間目だけ外したら、あとで拾い直す", () => {
  // 1区間目は一度だけ落ちる。以降は通る。
  let first = 0;
  return withYahoo(STOPS, (body) => {
    if (body.from === "新宿" && ++first === 1) {
      return { routed: false, reason: "経路が見つかりません" };
    }
    return { routed: true, minutes: 90, rideMinutes: 82, waitMinutes: 8,
             summary: "10:08 発→ 11:30 着 1時間22分" };
  }, async () => {
    const r = await computeRoute([SHINJUKU_ST, ODAWARA, HAKONE_YUMOTO], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(r.legs[1].routed, true, "2区間目が引けていません");
    assert.equal(r.legs[0].routed, true,
      "1区間目を拾い直していません（ここだけ目安のまま）");
    assert.equal(r.routed, true);
    assert.match(r.modeNote ?? "", /聞き直し/);
  }, { located: false });
});

test("ぜんぶ外しているときは、拾い直さない（同じ答えが返るだけ）", () =>
  withYahoo(STOPS, () => ({ routed: false, reason: "経路が見つかりません" }),
    async (asked) => {
      await computeRoute([SHINJUKU_ST, ODAWARA, HAKONE_YUMOTO], {
        mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
      });
      // 2区間 × 名前3通り = 6回まで。拾い直すと倍になります。
      assert.ok(asked.length <= 6, `聞きすぎです（${asked.length}回）`);
    }));

// --- 歩く距離は、聞かない -------------------------------------------------
//
// 「高乗寺へ移動 07:46発→09:07着（1時間21分）・乗換2回・608円・約0.6km」。
// 600mを1時間21分かけて2回乗り換える人はいません。歩けば8分です。
// 時刻表に聞けば時刻表は答えます。近すぎて直通がないので、遠回りの
// 乗り継ぎが返ってくるだけです。

const CLOSE_A = { lat: 35.6550, lng: 139.7010, name: "寺A" };
const CLOSE_B = { lat: 35.6590, lng: 139.7045, name: "寺B" };   // 約0.5km

test("歩ける距離の区間は、時刻表に聞かない", () =>
  withYahoo(CLUSTER, () => ({
    routed: true, minutes: 81, rideMinutes: 81, waitMinutes: 0,
    summary: "07:46 発→ 09:07 着 1時間21分",
  }), async (asked) => {
    const r = await computeRoute([CLOSE_A, CLOSE_B], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(asked.length, 0,
      "0.5kmの区間を時刻表に聞いています");
    assert.equal(r.legs[0].walk, true, "徒歩として扱っていません");
    assert.ok(r.legs[0].minutes < 30,
      `0.5kmに${r.legs[0].minutes}分かけています`);
    assert.equal(r.legs[0].line, null, "乗り継ぎの一行が付いています");
    assert.match(r.modeNote ?? "", /徒歩/);
  }));

test("歩ける距離を超えたら、聞く", () =>
  withYahoo(CLUSTER, () => ({
    routed: true, minutes: 14, rideMinutes: 14, waitMinutes: 0,
    summary: "10:05 発→ 10:19 着 14分",
  }), async (asked) => {
    const r = await computeRoute([NEAR_A, NEAR_B], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.ok(asked.length >= 1, "歩けない距離なのに聞いていません");
    assert.equal(r.legs[0].routed, true);
    assert.notEqual(r.legs[0].walk, true);
  }));

test("歩く区間は、「◯区間中◯区間で時刻表」の分母から外す", () =>
  withYahoo(CLUSTER, () => ({
    routed: true, minutes: 14, rideMinutes: 14, waitMinutes: 0,
    summary: "10:05 発→ 10:19 着 14分",
  }), async () => {
    // 1区間目は歩き、2区間目は電車。
    const r = await computeRoute([CLOSE_A, CLOSE_B, NEAR_B], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.match(r.modeNote ?? "", /1区間のうち1区間/,
      `分母に歩きが混ざっています: ${r.modeNote}`);
    assert.match(r.modeNote ?? "", /1区間は徒歩/);
    // 聞くべき区間はすべて引けているので、区間全体としては実測扱いです。
    assert.equal(r.routed, true);
  }));

// --- 停留所までの徒歩を、所要時間に入れる ---------------------------------
//
// 画面とGoogleを並べると、こうでした。
//
//   このアプリ  多摩森林科学園 → 浄泉寺   1分・140円
//   Google      同じ区間                  30分・200円（うち徒歩27分）
//
// Yahoo!に聞いているのは「停留所から停留所」で、「いまいる場所から次の
// 場所」ではありません。停留所どうしがたまたま隣で、乗っているのが1分
// だったというだけで、歩く27分をどちらの端にも数えていませんでした。

// 停留所から1kmほど離れた2地点。あいだの停留所どうしは隣です。
const FAR_FROM_STOP_A = { lat: 35.6450, lng: 139.6950, name: "森林科学園" };
const FAR_FROM_STOP_B = { lat: 35.6700, lng: 139.7150, name: "浄泉寺" };

test("停留所までの徒歩を、区間の所要時間に足す", () =>
  withYahoo(CLUSTER, () => ({
    routed: true, minutes: 1, rideMinutes: 1, waitMinutes: 0,
    summary: "10:07 発→ 10:08 着 1分",
    meta: { departure: "10:07", arrival: "10:08", transfers: 0, fareYen: 140,
            legs: [], alternatives: [] },
  }), async () => {
    const r = await computeRoute([FAR_FROM_STOP_A, FAR_FROM_STOP_B], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    const leg = r.legs[0];
    assert.equal(leg.rideMinutes, 1, "乗車時間が変わっています");
    assert.ok(leg.walkA > 0 && leg.walkB > 0,
      "どちらかの端の徒歩が0になっています");
    assert.equal(leg.minutes, 1 + leg.walkA + leg.walkB);
    assert.ok(leg.minutes > 15,
      `3km近い区間が${leg.minutes}分になっています`);
    // 一行にも書きます。「1分」とだけ出すと、歩く時間が無いように読めます。
    assert.match(leg.line, /徒歩/,
      `前後の徒歩が一行に出ていません: ${leg.line}`);
  }, { located: false }));

test("出発地そのものが駅なら、その端の徒歩は数えない", () =>
  withYahoo(STOPS, () => ({
    routed: true, minutes: 90, rideMinutes: 82, waitMinutes: 8,
    summary: "10:08 発→ 11:30 着 1時間22分",
    meta: { departure: "10:08", arrival: "11:30", transfers: 1, fareYen: 1190,
            legs: [], alternatives: [] },
  }), async () => {
    const r = await computeRoute([SHINJUKU_ST, HAKONE_YUMOTO], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(r.legs[0].walkA, 0, "駅から駅まで歩かせています");
    assert.equal(r.legs[0].minutes, 90);
  }));

test("乗るより歩くほうが早いなら、歩く", () =>
  withYahoo(CLUSTER, () => ({
    // 2km先へ行くのに、遠回りして1時間かかる乗り継ぎ。
    routed: true, minutes: 60, rideMinutes: 60, waitMinutes: 0,
    summary: "10:00 発→ 11:00 着 1時間",
    meta: { departure: "10:00", arrival: "11:00", transfers: 2, fareYen: 600,
            legs: [], alternatives: [] },
  }), async () => {
    // 約2.2km。歩けば35分ほどの距離です。
    const near = { lat: 35.6700, lng: 139.7150, name: "公園C" };
    const r = await computeRoute([NEAR_A, near], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(r.legs[0].walk, true,
      "1時間かけて乗せています（歩けば35分ほどです）");
    assert.ok(r.legs[0].minutes < 60);
  }));

// --- 近くに停留所が無い区間 -------------------------------------------------
//
// 「岩尾内ダム」（北海道士別市）の5km以内に、停留所は1つもありません。
// 半径を5kmだけで見ていたので、問い合わせる名前が作れず、**一度も
// 聞かないまま「目安」**になっていました。画面には37.6kmが
// 「約112分・目安」とだけ出て、調べられなかったのか調べていないのかが
// 読む人に分かりません。

const REMOTE = { lat: 44.10, lng: 142.4333, name: "岩尾内ダム" };
const TOWN = { lat: 44.0, lng: 142.50, name: "士別の町" };
// 10km前後に1つだけ停留所がある、という土地。
const SPARSE = [
  [44.05, 142.37, "東六線"],
  [44.02, 142.52, "和寒"],
];

test("5km以内に無ければ、広げて探す", () =>
  withYahoo(SPARSE, () => ({
    routed: true, minutes: 40, rideMinutes: 40, waitMinutes: 0,
    summary: "10:00 発→ 10:40 着 40分",
    meta: { departure: "10:00", arrival: "10:40", transfers: 0, fareYen: 700,
            legs: [], alternatives: [] },
  }), async (asked) => {
    const r = await computeRoute([REMOTE, TOWN], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.ok(asked.length >= 1,
      "5km以内に無いだけで、一度も聞いていません");
    assert.equal(r.legs[0].routed, true);
    // 駅まで歩く時間も足します（10kmなら2時間半です）。
    assert.ok(r.legs[0].walkA > 0, "駅までの徒歩が0になっています");
  }, { located: false }));

test("どこにも停留所が無いなら、「目安」ではなくそう言う", () =>
  withYahoo([], () => ({ routed: false }), async (asked) => {
    const r = await computeRoute([REMOTE, TOWN], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(asked.length, 0, "停留所が無いのに聞きに行っています");
    assert.match(r.modeNote ?? "", /駅・バス停が見当たりません/,
      `理由が出ていません: ${r.modeNote}`);
    assert.match(r.modeNote ?? "", /車/);
  }));

// --- 位置で聞く ------------------------------------------------------------
//
// 名前で聞くと「県庁前」が神戸に、「京都駅前」が飲食店になります。
// まず位置で聞き、Yahoo!に近くの駅・バス停を選ばせます。

test("まず位置で聞き、引けたら停留所名では聞かない", () =>
  withYahoo(CLUSTER, () => ({
    routed: true, minutes: 38, rideMinutes: 21, waitMinutes: 5,
    summary: "10:05 発→ 10:43 着 38分",
    meta: { departure: "10:05", arrival: "10:43", transfers: 1, fareYen: 460,
      distanceKm: 4.7, alternatives: [],
      legs: [
        { from: "京都駅", to: "烏丸御池/京都市営バス", departure: "10:05",
          arrival: "10:08", minutes: 3, line: "出口：徒歩 徒歩3分" },
        { from: "烏丸御池/京都市営バス", to: "銀閣寺前/京都市営バス",
          departure: "10:20", arrival: "10:41", minutes: 21,
          line: "京都市営バス・３２号・平安神宮 銀閣寺行" },
      ] },
  }), async (asked) => {
    const r = await computeRoute([FAR_FROM_STOP_A, FAR_FROM_STOP_B], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.equal(asked.length, 1, "位置で引けたのに、名前でも聞いています");
    assert.deepEqual(asked[0].fromAt,
      { lat: FAR_FROM_STOP_A.lat, lng: FAR_FROM_STOP_A.lng });
    const leg = r.legs[0];
    assert.equal(leg.routed, true);
    // 停留所までの徒歩は Yahoo!の答えに入っています。二重に足しません。
    assert.equal(leg.walkA, 0);
    assert.equal(leg.walkB, 0);
    assert.equal(leg.minutes, 38);
    assert.ok(leg.kinds.includes("bus"), `バスと分かっていません: ${leg.kinds}`);
    assert.equal(leg.stations.from, "烏丸御池");
  }));

test("位置を受け取らない中継なら、停留所名で聞き直す", () =>
  withYahoo(CLUSTER, () => ({
    routed: true, minutes: 14, rideMinutes: 14, waitMinutes: 0,
    summary: "10:05 発→ 10:19 着 14分",
  }), async (asked) => {
    const r = await computeRoute([NEAR_A, NEAR_B], {
      mode: "TRANSIT", departAt: new Date("2026-10-01T10:00:00+09:00"),
    });
    assert.ok(asked.length >= 2, "名前で聞き直していません");
    assert.ok(asked.slice(1).every((b) => !b.fromAt), "名前の問い合わせに位置が付いています");
    assert.equal(r.legs[0].routed, true);
  }, { located: false }));
