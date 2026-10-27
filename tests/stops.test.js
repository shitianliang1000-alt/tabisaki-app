// 停留所（駅・バス停）の最寄り検索。
//
// 実データは fetch で kb/stops-*.json を取りに行くので、テストでは
// fetch を差し替えて、狭い範囲の停留所だけを返します。

import assert from "node:assert/strict";
import test from "node:test";

import { findStop, nearbyStops, nearestStop, resetStopsCache, searchStops }
  from "../packages/core/src/stops.js";
import * as data from "../packages/core/src/stops-data.js";

const FUJI_5GO = { lat: 35.3606, lng: 138.7364 };
const FUJI_SUMMIT = { lat: 35.3606, lng: 138.7305 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };

function withStops(rail, bus, fn, asked = null) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked?.push(String(url));
    const body = String(url).includes("stops-bus") ? bus : rail;
    return { ok: true, json: async () => body };
  };
  return fn().finally(() => {
    globalThis.fetch = real;
    resetStopsCache();
  });
}

test("近くの停留所を、駅・バス停どちらからでも見つけられる", () =>
  withStops(
    { year: 2008, stops: [] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const s = await nearestStop(FUJI_5GO, 3);
      assert.equal(s?.name, "富士山五合目");
    }));

test("範囲より遠ければ、見つからない扱いにする", () =>
  withStops(
    { year: 2008, stops: [] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const s = await nearestStop(TOKYO, 3);
      assert.equal(s, null);
    }));

test("複数あれば、いちばん近いものを返す", () =>
  withStops(
    { year: 2008, stops: [[35.3606, 138.7305, "山頂駅（仮）"]] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const s = await nearestStop(FUJI_SUMMIT, 5);
      assert.equal(s?.name, "山頂駅（仮）");
    }));

test("読み込みに失敗しても、例外を投げずに「無い」を返す", () =>
  withStops(null, null, async () => {
    globalThis.fetch = async () => { throw new Error("network"); };
    const s = await nearestStop(TOKYO, 3);
    assert.equal(s, null);
  }));

// --- 出発地・到着地の入力補完 ----------------------------------------------
//
// 主要駅78件しか出発地に選べないと、最寄りが載っていない人は使い始める
// ことすらできません。全国の停留所から名前で引けるようにします。

const NAMED = {
  rail: { year: 2008, stops: [
    [35.6896, 139.7006, "新宿"],
    [35.6812, 139.7671, "東京"],
    [34.7025, 135.4959, "大阪"],
  ] },
  bus: { year: 2012, stops: [
    [35.6900, 139.7000, "新宿駅西口"],
    [35.3600, 138.7370, "富士山五合目"],
  ] },
};

test("名前から停留所を引ける（「駅」の有無は問わない）", () =>
  withStops(NAMED.rail, NAMED.bus, async () => {
    assert.equal((await findStop("新宿"))?.name, "新宿");
    assert.equal((await findStop("新宿駅"))?.name, "新宿");
    assert.equal((await findStop(" 東京 "))?.name, "東京");
    assert.equal(await findStop("存在しない停留所"), null);
    assert.equal(await findStop(""), null);
  }));

test("打った文字で候補を絞る。前方一致を先に返す", () =>
  withStops(NAMED.rail, NAMED.bus, async () => {
    const found = await searchStops("新宿", 20);
    assert.equal(found[0].name, "新宿", "前方一致が先頭に来ていません");
    assert.ok(!found.some((s) => s.name === "大阪"));
  }));

test("入力補完は、駅に当たるならバス停まで読まない", async () => {
  // 出発地の欄に触れただけで 2.6MB を取っていました。駅名を打つ人に
  // 要るのは駅で、バス停 25万件ではありません（駅に1つも当たらない
  // ときだけ、バス停まで見ます）。
  const asked = [];
  await withStops(NAMED.rail, NAMED.bus, async () => {
    const found = await searchStops("新宿", 20);
    assert.ok(found.some((s) => s.name === "新宿"));
    assert.ok(!asked.some((u) => u.includes("stops-bus")),
      `バス停まで読んでいます: ${asked.join(", ")}`);
  }, asked);

  asked.length = 0;
  await withStops(NAMED.rail, NAMED.bus, async () => {
    // 駅に当たらない名前なら、そこで初めてバス停を読みます
    const found = await searchStops("五合目", 20);
    assert.ok(found.some((s) => s.name === "富士山五合目"));
    assert.ok(asked.some((u) => u.includes("stops-bus")));
  }, asked);
});

test("候補は数を絞る（7万件を一度に並べない）", () =>
  withStops(NAMED.rail, NAMED.bus, async () => {
    assert.ok((await searchStops("新", 2)).length <= 2);
    assert.deepEqual(await searchStops("", 20), []);
  }));

test("同じ名前なら、バス停より駅を先に採る", () =>
  withStops(
    { year: 2008, stops: [[35.68, 139.76, "本町"]] },
    { year: 2012, stops: [[34.68, 135.50, "本町"]] },
    async () => {
      assert.equal((await findStop("本町"))?.kind, "rail");
    }));

test("近い順に、いくつかの停留所を返す（同じ名前はまとめる）", () =>
  withStops(
    { year: 2008, stops: [
      [35.3606, 138.7305, "山頂駅（仮）"],
      [35.3606, 138.7305, "山頂"],
    ] },
    { year: 2012, stops: [[35.3600, 138.7370, "富士山五合目"]] },
    async () => {
      const near = await nearbyStops(FUJI_SUMMIT, 5, 3);
      assert.equal(near[0].name, "山頂駅（仮）");
      // 「山頂」は「山頂駅（仮）」…ではなく別名なので残りますが、
      // 「駅」の有無だけが違う名前は1件にまとめます。
      assert.ok(near.length >= 2, "2件目が返っていません");
      assert.ok(near.some((s) => s.name === "富士山五合目"));
      assert.equal(new Set(near.map((s) => s.name)).size, near.length);
    }));

test("2番目の候補があるので、最寄りが同じでも別の名前を試せる", () =>
  withStops(
    { year: 2008, stops: [
      [35.6812, 139.7671, "東京"],
      [35.6846, 139.7744, "日本橋"],
    ] },
    { year: 2012, stops: [] },
    async () => {
      const near = await nearbyStops(TOKYO, 5, 3);
      assert.deepEqual(near.map((s) => s.name), ["東京", "日本橋"]);
    }));

test("Worker が無い場でも、同じ答えを返す", async () => {
  // 停留所の読み解きは別のスレッドに回しています（2.6MBあり、
  // 本体側で解くと画面が止まります）。ただし Worker が使えない場
  // （この試験、file:// で開いたとき、古い環境）でも動かなければ
  // なりません。**使えないときに止まる**より、その場で計算します。
  //
  // 計算は1か所（stops-data.js）にまとめてあるので、どちらで
  // 計算しても答えは同じです。ここでそれを固定します。
  assert.equal(typeof Worker, "undefined");
  await withStops(
    { stops: [[35.3606, 138.7364, "富士山五合目"]] },
    { stops: [] },
    async () => {
      const viaProxy = await nearbyStops(FUJI_5GO, 3, 3);
      resetStopsCache();
      const direct = await data.nearbyStops(FUJI_5GO, 3, 3);
      assert.deepEqual(viaProxy, direct);
      assert.equal(viaProxy[0].name, "富士山五合目");
    });
});
