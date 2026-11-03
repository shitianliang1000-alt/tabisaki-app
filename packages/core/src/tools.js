// 道具の登録所（ツールレジストリ。Issue #437）。
//
// Research Agent（packages/core/src/research.js）が使う道具を、同じ入口・
// 同じ返り値の形で並べます。道具ごとに、
//
//   name        呼ぶときの名前（search_spots など）
//   description 何をする道具か（AI に見せる一行）
//   priority    使う順の目安。小さいほど先に試します
//   input       引数の JSON Schema（AI の出力をこの形にしばる。Guided Decoding）
//   output      返す data の JSON Schema（文書と試験のため）
//   available   いま使えるか（キーが無い・通信を切っている、なら false）
//   run         本体。async (args, ctx) → data
//
// を持ちます。呼ぶのは registry.call(name, args) だけで、どの道具でも
//
//   {ok: true,  tool, data, ms}
//   {ok: false, tool, error: {code, message}, ms}
//
// が返ります。投げません（Agent のループを1つの失敗で止めないため）。
//
// 優先順位の考えかた（docs/research-agent.md）:
//   1. 手元の収録（kb）で分かることは、手元で調べる（速い・ただ・確か）
//   2. 移動と天気は、選んだ取り口（providers.js）で調べる
//   3. それでも分からないときだけ、ネットで調べる（遅い・回数に限りがある）
//   4. 決められないことは、利用者に聞く（最後の手段）

import { getProvider, straightKm } from "./providers.js";
import { searchSpotsByKeyword } from "./kb.js";
import { orderByRoute } from "./crowd.js";
import { travelMinutes } from "./geo.js";
import { findPlace } from "./places.js";
import { KNOWN_JOURNEYS, NATIONAL_ROUTES, readJourney } from "./journeys.js";
import { onlySpots } from "./notaspot.js";
import { canWebSearch, webSearch } from "./ai.js";

/** 道具の種類と、既定の優先順位。 */
export const TOOL_PRIORITY = Object.freeze({
  search_spots: 10,
  search_special_journey: 20,
  search_historical_route: 25,
  calculate_route: 30,
  search_transit: 40,
  search_weather: 50,
  web_search: 80,
  ask_user: 100,
});

/** 道具の失敗の種類。 */
export const TOOL_ERRORS = Object.freeze([
  "unknown_tool", "invalid_args", "unavailable", "not_found", "failed",
]);

// ---------------------------------------------------------------------------
//  JSON Schema（使う分だけの小さな確かめ）
//
//  type / properties / required / additionalProperties:false / enum / const /
//  minimum / maximum / minLength / maxLength / items / minItems / maxItems
//  を見ます。外の部品は使いません（ブラウザでも Node.js でも動かすため）。
// ---------------------------------------------------------------------------

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array"
  : Number.isInteger(v) ? "integer" : typeof v);

/**
 * 値が schema に合うかを確かめます。
 * @returns {string[]} 合わないところ（空なら合っています）
 */
export function validate(schema, value, where = "引数") {
  const errs = [];
  if (!schema || typeof schema !== "object") return errs;
  if ("const" in schema && value !== schema.const) errs.push(`${where} は ${JSON.stringify(schema.const)} にしてください`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${where} は ${schema.enum.join(" / ")} のどれかにしてください`);
  if (schema.type) {
    const t = typeOf(value);
    const types = [].concat(schema.type);
    const ok = types.some((want) => want === t || (want === "number" && t === "integer"));
    if (!ok) {
      errs.push(`${where} の型が違います（${types.join("|")} のはずが ${t}）`);
      return errs;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${where} が短すぎます（${schema.minLength}字以上）`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${where} が長すぎます（${schema.maxLength}字まで）`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${where} は ${schema.minimum} 以上にしてください`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${where} は ${schema.maximum} 以下にしてください`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${where} は ${schema.minItems} 件以上にしてください`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${where} は ${schema.maxItems} 件までにしてください`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${where}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) {
      if (value[k] === undefined) errs.push(`${where}.${k} がありません`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(props[k], v, `${where}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${where}.${k} は使えない項目です`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
//  登録所
// ---------------------------------------------------------------------------

class ToolFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 道具の中から、決まった種類の失敗を返すときに使います。 */
export function toolError(code, message) {
  return new ToolFailure(code, message);
}

/**
 * 道具の登録所を作ります。
 * @param {object} [ctx] 道具に渡す共通のもの（kb, search, now など）
 */
export function createToolRegistry(ctx = {}) {
  const tools = new Map();
  const registry = {
    ctx,
    /** 道具を登録します。同じ名前なら置き換えます。 */
    register(tool) {
      const name = String(tool?.name ?? "");
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new TypeError(`道具の名前が使えません: ${name}`);
      if (typeof tool.run !== "function") throw new TypeError(`道具「${name}」に run がありません`);
      if (!tool.input || tool.input.type !== "object") throw new TypeError(`道具「${name}」の input は type:"object" の JSON Schema にしてください`);
      tools.set(name, { priority: TOOL_PRIORITY[name] ?? 60, description: "", output: {}, ...tool });
      return registry;
    },
    has: (name) => tools.has(name),
    get: (name) => tools.get(name) ?? null,
    /** 優先順位の順に並べた道具（available を見た結果つき）。 */
    list() {
      return [...tools.values()]
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, priority: t.priority,
          available: isAvailable(t, ctx), input: t.input, output: t.output }));
    },
    /** いま使える道具の名前（優先順位の順）。 */
    available() {
      return registry.list().filter((t) => t.available).map((t) => t.name);
    },
    /**
     * 道具を呼びます。投げません。
     * @returns {Promise<{ok: boolean, tool: string, data?: any, error?: {code: string, message: string}, ms: number}>}
     */
    async call(name, args = {}, extra = {}) {
      const t0 = Date.now();
      const done = (r) => ({ tool: name, ...r, ms: Date.now() - t0 });
      const tool = tools.get(name);
      if (!tool) return done({ ok: false, error: { code: "unknown_tool", message: `道具「${name}」はありません` } });
      const errs = validate(tool.input, args ?? {});
      if (errs.length) return done({ ok: false, error: { code: "invalid_args", message: errs.join("。") } });
      if (!isAvailable(tool, ctx)) return done({ ok: false, error: { code: "unavailable", message: `「${name}」はいま使えません` } });
      try {
        const data = await tool.run(args ?? {}, { ...ctx, ...extra });
        return done({ ok: true, data });
      } catch (e) {
        const code = e instanceof ToolFailure ? e.code : "failed";
        return done({ ok: false, error: { code, message: e?.message ?? String(e) } });
      }
    },
    /**
     * AI に「次の一手」を返させるときの JSON Schema（Guided Decoding 用）。
     * {"tool": 名前, "args": {...}} か {"final": true} のどちらかの形です。
     */
    actionSchema(names = registry.available()) {
      return {
        type: "object",
        oneOf: [
          ...names.map((n) => ({
            type: "object", additionalProperties: false, required: ["tool", "args"],
            properties: { thought: { type: "string", maxLength: 200 }, tool: { const: n }, args: tools.get(n).input },
          })),
          { type: "object", additionalProperties: false, required: ["final"],
            properties: { thought: { type: "string", maxLength: 200 }, final: { const: true } } },
        ],
      };
    },
  };
  return registry;
}

function isAvailable(tool, ctx) {
  if (typeof tool.available === "function") return Boolean(tool.available(ctx));
  return tool.available !== false;
}

// ---------------------------------------------------------------------------
//  道具の本体
// ---------------------------------------------------------------------------

const point = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 80 },
    lat: { type: "number", minimum: -90, maximum: 90 },
    lng: { type: "number", minimum: -180, maximum: 180 },
  },
};

/** スポットを、Agent と AI に渡す短い形にします。 */
export function spotBrief(spot, score) {
  const out = { id: spot.id, name: spot.name, prefecture: spot.prefecture ?? "",
    region: spot.region ?? "", category: spot.category ?? "", lat: spot.lat, lng: spot.lng };
  if (score != null) out.score = Math.round(score * 1000) / 1000;
  return out;
}

const resolvePoint = (p, kb) => {
  if (!p) return null;
  if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) return p;
  const name = String(p.name ?? "").trim();
  if (!name) return null;
  const place = findPlace(name);
  if (place) return place;
  const spot = kb?.spots?.find((s) => s.name === name);
  return spot ? { name: spot.name, lat: spot.lat, lng: spot.lng } : null;
};

/** kb の中を語で探します。 */
export const searchSpotsTool = {
  name: "search_spots",
  description: "収録（kb）のスポットを語で探す。地名・名所の名前・ジャンル（温泉・城…）が使える",
  input: {
    type: "object", additionalProperties: false, required: ["keywords"],
    properties: {
      keywords: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 40 } },
      prefecture: { type: "string", maxLength: 10 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  output: { type: "object", properties: { spots: { type: "array" }, total: { type: "integer" } } },
  available: (ctx) => Boolean(ctx.kb?.spots?.length),
  async run({ keywords, prefecture, limit = 10 }, { kb }) {
    let hits = searchSpotsByKeyword(kb, keywords, { limit: 400 });
    if (prefecture) hits = hits.filter((h) => (h.spot.prefecture ?? "").includes(prefecture));
    const real = new Set(onlySpots(hits.map((h) => h.spot)));
    hits = hits.filter((h) => real.has(h.spot));
    return { spots: hits.slice(0, limit).map((h) => spotBrief(h.spot, h.score)), total: hits.length };
  },
};

/** 天気（providers.js の weather。既定は Open-Meteo）。 */
export const searchWeatherTool = {
  name: "search_weather",
  description: "その場所・その日の天気予報（降水確率・気温）を調べる",
  input: {
    type: "object", additionalProperties: false, required: ["place", "date"],
    properties: { place: point, date: { type: "string", minLength: 10, maxLength: 10 } },
  },
  output: { type: "object", properties: { date: { type: "string" }, maxRain: { type: "number" }, minTemp: { type: "number" }, maxTemp: { type: "number" } } },
  available: () => getProvider("weather").available !== false,
  async run({ place, date }, { kb }) {
    const at = resolvePoint(place, kb);
    if (!at) throw toolError("not_found", `場所が分かりません: ${place?.name ?? ""}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw toolError("invalid_args", "date は YYYY-MM-DD で書いてください");
    const fc = await getProvider("weather").forecast(at, new Date(`${date}T09:00:00+09:00`));
    if (!fc?.ok) throw toolError("unavailable", fc?.reason ?? "天気が取れませんでした");
    const day = fc.rows.filter((r) => { const h = new Date(r.at).getHours(); return h >= 8 && h <= 18; });
    const rows = day.length ? day : fc.rows;
    return { date: fc.date, maxRain: Math.max(...rows.map((r) => r.rain)),
      minTemp: Math.min(...rows.map((r) => r.temp)), maxTemp: Math.max(...rows.map((r) => r.temp)) };
  },
};

/**
 * 乗り換え（providers.js の routing）。中継が GTFS を使う Transitous（OTP 系）や
 * 駅すぱあとなどへ聞きます。経路の検索を切っているときは、距離からの目安を返します。
 */
export const searchTransitTool = {
  name: "search_transit",
  description: "2地点の間の公共交通の経路と所要時間を調べる（引けないときは距離からの目安）",
  input: {
    type: "object", additionalProperties: false, required: ["from", "to"],
    properties: { from: point, to: point, departAt: { type: "string", maxLength: 30 } },
  },
  output: { type: "object", properties: { minutes: { type: "number" }, summary: { type: "string" }, estimated: { type: "boolean" }, provider: { type: "string" } } },
  async run({ from, to, departAt }, { kb }) {
    const a = resolvePoint(from, kb);
    const b = resolvePoint(to, kb);
    if (!a || !b) throw toolError("not_found", `場所が分かりません: ${!a ? from?.name : to?.name}`);
    const routing = getProvider("routing");
    if (routing.available !== false) {
      const r = await routing.search(a, b, departAt ? { departAt } : {}).catch(() => null);
      if (r?.routed) return { minutes: r.minutes, summary: r.summary ?? "", estimated: false, provider: r.provider ?? routing.name };
    }
    const minutes = Math.round(travelMinutes(a, b));
    return { minutes, summary: `約${minutes}分（距離からの目安）`, estimated: true, provider: "estimate" };
  },
};

/** 回る順（最近傍＋2-opt。crowd.js の orderByRoute と同じ解きかた）。 */
export const calculateRouteTool = {
  name: "calculate_route",
  description: "スポットを回る順番を、移動がいちばん短くなるように並べる（巡回セールスマン問題の近似）",
  input: {
    type: "object", additionalProperties: false, required: ["spotIds"],
    properties: {
      spotIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 80 } },
      start: point,
    },
  },
  output: { type: "object", properties: { order: { type: "array" }, totalMinutes: { type: "number" }, totalKm: { type: "number" } } },
  available: (ctx) => Boolean(ctx.kb?.spots?.length),
  async run({ spotIds, start }, { kb }) {
    const byId = new Map(kb.spots.map((s) => [s.id, s]));
    const missing = spotIds.filter((id) => !byId.has(id));
    if (missing.length) throw toolError("not_found", `収録に無いスポットです: ${missing.join(", ")}`);
    const origin = start ? resolvePoint(start, kb) : null;
    const ordered = orderByRoute(spotIds.map((id) => byId.get(id)), origin, travelMinutes, { useCrowd: false });
    let totalMinutes = 0;
    let totalKm = 0;
    let prev = origin;
    for (const s of ordered) {
      if (prev) { totalMinutes += travelMinutes(prev, s); totalKm += straightKm(prev, s); }
      prev = s;
    }
    return { order: ordered.map((s) => spotBrief(s)), totalMinutes: Math.round(totalMinutes), totalKm: Math.round(totalKm * 10) / 10 };
  },
};

/** 名のある旅（最長片道切符・日本一周・国道1号線…）。journeys.js に持っています。 */
export const searchSpecialJourneyTool = {
  name: "search_special_journey",
  description: "「最長片道切符」「日本一周」「国道1号線」のような、名のある旅のしかたを調べる",
  input: {
    type: "object", additionalProperties: false, required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 200 } },
  },
  output: { type: "object", properties: { found: { type: "boolean" }, journey: { type: "object" } } },
  async run({ text }) {
    const j = readJourney(text);
    return j ? { found: true, journey: { name: j.name, meaning: j.meaning ?? "", along: j.along ?? [], transport: j.transport ?? null } }
      : { found: false, known: KNOWN_JOURNEYS.map((k) => k.name) };
  },
};

// 旧街道（歴史の道）。いまは journeys.js に持つものだけ答えます。
// ほかの街道（日光街道・甲州街道・熊野古道…）は、ここに足していく受け口です。
const HISTORICAL = new Set(["東海道五十三次", "中山道"]);

export const searchHistoricalRouteTool = {
  name: "search_historical_route",
  description: "旧街道・古道（東海道五十三次・中山道など）の沿う宿場町を調べる",
  input: {
    type: "object", additionalProperties: false, required: ["name"],
    properties: { name: { type: "string", minLength: 1, maxLength: 40 } },
  },
  output: { type: "object", properties: { found: { type: "boolean" }, along: { type: "array" } } },
  async run({ name }) {
    const j = KNOWN_JOURNEYS.find((k) => HISTORICAL.has(k.name) && (k.re.test(name) || k.name === name));
    if (j) return { found: true, name: j.name, meaning: j.meaning, along: j.along };
    const route = /(?:国道|R)\s*(\d{1,3})/.exec(name);
    if (route && NATIONAL_ROUTES[route[1]]) {
      const r = NATIONAL_ROUTES[route[1]];
      return { found: true, name: `国道${route[1]}号`, meaning: `${r.from}から${r.to}まで`, along: r.along };
    }
    return { found: false, known: [...HISTORICAL] };
  },
};

/**
 * ネットの検索。何で検索するかは ctx.search（async (q) → [{title,url,snippet}]）で
 * 差し替えます。Web 版は中継の /web/search（ai.js の webSearch）、#438 の
 * Brave LLM Context API とキャッシュもここへ差し込みます。無ければ使えません。
 */
export const webSearchTool = {
  name: "web_search",
  description: "ネットで調べる（収録に無い場所・催し・新しい情報）。回数に限りがあるので最後に使う",
  input: {
    type: "object", additionalProperties: false, required: ["query"],
    properties: { query: { type: "string", minLength: 2, maxLength: 80 } },
  },
  output: { type: "object", properties: { results: { type: "array" } } },
  available: (ctx) => typeof ctx.search === "function",
  async run({ query }, { search }) {
    const raw = await search(query);
    const results = (raw ?? [])
      .filter((r) => /^https:\/\//i.test(String(r?.url ?? "")))
      .slice(0, 5)
      .map((r) => ({ title: String(r.title ?? "").slice(0, 120), url: r.url, snippet: String(r.snippet ?? "").slice(0, 300) }));
    return { results };
  },
};

/** 利用者に聞く。答えは待たず、聞きたいことを返します（Agent はそこで止まります）。 */
export const askUserTool = {
  name: "ask_user",
  description: "決められないことを利用者に聞く（最後の手段）",
  input: {
    type: "object", additionalProperties: false, required: ["question"],
    properties: {
      question: { type: "string", minLength: 2, maxLength: 200 },
      choices: { type: "array", maxItems: 4, items: { type: "string", maxLength: 40 } },
    },
  },
  output: { type: "object", properties: { question: { type: "string" }, choices: { type: "array" } } },
  async run({ question, choices = [] }) {
    return { question, choices };
  },
};

export const BUILTIN_TOOLS = Object.freeze([
  searchSpotsTool, searchSpecialJourneyTool, searchHistoricalRouteTool, calculateRouteTool,
  searchTransitTool, searchWeatherTool, webSearchTool, askUserTool,
]);

/** 決まりの道具をすべて登録した登録所。 */
export function createDefaultTools(ctx = {}) {
  const reg = createToolRegistry(ctx);
  for (const t of BUILTIN_TOOLS) reg.register(t);
  return reg;
}

// ---------------------------------------------------------------------------
//  web_search の検索先
//
//  検索先は async (query) → [{title, url, snippet}] の関数です。
//  Brave LLM Context API（#438）などに替えるときも、この形の関数を作って
//  createDefaultTools({search}) に渡すだけです。控え（キャッシュ）は
//  cachedSearch で包みます。控えの置き場は get/set を持つもの（Map でも、
//  Redis の薄い包みでも）なら何でも使えます。
// ---------------------------------------------------------------------------

/** Web 版の中継（/web/search。Wikipedia か Tavily）で調べる検索先。使えなければ null。 */
export function relaySearch() {
  return canWebSearch() ? (q) => webSearch(q) : null;
}

/**
 * 検索先を控えで包みます。同じ語は ttlMs のあいだ聞き直しません。
 * @param {(q: string) => Promise<object[]>} search
 * @param {{ttlMs?: number, store?: {get: Function, set: Function}, now?: () => number}} [opts]
 */
export function cachedSearch(search, { ttlMs = 24 * 3600 * 1000, store = new Map(), now = () => Date.now() } = {}) {
  const stats = { hits: 0, misses: 0 };
  const fn = async (q) => {
    const key = String(q ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const hit = await store.get(key);
    if (hit && now() - hit.at < ttlMs) {
      stats.hits++;
      return hit.results;
    }
    stats.misses++;
    const results = await search(q);
    await store.set(key, { at: now(), results });
    return results;
  };
  fn.stats = stats;
  return fn;
}
