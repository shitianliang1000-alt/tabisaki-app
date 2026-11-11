// 行き先の注意報・警報（気象庁）と、もしものときの入口（#448）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { activeWarnings, alertsForItinerary, clearAlertCache, describeWarnings,
  emergencyLinks, fetchWarningMap, FINAL_CHECK, JMA_KINDS, JMA_WARNING_URL, officeFor }
  from "../packages/core/src/alerts.js";
import { JMA_CLASS10, JMA_OFFICES } from "../packages/core/src/jma-areas.js";

// 2026年5月からの形（bosai/warning/data/r8/map.json）を縮めたもの。
// 府県予報区ごとに、電文の種類（dataTypeCode）ごとの最新の1通が並びます。
const MAP = [
  { reportDatetime: "2026-11-11T10:06:00+09:00", dataTypeCode: "VPWW59",
    headlineText: "伊豆諸島、小笠原諸島では、高波に注意してください。",
    warning: { class10Items: [
      { areaCode: "130010", kinds: [{ status: "発表警報・注意報はなし" }] },
      { areaCode: "130020", kinds: [{ code: "16", status: "継続" }] },
      { areaCode: "130030", kinds: [{ code: "16", status: "継続" }] },
      { areaCode: "130040", kinds: [{ code: "07", status: "発表" }] },
    ] } },
  { reportDatetime: "2026-11-11T02:49:00+09:00", dataTypeCode: "VPWW55",
    warning: { class10Items: [
      { areaCode: "130010", kinds: [{ code: "10", status: "解除" }] },
    ] } },
  // 同じ種類の古い1通は、新しいほうに負けます。
  { reportDatetime: "2026-11-01T00:00:00+09:00", dataTypeCode: "VPWW59",
    warning: { class10Items: [
      { areaCode: "130010", kinds: [{ code: "07", status: "発表" }] },
    ] } },
  { reportDatetime: "2026-11-11T09:00:00+09:00", dataTypeCode: "VPWW55",
    warning: { class10Items: [
      { areaCode: "270000", kinds: [{ code: "43", status: "発表" }] },
    ] } },
];

test("区域の表は、気象庁の府県予報区と一次細分区域をそろえている", () => {
  assert.ok(Object.keys(JMA_OFFICES).length >= 50);
  assert.ok(Object.keys(JMA_CLASS10).length >= 140);
  for (const [code, [name, parent]] of Object.entries(JMA_CLASS10)) {
    assert.ok(name, code);
    assert.ok(JMA_OFFICES[parent], `${code} の親 ${parent} がありません`);
  }
});

test("警報の種類は、警戒レベルの重さを持つ", () => {
  assert.deepEqual(JMA_KINDS["03"], ["大雨警報", 3]);
  assert.deepEqual(JMA_KINDS[43], ["大雨危険警報", 4]);
  assert.deepEqual(JMA_KINDS[33], ["大雨特別警報", 5]);
  assert.deepEqual(JMA_KINDS[10], ["大雨注意報", 2]);
});

test("都道府県から府県予報区を選ぶ（複数ある県は近いほう）", () => {
  assert.equal(officeFor({ prefecture: "東京都" }), "130000");
  assert.equal(officeFor({ prefecture: "京都" }), "260000");
  assert.equal(officeFor({ prefecture: "北海道", lat: 43.06, lng: 141.35 }), "016000"); // 札幌
  assert.equal(officeFor({ prefecture: "北海道", lat: 41.77, lng: 140.73 }), "017000"); // 函館
  assert.equal(officeFor({ prefecture: "沖縄県", lat: 24.34, lng: 124.16 }), "474000"); // 石垣
  assert.equal(officeFor({ prefecture: "鹿児島県", lat: 28.37, lng: 129.49 }), "460040"); // 奄美
  assert.equal(officeFor({ prefecture: "北海道" }), null, "場所が無ければ決めません");
  assert.equal(officeFor({ prefecture: "どこか" }), null);
});

test("いま出ているものだけを、重い順に拾う（解除・古い電文は捨てる）", () => {
  const w = activeWarnings(MAP, "130000");
  assert.equal(w.officeName, "東京都");
  assert.equal(w.reportedAt, "2026-11-11T10:06:00+09:00");
  assert.deepEqual(w.items.map((i) => [i.area, i.name]), [
    ["130040", "波浪警報"], ["130020", "波浪注意報"], ["130030", "波浪注意報"]]);
  assert.deepEqual(describeWarnings(w), [
    "波浪警報（小笠原諸島）", "波浪注意報（伊豆諸島北部・伊豆諸島南部）"]);
  assert.equal(activeWarnings(MAP, "140000").items.length, 0);
});

test("入口は行き先の点だけを使い、利用者の位置は使わない", () => {
  const links = emergencyLinks({ lat: 35.62561, lng: 139.24721 }, "130000");
  assert.equal(links.length, 2);
  assert.match(links[0].url, /^https:\/\/www\.jma\.go\.jp\/bosai\/warning\/#area_type=offices&area_code=130000$/);
  assert.match(links[1].url, /^https:\/\/disaportal\.gsi\.go\.jp\/maps\/\?ll=35\.6256,139\.2472&z=13$/);
});

const NOW = Date.parse("2026-11-11T12:00:00+09:00");
const itin = (date, place) => ({ days: [{ date, items: [{ kind: "spot", place }] }] });
const OSAKA = { name: "大阪城", prefecture: "大阪府", lat: 34.687, lng: 135.526 };

test("今日・明日の旅なら、行き先の警報を添える", async () => {
  const out = await alertsForItinerary(itin("2026-11-12", OSAKA),
    { now: NOW, fetchMap: async () => MAP });
  assert.equal(out.checked, true);
  assert.equal(out.top, 4);
  assert.deepEqual(out.lines, ["大阪府: 大雨危険警報（大阪府）"]);
  assert.equal(out.note, FINAL_CHECK);
  assert.equal(out.source, "気象庁");
});

test("旅程の日付が Date でも、日本時間の日付で比べる", async () => {
  // planner.js は日付を Date で持ちます。11/12 の 10:47（日本時間）。
  const start = new Date("2026-11-12T10:47:00+09:00");
  const it = { days: [{ date: new Date("2026-11-12T00:00:00+09:00"),
    items: [{ kind: "spot", start, place: OSAKA }] }] };
  const out = await alertsForItinerary(it, { now: NOW, fetchMap: async () => MAP });
  assert.equal(out.checked, true);
  assert.equal(out.top, 4);
});

test("来週の旅には、今日の警報を出さない（聞きにも行かない）", async () => {
  let asked = 0;
  const out = await alertsForItinerary(itin("2026-11-20", OSAKA),
    { now: NOW, fetchMap: async () => { asked++; return MAP; } });
  assert.equal(asked, 0);
  assert.equal(out.checked, false);
  assert.equal(out.lines.length, 0);
  assert.ok(out.links.length >= 1, "入口は出します");
  assert.equal(out.note, FINAL_CHECK, "最後の一文はいつも出します");
});

test("取れなくても旅程は止めず、確かめられなかったと言う", async () => {
  const out = await alertsForItinerary(itin("2026-11-11", OSAKA),
    { now: NOW, fetchMap: async () => { throw new Error("圏外"); } });
  assert.equal(out.ok, false);
  assert.equal(out.checked, false);
  assert.equal(out.note, FINAL_CHECK);
});

test("全国の一覧は1回の GET で取り、5分は使い回す", async () => {
  clearAlertCache();
  const calls = [];
  const fetch = async (u) => { calls.push(u); return { ok: true, json: async () => MAP }; };
  await fetchWarningMap({ fetch, now: 0 });
  await fetchWarningMap({ fetch, now: 60_000 });
  assert.deepEqual(calls, [JMA_WARNING_URL]);
  await fetchWarningMap({ fetch, now: 6 * 60_000 });
  assert.equal(calls.length, 2);
  clearAlertCache();
});

test("気象庁への接続が、アプリの connect-src で通してある", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const csp = html.match(/connect-src 'self'([^;]+);/)?.[1] ?? "";
  assert.match(csp, /https:\/\/www\.jma\.go\.jp/);
});
