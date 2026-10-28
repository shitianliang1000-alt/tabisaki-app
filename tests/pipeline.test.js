// 画面で実際に壊れていた入力を、そのまま流して固定する。
//
//   「四国の有名な観光地を巡りたい」／東京駅発／9泊10日
//     → 銚子（千葉県）が提案され、4スポット・所要225時間45分・
//       余裕12951分という結果になっていました。
//
// APIキーは未設定なので、AI無し（語句検索＋距離推定）の経路を通ります。
// ネットワークにも触りません。

import assert from "node:assert/strict";
import test from "node:test";

import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";
import { areaScope, detectAreas } from "../packages/core/src/areas.js";

const kb = await loadKnowledgeBase();

function trip(over = {}) {
  return makeTrip({
    origin: findPlace("東京駅"),
    departAt: new Date("2026-08-31T09:00"),
    arriveBy: new Date("2026-09-09T19:00"),
    note: "四国の有名な観光地を巡りたい",
    interests: [],
    budgetYen: 999999,
    ...over,
  });
}

test("「四国」は地名として解釈され、四国4県の収録エリアに結びつく", () => {
  const scope = areaScope(detectAreas("四国の有名な観光地を巡りたい", kb));
  assert.ok(scope.regionIds, "地名で絞り込めていません");
  const prefs = new Set([...scope.regionIds]
    .map((id) => kb.regionsById.get(id).prefecture));
  assert.deepEqual([...prefs].sort(),
    ["愛媛県", "徳島県", "香川県", "高知県"].sort());
});

test("「四国」で銚子（千葉県）は提案されない", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  const prefs = itin.prefecture.split("・");
  for (const p of prefs) {
    assert.ok(["徳島県", "香川県", "愛媛県", "高知県"].includes(p),
      `四国以外が選ばれています: ${itin.regionName}（${itin.prefecture}）`);
  }
});

test("9泊10日なら、日数ぶんの旅程になる", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  assert.ok(itin.days.length >= 8,
    `10日間なのに${itin.days.length}日ぶんしかありません`);
  assert.ok(itin.spotCount >= 15,
    `10日間で${itin.spotCount}スポットは少なすぎます`);
});

test("夜通し観光する旅程にならない", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind !== "spot") continue;
      const h = item.start.getHours();
      assert.ok(h >= 5 && h < 21,
        `${item.title} が ${item.start.toLocaleString("ja-JP")} に始まっています`);
    }
  }
});

test("宿泊は泊数ぶん入り、その日にいるエリアに取る", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  const lodgings = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "lodging");
  assert.equal(lodgings.length, 9, "9泊ぶんの宿泊が入っていません");
  const areas = new Set(lodgings.map((l) => l.near.regionName));
  assert.ok(areas.size >= 2, `10日間ずっと同じ宿です: ${[...areas]}`);
});

test("長い旅では拠点を移す", async () => {
  const itin = await planTrip({ trip: trip(), kb });
  assert.ok(itin.stays.length >= 2,
    `10日間で1エリアに留まっています: ${itin.regionName}`);
});

test("日帰りは、これまでどおり1日で収まる", async () => {
  const itin = await planTrip({
    kb,
    trip: trip({
      note: "鎌倉で歴史ある街を歩きたい",
      departAt: new Date("2026-08-31T09:00"),
      arriveBy: new Date("2026-08-31T19:00"),
    }),
  });
  assert.equal(itin.days.length, 1);
  assert.ok(itin.spotCount >= 2);
  assert.equal(itin.days[0].items.filter((i) => i.kind === "lodging").length, 0);
});

test("収録の無い地名は、黙って別の場所に置き換えず、そう書く", async () => {
  const itin = await planTrip({
    kb,
    trip: trip({
      note: "屋久島の縄文杉を見たい",
      departAt: new Date("2026-08-31T09:00"),
      arriveBy: new Date("2026-09-02T19:00"),
    }),
  });
  const said = [itin.coverage?.text ?? "", ...itin.warnings].join("\n");
  assert.match(said, /屋久島|収録/);
});

// --- 収録に無い土地を、調べてから旅程にする ---------------------------------

const SAKYU = {
  ok: true, term: "鳥取砂丘", cached: false, rejected: [],
  regions: [{
    id: "tottori", name: "鳥取砂丘", prefecture: "鳥取県", prefectureId: "tottori",
    hub: "tokyo", lat: 35.5390, lng: 134.2260,
    station: "鳥取駅", stationLat: 35.4900, stationLng: 134.2310,
    genres: ["sea", "art", "history"], spotCount: 3,
    tagline: "日本海に面した砂の丘", description: "砂丘と、砂の美術館。",
    source: "ai", verified: false,
  }],
  spots: [
    { id: "tottori-1", regionId: "tottori", region: "鳥取砂丘", name: "鳥取砂丘",
      category: "海岸", genres: ["sea"], lat: 35.5390, lng: 134.2260,
      prefecture: "鳥取県", prefectureId: "tottori", description: "馬の背。",
      fame_score: 86, fame_tier: "major", dwell: 90, open: 0, close: 24, fee: 0,
      source: "ai", verified: false },
    { id: "tottori-2", regionId: "tottori", region: "鳥取砂丘", name: "砂の美術館",
      category: "美術館", genres: ["art"], lat: 35.5352, lng: 134.2266,
      prefecture: "鳥取県", prefectureId: "tottori", description: "砂の彫刻。",
      fame_score: 58, fame_tier: "known", dwell: 60, open: 9, close: 18, fee: 800,
      source: "ai", verified: false },
    { id: "tottori-3", regionId: "tottori", region: "鳥取砂丘", name: "白兎神社",
      category: "神社", genres: ["history"], lat: 35.4933, lng: 134.0994,
      prefecture: "鳥取県", prefectureId: "tottori", description: "因幡の白兎。",
      fame_score: 28, fame_tier: "hidden", dwell: 30, open: 0, close: 24, fee: 0,
      source: "ai", verified: false },
  ],
};

test("収録に無い土地でも、調べてその土地の旅程になる", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    discover: async () => SAKYU,
    trip: trip({
      note: "鳥取砂丘を見たい",
      departAt: new Date("2026-09-05T08:00"),
      arriveBy: new Date("2026-09-06T20:00"),
    }),
  });
  assert.equal(itin.prefecture, "鳥取県",
    `鳥取以外が選ばれています: ${itin.regionName}（${itin.prefecture}）`);
  const names = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(names.includes("鳥取砂丘"), `立ち寄り: ${names.join("、")}`);
});

test("調べたデータであることを、旅程に明記する", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    discover: async () => SAKYU,
    trip: trip({
      note: "鳥取砂丘を見たい",
      departAt: new Date("2026-09-05T08:00"),
      arriveBy: new Date("2026-09-06T20:00"),
    }),
  });
  const said = itin.warnings.join("\n");
  assert.match(said, /AIが検索して調べた/);
  assert.match(said, /未確認/);
});

test("調べられなかったときは、そう書く（黙って別の土地を出さない）", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    discover: async (term) => ({ ok: false, term, regions: [], spots: [],
                                 rejected: [], reason: "AIキーが未設定です" }),
    trip: trip({
      note: "屋久島の縄文杉を見たい",
      departAt: new Date("2026-09-05T09:00"),
      arriveBy: new Date("2026-09-07T19:00"),
    }),
  });
  assert.match(itin.warnings.join("\n"), /屋久島/);
});

test("利用者が選んだペースは、AIの読み取りに上書きされない", async () => {
  // 「もっとゆっくり」を押したのに、希望文からの推測でペースが
  // 戻されていました。押したのに何も変わらない、がいちばん困ります。
  const slow = await planTrip({
    trip: trip({ pace: "relaxed", note: "四国をきびきび回りたい" }), kb });
  const packed = await planTrip({
    trip: trip({ pace: "packed", note: "四国をきびきび回りたい" }), kb });
  assert.ok(slow.spotCount < packed.spotCount,
    `ゆっくり ${slow.spotCount}か所 / 詰めこみ ${packed.spotCount}か所 — `
    + "選んだペースが効いていません");
});

test("天気が取れれば、見直しの提案が旅程に付く", async () => {
  // 予報は注入します（この環境から Open-Meteo には出られません）。
  const rainy = (at, date) => Promise.resolve({
    ok: true, date: "x",
    rows: Array.from({ length: 24 }, (_, h) => ({
      iso: `2026-09-12T${String(h).padStart(2, "0")}:00`,
      rain: h >= 12 && h <= 16 ? 90 : 5, temp: 22, code: 61,
    })),
  });
  const itin = await planTrip({ trip: trip(), kb, forecast: rainy });
  assert.ok(itin.replan, "見直しの結果が付いていません");
  assert.ok(Array.isArray(itin.replan.suggestions));
  assert.ok(itin.replan.days.length > 0, "その日の天気の要約がありません");
});

test("天気が取れなくても、旅程はそのまま出る", async () => {
  const broken = () => Promise.reject(new Error("つながりません"));
  const itin = await planTrip({ trip: trip(), kb, forecast: broken });
  assert.ok(itin.days.length > 0, "天気の失敗で旅程が消えています");
  // 天気の提案は出ませんが、混雑や日没の提案は天気に依らず出ます
  assert.equal(itin.replan.suggestions.filter((s) => s.kind === "rain").length,
               0);
  assert.deepEqual(itin.replan.days, []);
});

test("予報の出ない先の旅には、その時期の平年が付く", async () => {
  // 予報は16日先までです。宿の都合で1か月先に組む旅には、いまの画面は
  // 天気の話をいっさいしませんでした。**予報ではなく**、過去の観測の
  // 平均を添えます（packages/core/src/normals.js）。取りにいく先は注入します。
  const normals = async () => ({ ok: true,
    text: "11月20日ごろの平年は、最高 15℃・最低 6℃ です。"
      + "これは予報ではなく、過去の観測の平均です。",
    value: { years: 10, samples: 70, tmaxMean: 15, tminMean: 6,
             tmaxLo: 12, tmaxHi: 18, rainDays: 24, rainRate: 34 } });
  const itin = await planTrip({ trip: trip(), kb, normals,
                                forecast: () => Promise.resolve({ ok: false }) });
  assert.ok(itin.replan.normals, "平年が付いていません");
  assert.match(itin.replan.normals.text, /予報ではなく/);
  assert.equal(itin.replan.normals.tmaxMean, 15);
});

test("平年が取れなくても、旅程はそのまま出る", async () => {
  const itin = await planTrip({ trip: trip(), kb,
    forecast: () => Promise.resolve({ ok: false }),
    normals: () => Promise.reject(new Error("つながりません")) });
  assert.ok(itin.days.length > 0, "平年の失敗で旅程が消えています");
  assert.equal(itin.replan.normals, undefined);
});

test("天気を使わない指定ができる（軽量モード用）", async () => {
  let called = 0;
  const spy = () => { called++; return Promise.resolve({ ok: false }); };
  const itin = await planTrip({ trip: trip(), kb, forecast: spy,
                               useWeather: false });
  assert.equal(called, 0, "使わない指定なのに天気を取りに行っています");
  assert.deepEqual(itin.replan.suggestions, [],
    "使わない指定のときは、混雑や日没の提案も出しません");
});

// --- 日数ぶんの立ち寄りを用意する -------------------------------------------
//
// 「箱根で」と書いて3泊4日にすると、箱根の収録11件だけで4日を埋めることに
// なり、1日2〜3か所で残りが空きます。実際に行く人も、その場合は隣の
// エリアまで足を延ばします。足りているときは広げません（指定は指定です）。

import { spotsNeededFor, widenScopeForDays } from "../packages/core/src/pipeline.js";

test("収録が足りない日数では、近いエリアを足す", async () => {
  const kb = await loadKnowledgeBase();
  const hakone = kb.regions.find((r) => r.name === "箱根");
  assert.ok(hakone, "箱根が収録にありません");

  const scope = { regionIds: new Set([hakone.id]) };
  const before = kb.spotsByRegion.get(hakone.id).length;
  const added = widenScopeForDays(scope, kb, 4);

  assert.ok(before < spotsNeededFor(4), "前提が変わっています");
  assert.ok(added.length > 0, "4日ぶんに足りないのに広げていません");
  const after = [...scope.regionIds]
    .reduce((n, id) => n + (kb.spotsByRegion.get(id)?.length ?? 0), 0);
  assert.ok(after >= spotsNeededFor(4), `${after}件では4日を埋められません`);
});

test("足りているときは、指定エリアを広げない", async () => {
  const kb = await loadKnowledgeBase();
  const hakone = kb.regions.find((r) => r.name === "箱根");
  const scope = { regionIds: new Set([hakone.id]) };
  assert.deepEqual(widenScopeForDays(scope, kb, 1), []);
  assert.equal(scope.regionIds.size, 1);
});

test("広げるのは近いエリアだけ（箱根と書いて京都が入らない）", async () => {
  const kb = await loadKnowledgeBase();
  const hakone = kb.regions.find((r) => r.name === "箱根");
  const scope = { regionIds: new Set([hakone.id]) };
  widenScopeForDays(scope, kb, 10);
  for (const id of scope.regionIds) {
    const r = kb.regionsById.get(id);
    const km = Math.hypot((r.lat - hakone.lat) * 111,
                          (r.lng - hakone.lng) * 91);
    assert.ok(km <= 70, `${r.name} は箱根から約${Math.round(km)}km あります`);
  }
});

test("日数が増えれば、立ち寄りも増える", async () => {
  const kb = await loadKnowledgeBase();
  const plan = async (nights) => {
    const itin = await planTrip({ kb, trip: makeTrip({
      origin: findPlace("新宿駅"), budgetYen: 999999,
      note: "箱根で温泉と自然を楽しみたい",
      departAt: new Date("2026-10-03T09:00"),
      arriveBy: new Date(`2026-10-0${3 + nights}T19:00`),
    }) });
    return itin.days.flatMap((d) => d.items)
      .filter((i) => i.kind === "spot").length;
  };
  const short = await plan(1);
  const long = await plan(3);
  assert.ok(long > short, `1泊${short}件・3泊${long}件で増えていません`);
  assert.ok(long >= 12, `3泊4日で${long}件は少なすぎます`);
});


// --- 調べた便と、旅程に出る時刻を合わせる -----------------------------------
//
// 画面にこう出ていました。
//
//   10:38  多摩森林科学園へ移動   09:02発→09:04着（2分）
//   12:42  浄泉寺へ移動          10:07発→10:08着（1分）
//
// どちらも1時間半ほど前の便です。1回目の実測で旅程ぜんぶが後ろへ
// 動いたのに、便を調べ直していなかったためです。本数の少ない路線では、
// これは別の便になります。

test("旅程に出る時刻と、調べた便の時刻がそろう", async () => {
  const { resetRoutesBreaker, resetTransitPacing, clearRouteCache } =
    await import("../packages/core/src/routes.js");
  resetRoutesBreaker();
  resetTransitPacing();
  clearRouteCache();

  const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}`
    + `:${String(d.getMinutes()).padStart(2, "0")}`;
  // 停留所のデータは、使う直前に fetch で読みます。ここを素通しにすると
  // Node には file: が無いので空になり、**立ち寄りどうしの区間が一度も
  // 調べられません**（この回帰そのものが見えなくなります）。ディスクから
  // 読ませます。
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../", import.meta.url).pathname;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    // 乗り換えは中継の /transit（古い中継なら /yahoo/transit）へ聞きます。
    if (!/\/transit$/.test(u)) {
      const path = u.startsWith("file:")
        ? new URL(u).pathname
        : root + u.replace(/^\.?\//, "").replace(/^.*\/kb\//, "kb/");
      const body = await readFile(path, "utf8");
      return { ok: true, status: 200,
               json: async () => JSON.parse(body), text: async () => body };
    }
    // 頼まれた時刻ちょうどに出る便がある、という世界。ずれて調べていれば、
    // ずれた時刻がそのまま旅程に出ます。
    const at = new Date(JSON.parse(init?.body ?? "{}").departAt);
    // どの区間も、目安よりずっと長くかかることにします。
    // これが1回では収まらない理由です。実測で組み直すと、そのあとの
    // 区間を通る時刻がまるごと後ろへ動きます。1回で止めると、
    // 動く前の時刻で調べた便が、動いたあとの行に並びます。
    const min = 45;
    const end = new Date(at.getTime() + min * 60000);
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => "",
      json: async () => ({
        routed: true, minutes: min, rideMinutes: min, waitMinutes: 0,
        summary: `${hhmm(at)} 発→ ${hhmm(end)} 着 ${min}分`,
        meta: { departure: hhmm(at), arrival: hhmm(end),
                transfers: 0, fareYen: 200, legs: [], alternatives: [] },
      }),
    };
  };
  // 停留所は一度読んだら覚えたままです。このファイルの前のテストが
  // 素のfetchで読みに行って空になっているので、読み直させます。
  const { resetStopsCache } = await import("../packages/core/src/stops.js");
  resetStopsCache();
  try {
    const itin = await planTrip({
      trip: trip({ note: "東京の下町を歩きたい",
                   departAt: new Date("2026-08-31T04:00"),
                   arriveBy: new Date("2026-09-01T19:00") }),
      kb,
    });
    const moves = itin.days.flatMap((d) => d.items)
      .filter((i) => i.kind === "transit" && i.yahoo?.departure);
    assert.ok(moves.length, "時刻の入った移動がありません");
    for (const m of moves) {
      const [h, min] = m.yahoo.departure.split(":").map(Number);
      const shown = new Date(m.start);
      const gap = Math.abs((h * 60 + min)
        - (shown.getHours() * 60 + shown.getMinutes()));
      assert.ok(gap <= 30,
        `${m.title}: 行は ${hhmm(shown)} なのに、`
        + `調べたのは ${m.yahoo.departure} の便です`);
    }
  } finally {
    globalThis.fetch = real;
    resetTransitPacing();
    resetStopsCache();
  }
});

// --- 同じ場所を、2回は置かない ---------------------------------------------
//
// 画面にこう出ていました。
//
//   17:50  高尾山
//   20:43  高尾山山頂へ移動   徒歩約11分・約0.0km
//   20:54  高尾山山頂
//
// 収録では takao-2「高尾山山頂」と lm-60「高尾山」が **21m** 離れて
// いるだけです。名前でまとめる仕組み（tools/dedupe_spots.py）はあり
// ますが、名前が違えば通り抜けます。同じ山頂に2回立ち、あいだの
// 「0.0kmを11分」は歩きようがありません。

test("同じ場所は、名前が違っても1回だけ置く", async () => {
  const { dropSamePlace } = await import("../packages/core/src/pipeline.js");
  const takaoTop = { id: "takao-2", name: "高尾山山頂",
                     lat: 35.6252, lng: 139.2434 };
  const takao = { id: "lm-60", name: "高尾山", lat: 35.6253, lng: 139.2436 };
  const yakuoin = { id: "takao-1", name: "高尾山薬王院",
                    lat: 35.6256, lng: 139.2472 };
  const kept = dropSamePlace([takaoTop, takao, yakuoin]);
  assert.deepEqual(kept.map((s) => s.id), ["takao-2", "takao-1"],
    "21m離れた同じ場所を2回置いています");
});

test("300m離れていれば、別の場所として置く", async () => {
  const { dropSamePlace } = await import("../packages/core/src/pipeline.js");
  // 薬王院と山頂は346m。参道を登る別の場所です。
  const top = { id: "a", lat: 35.6252, lng: 139.2434 };
  const temple = { id: "b", lat: 35.6256, lng: 139.2472 };
  assert.equal(dropSamePlace([top, temple]).length, 2);
});

test("旅程に、同じ場所が2回出てこない", async () => {
  const { haversineKm } = await import("../packages/core/src/feasibility.js");
  const itin = await planTrip({
    trip: trip({ note: "高尾山に登りたい",
                 departAt: new Date("2026-08-31T09:00"),
                 arriveBy: new Date("2026-09-01T19:00") }),
    kb,
  });
  // 駅からすぐの立ち寄り（99mを5分で歩く）は、おかしくありません。
  // おかしいのは、**同じ場所に2回立つ**ことです。
  const places = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot" && i.place)
    .map((i) => i.place);
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      const m = haversineKm(places[i], places[j]) * 1000;
      assert.ok(m >= 100,
        `${places[i].name} と ${places[j].name} は ${m.toFixed(0)}m しか`
        + "離れていません（同じ場所です）");
    }
  }
});

// --- ローマ字で書かれた行き先 -----------------------------------------------

test("英語で書かれた地名でも、その土地が出る", async () => {
  const itin = await planTrip({
    trip: trip({ note: "I want to visit around Sendai",
                 departAt: new Date("2026-09-12T09:00"),
                 arriveBy: new Date("2026-09-14T19:00") }),
    kb,
  });
  assert.match(itin.prefecture, /宮城/,
    `${itin.prefecture}（${itin.regionName}）が出ています。仙台ではありません`);
});

test("乗り物の指定を、旅程の組み立てに反映する", async () => {
  const itin = await planTrip({
    trip: trip({ note: "ツーリングで北海道を回りたい",
                 departAt: new Date("2026-09-12T08:00"),
                 arriveBy: new Date("2026-09-14T19:00") }),
    kb,
  });
  assert.ok(itin.warnings.some((w) => /バイク/.test(w)),
    "何を読み取ったかが、どこにも書かれていません");
});

test("画面で選ばれた乗り物を、文からの推し量りで上書きしない", async () => {
  const itin = await planTrip({
    trip: trip({ note: "ツーリングで北海道を回りたい", transport: "transit",
                 departAt: new Date("2026-09-12T08:00"),
                 arriveBy: new Date("2026-09-14T19:00") }),
    kb,
  });
  // 読み取ったことは伝えますが、選ばれた「電車・バス」で組みます。
  assert.ok(itin.days.length, "旅程が組めていません");
});

test("サンライズと書いたら、夜行で組む", async () => {
  const itin = await planTrip({
    trip: trip({ note: "サンライズに乗って出雲大社へ",
                 departAt: new Date("2026-09-12T10:00"),
                 arriveBy: new Date("2026-09-15T20:00") }),
    kb,
  });
  const items = itin.days.flatMap((d) => d.items);
  const out = items.find((i) => i.kind === "transit" && i.overnight !== false
    && /サンライズ/.test(i.detail ?? ""));
  assert.ok(out, "夜行の区間がありません");
  assert.equal(new Date(out.start).getHours(), 21, "21:50発になっていません");
  // 乗る前に、着いた先で観光していないこと。
  const board = new Date(out.start);
  for (const s of items.filter((i) => i.kind === "spot")) {
    assert.ok(new Date(s.start) >= board,
      `${s.title} が乗車前（${new Date(s.start).getHours()}時）に入っています`);
  }
  // その晩の宿は取りません（車中泊）。
  const firstNight = itin.days[0].items.find((i) => i.kind === "lodging");
  assert.equal(firstNight, undefined, "車中泊の晩に宿を取っています");
});

test("名前のある列車を書いたら、その列車の行き先を地名として読む", async () => {
  // ここは収録の小さいほう（サンプル）で走ります。伊豆の収録は
  // 「熱海」しか無いので、2日ぶんの立ち寄りが足りずに範囲が広がる
  // ことがあります。**寄せられているか**を見るのは areas の側の仕事に
  // して、ここでは「読み取ったことが伝わるか」を見ます。
  const { detectAreas } = await import("../packages/core/src/areas.js");
  const { readIntent } = await import("../packages/core/src/intent.js");
  const toward = readIntent("サフィール踊り子に乗りたい").toward;
  const areas = detectAreas(`サフィール踊り子に乗りたい ${toward.join(" ")}`, kb);
  assert.ok(areas.length,
    "列車の行き先が、地名として読めていません");
  assert.ok(areas.every((a) => a.prefectures.includes("静岡県")),
    `伊豆以外が混ざっています: ${areas.map((a) => a.term).join(",")}`);

  const itin = await planTrip({
    trip: trip({ note: "サフィール踊り子に乗りたい",
                 departAt: new Date("2026-09-12T09:00"),
                 arriveBy: new Date("2026-09-13T20:00") }),
    kb,
  });
  assert.ok(itin.warnings.some((w) => /サフィール踊り子/.test(w)),
    "どの列車を読み取ったかが、どこにも書かれていません");
});


// --- 1か所を「外す」と、件数ごと減る -----------------------------------------
//
// 旅程のカードの「外す」は、その場所を候補から外して組み直します。
// 件数を減らさずに外すだけだと、空いた枠を別の場所が埋めます。
// 組み直しとしては正しいのですが、押した人には何も起きていないように
// 見え、「別の候補」との違いも分かりません。

test("「外す」を押すと、いま出ている件数より減る", async () => {
  const kb = await loadKnowledgeBase();
  const base = {
    origin: findPlace("新宿駅"), budgetYen: 999999,
    note: "箱根で温泉と自然を楽しみたい",
    departAt: new Date("2026-10-03T09:00"),
    arriveBy: new Date("2026-10-05T19:00"),
  };
  const spots = (itin) => itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot");

  const before = await planTrip({ kb, trip: makeTrip(base) });
  const target = spots(before).find((i) => i.spotId ?? i.place?.id);
  assert.ok(target, "外せる立ち寄りがありません");
  const id = target.spotId ?? target.place.id;
  const was = spots(before).length;

  // 上限は「いま出ている件数マイナス1」。減らす数ではなく上限の絶対値に
  // している理由は pipeline.js のコメントにあります。
  const after = await planTrip({ kb, trip: makeTrip({
    ...base,
    must: { avoidSpotIds: [id], removedSpotIds: [id], spotCap: was - 1 },
  }) });
  assert.ok(!spots(after).some((i) => (i.spotId ?? i.place?.id) === id),
    "外したはずの場所が、まだ入っています");
  assert.ok(spots(after).length < was,
    `外す前 ${was}件・外したあと ${spots(after).length}件で減っていません`);
});

test("「別の候補」は、その場所だけを入れ替える", async () => {
  const kb = await loadKnowledgeBase();
  const base = {
    origin: findPlace("新宿駅"), budgetYen: 999999,
    note: "箱根で温泉と自然を楽しみたい",
    departAt: new Date("2026-10-03T09:00"),
    arriveBy: new Date("2026-10-05T19:00"),
  };
  const spots = (itin) => itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot");

  const before = await planTrip({ kb, trip: makeTrip(base) });
  const target = spots(before).find((i) => i.spotId ?? i.place?.id);
  const id = target.spotId ?? target.place.id;

  // 上限を渡さないのが「別の候補」です。空いた枠は、埋められるなら
  // 別の場所が埋めます（近くに代わりが無ければ、埋まらないこともあります）。
  const after = await planTrip({ kb, trip: makeTrip({
    ...base, must: { avoidSpotIds: [id] },
  }) });
  assert.ok(!spots(after).some((i) => (i.spotId ?? i.place?.id) === id),
    "差し替えたはずの場所が、まだ入っています");
  assert.ok(spots(after).length >= spots(before).length - 1,
    "差し替えただけなのに、旅程が大きく痩せています");
});

test("立ち寄りの数の上限は、旅程に効く", async () => {
  // 「外す」が効くための土台です。上限を渡さなければ日数から決まり、
  // 渡せばそれを超えません。
  const kb = await loadKnowledgeBase();
  const base = {
    origin: findPlace("新宿駅"), budgetYen: 999999,
    note: "箱根で温泉と自然を楽しみたい",
    departAt: new Date("2026-10-03T09:00"),
    arriveBy: new Date("2026-10-05T19:00"),
  };
  const count = (itin) => itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "spot").length;

  const free = await planTrip({ kb, trip: makeTrip(base) });
  assert.ok(count(free) > 4, `上限なしで${count(free)}件では、試せません`);
  const capped = await planTrip({ kb, trip: makeTrip({
    ...base, must: { spotCap: 4 },
  }) });
  assert.ok(count(capped) <= 4,
    `上限4のはずが${count(capped)}件あります`);
});

test("日をまたいで着いた朝は、その日の頭に「着いた」を置く", async () => {
  // 夜行の旅程が、こうなっていました。
  //
  //   1日目  21:50–09:58  東京駅 → 出雲市駅（サンライズ出雲・車中泊）
  //   2日目  09:58–10:29  出雲大社へ移動
  //
  // **2日目に「出雲市駅に着いた」行がありません。** 着いた時刻は
  // 1日目の行の右端にしかなく、2日目だけを見ると、どこから動き出すのか
  // その日のどこにも書かれていません。
  const itin = await planTrip({
    trip: trip({ note: "サンライズに乗って出雲大社へ",
                 departAt: new Date("2026-09-12T10:00"),
                 arriveBy: new Date("2026-09-15T20:00") }),
    kb,
  });
  const out = itin.days.flatMap((d) => d.items)
    .find((i) => i.kind === "transit" && /サンライズ/.test(i.detail ?? ""));
  assert.ok(out, "夜行の区間がありません");
  // 着く日の頭に、着地があること。
  const arriveDay = itin.days.find((d) =>
    new Date(d.date).setHours(0, 0, 0, 0)
      === new Date(out.end).setHours(0, 0, 0, 0));
  assert.ok(arriveDay, "着いた日が旅程にありません");
  const first = arriveDay.items[0];
  assert.equal(first.kind, "arrive",
    `着いた日の1行目が ${first.kind}（${first.title}）です`);
  assert.match(first.title, /出雲市.*着/);
  // 着いた時刻そのものであること（前後にずらしません）。
  assert.equal(+new Date(first.start), +new Date(out.end));
  // 幅は持ちません。時計を進めるものではなく、その日の起点の目印です。
  assert.equal(+new Date(first.end), +new Date(first.start));
  // 何に乗って、いつ出たのかが書かれていること。
  assert.match(first.detail, /サンライズ/);
  assert.match(first.detail, /21:50/);
  // 同じ時刻に並ぶ移動より先にあること（まだ着いていない駅から
  // 動き出す旅程にはしません）。
  const move = arriveDay.items.find((i) => i.kind === "transit");
  if (move && +new Date(move.start) === +new Date(first.start)) {
    assert.ok(arriveDay.items.indexOf(first) < arriveDay.items.indexOf(move),
      "着く前に動き出しています");
  }
});

test("日をまたがない旅程には、「着いた」を足さない", async () => {
  // 日帰り・ふつうの泊まりでは、着地の行は要りません。足すと
  // 「9:00 東京駅 着」が毎朝並びます。
  const itin = await planTrip({
    trip: trip({ note: "鎌倉をゆっくり回りたい",
                 departAt: new Date("2026-09-12T09:00"),
                 arriveBy: new Date("2026-09-12T19:00") }),
    kb,
  });
  const arrives = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "arrive");
  assert.deepEqual(arrives, []);
});

test("予約済みの宿を書いたら、毎晩そこに泊まる旅程になる", async () => {
  // 旅程を組む側は「指定された宿」を前から受け取れました
  // （planner.js の pushLodging → lodging.js の explicit）。無かったのは
  // 入力する欄です。すでに取ったホテルがあっても、旅程は別の場所に宿を
  // 置いていました。
  const hotel = { name: "松江しんじ湖温泉駅", lat: 35.4727, lng: 133.0468 };
  const itin = await planTrip({
    trip: trip({ note: "松江と出雲をゆっくり",
                 departAt: new Date("2026-09-12T08:00"),
                 arriveBy: new Date("2026-09-14T20:00"),
                 lodging: [{ place: hotel }, { place: hotel }],
                 stayStyle: "base" }),
    kb,
  });
  const nights = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "lodging");
  assert.equal(nights.length, 2, "2泊になっていません");
  for (const n of nights) {
    assert.equal(n.place?.name, hotel.name, `${n.title} が指定の宿ではありません`);
  }
});
