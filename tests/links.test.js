// 旅程から外へ渡すリンク（公式サイト・電話）。
//
// 収録 29,706 件のうち、公式サイトと電話を持つものは 0 件でした。
// 収録の半分は Wikidata 由来で、そこには公式サイト（P856）と電話番号
// （P1329）があります。tools/enrich_wikidata.py が段に書き戻したものを
// 出します。圏外で地図アプリが重いとき、電話は命綱です。予約が要るか
// どうかも、公式でしか確かめられません。

import assert from "node:assert/strict";
import test from "node:test";

import { linksForItem, officialUrl, phoneOf } from "../js/links.js";

test("電話番号を、日本の形で出し、そのままかけられるリンクにする", () => {
  const t = phoneOf({ tel: "+81-982-72-2413" });
  // 表示は国内からかける形。区切りは元のまま。
  assert.equal(t.display, "0982-72-2413");
  // リンクは国番号つき（携帯がそのままかけられる形）。
  assert.equal(t.href, "tel:+81982722413");
  // 番号でないものは出しません。
  assert.equal(phoneOf({ tel: "要確認" }), null);
  assert.equal(phoneOf({}), null);
});

test("公式サイトは https だけを通す", () => {
  assert.equal(officialUrl({ url: "https://example.jp/" }), "https://example.jp/");
  // http は https に書き換えて通します（平文で開かせません）。
  assert.equal(officialUrl({ url: "http://example.jp/" }), "https://example.jp/");
  // 変なものは通しません。
  assert.equal(officialUrl({ url: "javascript:alert(1)" }), "");
  assert.equal(officialUrl({ url: "ftp://example.jp/" }), "");
  assert.equal(officialUrl({}), "");
});

test("スポットのリンクに、公式サイトと電話が並ぶ", () => {
  const links = linksForItem({ kind: "spot" }, { place: {
    name: "高千穂神社", lat: 32.70667, lng: 131.30167,
    url: "https://takachiho-jinja.example/", tel: "+81-982-72-2413",
  } });
  const labels = links.map((l) => l.label);
  assert.ok(labels.includes("公式サイト"), labels.join("/"));
  assert.ok(labels.some((l) => l.startsWith("電話 0982")), labels.join("/"));
  // 無いものは並びません。
  const bare = linksForItem({ kind: "spot" },
                            { place: { name: "x", lat: 35, lng: 135 } });
  assert.ok(!bare.map((l) => l.label).some((l) => /公式|電話/.test(l)));
});

test("駅は名前で地図に渡す（座標だと知らない建物から始まる）", async () => {
  const { directionsUrl } = await import("../js/links.js");
  const nan = { name: "難波駅", lat: 34.6659, lng: 135.5015 };
  const sumi = { name: "住吉大社", lat: 34.61251, lng: 135.49293 };
  const u = new URL(directionsUrl(nan, sumi));
  assert.equal(u.searchParams.get("origin"), "難波駅");
  // スポットの座標は正確なので、そのまま。
  assert.equal(u.searchParams.get("destination"), "34.61251,135.49293");

  const links = linksForItem({ kind: "transit", start: new Date("2026-10-11T06:36:00") },
    { from: nan, to: sumi });
  assert.ok(links.some((l) => l.url.includes("google.com/maps/dir")), "Google マップの経路リンクがありません");
  assert.ok(!links.some((l) => /Yahoo/.test(l.label)), "Yahoo!へのリンクが残っています");
});
