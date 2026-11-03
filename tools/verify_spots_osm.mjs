// 第3段: Wikipedia で未確認だったスポットを OpenStreetMap (Nominatim) と
// Wikidata で照合する。座標が手がかりになるため、名前の一致＋距離で確度を付ける。
// Nominatim の利用ポリシーに従い 1.15 秒間隔・単独実行・結果キャッシュ（進捗ファイル）。
// 使い方: node tools/verify_spots_osm.mjs --out <検証データ置き場> [--limit N]
import { readFileSync, readdirSync, appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const outDir = args[args.indexOf("--out") + 1];
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
const UA = { "User-Agent": "TabisakiSpotVerification/1.0 (https://github.com/shitianliang1000-alt/tabisaki-app)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(2000 * (i + 1)); }
  }
  return null;
}
const norm = (s) => (s || "").replace(/[\s　・]/g, "").replace(/[（(].*?[）)]/g, "").toLowerCase();
function distM(a, b, c, d) {
  const R = 6371000, t = Math.PI / 180;
  const x = Math.sin(((c - a) * t) / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(((d - b) * t) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// スポット全件
const kbDir = new URL("../kb/", import.meta.url).pathname;
const spots = new Map();
for (const f of readdirSync(kbDir).filter((f) => /^spots-.*\.json$/.test(f))) {
  for (const s of JSON.parse(readFileSync(kbDir + f, "utf8")).spots) spots.set(s.id, s);
}
// 第2段の最新状態から unresolved を集める
function unresolvedIds() {
  const latest = new Map();
  for (const line of readFileSync(`${outDir}/stage-b-progress.jsonl`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    latest.set(r.id, r);
  }
  return [...latest.values()].filter((r) => r.status === "unresolved").map((r) => r.id);
}
const progressFile = `${outDir}/stage-c-progress.jsonl`;
const done = new Set();
if (existsSync(progressFile)) {
  for (const line of readFileSync(progressFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.status !== "error") done.add(r.id);
  }
}
const record = (r) => { appendFileSync(progressFile, JSON.stringify(r) + "\n"); if (r.status !== "error") done.add(r.id); };

async function checkOsm(spot) {
  const d = 0.04; // 約 4km のボックス
  const vb = [spot.lng - d, spot.lat + d, spot.lng + d, spot.lat - d].join(",");
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&viewbox=${vb}&bounded=1&q=${encodeURIComponent(spot.name)}`;
  const hits = await get(url);
  if (!hits) return { status: "error" };
  let best = null;
  for (const h of hits) {
    const dist = Math.round(distM(spot.lat, spot.lng, Number(h.lat), Number(h.lon)));
    const hn = norm(h.name || (h.display_name || "").split(",")[0]);
    const sn = norm(spot.name);
    const nameScore = hn === sn ? 2 : hn && sn && (hn.includes(sn) || sn.includes(hn)) ? 1 : 0;
    const score = nameScore * 10000 - dist;
    if (!best || score > best.score) best = { score, nameScore, dist, osmName: h.name || h.display_name, osmType: `${h.class}/${h.type}` };
  }
  if (best && best.nameScore === 2 && best.dist <= 2000)
    return { status: "verified_osm", confidence: "high", osmName: best.osmName, osmType: best.osmType, distanceM: best.dist };
  if (best && best.nameScore >= 1 && best.dist <= 2000)
    return { status: "verified_osm", confidence: "medium", osmName: best.osmName, osmType: best.osmType, distanceM: best.dist };
  return null;
}
async function checkWikidata(spot) {
  const s = await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=ja&uselang=ja&type=item&limit=5&search=${encodeURIComponent(spot.name)}`);
  if (!s) return { status: "error" };
  const ids = (s.search || []).map((x) => x.id);
  if (!ids.length) return null;
  const e = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|claims&languages=ja&ids=${ids.join("|")}`);
  if (!e) return { status: "error" };
  const sn = norm(spot.name);
  for (const id of ids) {
    const ent = e.entities?.[id];
    const label = ent?.labels?.ja?.value;
    const coord = ent?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    if (!label || !coord) continue;
    const ln = norm(label);
    if (ln !== sn && !ln.includes(sn) && !sn.includes(ln)) continue;
    const dist = Math.round(distM(spot.lat, spot.lng, coord.latitude, coord.longitude));
    if (dist <= 3000) return { status: "verified_wikidata", confidence: ln === sn && dist <= 1000 ? "high" : "medium", wikidata: id, label, distanceM: dist };
  }
  return null;
}

let processed = 0;
for (;;) {
  const todo = unresolvedIds().filter((id) => !done.has(id) && spots.has(id));
  if (!todo.length || processed >= limit) break;
  for (const id of todo) {
    if (processed >= limit) break;
    const spot = spots.get(id);
    let r = await checkOsm(spot);
    await sleep(1150); // Nominatim ポリシー: 最大 1 req/s
    if (r && r.status === "error") { record({ id, status: "error", via: "osm" }); continue; }
    if (!r) {
      r = await checkWikidata(spot);
      await sleep(300);
      if (r && r.status === "error") { record({ id, status: "error", via: "wikidata" }); continue; }
    }
    record(r ? { id, ...r } : { id, status: "unresolved_other" });
    processed++;
    if (processed % 50 === 0) console.log(new Date().toISOString(), "stage-c processed", processed);
  }
  if (processed >= limit) break;
  // 第2段がまだ走っていれば新しい unresolved の出現を待つ
  const { execSync } = await import("node:child_process");
  let alive = 0;
  try { alive = Number(execSync("pgrep -f 'verify_spots.mjs --stage b' | wc -l").toString().trim()); } catch {}
  if (!alive) break;
  await sleep(60000);
}
console.log("stage-c 終了。今回の処理件数:", processed);
