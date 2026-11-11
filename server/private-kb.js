// 国土数値情報の非商用データ（P11 バス停・P12 観光資源・P27 文化施設）を、
// **中継（Cloudflare Worker）の中だけで**使うための窓口。
//
// なぜここにあるか
// ----------------
// 非商用のデータは、複製物の再配布ができません（docs/kokudo-licenses.md）。
// そこで元データはリポジトリにもサイトにも置かず、Cloudflare の Workers KV
// （バインディング PRIVATE_KB）に入れます。Workers の無料プランに含まれ、
// カードの登録は要りません（R2 は無料枠でも支払い方法の登録が要ります）。リポジトリに残るのは、
// 学習済みの重みや集計値のような「パラメータ」だけです。
//
// **元データは外に返しません。** この窓口が返すのは、
//
//   POST /stops/near  {lat,lng,km}      → { available, within }   … その半径にバス停があるか
//   POST /spots/check {name,lat,lng}    → { available, listed }   … その名前の観光資源・文化施設が近くにあるか
//
// という「はい／いいえ」だけです。名前・座標・件数・距離は返しません。
// 半径も決まった値（STOP_RADII）に丸めるので、細かく聞いて位置を割り出す
// のは手間がかかります（それでも残る危うさは docs/private-kb.md に書きました）。
//
// 入れ物の形（tools/upload_private_kb.mjs が作ります。KV の鍵＝下の名前）
// ----------------------------------------------------
//   manifest.json           { version, bus: ["34_135", …], spots: ["34_135", …] }
//   bus/<lat>_<lng>.json    [[lat, lng, 名前], …]   1度四方ごと（P11）
//   spots/<lat>_<lng>.json  [[lat, lng, 名前], …]   1度四方ごと（P12・P27）
//
// 1度四方に切るのは、Workers の無料枠の CPU 時間（1回 10ms）に収めるためです。
// 7MB の JSON を1回で読むと、それだけで超えます。
//
// 入れ物（store）は `get(key) → {json()}|null` の形であれば何でも構いません。
// KV のバインディングは storeFrom() がこの形に包みます（R2 のバインディングは
// そのまま使えます）。手元の node-proxy では、.private-kb/ を読む同じ形のもの
// （server/private-kb-dir.mjs）を渡します。

/** 1枚の大きさ（度）。tools/upload_private_kb.mjs と合わせます。 */
export const TILE_DEG = 1;

/** 聞いてよい半径（km）。これ以外は、いちばん近い上の値に丸めます。 */
export const STOP_RADII = [0.5, 1, 1.5, 2, 3, 5];

/** 名前の照合で見る半径（km）。 */
export const SPOT_RADIUS_KM = 2;

const R = 6371;
function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function tileOf(lat, lng) {
  return `${Math.floor(lat / TILE_DEG)}_${Math.floor(lng / TILE_DEG)}`;
}

/** 「新宿駅」「 新宿 」「（新宿）」を同じ鍵にします。 */
export function normalizeName(name) {
  return String(name ?? "").normalize("NFKC").trim()
    .replace(/[\s　・･()（）「」『』]+/g, "").replace(/(駅|停留所|バス停)$/, "")
    .toLowerCase();
}

/** 日本の範囲の座標だけ受け付けます。おかしな値で入れ物を叩きません。 */
export function pointOf(body) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) return null;
  return { lat, lng };
}

export function radiusOf(km) {
  const x = Number(km);
  if (!Number.isFinite(x) || x <= 0) return 1;
  return STOP_RADII.find((r) => x <= r) ?? STOP_RADII[STOP_RADII.length - 1];
}

// --- 読み込み（同じ isolate の中では使い回します） -------------------------

/** KV は読んだ値を各地の拠点に1時間置きます（読み出しの回数を減らすため）。 */
const KV_CACHE_TTL = 3600;
const wrapped = new WeakMap();

/** KV・R2・手元の入れ物を、同じ `get(key) → {json()}|null` の形にそろえます。 */
export function storeFrom(binding) {
  if (!binding || typeof binding.get !== "function") return null;
  // KV のバインディングだけが getWithMetadata を持っています。
  if (typeof binding.getWithMetadata !== "function") return binding;
  let s = wrapped.get(binding);
  if (!s) {
    s = {
      async get(key) {
        const text = await binding.get(key, { type: "text", cacheTtl: KV_CACHE_TTL });
        return text == null ? null : { json: async () => JSON.parse(text), text: async () => text };
      },
    };
    wrapped.set(binding, s);
  }
  return s;
}

const cache = new WeakMap();   // store → { manifest, tiles: Map }

function slot(store) {
  let s = cache.get(store);
  if (!s) { s = { manifest: null, tiles: new Map() }; cache.set(store, s); }
  return s;
}

async function readJson(store, key) {
  const obj = await store.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}

async function manifestOf(store) {
  const s = slot(store);
  s.manifest ??= readJson(store, "manifest.json").then((m) => ({
    bus: new Set(Array.isArray(m?.bus) ? m.bus : []),
    spots: new Set(Array.isArray(m?.spots) ? m.spots : []),
    ok: Boolean(m),
  })).catch(() => ({ bus: new Set(), spots: new Set(), ok: false }));
  return s.manifest;
}

async function tile(store, kind, name) {
  const s = slot(store);
  const key = `${kind}/${name}.json`;
  let p = s.tiles.get(key);
  if (!p) {
    p = readJson(store, key).then((rows) => (Array.isArray(rows) ? rows : []))
      .catch(() => []);
    s.tiles.set(key, p);
  }
  return p;
}

/** その点から km 以内に掛かるタイルの行を、まとめて返します。 */
async function rowsNear(store, kind, point, km) {
  const m = await manifestOf(store);
  const have = m[kind];
  // 半径が掛かるタイルだけを読みます（たいていは1枚。境目の近くだけ2〜4枚）。
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
  const want = [];
  for (let y = Math.floor((point.lat - dLat) / TILE_DEG); y <= Math.floor((point.lat + dLat) / TILE_DEG); y++) {
    for (let x = Math.floor((point.lng - dLng) / TILE_DEG); x <= Math.floor((point.lng + dLng) / TILE_DEG); x++) {
      const name = `${y}_${x}`;
      if (have.has(name)) want.push(name);
    }
  }
  const lists = await Promise.all(want.map((n) => tile(store, kind, n)));
  return lists.flat();
}

// --- 判定（中の値は外に出しません） ---------------------------------------

/**
 * その点から km 以内にバス停（P11）があるか。
 * @returns {Promise<{available:boolean, within:boolean}>}
 */
export async function stopNear(store, body) {
  if (!store) return { available: false, within: false };
  const point = pointOf(body);
  if (!point) return { available: true, within: false };
  const km = radiusOf(body?.km);
  const m = await manifestOf(store);
  if (!m.ok) return { available: false, within: false };
  const rows = await rowsNear(store, "bus", point, km);
  const within = rows.some((r) => haversineKm(point, { lat: r[0], lng: r[1] }) <= km);
  return { available: true, within };
}

/**
 * その名前の観光資源・文化施設（P12・P27）が、その点の近くに載っているか。
 * 名前の裏取り（AI が作った名前ではないか）に使います。
 * @returns {Promise<{available:boolean, listed:boolean}>}
 */
export async function spotListed(store, body) {
  if (!store) return { available: false, listed: false };
  const point = pointOf(body);
  const q = normalizeName(body?.name);
  if (!point || q.length < 2 || q.length > 60) return { available: true, listed: false };
  const m = await manifestOf(store);
  if (!m.ok) return { available: false, listed: false };
  const rows = await rowsNear(store, "spots", point, SPOT_RADIUS_KM);
  const listed = rows.some((r) => {
    if (haversineKm(point, { lat: r[0], lng: r[1] }) > SPOT_RADIUS_KM) return false;
    const n = normalizeName(r[2]);
    if (n === q) return true;
    // 「清水寺」と「音羽山清水寺」のような、片方がもう片方を含む名前も同じものと見ます。
    // 短すぎる名前（2文字）で広く当たらないよう、3文字以上のときだけです。
    return q.length >= 3 && n.length >= 3 && (n.includes(q) || q.includes(n));
  });
  return { available: true, listed };
}

/** 中継の入口。返すのは決まった鍵だけです（tests/private-kb.test.js が見ます）。 */
export async function privateKbHandler(path, body, env) {
  const store = storeFrom(env?.PRIVATE_KB);
  if (path.endsWith("/stops/near")) {
    const r = await stopNear(store, body);
    return { available: r.available, within: r.within };
  }
  if (path.endsWith("/spots/check")) {
    const r = await spotListed(store, body);
    return { available: r.available, listed: r.listed };
  }
  return null;
}

// --- 管理画面から入れる（server/admin.js の /private/api/private-kb） --------

/** 入れてよい鍵。これ以外は受け付けません。 */
export const KEY_PATTERN = /^(manifest\.json|(bus|spots)\/-?\d{1,3}_-?\d{1,3}\.json)$/;
/** 1件の上限。いちばん大きいタイルが 0.2MB なので、余裕を見ても 2MB で足ります。 */
export const MAX_VALUE_BYTES = 2 * 1024 * 1024;

/**
 * 入れる前に、鍵と中身の形を確かめます。決まった形の JSON だけを通します
 * （合言葉が漏れても、別のものを置き場に使われないように）。
 * @returns {string|null} だめなわけ。よければ null
 */
export function checkUpload(key, text) {
  if (!KEY_PATTERN.test(String(key ?? ""))) return "鍵の形が違います";
  if (typeof text !== "string" || !text.length) return "中身がありません";
  if (new TextEncoder().encode(text).length > MAX_VALUE_BYTES) return "大きすぎます";
  let doc;
  try { doc = JSON.parse(text); } catch { return "JSON として読めません"; }
  if (key === "manifest.json") {
    const ok = doc && Array.isArray(doc.bus) && Array.isArray(doc.spots)
      && [...doc.bus, ...doc.spots].every((t) => /^-?\d{1,3}_-?\d{1,3}$/.test(String(t)));
    return ok ? null : "目次（manifest.json）の形が違います";
  }
  const rows = Array.isArray(doc) && doc.every((r) => Array.isArray(r) && r.length === 3
    && Number.isFinite(r[0]) && Number.isFinite(r[1]) && typeof r[2] === "string" && r[2].length <= 200);
  if (!rows) return "タイルの形が違います（[[緯度, 経度, 名前], …]）";
  return null;
}

/**
 * 1件入れます（KV の put）。返すのは件数だけで、中身は返しません。
 * @returns {Promise<{ok:boolean, error?:string, status?:number}>}
 */
export async function putPrivate(env, key, text) {
  const kv = env?.PRIVATE_KB;
  if (!kv || typeof kv.put !== "function") {
    return { ok: false, status: 503, error: "PRIVATE_KB（Workers KV）がつながっていません。wrangler.jsonc の kv_namespaces を見てください" };
  }
  const bad = checkUpload(key, text);
  if (bad) return { ok: false, status: 400, error: bad };
  await kv.put(key, text);
  // この isolate の読み込みの覚えを捨てます（新しい中身で答えるため）。
  const s = storeFrom(kv);
  if (s) cache.delete(s);
  return { ok: true };
}

/** 入れ物の様子（つながっているか・目次の件数だけ）。 */
export async function privateStatus(env) {
  const store = storeFrom(env?.PRIVATE_KB);
  if (!store) return { bound: false, ready: false };
  const m = await readJson(store, "manifest.json").catch(() => null);
  return {
    bound: true, ready: Boolean(m),
    tiles: m ? { bus: (m.bus ?? []).length, spots: (m.spots ?? []).length } : null,
  };
}

// --- 入れ物の中身を作る（tools/upload_private_kb.mjs が使います） ---------

/**
 * kb-private/ の中身から、KV に入れる鍵と中身の一覧を作ります。
 *
 * @param {{busIndex?:object, readBusTile?:(file:string)=>object|null, spotsDoc?:object}} src
 * @returns {Map<string, any>} 鍵 → JSON にする値
 */
export function packPrivateKb({ busIndex, readBusTile, spotsDoc }) {
  const out = new Map();
  const bus = new Map();
  const add = (map, lat, lng, name) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) return;
    const t = tileOf(lat, lng);
    const list = map.get(t);
    const row = [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, String(name)];
    if (list) list.push(row); else map.set(t, [row]);
  };
  const busRows = [];
  if (Array.isArray(busIndex?.stops)) busRows.push(...busIndex.stops);
  for (const t of Array.isArray(busIndex?.tiles) ? busIndex.tiles : []) {
    const doc = readBusTile?.(t.file);
    if (Array.isArray(doc?.stops)) busRows.push(...doc.stops);
  }
  for (const s of busRows) add(bus, Number(s[0]), Number(s[1]), s[2]);

  const spots = new Map();
  for (const list of Object.values(spotsDoc?.shards ?? {})) {
    for (const s of Array.isArray(list) ? list : []) {
      add(spots, Number(s?.lat), Number(s?.lng), s?.name);
    }
  }
  for (const [t, rows] of bus) out.set(`bus/${t}.json`, rows);
  for (const [t, rows] of spots) out.set(`spots/${t}.json`, rows);
  out.set("manifest.json", {
    version: 1,
    note: "国土数値情報（非商用）。公開しないこと。中継の中の判定だけに使う（docs/private-kb.md）。",
    bus: [...bus.keys()].sort(),
    spots: [...spots.keys()].sort(),
    counts: { bus: busRows.length, spots: [...spots.values()].reduce((n, r) => n + r.length, 0) },
  });
  return out;
}
