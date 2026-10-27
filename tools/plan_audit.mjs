// 旅程を何本か組んで、おかしな点を機械的に拾う。
//
// 画面のスクリーンショットで見つかる壊れ方は、たいてい1本の旅程に
// 1つずつしか出ません。何本かまとめて組んで、決まった形の粗
// （移動中の食事、置いてきた拠点への逆戻り、長い空白、同じ場所を2回）
// を数えます。通信はしないので、実際の便は入りません。
//
//     node tools/plan_audit.mjs
import { readFile } from "node:fs/promises";
const ROOT = new URL("../", import.meta.url).pathname;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/^https?:\/\//.test(u) && !u.includes("/kb/")) throw new Error("net off");
  const path = u.startsWith("file:") ? new URL(u).pathname
    : ROOT + u.replace(/^\.?\//, "").replace(/^.*\/kb\//, "kb/");
  const body = await readFile(path, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
};
const { loadKnowledgeBase } = await import(ROOT + "packages/core/src/kb.js");
const { planTrip } = await import(ROOT + "packages/core/src/pipeline.js");
const { findPlace } = await import(ROOT + "packages/core/src/places.js");
const { makeTrip } = await import(ROOT + "packages/core/src/trip.js");
const { haversineKm } = await import(ROOT + "packages/core/src/feasibility.js");
const { sunTimes } = await import(ROOT + "packages/core/src/sun.js").catch(() => ({}));
const kb = await loadKnowledgeBase();

const CASES = [
  ["高尾山に登りたい", "東京駅", "2026-08-31T09:00", "2026-09-01T19:00"],
  ["京都の寺を見たい", "東京駅", "2026-08-31T07:00", "2026-09-03T20:00"],
  ["北海道の自然", "東京駅", "2026-08-31T06:00", "2026-09-04T21:00"],
  ["沖縄の海でのんびり", "東京駅", "2026-08-31T06:00", "2026-09-03T20:00"],
  ["大阪で食べ歩き", "名古屋駅", "2026-08-31T08:00", "2026-09-01T20:00"],
  ["東北の温泉", "東京駅", "2026-08-31T07:00", "2026-09-02T20:00"],
];
const hm = (d) => { const x = new Date(d); return `${String(x.getHours()).padStart(2,"0")}:${String(x.getMinutes()).padStart(2,"0")}`; };
let issues = 0;
const flag = (tag, msg) => { issues++; console.log(`  [${tag}] ${msg}`); };

for (const [note, from, dep, arr] of CASES) {
  console.log(`\n### ${note}（${from}）`);
  let itin;
  try {
    itin = await planTrip({ trip: makeTrip({
      origin: findPlace(from), departAt: new Date(dep), arriveBy: new Date(arr),
      note, interests: [], budgetYen: 999999 }), kb });
  } catch (e) { flag("crash", String(e?.message ?? e)); continue; }

  for (const [di, day] of itin.days.entries()) {
    const items = day.items ?? [];
    const spots = items.filter((i) => i.kind === "spot");
    const meals = items.filter((i) => i.kind === "meal");
    if (!spots.length && items.some((i) => i.kind === "lodging")) {
      flag("empty-day", `${di + 1}日目に立ち寄りがありません`);
    }
    if (spots.length === 1) flag("thin-day", `${di + 1}日目が1か所だけ`);

    // 夜に屋外
    for (const s of spots) {
      const h = new Date(s.start).getHours();
      const outdoor = ["山", "展望台", "公園", "渓谷", "高原", "海岸", "登山", "庭園"]
        .includes(s.place?.category);
      if (outdoor && (h >= 19 || h < 6)) {
        flag("dark", `${di + 1}日目 ${hm(s.start)} ${s.title}（${s.place?.category}）`);
      }
      if (h >= 22 || h < 5) flag("odd-hour", `${di + 1}日目 ${hm(s.start)} ${s.title}`);
    }
    // 予定の切れ目
    const sorted = [...items].sort((a, b) => new Date(a.start) - new Date(b.start));
    for (let i = 0; i + 1 < sorted.length; i++) {
      const gap = (new Date(sorted[i + 1].start) - new Date(sorted[i].end)) / 60000;
      if (gap > 90) {
        flag("gap", `${di + 1}日目 ${hm(sorted[i].end)}→${hm(sorted[i + 1].start)} `
          + `${Math.round(gap)}分の空白`);
      }
      if (gap < -1) {
        flag("overlap", `${di + 1}日目 ${sorted[i].title} と ${sorted[i + 1].title} が重なっています`);
      }
    }
    // 食事
    const lunch = meals.some((m) => new Date(m.start).getHours() < 15);
    if (spots.length >= 2 && !lunch) flag("no-lunch", `${di + 1}日目に昼食がありません`);
    // 移動の妥当性
    for (const t of items.filter((i) => i.kind === "transit")) {
      const min = (new Date(t.end) - new Date(t.start)) / 60000;
      const km = t.km ?? 0;
      if (km > 0.3 && min > 0 && km / (min / 60) > 300) {
        flag("too-fast", `${t.title} ${km.toFixed(1)}kmを${Math.round(min)}分（時速${Math.round(km / (min / 60))}km）`);
      }
      if (km < 5 && min > 90) flag("too-slow", `${t.title} ${km.toFixed(1)}kmに${Math.round(min)}分`);
    }
  }
  // 同じ場所
  const places = itin.days.flatMap((d) => d.items).filter((i) => i.kind === "spot" && i.place).map((i) => i.place);
  for (let i = 0; i < places.length; i++) for (let j = i + 1; j < places.length; j++) {
    const m = haversineKm(places[i], places[j]) * 1000;
    if (m < 100) flag("same-place", `${places[i].name} と ${places[j].name} が ${m.toFixed(0)}m`);
  }
  console.log(`  （立ち寄り ${places.length}か所 / ${itin.days.length}日）`);
}
console.log(`\n合計 ${issues} 件`);
