// バス停・駅・観光地のデータを配る API（GET /v1/data/…）。
//
// CUI（./tabisaki）とアプリが、収録のデータを丸ごと抱えずに、要る範囲だけを
// 取りに来るための窓口です。中継（AI・乗り換え）とは別の道で、Origin の
// 決まり（ALLOW_ORIGIN）も使いません。読むだけの公開データなので、どこからでも
// 呼べます（CORS は *）。
//
// **ここで配るのは「再配布してよいデータ」だけです。** 線引きは
// docs/data-api.md の「配るもの・配らないもの」に書きました。要点は、
//
//   ・国土数値情報の非商用データ（P11 バス停・P12 観光資源・P27 文化施設）は
//     ここには入りません。入れ物（下の store）にも入れません。アプリが使うときは
//     今までどおり POST /stops/near・/spots/check の「はい／いいえ」だけです
//     （server/private-kb.js）。
//   ・入れ物を作る道具（tools/data_api.mjs build）が、出どころを1件ずつ見て、
//     PUBLIC_SOURCES に無いものを落とします。ここでももう一度確かめ、通らない
//     ものは返しません（assertPublicItem）。
//
// 入れ物（tools/data_api.mjs build が作ります）
// ---------------------------------------------
//   manifest.json            版・件数・タイルの一覧・出どころの台帳
//   spots/<タイル>.json      { items: [...] }   0.5度四方ごと（TILE_DEG）
//   spots-index/<0-f>.json   { <id>: "<タイル>" }（id の SHA-1 の頭1文字で16に分ける）
//   stations/<lat>_<lng>.json
//   stops/<lat>_<lng>.json
//
// 読む場所は2つで、どちらか片方だけを使います（混ぜると版が食い違うため）。
//   1. Workers KV（バインディング DATA_KB）に manifest があれば、全部そこから。
//      持ち主が `./tabisaki data push` で入れます。デプロイしなくても差し替えられます。
//   2. 無ければ、デプロイに同梱したもの（.site/__data/v1/。外からは 404）。
//
// 回数の制限は Durable Object（RateLimiter）で、中継とは別の枠で数えます。
// 鍵（API キー）は無くても呼べます。鍵があると枠が広がります。鍵の扱いは
// docs/data-api.md の「鍵」にあります。

export const DATA_API_PREFIX = "/v1/data";
export const DATA_SCHEMA = "tabisaki.data-api/1";
export const DATA_API_VERSION = 1;
/**
 * 1枚の大きさ（度）。タイルの名前は「緯度÷0.5 の整数部_経度÷0.5 の整数部」です
 * （例: 東京駅は 71_279）。1度四方だと東京の1枚が 2MB になり、読むだけで
 * 無料枠の CPU 時間（1回10ms）を超えるので、半分にしています。0.25 にすると
 * 枚数が 1,000 を超え、KV の無料枠（1日 1,000 回の書き込み）で1回に入れきれません。
 */
export const TILE_DEG = 0.5;
/** スポットの id → タイルの表を、id の指紋の頭1文字で16に分けます。 */
export const INDEX_SHARDS = "0123456789abcdef";
/** 同梱したものの置き場（外からは 404）。 */
export const DATA_ASSET_DIR = "/__data/";
/** KV の鍵の頭。 */
export const KV_PREFIX = "v1/";
export const KEY_PREFIX = "apikey:";

/** 1回で返す件数。 */
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;
/** 範囲の上限。広すぎる頼みは CPU 時間（無料枠は1回10ms）を食うので断ります。 */
export const MAX_BBOX_DEG = 1;
export const MAX_RADIUS_KM = 10;

/** 鍵なし・鍵ありの枠（1つの相手につき）。環境変数で変えられます。 */
export const DATA_LIMITS = {
  anon: { minute: 60, hour: 1000 },
  key: { minute: 600, hour: 20000 },
};

/**
 * 配ってよい出どころ。packages/core/src/provenance.js の台帳の鍵に、
 * 駅（国土数値情報 N02。商用可）と GTFS の時刻表（1本ずつライセンスを持つ）を
 * 足したものです。ここに無い出どころの1件は配りません。
 *
 * 入っていないもの: unknown（出どころ不明）、user（利用者が足したもの）、
 * 国土数値情報の非商用（P11・P12・P27）。
 */
export const PUBLIC_SOURCES = new Set([
  "tabisaki_original", "wikipedia", "wikidata", "osm", "overture",
  "yahoo", "gsi", "mlit_river", "tourlist", "kokudo_n02",
]);
/** GTFS の時刻表は gtfs:<名前> の形で、1本ずつ manifest の台帳に載ります。 */
export const GTFS_SOURCE_PREFIX = "gtfs:";

/** 非商用データの印。どこかに出てきたら、その1件は配りません。 */
const NONCOMMERCIAL = /kokudo(?!_n02)|国土数値情報.*(P11|P12|P27|バス停留所|観光資源|文化施設)|\bP1[12]\b|\bP27\b/i;

export function isPublicSource(id) {
  return PUBLIC_SOURCES.has(id) || (typeof id === "string" && id.startsWith(GTFS_SOURCE_PREFIX));
}

/**
 * 1件を配ってよいか。だめなら理由（文字列）、よければ null。
 * 作る道具と、配る直前の両方で使います。
 */
export function publicProblem(item) {
  if (!item || typeof item !== "object") return "1件の形ではありません";
  const srcs = item.sources;
  if (!Array.isArray(srcs) || srcs.length === 0) return "出どころ（sources）がありません";
  for (const s of srcs) if (!isPublicSource(s)) return `配れない出どころです: ${s}`;
  if ("dataSource" in item) return "dataSource（国土数値情報の取り込みの印）があります";
  for (const k of ["src", "geo", "license"]) {
    if (typeof item[k] === "string" && NONCOMMERCIAL.test(item[k])) return `非商用データの印があります（${k}: ${item[k]}）`;
  }
  if (typeof item.lat !== "number" || typeof item.lng !== "number") return "座標がありません";
  return null;
}

/** id の載っている索引の1枚（0〜f）。 */
export async function indexShardOf(id) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(String(id)));
  return INDEX_SHARDS[new Uint8Array(buf)[0] >> 4];
}

export function tileOf(lat, lng) {
  return `${Math.floor(lat / TILE_DEG)}_${Math.floor(lng / TILE_DEG)}`;
}

/** 範囲にかかるタイル。 */
export function tilesForBox([w, s, e, n]) {
  const out = [];
  for (let la = Math.floor(s / TILE_DEG); la <= Math.floor(n / TILE_DEG); la++) {
    for (let lo = Math.floor(w / TILE_DEG); lo <= Math.floor(e / TILE_DEG); lo++) out.push(`${la}_${lo}`);
  }
  return out;
}

const R = 6371;
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 半径 km の円を囲む範囲 [w,s,e,n]。 */
export function boxAround(lat, lng, km) {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/**
 * 問い合わせ（?near= ?bbox= ?pref= ?limit= ?offset= …）を読みます。
 * 知らない項目は 400 にします（書きまちがいに気づけるように）。
 */
export function parseQuery(params, dataset) {
  const allowed = new Set(["near", "radius", "bbox", "limit", "offset"]);
  if (dataset === "spots") for (const k of ["pref", "category", "tier"]) allowed.add(k);
  for (const k of params.keys()) {
    if (!allowed.has(k)) throw new ApiError(400, "unknown_param", `知らない項目です: ${k}`);
  }
  const q = { limit: DEFAULT_LIMIT, offset: 0 };
  if (params.has("limit")) {
    const n = num(params.get("limit"));
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new ApiError(400, "bad_limit", `limit は 1〜${MAX_LIMIT} の整数です`);
    q.limit = n;
  }
  if (params.has("offset")) {
    const n = num(params.get("offset"));
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new ApiError(400, "bad_offset", "offset は 0 以上の整数です");
    q.offset = n;
  }
  const ways = ["near", "bbox", "pref"].filter((k) => params.has(k));
  if (ways.length !== 1) {
    throw new ApiError(400, "need_area", dataset === "spots"
      ? "near・bbox・pref のどれか1つで範囲を決めてください"
      : "near か bbox のどちらか1つで範囲を決めてください");
  }
  if (params.has("near")) {
    const [lat, lng] = String(params.get("near")).split(",").map(num);
    if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) throw new ApiError(400, "bad_near", "near は 緯度,経度（日本の中）です");
    let km = 1;
    if (params.has("radius")) {
      km = num(params.get("radius"));
      if (!(km > 0 && km <= MAX_RADIUS_KM)) throw new ApiError(400, "bad_radius", `radius は 0〜${MAX_RADIUS_KM} km です`);
    }
    q.near = { lat, lng, km };
    q.box = boxAround(lat, lng, km);
  } else if (params.has("radius")) {
    throw new ApiError(400, "bad_radius", "radius は near と一緒に使います");
  }
  if (params.has("bbox")) {
    const b = String(params.get("bbox")).split(",").map(num);
    const [w, s, e, n] = b;
    if (b.length !== 4 || !b.every(Number.isFinite) || !(w < e && s < n)) {
      throw new ApiError(400, "bad_bbox", "bbox は 西経度,南緯度,東経度,北緯度 です");
    }
    if (e - w > MAX_BBOX_DEG || n - s > MAX_BBOX_DEG) {
      throw new ApiError(400, "bbox_too_large", `bbox は ${MAX_BBOX_DEG} 度四方までです`);
    }
    q.box = [w, s, e, n];
  }
  if (params.has("pref")) {
    const p = String(params.get("pref")).padStart(2, "0");
    if (!/^(0[1-9]|[1-3]\d|4[0-7])$/.test(p)) throw new ApiError(400, "bad_pref", "pref は 1〜47（都道府県コード）です");
    q.pref = p;
  }
  if (params.has("category")) q.category = String(params.get("category")).slice(0, 40);
  if (params.has("tier")) {
    const t = params.get("tier");
    if (!["major", "hidden"].includes(t)) throw new ApiError(400, "bad_tier", "tier は major か hidden です");
    q.tier = t;
  }
  return q;
}

/** タイルから集めた候補を、問い合わせで絞ります（距離の近い順・または id 順）。 */
export function filterItems(items, q) {
  let out = items;
  if (q.box) {
    const [w, s, e, n] = q.box;
    out = out.filter((it) => it.lng >= w && it.lng <= e && it.lat >= s && it.lat <= n);
  }
  if (q.pref) out = out.filter((it) => it.pref === q.pref);
  if (q.category) out = out.filter((it) => it.category === q.category);
  if (q.tier) out = out.filter((it) => it.fame_tier === q.tier);
  if (q.near) {
    out = out
      .map((it) => ({ it, d: haversineKm(q.near, it) }))
      .filter((x) => x.d <= q.near.km)
      .sort((a, b) => a.d - b.d || (a.it.id < b.it.id ? -1 : 1))
      .map((x) => ({ ...x.it, distance_m: Math.round(x.d * 1000) }));
  } else {
    out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return out;
}

/** 返す1件に付ける出典のまとめ（使った出どころだけ）。 */
export function licenseSummaryFor(items, sources) {
  const used = new Set();
  for (const it of items) for (const s of it.sources ?? []) used.add(s);
  const list = [...used].sort().map((id) => ({ id, ...(sources?.[id] ?? { license: "?" }) }));
  return {
    sources: list.map(({ id, license, licenseUrl, shareAlike }) => ({
      id, license, ...(licenseUrl ? { licenseUrl } : {}), ...(shareAlike ? { shareAlike: true } : {}),
    })),
    attribution: list.filter((s) => s.required && s.attribution).map((s) => s.attribution),
  };
}

// --- 入れ物 --------------------------------------------------------------

const memo = new Map(); // 版:道 → 中身（同じ isolate の中だけ）
const MEMO_MAX = 96;
let manifestMemo = null; // { at, value, from }
const MANIFEST_TTL_MS = 60_000;

function remember(key, value) {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(key, value);
}

/** テストから呼ぶ: 覚えているものを捨てます。 */
export function _resetDataApiMemo() { memo.clear(); manifestMemo = null; }

/**
 * 読む場所を決めます。KV に manifest があれば KV だけ、無ければ同梱のものだけ。
 * 返すのは get(path) → 中身（JSON）か null。
 */
export async function openStore(env, now = Date.now()) {
  if (manifestMemo && now - manifestMemo.at < MANIFEST_TTL_MS) return manifestMemo.store;
  let store = null;
  if (env?.DATA_KB) {
    const kv = env.DATA_KB;
    const m = await kv.get(`${KV_PREFIX}manifest.json`, "json").catch(() => null);
    if (m) store = { from: "kv", manifest: m, get: (p) => kv.get(`${KV_PREFIX}${p}`, "json") };
  }
  if (!store && env?.ASSETS) {
    const get = async (p) => {
      const res = await env.ASSETS.fetch(new Request(`https://assets.local${DATA_ASSET_DIR}v1/${p}`));
      return res.ok ? res.json() : null;
    };
    const m = await get("manifest.json").catch(() => null);
    if (m) store = { from: "assets", manifest: m, get };
  }
  manifestMemo = { at: now, store };
  return store;
}

async function readPath(store, path) {
  const key = `${store.manifest.version}:${path}`;
  if (memo.has(key)) return memo.get(key);
  const v = await store.get(path);
  remember(key, v);
  return v;
}

async function itemsFromTiles(store, dataset, tiles) {
  const have = new Set(store.manifest.datasets?.[dataset]?.tiles ?? []);
  const out = [];
  for (const t of tiles) {
    if (!have.has(t)) continue;
    const page = await readPath(store, `${dataset}/${t}.json`);
    for (const it of page?.items ?? []) out.push(it);
  }
  return out;
}

// --- 鍵 ------------------------------------------------------------------

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 鍵の形（tools/data_api.mjs key new が作るもの）。 */
export const KEY_PATTERN = /^tbk_[A-Za-z0-9_-]{32,64}$/;

/** 頼みについてきた鍵。クエリ文字列では受けません（記録に残るため）。 */
export function keyFrom(request) {
  const auth = request.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  return m?.[1] ?? request.headers.get("X-API-Key") ?? null;
}

/**
 * 鍵を確かめます。KV（DATA_KB）に、鍵の SHA-256 だけを置いています。
 * 戻り値: null（鍵なし）／{ ok:false }／{ ok:true, id, name, perMinute? }
 */
export async function checkKey(env, key) {
  if (!key) return null;
  if (!KEY_PATTERN.test(key) || !env?.DATA_KB) return { ok: false };
  const hash = await sha256Hex(key);
  const rec = await env.DATA_KB.get(`${KEY_PREFIX}${hash}`, "json").catch(() => null);
  if (!rec || rec.revoked) return { ok: false };
  return { ok: true, id: hash.slice(0, 16), name: rec.name ?? "", perMinute: rec.perMinute, perHour: rec.perHour };
}

export function limitsFor(env, key) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  if (key?.ok) {
    return {
      minute: n(key.perMinute, n(env?.DATA_KEY_PER_MINUTE, DATA_LIMITS.key.minute)),
      hour: n(key.perHour, n(env?.DATA_KEY_PER_HOUR, DATA_LIMITS.key.hour)),
    };
  }
  return {
    minute: n(env?.DATA_ANON_PER_MINUTE, DATA_LIMITS.anon.minute),
    hour: n(env?.DATA_ANON_PER_HOUR, DATA_LIMITS.anon.hour),
  };
}

// --- 返事 ----------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-API-Key, If-None-Match",
  "Access-Control-Expose-Headers": "ETag, Retry-After, X-Data-Version, X-RateLimit-Limit",
  "Access-Control-Max-Age": "86400",
};

function reply(status, body, headers = {}, method = "GET") {
  return new Response(method === "HEAD" || status === 304 ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...CORS,
      ...headers,
    },
  });
}

function errorReply(e, method) {
  return reply(e.status, { error: { code: e.code, message: e.message, ...e.extra } },
    { "Cache-Control": "no-store", ...(e.extra?.retryAfter ? { "Retry-After": String(e.extra.retryAfter) } : {}) }, method);
}

function endpointsList(origin) {
  const b = `${origin}${DATA_API_PREFIX}`;
  return {
    manifest: `${b}`,
    attribution: `${b}/attribution`,
    spots: `${b}/spots?near=35.6812,139.7671&radius=2`,
    spot: `${b}/spots/{id}`,
    stations: `${b}/stations?near=35.6812,139.7671&radius=2`,
    stops: `${b}/stops?near=35.6812,139.7671&radius=1`,
  };
}

/**
 * 窓口の本体。
 * @param {Request} request
 * @param {object} env
 * @param {{ rate?: (id: string, limits: {minute:number,hour:number}) => Promise<{ok:boolean, retryAfter?:number}>,
 *           ip?: string }} deps
 */
export async function serveDataApi(request, env, deps = {}) {
  const url = new URL(request.url);
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (method !== "GET" && method !== "HEAD") throw new ApiError(405, "method_not_allowed", "GET だけです");
    if (String(env?.DATA_API ?? "").toLowerCase() === "off") throw new ApiError(503, "disabled", "いまは止めています");

    // 鍵（無くても呼べます。DATA_API_REQUIRE_KEY=1 のときは要ります）。
    const key = await checkKey(env, keyFrom(request));
    if (key && !key.ok) throw new ApiError(401, "bad_key", "鍵がちがうか、取り消されています");
    if (!key && String(env?.DATA_API_REQUIRE_KEY ?? "") === "1") {
      throw new ApiError(401, "key_required", "鍵が要ります（Authorization: Bearer <鍵>）");
    }

    // 回数（鍵を確かめたあと。鍵ごと・相手ごとに数えます）。
    const limits = limitsFor(env, key);
    if (deps.rate) {
      const who = key?.ok ? `datakey|${key.id}` : `data|${deps.ip ?? "unknown"}`;
      const gate = await deps.rate(who, limits);
      if (!gate.ok) {
        throw new ApiError(429, "rate_limited", "回数の上限です。少しおいてから呼んでください",
          { retryAfter: gate.retryAfter ?? 60 });
      }
    }

    const store = await openStore(env);
    if (!store) throw new ApiError(503, "no_data", "データがまだ入っていません（./tabisaki data build / push）");
    const m = store.manifest;
    const version = String(m.version ?? "0");
    const etag = `"${version}"`;
    const common = {
      "Cache-Control": "public, max-age=300",
      ETag: etag,
      "X-Data-Version": version,
      "X-RateLimit-Limit": `${limits.minute};w=60`,
    };
    if ((request.headers.get("If-None-Match") ?? "") === etag) return reply(304, null, common, method);

    const rest = url.pathname.slice(DATA_API_PREFIX.length).replace(/\/+$/, "");
    const head = { api: DATA_API_VERSION, schema: DATA_SCHEMA, version };

    if (rest === "") {
      return reply(200, {
        ...head,
        generatedAt: m.generatedAt,
        datasets: Object.fromEntries(Object.entries(m.datasets ?? {})
          .map(([k, d]) => [k, { count: d.count ?? 0, description: d.description ?? "" }])),
        terms: m.terms ?? null,
        excluded: m.excluded ?? [],
        endpoints: endpointsList(url.origin),
      }, common, method);
    }
    if (rest === "/attribution") {
      return reply(200, { ...head, sources: m.sources ?? {}, terms: m.terms ?? null }, common, method);
    }
    const one = /^\/spots\/([A-Za-z0-9:_.-]{1,80})$/.exec(rest);
    if (one) {
      if ([...url.searchParams.keys()].length) throw new ApiError(400, "unknown_param", "この道に項目はありません");
      const id = one[1];
      const index = await readPath(store, `spots-index/${await indexShardOf(id)}.json`);
      const tile = index?.[id];
      const it = tile ? (await itemsFromTiles(store, "spots", [tile])).find((x) => x.id === id) : null;
      if (!it || publicProblem(it)) throw new ApiError(404, "not_found", "そのスポットはありません");
      return reply(200, { ...head, dataset: "spots", item: it, license_summary: licenseSummaryFor([it], m.sources) }, common, method);
    }
    const ds = /^\/(spots|stations|stops)$/.exec(rest)?.[1];
    if (!ds) throw new ApiError(404, "not_found", "その道はありません");
    const q = parseQuery(url.searchParams, ds);
    let tiles;
    if (q.box) tiles = tilesForBox(q.box);
    else tiles = m.datasets?.spots?.prefTiles?.[q.pref] ?? [];
    const all = filterItems(await itemsFromTiles(store, ds, tiles), q).filter((it) => !publicProblem(it));
    const items = all.slice(q.offset, q.offset + q.limit);
    let next = null;
    if (q.offset + q.limit < all.length) {
      const nu = new URL(url); nu.searchParams.set("offset", String(q.offset + q.limit));
      next = nu.pathname + nu.search;
    }
    return reply(200, {
      ...head, dataset: ds, total: all.length, offset: q.offset, count: items.length, next,
      items, license_summary: licenseSummaryFor(items, m.sources),
    }, common, method);
  } catch (e) {
    if (e instanceof ApiError) return errorReply(e, method);
    return errorReply(new ApiError(500, "internal", "中で失敗しました"), method);
  }
}
