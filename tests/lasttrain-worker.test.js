// 中継が「終電」を聞けるか。
//
// 終電は ls8h Transit API の type=last で引きます（Yahoo!路線情報の
// スクレイピングは廃止。#367）。
//
// ここで確かめたいのは2つです。
//
//   ① 終電のときだけ type=last で聞くこと
//   ② 終電では「いちばん早く着く便」ではなく「いちばん遅く出る便」を
//      採ること。取り違えると、2分早い嘘になります

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../server/worker.js";

const ORIGIN = "https://tabisaki.example";

// 小田原→東京の終電候補。22:56 発（23:29 着）のほうが早く着きますが、
// 最後まで粘れるのは 22:58 発（翌 00:39 着）です。
const PLAN = {
  date: "20261030", type: "last", timezone: "Asia/Tokyo",
  from: { id: "geo:35.2564,139.1556", name: "地点" },
  to: { id: "geo:35.6812,139.7671", name: "地点" },
  journeys: [
    { departureSecs: 22 * 3600 + 56 * 60, arrivalSecs: 23 * 3600 + 29 * 60,
      durationSecs: 1980, transferCount: 0,
      legs: [{ kind: "transit", routeName: "東海道新幹線", mode: "rail",
        from: { id: "s1", name: "小田原" }, to: { id: "s2", name: "東京" },
        departureSecs: 22 * 3600 + 56 * 60, arrivalSecs: 23 * 3600 + 29 * 60,
        headwayBased: false }] },
    { departureSecs: 22 * 3600 + 58 * 60, arrivalSecs: 86400 + 39 * 60,
      durationSecs: 6060, transferCount: 1,
      legs: [{ kind: "transit", routeName: "東海道本線", mode: "rail",
        from: { id: "s1", name: "小田原" }, to: { id: "s2", name: "東京" },
        departureSecs: 22 * 3600 + 58 * 60, arrivalSecs: 86400 + 39 * 60,
        headwayBased: false }] },
  ],
};

/**
 * ls8h の代わり。呼ばれた URL を控えて、決まった答えを返します。
 * 本物には行きません（ダイヤが変われば答えも変わるため）。
 */
function stubFetch(calls) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    calls.push(url);
    return new Response(JSON.stringify(PLAN), {
      status: 200, headers: { "Content-Type": "application/json" } });
  };
  return () => { globalThis.fetch = real; };
}

const post = (body, env = {}) => worker.fetch(new Request(`${ORIGIN}/transit`, {
  method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
  body: JSON.stringify(body),
}), { ALLOW_ORIGIN: ORIGIN, ...env });

const BASE = {
  from: "小田原駅", to: "東京駅",
  fromAt: { lat: 35.2564, lng: 139.1556 }, toAt: { lat: 35.6812, lng: 139.7671 },
  departAt: "2026-10-30T18:00:00+09:00",
};

test("終電: type=last で聞き、いちばん遅く出る便を採る", async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    const res = await post({ ...BASE, search: "last" });
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.routed, true);
    assert.equal(doc.provider, "ls8h");
    assert.equal(doc.meta.departure, "22:58");
    assert.equal(calls.length, 1);
    const u = new URL(calls[0]);
    assert.equal(u.host, "api.transit.ls8h.com");
    assert.equal(u.searchParams.get("type"), "last");
    assert.equal(u.searchParams.get("time"), "18:00");
    assert.equal(u.searchParams.get("date"), "20261030");
  } finally { restore(); }
});

test("通常の検索では type=departure で聞く", async () => {
  const calls = [];
  const restore = stubFetch(calls);
  try {
    const res = await post({ ...BASE });
    assert.equal(res.status, 200);
    const u = new URL(calls[0]);
    assert.equal(u.searchParams.get("type"), "departure");
  } finally { restore(); }
});
