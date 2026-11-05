// 第4段: 第1〜3段で確認しきれなかったスポットを照らし直す。
//
// 対象: kb/verification-*.json で status が
//   not_found_web   … Web 検索でも出典が見つからなかった
//   name_match_low  … Wikipedia の名前検索で、あいまいな記事に当たっただけ
// のスポット。どれも座標を持っているので、名前＋座標の近さで次の3つと照合する。
//   gsi : 国土地理院 地名検索（電子国土基本図の地名。山・滝・湖・峠などに強い）
//   wd  : Wikidata SPARQL の周辺検索（座標から半径 2km の項目の日本語ラベル）
//   osm : OpenStreetMap Nominatim（約 4km 四方の範囲で名前検索。1.15 秒間隔）
// 3つは別々のサービスなので、--source ごとに並行して走らせてよい。
// 照合は「名前が一致（または片方がもう片方を含む）かつ近い」ときだけ確認済みにし、
// 名前だけ・座標だけの一致は採らない。
//
// 使い方:
//   node tools/verify_spots_recheck.mjs --source gsi --out <作業フォルダ>
//   node tools/verify_spots_recheck.mjs --source wd  --out <作業フォルダ>
//   node tools/verify_spots_recheck.mjs --source osm --out <作業フォルダ>
//   node tools/verify_spots_recheck.mjs --apply --out <作業フォルダ>   # kb/verification-*.json へ反映
//   （gsi・wd は --part 0/3 のように分けて並行にできる）
// 進捗は <作業フォルダ>/recheck-<source>.jsonl に追記するので、止めても続きから再開できる。
import { readFileSync, readdirSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KB = path.join(ROOT, "kb");
const UA = { "User-Agent": "TabisakiSpotVerification/1.0 (https://github.com/shitianliang1000-alt/tabisaki-app)" };
export const TARGET = new Set(["not_found_web", "name_match_low"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 照合用に名前をそろえる（空白・中黒・括弧書き・旧字の揺れを落とす）。 */
export function norm(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[\s・·.,、。「」『』"'’\-ー〜~]/g, "")
    .replace(/ヶ|ケ|ヵ/g, "ケ")
    .replace(/之/g, "ノ").replace(/の/g, "ノ")
    .replace(/跡地$/, "跡")
    .toLowerCase();
}

/** 2つの名前の一致度。2=同じ、1=片方がもう片方を含み長さも近い、0=別物。
 *  「鹿追町」と「鹿追町コミュニティセンター郷土資料室」のように、地名だけが重なる場合を
 *  拾わないよう、短い方が長い方の 6 割以上あることを求める。 */
export function nameScore(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  // 道路・路線（「権現崎線」）は場所の裏付けにしない。
  if (/線$/.test(y) && !/線$/.test(x)) return 0;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // 候補の方が短いとき（「宮原八幡宮」に「八幡宮」）は、固有の部分が落ちやすいので厳しめにする。
  const min = short === y ? 0.75 : 0.6;
  if (short.length >= 3 && long.includes(short) && short.length / long.length >= min) return 1;
  return 0;
}

/** 調べる名前。「黒岳の湯|層雲峡」のような「施設|地区」は施設名の方で調べる。 */
export function queryName(spot) {
  return String(spot.name).split("|")[0].trim();
}

/** 収録元そのもの（同じ OSM ノードや Wikidata 項目）との一致は裏付けにならない。 */
export function isSelf(spot, ref) {
  if (!ref) return false;
  return ref === spot.osm || ref === spot.wikidata || `wd-${ref}` === spot.id;
}

export function distM(a, b, c, d) {
  const R = 6371000, t = Math.PI / 180;
  const x = Math.sin(((c - a) * t) / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(((d - b) * t) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

/** 一番よい候補から記録を作る。名前一致が無ければ null。 */
export function judge(spot, cands, maxM) {
  let best = null;
  for (const c of cands) {
    if (isSelf(spot, c.ref)) continue;
    const ns = nameScore(queryName(spot), c.name);
    if (!ns) continue;
    const dist = distM(spot.lat, spot.lng, c.lat, c.lng);
    if (dist > maxM) continue;
    const score = ns * 100000 - dist;
    if (!best || score > best.score) best = { ...c, ns, dist, score };
  }
  if (!best) return null;
  // OSM から収録したスポットが OSM の別オブジェクトと一致しても、同じ情報源の重複にすぎない場合がある。
  const sameSource = spot.src?.startsWith("osm") && /^(node|way|relation)\//.test(best.ref ?? "");
  const confidence = best.ns === 2 && best.dist <= maxM / 2 && !sameSource ? "high" : "medium";
  return { confidence, matchedName: best.name, distanceM: best.dist, ...(best.ref ? { ref: best.ref } : {}) };
}

async function get(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch { await sleep(2000 * (i + 1)); }
  }
  return undefined; // 通信エラー（null = 見つからず と区別する）
}

const SOURCES = {
  gsi: {
    status: "verified_gsi", gapMs: 400, maxM: 2000,
    async check(spot) {
      const hits = await get(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(queryName(spot))}`);
      if (hits === undefined) return undefined;
      const cands = (hits || [])
        .filter((h) => h.properties?.dataSource) // 住所ではなく地名の行だけ
        .map((h) => ({ name: h.properties.title, lng: h.geometry.coordinates[0], lat: h.geometry.coordinates[1] }));
      return judge(spot, cands, this.maxM);
    },
  },
  wd: {
    status: "verified_wikidata", gapMs: 700, maxM: 2000,
    async check(spot) {
      const q = `SELECT ?item ?label ?loc WHERE { SERVICE wikibase:around { ?item wdt:P625 ?loc . ` +
        `bd:serviceParam wikibase:center "Point(${spot.lng} ${spot.lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "2" . } ` +
        `{ ?item rdfs:label ?label } UNION { ?item skos:altLabel ?label } FILTER(LANG(?label)="ja") } LIMIT 2000`;
      const data = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`,
        { headers: { Accept: "application/sparql-results+json" } });
      if (data === undefined) return undefined;
      const cands = (data?.results?.bindings || []).map((b) => {
        const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.loc.value);
        return { name: b.label.value, lng: Number(m?.[1]), lat: Number(m?.[2]), ref: b.item.value.split("/").pop() };
      }).filter((c) => Number.isFinite(c.lat));
      return judge(spot, cands, this.maxM);
    },
  },
  osm: {
    status: "verified_osm", gapMs: 1150, maxM: 2000, skipMatched: true, // Nominatim 利用ポリシー: 最大 1 req/s・並列なし
    async check(spot) {
      const d = 0.04;
      const vb = [spot.lng - d, spot.lat + d, spot.lng + d, spot.lat - d].join(",");
      const hits = await get(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=ja&viewbox=${vb}&bounded=1&q=${encodeURIComponent(queryName(spot))}`);
      if (hits === undefined) return undefined;
      const cands = (hits || []).map((h) => ({
        name: h.name || (h.display_name || "").split(",")[0], lat: Number(h.lat), lng: Number(h.lon), ref: `${h.osm_type}/${h.osm_id}`,
      }));
      return judge(spot, cands, this.maxM);
    },
  },
};

export function loadSpots() {
  const spots = new Map();
  for (const f of readdirSync(KB).filter((f) => /^spots-jp.*\.json$/.test(f))) {
    for (const s of JSON.parse(readFileSync(path.join(KB, f), "utf8")).spots) spots.set(s.id, s);
  }
  return spots;
}

function verificationShards() {
  return readdirSync(KB).filter((f) => /^verification-jp.*\.json$/.test(f)).sort();
}

export function targetIds() {
  const ids = [];
  for (const f of verificationShards()) {
    const d = JSON.parse(readFileSync(path.join(KB, f), "utf8"));
    for (const [id, r] of Object.entries(d.records)) if (TARGET.has(r.status)) ids.push(id);
  }
  return ids;
}

function readProgress(file) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.status !== "error") out.set(r.id, r); } catch { /* 途中で切れた行 */ }
  }
  return out;
}

async function run(source, outDir, limit, part) {
  const src = SOURCES[source];
  const file = path.join(outDir, `recheck-${source}.jsonl`);
  const done = readProgress(file);
  const spots = loadSpots();
  const [k, n] = (part ?? "0/1").split("/").map(Number);
  const todo = targetIds().filter((id, i) => i % n === k && !done.has(id) && spots.has(id)).slice(0, limit);
  console.log(source, part ?? "", "対象", todo.length, "件（処理済み", done.size, "件）");
  // 一番遅い osm は、ほかの2つで既に一致したスポットを飛ばす（Nominatim への問い合わせを減らす）。
  const others = Object.keys(SOURCES).filter((s) => s !== source);
  let matchedElsewhere = new Set();
  const refresh = () => {
    matchedElsewhere = new Set(others.flatMap((s) =>
      [...readProgress(path.join(outDir, `recheck-${s}.jsonl`)).values()].filter((r) => r.status === "hit").map((r) => r.id)));
  };
  let count = 0, hit = 0;
  for (const id of todo) {
    if (src.skipMatched && count % 100 === 0) refresh();
    let rec;
    if (src.skipMatched && matchedElsewhere.has(id)) rec = { id, status: "skipped" };
    else {
      const r = await src.check(spots.get(id));
      rec = r === undefined ? { id, status: "error" } : r ? { id, status: "hit", ...r } : { id, status: "miss" };
      await sleep(src.gapMs);
    }
    appendFileSync(file, JSON.stringify(rec) + "\n");
    if (rec.status === "hit") hit++;
    if (++count % 200 === 0) console.log(new Date().toISOString(), source, count, "件 / 一致", hit);
  }
  console.log(source, "終了", count, "件 / 一致", hit);
}

/** 照合結果を1件の記録にまとめる。優先順位は 一致の確度 → gsi/wd/osm の順。 */
export function merge(prev, hits, checkedAt) {
  const order = ["gsi", "wd", "osm"];
  const all = order.map((s) => hits[s] && { s, ...hits[s] }).filter(Boolean);
  if (!all.length) return null;
  all.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1));
  const top = all[0];
  const rec = {
    status: SOURCES[top.s].status,
    confidence: all.filter((h) => h.confidence === "high").length >= 1 || all.length >= 2 ? "high" : top.confidence,
    checkedAt,
    matchedName: top.matchedName,
    distanceM: top.distanceM,
  };
  if (top.s === "wd") rec.wikidata = top.ref;
  if (top.s === "osm") rec.osm = top.ref;
  if (all.length > 1) rec.alsoMatched = all.slice(1).map((h) => h.s);
  rec.previous = prev.status;
  return rec;
}

function apply(outDir) {
  const spots = loadSpots();
  const prog = Object.fromEntries(Object.keys(SOURCES).map((s) => [s, readProgress(path.join(outDir, `recheck-${s}.jsonl`))]));
  const checkedAt = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const counts = {};
  for (const f of verificationShards()) {
    const p = path.join(KB, f);
    const d = JSON.parse(readFileSync(p, "utf8"));
    let changed = false;
    for (const [id, r] of Object.entries(d.records)) {
      if (!TARGET.has(r.status)) continue;
      const hits = {};
      let seen = 0;
      for (const s of Object.keys(SOURCES)) {
        const x = prog[s].get(id);
        if (x) seen++;
        // 照合ルールを後から厳しくしたときに、古い一致を捨てられるよう名前を比べ直す。
        if (x?.status === "hit" && nameScore(queryName(spots.get(id) ?? { name: "" }), x.matchedName)) hits[s] = x;
      }
      const rec = merge(r, hits, checkedAt);
      if (rec) {
        d.records[id] = rec; changed = true;
        counts[rec.status] = (counts[rec.status] ?? 0) + 1;
      } else if (seen === Object.keys(SOURCES).length && !r.recheckedAt) {
        // 3つとも当たらなかった印。次に手で調べる対象を絞り込むのに使う。
        d.records[id] = { ...r, recheckedAt: checkedAt, recheckedWith: Object.keys(SOURCES) }; changed = true;
        counts[`still_${r.status}`] = (counts[`still_${r.status}`] ?? 0) + 1;
      }
    }
    if (changed) writeFileSync(p, JSON.stringify(d));
  }
  console.log(counts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const outDir = opt("--out");
  if (!outDir) { console.error("--out <作業フォルダ> が必要です"); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  if (args.includes("--apply")) apply(outDir);
  else {
    const source = opt("--source");
    if (!SOURCES[source]) { console.error("--source gsi|wd|osm が必要です"); process.exit(1); }
    // --part k/n で対象を n 分割して並行に走らせられる（gsi・wd のみ。osm は 1 本で走らせること）。
    if (source === "osm" && opt("--part")) { console.error("osm は Nominatim の利用ポリシーにより並列にしません"); process.exit(1); }
    await run(source, outDir, Number(opt("--limit") ?? Infinity), opt("--part"));
  }
}
