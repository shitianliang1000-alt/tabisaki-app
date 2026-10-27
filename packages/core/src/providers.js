// 外のデータの取り口（プロバイダー）を、差し替えられるようにする。
//
// 旅さきは、経路・天気・地名・スポットを外から（または手元の収録から）
// もらっています。どこからもらうかを旅程を組む本体（pipeline.js・
// routes.js）が直接知っていると、取り口が止まったり規約が変わったり
// したとき（Yahoo!路線情報、#367）に、本体ごと書き直すことになります。
//
// そこで、取り口ごとに「何を渡すと、どんな形で返るか」を決めておき、
// 本体はその形だけを使います。取り口を替えるときは、同じ形を返す
// アダプタを1つ書いて登録し、useProvider() で選ぶだけです。
//
//   routing   … 2地点の公共交通の経路（いまは Yahoo!路線情報を中継経由で）
//   weather   … その場所・その日の時間ごとの予報（いまは Open-Meteo）
//   geocoding … 地名・駅名から位置（いまは手元の収録。国土地理院も用意）
//   spots     … 観光地の知識ベース（いまは kb/ の JSON）
//
// どの取り口にも、キー無しで動く mock と、通信しない off があります。
// テストや packages/core（端末から使うとき）は、これで外へ出ずに動きます。
//
// 取り口の失敗は、どれも ProviderError（code で見分ける）にそろえます。
// 呼ぶ側は「待てば通るのか（retryable）」「何秒待つのか（retryAfter）」
// だけを見ればよく、相手ごとのエラーの形を知る必要はありません。
//
// 切り替えかたは docs/data-providers.md に書いてあります。

import { findPlace, nearestPlaceInfo } from "./places.js";
import { forecastFor } from "./weather.js";
import { resetYahooCooldown, resetYahooPace, searchYahooTransit, yahooCooldown }
  from "./yahoo-transit.js";
import { requestSignal } from "./endpoints.js";

/** 取り口の種類。 */
export const PROVIDER_KINDS = Object.freeze(["routing", "weather", "geocoding", "spots"]);

/**
 * 取り口の失敗の種類。
 *
 *   not_configured … 使えるように設定されていない（キー・中継が無い、off を選んでいる）
 *   rate_limited   … 回数が多いと断られた。待てば通ります
 *   timeout        … 返事が来なかった
 *   network        … 届かなかった（圏外など）
 *   upstream       … 相手の不調（5xx）。待てば通るかもしれません
 *   rejected       … 頼みかたが通らない（400・403 など）。待っても同じです
 *   bad_response   … 返ってきたが、読めなかった
 */
export const ERROR_CODES = Object.freeze([
  "not_configured", "rate_limited", "timeout", "network",
  "upstream", "rejected", "bad_response",
]);

const RETRYABLE = new Set(["rate_limited", "timeout", "network", "upstream"]);

/** 取り口の失敗。code で見分けます。message は利用者に見せる日本語です。 */
export class ProviderError extends Error {
  /**
   * @param {string} code ERROR_CODES のどれか
   * @param {string} message
   * @param {{provider?:string, status?:number, retryable?:boolean,
   *          retryAfter?:number|null, upstreamCode?:string, cause?:unknown}} [info]
   */
  constructor(code, message, info = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "ProviderError";
    this.code = ERROR_CODES.includes(code) ? code : "bad_response";
    this.provider = info.provider ?? "";
    this.status = Number(info.status) || 0;
    this.retryable = info.retryable ?? RETRYABLE.has(this.code);
    this.retryAfter = Number(info.retryAfter) > 0 ? Number(info.retryAfter) : null;
    // 相手が付けてきた見分けの印（中継の "RATE_LIMITED" など）。診断用です。
    if (info.upstreamCode) this.upstreamCode = String(info.upstreamCode);
  }
}

/** HTTP の番号から、失敗の種類を決めます。 */
export function codeForStatus(status) {
  const s = Number(status) || 0;
  if (s === 429) return "rate_limited";
  if (s === 408 || s === 504) return "timeout";
  if (s >= 500) return "upstream";
  if (s === 401) return "not_configured";
  if (s >= 400) return "rejected";
  return "bad_response";
}

/**
 * どんな失敗でも ProviderError にそろえます。
 * 呼ぶ側の中止（AbortError）だけは、そのまま返します。止めたのは自分です。
 */
export function toProviderError(e, provider = "") {
  if (e instanceof ProviderError) {
    if (!e.provider) e.provider = provider;
    return e;
  }
  if (e?.name === "AbortError") return e;
  const message = String(e?.message ?? e ?? "取得できませんでした");
  if (e?.name === "TimeoutError") {
    return new ProviderError("timeout", message, { provider, cause: e });
  }
  const status = Number(e?.status) || 0;
  if (!status) {
    // 番号が無いのは、返事そのものが無かったときです（fetch の TypeError）。
    return new ProviderError(e instanceof SyntaxError ? "bad_response" : "network",
      message, { provider, cause: e });
  }
  const code = codeForStatus(status);
  return new ProviderError(code, message, {
    provider, status,
    retryable: typeof e?.retryable === "boolean" ? e.retryable || RETRYABLE.has(code)
      : undefined,
    retryAfter: e?.retryAfter, upstreamCode: e?.code, cause: e,
  });
}

// ---------------------------------------------------------------------------
//  経路（routing）
//
//  search(from, to, opts) → RouteResult | null
//
//    from / to  {name, lat?, lng?}（名前だけでも可）
//    opts       {departAt?: Date|string, modes?, prefer?, search?: "last",
//                byName?, signal?, timeoutMs?, retryWaits?, pace?, force?}
//
//  RouteResult は旅さきの中の形です（Yahoo!の HTML ではありません）。
//    routed       経路が引けたか
//    minutes      頼んだ時刻から着くまでの分（便を待つ時間を含む）
//    rideMinutes? 乗っている分   waitMinutes? 便を待つ分
//    summary      「10:08 発→ 11:30 着 1時間22分」のような一行
//    meta?        {legs:[{line, from, to, ...}], alternatives:[...], fare?, transfers?}
//    kinds?       乗り物の種類（"train" "bus" "plane" "ferry" ...）
//    preferMet?   頼んだ種類で引けたか
//    byLocation?  位置で引いたか
//    searchedAt   調べた出発時刻（ISO）
//    provider     どの取り口の答えか
//
//  cooldown() → {waiting, seconds, reason, retryable}
//    いま聞いてよいか。断られた直後は waiting になります。
//  resetCooldown() / resetPace()
//    旅程を組み直すとき・テストのときに、数えたものを捨てます。
//  available
//    false なら、本体は聞きに行かず、距離からの目安で組みます。
// ---------------------------------------------------------------------------

const idle = () => ({ waiting: false, seconds: 0, reason: "", retryable: false });

/** Yahoo!路線情報（自前の中継 server/worker.js 経由）。 */
export const yahooRouting = {
  kind: "routing",
  name: "yahoo",
  label: "Yahoo!路線情報（中継経由）",
  available: true,
  async search(from, to, opts = {}) {
    let doc;
    try {
      doc = await searchYahooTransit(from, to, opts);
    } catch (e) {
      throw toProviderError(e, "yahoo");
    }
    return doc ? { ...doc, provider: "yahoo" } : null;
  },
  cooldown: (now) => yahooCooldown(now),
  resetCooldown: () => resetYahooCooldown(),
  resetPace: () => resetYahooPace(),
};

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
/** 2点の直線距離（km）。 */
export function straightKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * キー無しで動く経路。直線距離から、電車の目安（平均時速40km・待ち5分）を返します。
 * テストと、APIキーの無い手元での動作確認のためのものです。時刻表ではありません。
 */
export function createMockRouting({ kmPerHour = 40, waitMinutes = 5, name = "mock" } = {}) {
  const asked = [];
  return {
    kind: "routing",
    name,
    label: "目安（キー不要・時刻表ではありません）",
    available: true,
    asked,
    async search(from, to, opts = {}) {
      asked.push({ from, to, opts });
      const a = from && Number.isFinite(from.lat) ? from : findPlace(from?.name ?? from);
      const b = to && Number.isFinite(to.lat) ? to : findPlace(to?.name ?? to);
      const departAt = opts.departAt ? new Date(opts.departAt) : new Date();
      if (!a || !b) {
        return { routed: false, reason: "位置が分かりません", provider: name,
          searchedAt: departAt.toISOString() };
      }
      const km = straightKm(a, b) * 1.3;
      const ride = Math.max(1, Math.round((km / kmPerHour) * 60));
      const minutes = ride + waitMinutes;
      const dep = new Date(departAt.getTime() + waitMinutes * 60000);
      const arr = new Date(departAt.getTime() + minutes * 60000);
      return {
        routed: true, minutes, rideMinutes: ride, waitMinutes,
        summary: `${hm(dep)} 発→ ${hm(arr)} 着（目安）`,
        meta: { legs: [{ line: "目安", from: a.name ?? "", to: b.name ?? "" }],
          alternatives: [] },
        kinds: ["train"], preferMet: true,
        byLocation: Number.isFinite(from?.lat) && Number.isFinite(to?.lat),
        searchedAt: departAt.toISOString(), provider: name,
      };
    },
    cooldown: idle,
    resetCooldown() {},
    resetPace() {},
  };
}

/** 通信しない経路。本体は聞きに行かず、距離からの目安で組みます。 */
export const offRouting = {
  kind: "routing",
  name: "off",
  label: "使わない（距離からの目安だけ）",
  available: false,
  async search() {
    throw new ProviderError("not_configured", "経路の検索を使わない設定です。",
      { provider: "off", retryable: false });
  },
  cooldown: idle,
  resetCooldown() {},
  resetPace() {},
};

// ---------------------------------------------------------------------------
//  天気（weather）
//
//  forecast(at, date, opts) → Forecast
//    at {lat, lng}   date Date   opts {signal?, now?, storage?, fetchImpl?}
//
//  Forecast は失敗でも投げません（天気は旅程の本体ではないため）。
//    {ok: true, date: "YYYY-MM-DD", rows: [{iso, at: Date, rain(%), temp(℃), code}]}
//    {ok: false, reason: "利用者に見せる一行"}
// ---------------------------------------------------------------------------

/** Open-Meteo（キー不要）。予報の範囲・3時間の控えは weather.js が受け持ちます。 */
export const openMeteoWeather = {
  kind: "weather",
  name: "open-meteo",
  label: "Open-Meteo",
  available: true,
  forecast: (at, date, opts) => forecastFor(at, date, opts),
};

/** キー無しで動く天気。一日中くもり・降水確率20%・18℃。 */
export function createMockWeather({ rain = 20, temp = 18, code = 3, name = "mock" } = {}) {
  return {
    kind: "weather",
    name,
    label: "目安（キー不要）",
    available: true,
    async forecast(at, date) {
      const d = new Date(date);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-`
        + String(d.getDate()).padStart(2, "0");
      const rows = Array.from({ length: 24 }, (_, h) => {
        const t = new Date(d);
        t.setHours(h, 0, 0, 0);
        return { iso: `${day}T${String(h).padStart(2, "0")}:00`, at: t, rain, temp, code };
      });
      return { ok: true, date: day, rows };
    },
  };
}

/** 天気を取りに行かない。 */
export const offWeather = {
  kind: "weather",
  name: "off",
  label: "使わない",
  available: false,
  async forecast() {
    return { ok: false, reason: "天気は取得しない設定です。" };
  },
};

// ---------------------------------------------------------------------------
//  地名（geocoding）
//
//  lookup(query, opts) → Place[]（近いものから。見つからなければ []）
//  reverse(lat, lng, opts) → {place: Place, km} | null
//
//  Place は {name, lat, lng, source}。
// ---------------------------------------------------------------------------

/** 手元の収録（js/places.js の駅・空港）。通信しません。 */
export const localGeocoding = {
  kind: "geocoding",
  name: "local",
  label: "手元の収録（駅・空港）",
  available: true,
  async lookup(query) {
    const p = findPlace(query);
    return p ? [{ name: p.name, lat: p.lat, lng: p.lng, source: "local" }] : [];
  },
  async reverse(lat, lng, opts = {}) {
    const hit = nearestPlaceInfo(lat, lng, opts.maxKm);
    return hit ? { place: { name: hit.place.name, lat: hit.place.lat,
      lng: hit.place.lng, source: "local" }, km: hit.km } : null;
  },
};

const GSI_SEARCH = "https://msearch.gsi.go.jp/address-search/AddressSearch";

/**
 * 国土地理院の地名検索（キー不要）。Yahoo!のジオコーダーから移るときの候補です（#367）。
 * 画面からはまだ使っていません（使うときは index.html の CSP の connect-src に足します）。
 */
export function createGsiGeocoding({ fetchImpl, timeoutMs = 15_000 } = {}) {
  return {
    kind: "geocoding",
    name: "gsi",
    label: "国土地理院 地名検索",
    available: true,
    async lookup(query, opts = {}) {
      const q = String(query ?? "").trim();
      if (!q) return [];
      const send = opts.fetchImpl ?? fetchImpl ?? globalThis.fetch;
      let res;
      try {
        res = await send(`${GSI_SEARCH}?q=${encodeURIComponent(q)}`,
          { signal: requestSignal(opts.signal, timeoutMs) });
      } catch (e) {
        throw toProviderError(e, "gsi");
      }
      if (!res?.ok) {
        throw new ProviderError(codeForStatus(res?.status),
          `地名を検索できませんでした（${res?.status}）。`,
          { provider: "gsi", status: res?.status });
      }
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new ProviderError("bad_response", "地名検索の応答を読めませんでした。",
          { provider: "gsi", cause: e });
      }
      return normalizeGsi(data);
    },
    async reverse() {
      // 地理院の逆引きは住所（市区町村）までなので、駅を返す収録に任せます。
      return null;
    },
  };
}

/** 国土地理院の応答（GeoJSON の Feature の並び）を Place[] にします。 */
export function normalizeGsi(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const f of data) {
    const [lng, lat] = f?.geometry?.coordinates ?? [];
    const name = String(f?.properties?.title ?? "").trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({ name, lat, lng, source: "gsi" });
  }
  return out;
}

// ---------------------------------------------------------------------------
//  スポット（spots）
//
//  load(opts) → KnowledgeBase（kb.js の loadKnowledgeBase と同じ形）
//    opts {onProgress?, signal?}
// ---------------------------------------------------------------------------

/** 手元の知識ベース（kb/）。 */
export const kbSpots = {
  kind: "spots",
  name: "kb",
  label: "知識ベース（kb/）",
  available: true,
  async load(opts = {}) {
    const { loadKnowledgeBase } = await import("./kb.js");
    return loadKnowledgeBase(opts.onProgress, opts.signal);
  },
};

/** 決まった中身を返す知識ベース。テスト用です。 */
export function createMockSpots(kb = { regions: [], spots: [] }, name = "mock") {
  return { kind: "spots", name, label: "決まった中身（テスト用）", available: true,
    async load() { return kb; } };
}

// ---------------------------------------------------------------------------
//  登録と切り替え
// ---------------------------------------------------------------------------

const REQUIRED = {
  routing: ["search", "cooldown", "resetCooldown", "resetPace"],
  weather: ["forecast"],
  geocoding: ["lookup", "reverse"],
  spots: ["load"],
};

const DEFAULTS = { routing: "yahoo", weather: "open-meteo", geocoding: "local", spots: "kb" };

const registry = new Map(PROVIDER_KINDS.map((k) => [k, new Map()]));
const active = { ...DEFAULTS };

function check(kind) {
  if (!registry.has(kind)) {
    throw new TypeError(`取り口の種類が違います: ${kind}（${PROVIDER_KINDS.join(" / ")}）`);
  }
}

/**
 * 取り口を登録します。同じ名前なら置き換えます。
 * @param {object} adapter {kind, name, ...種類ごとの関数}
 */
export function registerProvider(adapter) {
  check(adapter?.kind);
  const name = String(adapter.name ?? "").trim();
  if (!name) throw new TypeError("取り口には name が要ります");
  const missing = REQUIRED[adapter.kind].filter((f) => typeof adapter[f] !== "function");
  if (missing.length) {
    throw new TypeError(`${adapter.kind} の取り口「${name}」に ${missing.join("・")} がありません`);
  }
  registry.get(adapter.kind).set(name, adapter);
  return adapter;
}

/** その種類で使う取り口を選びます。登録の無い名前は断ります。 */
export function useProvider(kind, name) {
  check(kind);
  if (!registry.get(kind).has(name)) {
    throw new TypeError(`${kind} の取り口「${name}」は登録されていません`
      + `（${[...registry.get(kind).keys()].join(" / ")}）`);
  }
  active[kind] = name;
  return registry.get(kind).get(name);
}

/** まとめて選びます。{routing: "mock", weather: "off"} のように渡します。 */
export function useProviders(choice = {}) {
  for (const [kind, name] of Object.entries(choice)) {
    if (name) useProvider(kind, name);
  }
}

/** いま使っている取り口。 */
export function getProvider(kind) {
  check(kind);
  return registry.get(kind).get(active[kind]);
}

/** 登録されている取り口の一覧（診断・文書用）。 */
export function listProviders() {
  return Object.fromEntries(PROVIDER_KINDS.map((k) => [k, {
    active: active[k],
    names: [...registry.get(k).keys()],
  }]));
}

/** 既定の取り口に戻します（テストの後始末用）。 */
export function resetProviders() {
  Object.assign(active, DEFAULTS);
}

for (const a of [
  yahooRouting, createMockRouting(), offRouting,
  openMeteoWeather, createMockWeather(), offWeather,
  localGeocoding, createGsiGeocoding(),
  kbSpots, createMockSpots(),
]) registerProvider(a);
