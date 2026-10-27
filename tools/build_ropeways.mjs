// ロープウェイ・ゴンドラの乗り場を kb/ropeways.json にまとめます。
//
// なぜ要るか
//   山頂のスポットどうしを Yahoo!路線情報に聞いても、答えは返りません。
//   山頂には駅もバス停も無いからです。人が実際に通るのは「麓のバス停 →
//   ロープウェイの山麓駅 → 山頂駅 → 歩いて山頂」です。どこに
//   ロープウェイが架かっているかが分かれば、聞く先を山麓駅に替えられ、
//   旅程にも「ロープウェイで上がる／ロープウェイは無い」と書けます。
//
// 入力
//   1. OpenStreetMap の aerialway=cable_car / gondola の線（Overpass で
//      `way["aerialway"~"^(cable_car|gondola)$"](area.jp); out tags geom;`）
//   2. （任意）Wikidata の乗り場の名前と位置（[[label, lat, lng], ...]）
//
// 線の両端が乗り場です。どちらが山麓かは、**標高**で決めます（国土地理院の
// 標高API）。引けなかったときだけ、近くの駅・バス停で決めます
// （kb/stops-*.json）。麓の乗り場はバスの終点や駅のすぐそばにあり、
// 山頂の乗り場から歩いて行ける停留所はまずありません。
//
// 使い方
//   node tools/build_ropeways.mjs <overpass.json> [wikidata-stations.json] [出力先]
//
// 出典: © OpenStreetMap contributors（ODbL）、Wikidata（CC0）

import { readFile, writeFile } from "node:fs/promises";
import { nearestStop } from "../packages/core/src/stops-data.js";

const [, , osmPath, wdPath, outPath = "kb/ropeways.json"] = process.argv;
if (!osmPath) {
  console.error("使い方: node tools/build_ropeways.mjs <overpass.json> [wikidata.json] [出力先]");
  process.exit(1);
}

// stops-data.js は kb/ を fetch で読みます。Node ではファイルから返します。
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (url.startsWith("file://")) {
    try {
      return new Response(await readFile(new URL(url), "utf8"), { status: 200 });
    } catch {
      return new Response("", { status: 404 });
    }
  }
  return realFetch(u, init);
};

const km = (a, b) => {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const round = (x) => Math.round(x * 1e5) / 1e5;

const osm = JSON.parse(await readFile(osmPath, "utf8"));
const named = wdPath ? JSON.parse(await readFile(wdPath, "utf8")) : [];

// スキー場のリフトに近いゴンドラは、名前で見分けます。冬だけ動くものが
// 多く、旅程の「山へ上がる手段」として案内すると外れます。
const LOOKS_LIKE_ROPEWAY = /ロープウ[ェエ]|索道|ケーブル|Ropeway|RW$/i;
// もう動いていないもの。
const GONE = /撤去|廃止|休止/;

/**
 * Wikidata の乗り場の名前を、400m以内なら借ります。
 * 「◯◯駅」だけです。終点として城や公園が入っていることがあり、
 * それを乗り場の名前として案内すると、行き先と取り違えます。
 */
function stationName(p) {
  let best = null;
  for (const [label, lat, lng] of named) {
    if (!/駅$/.test(label)) continue;
    const d = km(p, { lat, lng });
    if (d <= 0.4 && (!best || d < best.d)) best = { label, d };
  }
  return best?.label ?? null;
}

/** 標高（m）。国土地理院の標高API。引けなければ null。 */
async function elevation(p) {
  const u = "https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php"
    + `?lon=${p.lng}&lat=${p.lat}&outtype=JSON`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = await (await realFetch(u)).json();
      const m = Number(j?.elevation);
      if (Number.isFinite(m)) return m;
      return null;
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

const out = [];
for (const w of osm.elements ?? []) {
  if (w.type !== "way" || !Array.isArray(w.geometry) || w.geometry.length < 2) continue;
  const name = String(w.tags?.["name:ja"] ?? w.tags?.name ?? "").trim();
  if (!name || GONE.test(name)) continue;
  if (!LOOKS_LIKE_ROPEWAY.test(name)) continue;
  const pts = w.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += km(pts[i - 1], pts[i]);
  const ends = [pts[0], pts.at(-1)];
  const alt = [];
  for (const p of ends) alt.push(await elevation(p));
  let baseIdx;
  if (alt[0] != null && alt[1] != null && alt[0] !== alt[1]) {
    baseIdx = alt[0] < alt[1] ? 0 : 1;
  } else {
    const near = await Promise.all(ends.map((p) => nearestStop(p, 15)));
    const dist = near.map((s, i) => (s ? km(ends[i], s) : Infinity));
    // 近くの停留所までが短いほうが麓です。どちらも同じくらいなら、
    // 線の向き（OSM は下から上へ引くのが慣例）に従います。
    baseIdx = dist[1] + 0.05 < dist[0] ? 1 : 0;
  }
  const base = ends[baseIdx];
  const top = ends[1 - baseIdx];
  const station = (p, fallback, m) => ({
    name: stationName(p) ?? fallback, lat: round(p.lat), lng: round(p.lng),
    ...(m != null ? { alt: Math.round(m) } : {}),
  });
  const entry = {
    name,
    base: station(base, "山麓駅", alt[baseIdx]),
    top: station(top, "山頂駅", alt[1 - baseIdx]),
    km: Math.round(length * 100) / 100,
  };
  // 同じ線が2本に分けて描かれていることがあります（往復の索条）。
  // 両端がほぼ同じなら1本にします。
  const dup = out.find((o) => o.name === entry.name
    && km(o.base, entry.base) < 0.1 && km(o.top, entry.top) < 0.1);
  if (!dup) out.push(entry);
}
// 乗り継ぐロープウェイ（蔵王の山麓線→山頂線、新穂高の第1→第2）は、
// 山頂から見れば1本の道です。上の線の山麓駅が、下の線の山頂駅と同じ
// 場所なら、つないで1本にします。案内するのは一番下の山麓駅です。
const plainName = (n) => n.replace(/^\d+\s*/, "").trim();
let merged = true;
while (merged) {
  merged = false;
  for (const lower of out) {
    const upper = out.find((o) => o !== lower && km(lower.top, o.base) < 0.25);
    if (!upper) continue;
    const names = [...new Set([plainName(lower.name), plainName(upper.name)])];
    // 「蔵王ロープウェイ山麓線」と「蔵王ロープウェイ山頂線」なら
    // 「蔵王ロープウェイ」。共通の頭が線の名前になっていなければ並べます。
    const head = names.length > 1
      && names[0].match(/^.*?ロープウ[ェエ]イ?ー?/)?.[0];
    lower.name = head && names.every((n) => n.startsWith(head))
      ? head : names.join("・");
    lower.top = upper.top;
    lower.km = Math.round((lower.km + upper.km) * 100) / 100;
    lower.legs = (lower.legs ?? 1) + (upper.legs ?? 1);
    out.splice(out.indexOf(upper), 1);
    merged = true;
    break;
  }
}
for (const o of out) o.name = plainName(o.name);
out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
await writeFile(outPath, JSON.stringify({
  source: "OpenStreetMap contributors (ODbL), Wikidata (CC0)",
  ropeways: out,
}) + "\n");
console.log(`${out.length}本を書きました → ${outPath}`);
