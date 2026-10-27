// 端末で旅程を1本組んで、中身を眺めるための道具。
//
// ブラウザを立ち上げずに、収録30,000件の本物の kb/ で組みます。
// 画面のスクリーンショットで見つかる壊れ方（朝4時の参拝、昼食が
// 抜ける、1日に1か所しか無い、など）は、ここで先に見つかります。
//
//     node tools/plan_preview.mjs
//
// 中継（AI・Yahoo!）へは出ません。行き先の選びかたと時刻の組み立てを
// 見るための道具なので、実際の便は入りません。
// kb/ を fetch の代わりにディスクから読ませて、Node で旅程を組む。
import { readFile } from "node:fs/promises";
const ROOT = new URL("../", import.meta.url).pathname;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/^https?:\/\/(?!localhost)/.test(u) && !u.startsWith("file:")) {
    if (!u.includes("/kb/")) throw new Error("network off");
  }
  const path = u.startsWith("file:")
    ? new URL(u).pathname
    : ROOT + u.replace(/^\.?\//, "").replace(/^.*\/kb\//, "kb/");
  const body = await readFile(path, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body),
           text: async () => body };
};
const { loadKnowledgeBase } = await import(ROOT + "packages/core/src/kb.js");
const { planTrip } = await import(ROOT + "packages/core/src/pipeline.js");
const { findPlace } = await import(ROOT + "packages/core/src/places.js");
const { makeTrip } = await import(ROOT + "packages/core/src/trip.js");
const kb = await loadKnowledgeBase();
console.log("kb", kb.spots.length, "spots /", kb.regions.length, "regions");
const itin = await planTrip({ trip: makeTrip({
  origin: findPlace("東京駅"), departAt: new Date("2026-09-13T04:00"),
  arriveBy: new Date("2026-09-17T19:00"), note: "東京と名古屋をまわりたい",
  interests: [], budgetYen: 999999, dayStartHour: 4, dayEndHour: 18.5 }), kb });
const f = (d) => { const x = new Date(d); return `${x.getMonth()+1}/${x.getDate()} ${String(x.getHours()).padStart(2,"0")}:${String(x.getMinutes()).padStart(2,"0")}`; };
console.log(itin.warnings.slice(0, 3).join("\n"));
for (const [i, day] of itin.days.entries()) {
  console.log(`--- ${i+1}日目`);
  for (const it of day.items) {
    console.log(` ${f(it.start)} [${it.kind}] ${it.title}${it.km ? " · " + it.km.toFixed(1) + "km" : ""}`);
  }
}
