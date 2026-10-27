// 電車・バスは、名前ではなく**位置**で聞く。
//
// 名前だけで聞くと、Yahoo!が同じ名前の別の場所に読み替えます。
//
//   「県庁前駅」（那覇・ゆいレール）→ 県庁前(兵庫県)
//     沖縄の旅の行き帰りが東京⇔神戸の新幹線になり、飛行機が出ません。
//   「京都駅前」（市バスの乗り場）→ 駅前の飲食店
//     バスに乗る経路が返りません。
//
// 位置（flatlon / tlatlon）を渡すと、Yahoo!がその近くの駅・バス停を
// 選んで、徒歩・バス・電車・飛行機をつないで答えます。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../server/worker.js";
import { plausibleRoute } from "../packages/core/src/routes.js";

const ORIGIN = "https://tabisaki.example";
const html = await readFile(
  new URL("./fixtures/yahoo-odawara-tokyo-last.html", import.meta.url), "utf8");

async function ask(body) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input?.url ?? input));
    return new Response(html, { status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}/yahoo/transit`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), { ALLOW_ORIGIN: ORIGIN });
    return { doc: await res.json(), url: new URL(calls[0]) };
  } finally {
    globalThis.fetch = real;
  }
}

const BASE = { from: "県庁前駅", to: "東京駅",
               departAt: "2026-10-13T10:00:00+09:00" };

test("位置を渡されたら、Yahoo!に位置で聞く", async () => {
  const { doc, url } = await ask({ ...BASE,
    fromAt: { lat: 26.2148, lng: 127.6792 },
    toAt: { lat: 35.6812, lng: 139.7671 } });
  assert.equal(url.searchParams.get("flatlon"), "26.214800,127.679200");
  assert.equal(url.searchParams.get("tlatlon"), "35.681200,139.767100");
  // 名前は表示用として残します
  assert.equal(url.searchParams.get("from"), "県庁前駅");
  assert.equal(doc.byLocation, true);
});

test("位置が無ければ、これまでどおり名前だけで聞く", async () => {
  const { doc, url } = await ask(BASE);
  assert.equal(url.searchParams.get("flatlon"), "");
  assert.equal(url.searchParams.get("tlatlon"), "");
  assert.equal(doc.byLocation, false);
});

test("日本の外の値や壊れた値は、位置として使わない", async () => {
  const { url } = await ask({ ...BASE,
    fromAt: { lat: "x", lng: 1 }, toAt: { lat: 0, lng: 0 } });
  assert.equal(url.searchParams.get("flatlon"), "");
  assert.equal(url.searchParams.get("tlatlon"), "");
});

test("名前で聞いた答えが、別の土地の経路なら使わない", () => {
  const kenchomae = { lat: 26.2148, lng: 127.6792 };   // 那覇
  const asahibashi = { lat: 26.2125, lng: 127.6747 };
  // 那覇の2駅のあいだを聞いて、神戸を回る1,000km超の答え
  assert.equal(plausibleRoute({ meta: { distanceKm: 1120 } },
    asahibashi, kenchomae), false);
  // ふつうの答え
  assert.equal(plausibleRoute({ meta: { distanceKm: 1.6 } },
    asahibashi, kenchomae), true);
  // 距離が分からなければ通す
  assert.equal(plausibleRoute({ meta: {} }, asahibashi, kenchomae), true);
});
