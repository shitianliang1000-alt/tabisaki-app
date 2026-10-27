// 知識ベース（kb/）を地域ごとに切り出し、似たスポットを探す（Issue #353）。
//
//     tabisaki kb extract --region=関東         # .tabisaki/kb/関東.json
//     tabisaki kb index --region=関東           # .tabisaki/index/関東.json
//     tabisaki similar "清水寺"
//
// js/ の本体には頼らず、kb/ の JSON だけを読みます（packages/core の中で完結）。
// 外へは通信しません。依存するパッケージもありません。
//
// 似ているかどうかは、TF-IDF（言葉の重み）と余弦類似度で測ります。
// スポットの多くは「名前・分類・座標」しか持たないので、意味の埋め込み
// （ベクトルを作るモデル）を入れても、名前1語からでは差が出にくいためです。
// 比べた結果は docs/kb-extract.md に書いてあります。

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 都道府県（kb/index.json の shards の順＝JIS の番号順）。 */
export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

const range = (a, b) => PREFECTURES.slice(a - 1, b);
/** 地方の名前 → 都道府県。8地方区分に、よく使う呼びかたを足しています。 */
export const AREAS = {
  北海道: range(1, 1),
  東北: range(2, 7),
  関東: range(8, 14),
  中部: range(15, 23),
  北陸: range(16, 18),
  甲信越: [PREFECTURES[14], PREFECTURES[18], PREFECTURES[19]],
  東海: range(21, 24),
  近畿: range(24, 30),
  関西: range(24, 30),
  中国: range(31, 35),
  四国: range(36, 39),
  九州: range(40, 46),
  九州沖縄: range(40, 47),
  沖縄: range(47, 47),
};

export class KbToolError extends Error {
  constructor(code, message) { super(message); this.name = "KbToolError"; this.code = code; }
}

/**
 * 「関東」「京都府」「京都」「京都府,奈良県」を都道府県の並びにします。
 * @returns {string[]} JIS の番号順
 */
export function resolveRegion(spec) {
  const words = String(spec ?? "").split(/[,、，]/).map((w) => w.trim().replace(/地方$/, "")).filter(Boolean);
  if (!words.length) throw new KbToolError("invalid_input", "--region=<地方か都道府県> を書いてください（例: 関東・京都府・九州沖縄）");
  const out = new Set();
  for (const w of words) {
    if (w === "全国" || w === "all") { PREFECTURES.forEach((p) => out.add(p)); continue; }
    if (AREAS[w]) { AREAS[w].forEach((p) => out.add(p)); continue; }
    const pref = PREFECTURES.find((p) => p === w || p.replace(/[都府県]$/, "") === w);
    if (!pref) {
      throw new KbToolError("invalid_input", `「${w}」は地方・都道府県の名前として知りません（使えるもの: ${Object.keys(AREAS).join("・")}・各都道府県・全国）`);
    }
    out.add(pref);
  }
  return PREFECTURES.filter((p) => out.has(p));
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

// 切り出しで残す項目。座標・分類・名前だけでも旅程は組めます。
// 出典（src・source・dataSource・license・osm・overture）は必ず残します。
const SPOT_FIELDS = [
  "id", "regionId", "name", "category", "genres", "lat", "lng", "prefecture",
  "description", "fame_tier", "fame_score", "dwell", "open", "close", "fee",
  "wikipedia", "url", "src", "source", "dataSource", "license", "osm", "overture",
];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, o[k]]));

/**
 * 地域の知識ベースを切り出します。同じ kb/ からは、いつ走らせても同じ中身になります
 * （日時は入れず、かわりに元ファイルの指紋 kbHash を入れます）。
 */
export async function extractRegion(spec, { root = ROOT } = {}) {
  const prefectures = resolveRegion(spec);
  const kbDir = path.join(root, "kb");
  const manifest = await readJson(path.join(kbDir, "index.json"));
  const hash = createHash("sha256");
  const regionsRaw = await readFile(path.join(kbDir, manifest.regionsFile ?? "regions.json"));
  hash.update(regionsRaw);
  const allRegions = JSON.parse(regionsRaw).regions ?? [];
  const spots = [];
  const files = [];
  for (const shard of manifest.shards ?? []) {
    if (!prefectures.includes(shard.prefecture)) continue;
    const raw = await readFile(path.join(kbDir, shard.file));
    hash.update(shard.file).update(raw);
    files.push(shard.file);
    for (const s of JSON.parse(raw).spots ?? []) spots.push(pick({ prefecture: shard.prefecture, ...s }, SPOT_FIELDS));
  }
  const regionIds = new Set(spots.map((s) => s.regionId));
  const regions = allRegions.filter((r) => regionIds.has(r.id))
    .map((r) => pick(r, ["id", "name", "prefecture", "lat", "lng", "station", "genres", "src", "tagline"]));
  // どの出典から何件か（元データの条件を確かめるための手がかり）。
  const bySrc = {};
  for (const s of spots) bySrc[s.src ?? "manual"] = (bySrc[s.src ?? "manual"] ?? 0) + 1;
  return {
    version: 1,
    region: String(spec),
    prefectures,
    kbHash: hash.digest("hex").slice(0, 16),
    files,
    counts: { regions: regions.length, spots: spots.length },
    sources: manifest.sources ?? [],
    spotsBySrc: Object.fromEntries(Object.entries(bySrc).sort()),
    notice: "外から取り込んだデータは、それぞれの提供元の条件に従います（docs/data-licenses.md・credits.html）。"
      + "国土数値情報の観光資源（src=kokudo）・文化施設は非商用で、再配布できるかは確かめていません。",
    regions,
    spots,
  };
}

/** 切り出しを書き出します。既定は .tabisaki/kb/<地域>.json（.gitignore 済み）。 */
export async function writeExtract(doc, out) {
  const file = out ?? path.join(ROOT, ".tabisaki", "kb", `${safeName(doc.region)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc) + "\n");
  return file;
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "region";

// --- 似たスポットの検索（TF-IDF） ------------------------------------------

const bigrams = (s) => {
  const t = String(s ?? "").replace(/[\s・（）()「」『』、。,.\-ー〜~]/g, "");
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  if (t.length === 1) out.push(t);
  return out;
};

/**
 * スポット1件を言葉の重みの集まりにします。
 * 分類（寺院・滝…）をいちばん重く、名前の終わりの字（〜寺・〜滝・〜城）を次に置きます。
 */
export function spotTerms(s, regionName = "") {
  const w = new Map();
  const add = (t, x) => w.set(t, (w.get(t) ?? 0) + x);
  if (s.category) add(`c:${s.category}`, 3);
  for (const g of s.genres ?? []) add(`g:${g}`, 1.5);
  const name = String(s.name ?? "");
  const tail = name.replace(/[（(].*$/, "").trim().slice(-1);
  if (tail) add(`t:${tail}`, 1.5);
  for (const b of bigrams(name)) add(`n:${b}`, 1);
  for (const b of bigrams(s.description)) add(`d:${b}`, 0.4);
  if (s.regionId) add(`r:${s.regionId}`, 0.6);
  if (regionName) for (const b of bigrams(regionName)) add(`n:${b}`, 0.2);
  return w;
}

/** 自由な文（「紅葉のきれいな寺」）を、同じ言葉の集まりにします。 */
export function textTerms(text, categories = [], tailCats = {}) {
  const w = new Map();
  const add = (t, x) => w.set(t, (w.get(t) ?? 0) + x);
  for (const c of categories) if (String(text).includes(c)) add(`c:${c}`, 3);
  // 「寺」「滝」のような1字からも分類を読みます（名前の終わりの字と分類の対応。buildIndex が数える）。
  for (const ch of new Set(String(text))) if (tailCats[ch] && !w.has(`c:${tailCats[ch]}`)) add(`c:${tailCats[ch]}`, 2);
  for (const b of bigrams(text)) { add(`n:${b}`, 1); add(`d:${b}`, 0.4); }
  const tail = String(text).trim().slice(-1);
  if (tail) add(`t:${tail}`, 1);
  return w;
}

/**
 * 索引を作ります。
 * @param {{spots: object[], regions?: object[]}} kb 切り出し（extractRegion の結果）か、それと同じ形
 * @param {{method?: string}} [opts]
 */
export function buildIndex(kb, { method = "tfidf" } = {}) {
  if (method !== "tfidf") {
    throw new KbToolError("invalid_input", `--method=${method} は使えません。いま使えるのは tfidf だけです`
      + "（faiss は外の部品が要り、件数が数万では速さの差が出ないため入れていません。docs/kb-extract.md）");
  }
  const regionName = new Map((kb.regions ?? []).map((r) => [r.id, r.name]));
  const raw = kb.spots.map((s) => spotTerms(s, regionName.get(s.regionId)));
  const df = new Map();
  for (const m of raw) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const terms = [...df.keys()].sort();
  const termId = new Map(terms.map((t, i) => [t, i]));
  const N = raw.length;
  const idf = terms.map((t) => Math.log((N + 1) / (df.get(t) + 1)) + 1);
  const vectors = raw.map((m) => normalize([...m].map(([t, x]) => [termId.get(t), x * idf[termId.get(t)]])));
  // 名前の終わりの漢字 → いちばん多い分類（20件以上あり、6割以上がその分類のものだけ）。
  const tails = new Map();
  for (const sp of kb.spots) {
    const ch = String(sp.name ?? "").replace(/[（(].*$/, "").trim().slice(-1);
    if (!/\p{Script=Han}/u.test(ch) || !sp.category || sp.category === "観光名所") continue;
    const m = tails.get(ch) ?? new Map();
    m.set(sp.category, (m.get(sp.category) ?? 0) + 1);
    tails.set(ch, m);
  }
  const tailCats = {};
  for (const [ch, m] of [...tails].sort()) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [cat, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    if (total >= 20 && n / total >= 0.6) tailCats[ch] = cat;
  }
  return {
    version: 1, method, kbHash: kb.kbHash ?? null, region: kb.region ?? null,
    terms, idf, tailCats,
    categories: [...new Set(kb.spots.map((s) => s.category).filter(Boolean))].sort(),
    spots: kb.spots.map((s) => ({ id: s.id, name: s.name, category: s.category ?? "", regionId: s.regionId ?? "",
      region: regionName.get(s.regionId) ?? "", prefecture: s.prefecture ?? "", lat: s.lat, lng: s.lng,
      rank: nameRank(s) })),
    vectors,
  };
}

/**
 * 同じ名前が何件もあるとき（清水寺は全国に17件）、どれを指していると読むか。
 * 手で確かめた収録（説明つき）→ 同名の Wikipedia 記事あり → 有名度、の順です。
 */
export function nameRank(s) {
  return (s.description ? 4 : 0) + (!s.src ? 3 : 0) + (s.wikipedia === s.name ? 2 : 0)
    + ({ major: 3, known: 1 }[s.fame_tier] ?? 0);
}

function normalize(pairs) {
  const len = Math.sqrt(pairs.reduce((a, [, x]) => a + x * x, 0)) || 1;
  // 索引ファイルを小さく保つため、重みは4桁に丸めます。
  return pairs.map(([i, x]) => [i, Math.round((x / len) * 1e4) / 1e4]).sort((a, b) => a[0] - b[0]);
}

function postings(index) {
  if (index._post) return index._post;
  const post = Array.from({ length: index.terms.length }, () => []);
  index.vectors.forEach((v, n) => { for (const [i, x] of v) post[i].push([n, x]); });
  Object.defineProperty(index, "_post", { value: post, enumerable: false });
  return post;
}

const km = (a, b) => {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/** 名前で1件を探します（完全一致 → かっこを外して一致 → 含む、の順。同名なら nameRank の高いもの）。無ければ -1。 */
export function findSpot(index, name) {
  const q = String(name ?? "").trim();
  if (!q) return null;
  const bare = (s) => String(s).replace(/[（(].*?[）)]/g, "").trim();
  for (const test of [(s) => s.name === q, (s) => bare(s.name) === q, (s) => s.name.includes(q)]) {
    let best = -1;
    index.spots.forEach((s, i) => {
      if (test(s) && (best < 0 || (s.rank ?? 0) > (index.spots[best].rank ?? 0))) best = i;
    });
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * 似たスポットを返します。名前が収録にあればそのスポットを起点に、無ければ文として探します。
 * @returns {{query: object|null, text: string, results: object[]}}
 */
export function similar(index, q, { limit = 10, exclude = true } = {}) {
  const at = findSpot(index, q);
  let vec;
  let origin = null;
  if (at >= 0) {
    vec = index.vectors[at];
    origin = index.spots[at];
  } else {
    const termId = new Map(index.terms.map((t, i) => [t, i]));
    vec = normalize([...textTerms(q, index.categories, index.tailCats)]
      .filter(([t]) => termId.has(t)).map(([t, x]) => [termId.get(t), x * index.idf[termId.get(t)]]));
  }
  const post = postings(index);
  const score = new Map();
  for (const [i, x] of vec) for (const [n, y] of post[i]) score.set(n, (score.get(n) ?? 0) + x * y);
  if (origin && exclude) score.delete(at);
  // 起点から 0.5km 以内の同じ分類は、同じ場所の重複（出典ちがいの2件）とみなして外します。
  const dup = (n) => origin && exclude && index.spots[n].category === origin.category
    && (km(origin, index.spots[n]) ?? 99) < 0.5;
  const results = [...score].filter(([n, s]) => s > 0 && !dup(n))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit)
    .map(([n, s]) => ({ ...index.spots[n], score: Math.round(s * 1000) / 1000,
      km: origin ? roundKm(km(origin, index.spots[n])) : null }));
  return { query: origin, text: String(q), results };
}

const roundKm = (d) => (d === null ? null : Math.round(d * 10) / 10);

/** 索引を書き出します。既定は .tabisaki/index/<地域>.json。 */
export async function writeIndex(index, out) {
  const file = out ?? path.join(ROOT, ".tabisaki", "index", `${safeName(index.region ?? "全国")}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(index) + "\n");
  return file;
}

/** 書き出した索引を読みます（無ければ null）。 */
export async function readIndex(file) {
  try { return await readJson(file); } catch { return null; }
}

/**
 * 似たスポットの当たりぐあい（評価）。cases は tests/fixtures/similar-eval.json の形。
 * 上位 k 件のうち、期待した分類に入るものの割合（precision@k）の平均を返します。
 */
export function evaluate(index, cases, k = 5) {
  const rows = cases.map((c) => {
    const { query, results } = similar(index, c.query, { limit: k });
    const hit = results.filter((r) => c.categories.includes(r.category)).length;
    return { query: c.query, found: Boolean(query), precision: results.length ? hit / k : 0,
      top: results.map((r) => `${r.name}（${r.category}）`) };
  });
  const mean = rows.reduce((a, r) => a + r.precision, 0) / (rows.length || 1);
  return { k, mean: Math.round(mean * 1000) / 1000, rows };
}
