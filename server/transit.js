// 乗り換え検索の API を、1つの形にそろえて呼びます。
//
// 中継の POST /transit が入口です。本文の provider で使う API を選びます。
// 無ければ "auto" で、キーが入っているものを TRANSIT_ORDER の順に試します。
//
//   ekispert   駅すぱあと API（Val研究所）     EKISPERT_API_KEY
//   navitime   NAVITIME Route(totalnavi)       NAVITIME_RAPIDAPI_KEY（RapidAPI 経由）
//   here       HERE Public Transit API v8       HERE_API_KEY
//   transitous Transitous（MOTIS・GTFS）       キー不要・非商用だけ
//   yahoo      Yahoo!路線情報（ページを読む）  キー不要。YAHOO_TRANSIT=off で止まる
//
// どの API の答えも、これまでの /yahoo/transit と同じ形で返します
// （routed・minutes・rideMinutes・waitMinutes・summary・kinds・preferMet・
// meta.legs …）。画面の側は、どれが答えたかを provider で知るだけです。
//
// Google の Routes API は、日本の電車・バスを返しません（日本の提供元が
// 除かれています）。海外の区間は今までどおり /routes で引きます。
//
// 文書: docs/transit-apis.md

const TIMEOUT_MS = 20_000;
const UA = "Tabisaki/1.0 (+https://github.com/shitianliang1000-alt/tabisaki-app)";

export const PROVIDERS = ["ekispert", "navitime", "here", "yahoo", "transitous"];
export const DEFAULT_ORDER = PROVIDERS;

export const LABELS = {
  ekispert: "駅すぱあと",
  navitime: "NAVITIME",
  here: "HERE",
  transitous: "Transitous",
  yahoo: "Yahoo!路線情報",
};

/** API が答えられなかったわけ。auto はこれを見て次へ進みます。 */
export class TransitError extends Error {
  constructor(code, message, { status = 502, retryable = false } = {}) {
    super(message);
    this.code = code;          // not_configured / unsupported / rate_limited / upstream / bad_response / timeout
    this.status = status;
    this.retryable = retryable;
  }
}

const has = (env, name) => typeof env?.[name] === "string" && env[name].trim().length > 0;
const off = (env, name) => String(env?.[name] ?? "").trim().toLowerCase() === "off";

/** その API が、いまの設定で使えるか。 */
export function available(name, env) {
  switch (name) {
    case "ekispert": return has(env, "EKISPERT_API_KEY");
    case "navitime": return has(env, "NAVITIME_RAPIDAPI_KEY");
    case "here": return has(env, "HERE_API_KEY");
    case "transitous": return !off(env, "TRANSITOUS");
    case "yahoo": return !off(env, "YAHOO_TRANSIT");
    default: return false;
  }
}

/** auto で試す順番。TRANSIT_ORDER（カンマ区切り）で変えられます。 */
export function orderFrom(env) {
  const raw = String(env?.TRANSIT_ORDER ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase());
  const asked = raw.filter((s) => PROVIDERS.includes(s));
  return [...new Set(asked.length ? asked : DEFAULT_ORDER)];
}

/** 画面と管理画面に見せる一覧（キーの値は出しません）。 */
export function providerStatus(env) {
  const order = orderFrom(env);
  return {
    order,
    providers: PROVIDERS.map((name) => ({
      name, label: LABELS[name], available: available(name, env),
      inAuto: order.includes(name),
      lastTrain: SUPPORTS_LAST.has(name),
    })),
  };
}

// 終電（search: "last"）を答えられるもの。ほかは auto で飛ばします。
const SUPPORTS_LAST = new Set(["ekispert", "yahoo"]);

// ── 問い合わせの読み取り ───────────────────────────────

/** 日本の範囲の位置だけを受け付けます。 */
export function pointOf(v) {
  const lat = Number(v?.lat);
  const lng = Number(v?.lng);
  if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) return null;
  return { lat, lng };
}

/**
 * 本文を決まった形にします。おかしければ TransitError(400)。
 * 形は /yahoo/transit と同じです（from・to・fromAt・toAt・departAt・
 * search・modes・prefer）。
 */
export function readQuery(body) {
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  if (!from || !to || from.length > 100 || to.length > 100) {
    throw new TransitError("bad_request", "出発地と到着地が必要です", { status: 400 });
  }
  const at = body?.departAt ? new Date(body.departAt) : new Date();
  if (Number.isNaN(at.getTime())) throw new TransitError("bad_request", "出発時刻が不正です", { status: 400 });
  const flags = { al: 1, shin: 1, ex: 1, hb: 1, lb: 1, sr: 1 };
  if (body?.modes && typeof body.modes === "object") {
    for (const k of Object.keys(flags)) {
      const v = body.modes[k];
      if (v === 0 || v === "0" || v === false) flags[k] = 0;
    }
  }
  return {
    from, to, at,
    fromAt: pointOf(body?.fromAt),
    toAt: pointOf(body?.toAt),
    search: body?.search === "last" ? "last" : "depart",
    modes: flags,
    prefer: Array.isArray(body?.prefer) ? body.prefer.map(String).slice(0, 4) : [],
  };
}

// ── 時刻 ────────────────────────────────────────

/** 東京の時刻の部品。 */
export function tokyo(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = g("hour") === "24" ? "00" : g("hour");
  return { y: g("year"), m: g("month"), d: g("day"), hh: hour, mm: g("minute"), ss: g("second") };
}

/** ISO の日時（どの時差でも）を、東京の「HH:MM」に。 */
export function clockOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const t = tokyo(d);
  return `${t.hh}:${t.mm}`;
}

const minutesOfClock = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const clockDiff = (a, b) => (minutesOfClock(b) - minutesOfClock(a) + 1440) % 1440;

// ── 乗り物の見分け ─────────────────────────────────

/**
 * 路線名に乗り物の呼び名を添えます。画面（js/modes.js の classifyLine）と
 * 中継（routeKinds）は名前の文字で乗り物を見分けるので、種別しか返さない
 * API でも見分けられるように「（新幹線）」のように付けます。
 */
export function labelLine(name, kind) {
  const n = String(name ?? "").trim();
  const tag = {
    walk: "徒歩", air: "航空", ferry: "フェリー", shinkansen: "新幹線",
    coach: "高速バス", bus: "バス", ropeway: "ロープウェイ", cable: "ケーブルカー",
    monorail: "モノレール", tram: "路面電車",
  }[kind];
  if (kind === "walk") return "徒歩";
  if (!tag) return n || "電車";
  if (!n) return tag;
  return n.includes(tag) ? n : `${n}（${tag}）`;
}

/** 乗り物が、指定で外された種類か（modes の旗）。 */
function excluded(kind, modes) {
  if (!modes) return false;
  return (kind === "air" && !modes.al)
    || (kind === "shinkansen" && !modes.shin)
    || (kind === "express" && !modes.ex)
    || (kind === "coach" && !modes.hb)
    || (kind === "bus" && !modes.lb)
    || (kind === "ferry" && !modes.sr);
}

/** 経路に含まれる、指定できる乗り物（routeKinds と同じ考え）。 */
export function kindsOf(route) {
  const out = [];
  for (const leg of route?.legs ?? []) {
    const k = leg?.vehicle;
    if ((k === "air" || k === "ferry") && !out.includes(k)) out.push(k);
  }
  return out;
}

// ── 候補から1本を選ぶ ──────────────────────────────

/**
 * 候補（どの API でも同じ形）から1本を選んで、返す形にします。
 * 選びかたは /yahoo/transit と同じです。
 *
 *   depart … 待ちを含めて、いちばん早く着くもの。乗り物の指定
 *            （prefer: air・ferry）に合うものがあれば、その中から。
 *   last   … いちばん遅く出られるもの（終電）。
 */
export function choose(routes, q, extra = {}) {
  const asked = Number(tokyo(q.at).hh) * 60 + Number(tokyo(q.at).mm);
  const list = [];
  for (const r of routes) {
    if (!r?.departure || !r?.arrival) continue;
    if ((r.legs ?? []).some((l) => excluded(l.vehicle, q.modes))) continue;
    const ride = r.departure !== r.arrival ? clockDiff(r.departure, r.arrival) : (r.rideMinutes ?? 0);
    if (!(ride > 0)) continue;
    const wait = q.search === "last" ? 0 : (minutesOfClock(r.departure) - asked + 1440) % 1440;
    list.push({ ...r, rideMinutes: ride, waitMinutes: wait, minutes: wait + ride });
  }
  if (!list.length) return { routed: false, reason: extra.reason ?? "経路が見つかりませんでした", ...extra };

  let best;
  let preferMet = true;
  if (q.search === "last") {
    const late = (hm) => { const m = minutesOfClock(hm); return m < 240 ? m + 1440 : m; };
    best = list.reduce((a, b) => (late(a.departure) >= late(b.departure) ? a : b));
  } else {
    const fits = q.prefer.length ? list.filter((r) => kindsOf(r).some((k) => q.prefer.includes(k))) : [];
    preferMet = q.prefer.length ? fits.length > 0 : true;
    const pool = fits.length ? fits : list;
    best = pool.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  }
  const strip = (legs) => (legs ?? []).map(({ vehicle, ...l }) => l);
  return {
    routed: true,
    search: q.search,
    byLocation: Boolean(q.fromAt || q.toAt),
    minutes: q.search === "last" ? best.rideMinutes : best.minutes,
    rideMinutes: best.rideMinutes,
    waitMinutes: best.waitMinutes,
    summary: best.summary,
    kinds: kindsOf(best),
    preferMet,
    ...extra,
    meta: {
      ...(extra.url ? { url: extra.url } : {}),
      departure: best.departure,
      arrival: best.arrival,
      requestedDeparture: q.at.toISOString(),
      transfers: best.transfers ?? 0,
      fareYen: best.fareYen ?? null,
      distanceKm: best.distanceKm ?? null,
      legs: strip(best.legs),
      intermediateStops: best.intermediateStops ?? [],
      alternatives: list.filter((r) => r !== best).map((r) => ({
        departure: r.departure, arrival: r.arrival, minutes: r.minutes,
        rideMinutes: r.rideMinutes, transfers: r.transfers ?? 0,
        fareYen: r.fareYen ?? null, distanceKm: r.distanceKm ?? null, summary: r.summary,
      })),
    },
  };
}

/** 区間の並びから、候補1本の形を作ります（API ごとの読み替えの最後）。 */
export function routeFrom(legs, extra = {}) {
  const rides = legs.filter((l) => l.vehicle !== "walk");
  const departure = legs[0]?.departure ?? null;
  const arrival = legs.at(-1)?.arrival ?? null;
  const transfers = extra.transfers ?? Math.max(0, rides.length - 1);
  const fare = extra.fareYen ? ` / ${extra.fareYen.toLocaleString("ja-JP")}円` : "";
  const summary = departure && arrival
    ? `${departure}発→${arrival}着 / 乗換${transfers}回${fare}` : "";
  return {
    departure, arrival, summary, transfers,
    fareYen: extra.fareYen ?? null,
    distanceKm: extra.distanceKm ?? null,
    legs: legs.map((l) => ({
      kind: l.vehicle === "walk" ? "walk" : "ride",
      from: l.from, to: l.to,
      departure: l.departure, arrival: l.arrival,
      minutes: l.departure && l.arrival ? clockDiff(l.departure, l.arrival) : (l.minutes ?? null),
      line: labelLine(l.line, l.vehicle),
      vehicle: l.vehicle,
    })),
    intermediateStops: extra.intermediateStops ?? [],
  };
}

async function getJson(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new TransitError(timeout ? "timeout" : "network",
      timeout ? "時間内に答えが返りませんでした" : "つながりませんでした", { retryable: true });
  }
  if (res.status === 429) throw new TransitError("rate_limited", "回数の上限に当たりました", { status: 429, retryable: true });
  if (res.status === 401 || res.status === 403) throw new TransitError("rejected", `キーが通りませんでした（${res.status}）`, { status: 502 });
  if (!res.ok) throw new TransitError("upstream", `相手の返事が ${res.status} でした`, { retryable: res.status >= 500 });
  try { return await res.json(); } catch {
    throw new TransitError("bad_response", "答えを読めませんでした");
  }
}

// ── Transitous（MOTIS） ──────────────────────────────

const TRANSITOUS_KIND = {
  WALK: "walk", AIRPLANE: "air", FERRY: "ferry", HIGHSPEED_RAIL: "shinkansen",
  COACH: "coach", BUS: "bus", AERIAL_LIFT: "ropeway", FUNICULAR: "cable",
  TRAM: "tram", MONORAIL: "monorail",
};

/** 「小田原 Odawara」のように付いてくるローマ字を落とします（日本語の名前のときだけ）。 */
export function cleanName(s) {
  const n = String(s ?? "").trim();
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(n) ? n.replace(/\s+[A-Za-z][A-Za-z .'()\-]*$/, "") : n;
}

export function readTransitous(data, q) {
  return (data?.itineraries ?? []).map((it) => {
    const legs = (it.legs ?? []).map((l) => ({
      vehicle: TRANSITOUS_KIND[l.mode] ?? "rail",
      from: l.from?.name === "START" ? q.from : cleanName(l.from?.name),
      to: l.to?.name === "END" ? q.to : cleanName(l.to?.name),
      departure: clockOf(l.startTime ?? l.scheduledStartTime),
      arrival: clockOf(l.endTime ?? l.scheduledEndTime),
      line: [l.routeShortName, l.routeLongName].filter((s) => s && !/^\d{5,}$/.test(s)).join(" ")
        || l.agencyName || "",
    }));
    return routeFrom(legs, { transfers: it.transfers });
  });
}

async function transitous(q, env, fetchImpl) {
  if (q.search === "last") throw new TransitError("unsupported", "Transitous は終電を探せません", { status: 400 });
  const place = (p, name) => (p ? `${p.lat},${p.lng}` : name);
  const u = new URL("https://api.transitous.org/api/v5/plan");
  u.searchParams.set("fromPlace", place(q.fromAt, q.from));
  u.searchParams.set("toPlace", place(q.toAt, q.to));
  u.searchParams.set("time", q.at.toISOString());
  u.searchParams.set("numItineraries", "3");
  if (!q.fromAt || !q.toAt) throw new TransitError("unsupported", "Transitous は位置が要ります", { status: 400 });
  const data = await getJson(fetchImpl, u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  return { routes: readTransitous(data, q), url: null };
}

// ── 駅すぱあと API ───────────────────────────────

/** 度を「度.分.秒」に（駅すぱあとの座標の書きかた）。 */
export function dms(deg) {
  const sign = deg < 0 ? "-" : "";
  let v = Math.abs(deg);
  const d = Math.floor(v); v = (v - d) * 60;
  const m = Math.floor(v);
  const s = ((v - m) * 60).toFixed(1);
  return `${sign}${d}.${m}.${s}`;
}

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const textOf = (v) => (v && typeof v === "object" ? v.text ?? v.Name ?? "" : v ?? "");

const EKISPERT_KIND = { walk: "walk", plane: "air", ship: "ferry", bus: "bus", strange: "rail", train: "rail" };

export function readEkispert(data) {
  return arr(data?.ResultSet?.Course).map((c) => {
    const route = c?.Route ?? {};
    const points = arr(route.Point);
    const lines = arr(route.Line);
    const legs = lines.map((l, i) => {
      const type = String(textOf(l.Type)).toLowerCase();
      let vehicle = EKISPERT_KIND[type] ?? "rail";
      const name = textOf(l.Name);
      if (vehicle === "rail" && /新幹線/.test(name)) vehicle = "shinkansen";
      if (vehicle === "bus" && /高速/.test(name)) vehicle = "coach";
      return {
        vehicle,
        from: textOf(points[i]?.Station?.Name ?? points[i]?.Name),
        to: textOf(points[i + 1]?.Station?.Name ?? points[i + 1]?.Name),
        departure: clockOf(textOf(l.DepartureState?.Datetime)),
        arrival: clockOf(textOf(l.ArrivalState?.Datetime)),
        line: name,
      };
    });
    const fare = arr(c.Price).find((p) => p.kind === "FareSummary") ?? null;
    const yen = Number(textOf(fare?.Oneway)) || null;
    return routeFrom(legs, {
      transfers: Number(route.transferCount) || 0,
      fareYen: yen,
      distanceKm: Number(route.distance) ? Number(route.distance) / 10 : null,
    });
  });
}

async function ekispert(q, env, fetchImpl) {
  const via = (p, name) => (p ? `${dms(p.lat)},${dms(p.lng)},wgs84,1000` : name);
  const u = new URL("https://api.ekispert.jp/v1/json/search/course/extreme");
  u.searchParams.set("key", env.EKISPERT_API_KEY.trim());
  u.searchParams.set("viaList", `${via(q.fromAt, q.from)}:${via(q.toAt, q.to)}`);
  const t = tokyo(q.at);
  u.searchParams.set("date", `${t.y}${t.m}${t.d}`);
  u.searchParams.set("time", `${t.hh}${t.mm}`);
  u.searchParams.set("searchType", q.search === "last" ? "lastTrain" : "departure");
  u.searchParams.set("answerCount", "3");
  u.searchParams.set("gcs", "wgs84");
  const data = await getJson(fetchImpl, u, { headers: { Accept: "application/json" } });
  return { routes: readEkispert(data), url: null };
}

// ── NAVITIME Route(totalnavi)（RapidAPI） ─────────────────

const NAVITIME_KIND = {
  walk: "walk", domestic_flight: "air", ferry: "ferry", superexpress_train: "shinkansen",
  highway_bus: "coach", local_bus: "bus", shuttle_bus: "bus",
  ultraexpress_train: "express", sleeper_ultraexpress: "express",
};

/** 外された乗り物を、NAVITIME の unuse に。 */
export function navitimeUnuse(modes) {
  const out = [];
  if (!modes.al) out.push("domestic_flight");
  if (!modes.shin) out.push("superexpress_train");
  if (!modes.ex) out.push("ultraexpress_train", "sleeper_ultraexpress");
  if (!modes.hb) out.push("highway_bus");
  if (!modes.lb) out.push("local_bus", "shuttle_bus");
  if (!modes.sr) out.push("ferry");
  return out.join(".");
}

export function readNavitime(data, q) {
  return arr(data?.items).map((it) => {
    const secs = arr(it.sections);
    const legs = [];
    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      if (s?.type !== "move") continue;
      const prev = secs[i - 1];
      const next = secs[i + 1];
      const name = s.transport?.name || s.line_name || "";
      legs.push({
        vehicle: NAVITIME_KIND[s.move] ?? "rail",
        from: prev?.name === "start" ? q.from : prev?.name,
        to: next?.name === "goal" ? q.to : next?.name,
        departure: clockOf(s.from_time),
        arrival: clockOf(s.to_time),
        line: name,
      });
    }
    const mv = it.summary?.move ?? {};
    const yen = Number(mv.fare?.unit_0) || null;
    return routeFrom(legs, {
      transfers: Number(mv.transit_count) || 0,
      fareYen: yen,
      distanceKm: Number(mv.distance) ? Math.round(Number(mv.distance) / 100) / 10 : null,
    });
  });
}

async function navitime(q, env, fetchImpl) {
  if (q.search === "last") throw new TransitError("unsupported", "NAVITIME（RapidAPI）は終電を探せません", { status: 400 });
  if (!q.fromAt || !q.toAt) throw new TransitError("unsupported", "NAVITIME は位置が要ります", { status: 400 });
  const host = "navitime-route-totalnavi.p.rapidapi.com";
  const u = new URL(`https://${host}/route_transit`);
  u.searchParams.set("start", `${q.fromAt.lat},${q.fromAt.lng}`);
  u.searchParams.set("goal", `${q.toAt.lat},${q.toAt.lng}`);
  const t = tokyo(q.at);
  u.searchParams.set("start_time", `${t.y}-${t.m}-${t.d}T${t.hh}:${t.mm}:00`);
  u.searchParams.set("limit", "3");
  const unuse = navitimeUnuse(q.modes);
  if (unuse) u.searchParams.set("unuse", unuse);
  // NAVITIME の規約で、受け取った答えは控えません（キャッシュしない）。
  const data = await getJson(fetchImpl, u, {
    headers: { "X-RapidAPI-Key": env.NAVITIME_RAPIDAPI_KEY.trim(), "X-RapidAPI-Host": host },
  });
  return { routes: readNavitime(data, q), url: null };
}

// ── HERE Public Transit API v8 ──────────────────────────

const HERE_KIND = {
  pedestrian: "walk", flight: "air", ferry: "ferry", highSpeedTrain: "shinkansen",
  bus: "bus", privateBus: "bus", busRapid: "bus", intercityBus: "coach",
  aerial: "ropeway", inclined: "cable", lightRail: "tram", monorail: "monorail",
};

export function readHere(data, q) {
  return arr(data?.routes).map((r) => {
    const legs = arr(r.sections).map((s) => {
      const mode = s.type === "pedestrian" ? "pedestrian" : s.transport?.mode;
      return {
        vehicle: HERE_KIND[mode] ?? "rail",
        from: s.departure?.place?.name || (s === r.sections[0] ? q.from : ""),
        to: s.arrival?.place?.name || (s === r.sections.at(-1) ? q.to : ""),
        departure: clockOf(s.departure?.time),
        arrival: clockOf(s.arrival?.time),
        line: [s.transport?.name, s.transport?.headsign ? `${s.transport.headsign}行` : ""].filter(Boolean).join(" "),
      };
    });
    return routeFrom(legs);
  });
}

async function here(q, env, fetchImpl) {
  if (q.search === "last") throw new TransitError("unsupported", "HERE は終電を探せません", { status: 400 });
  if (!q.fromAt || !q.toAt) throw new TransitError("unsupported", "HERE は位置が要ります", { status: 400 });
  const u = new URL("https://transit.router.hereapi.com/v8/routes");
  u.searchParams.set("origin", `${q.fromAt.lat},${q.fromAt.lng}`);
  u.searchParams.set("destination", `${q.toAt.lat},${q.toAt.lng}`);
  u.searchParams.set("departureTime", q.at.toISOString());
  u.searchParams.set("alternatives", "2");
  u.searchParams.set("lang", "ja-JP");
  const no = [];
  if (!q.modes.al) no.push("-flight");
  if (!q.modes.shin) no.push("-highSpeedTrain");
  if (!q.modes.hb) no.push("-intercityBus");
  if (!q.modes.lb) no.push("-bus");
  if (!q.modes.sr) no.push("-ferry");
  if (no.length) u.searchParams.set("modes", no.join(","));
  u.searchParams.set("apiKey", env.HERE_API_KEY.trim());
  const data = await getJson(fetchImpl, u, { headers: { Accept: "application/json" } });
  return { routes: readHere(data, q), url: null };
}

// ── 入口 ───────────────────────────────────────

const SEARCH = { ekispert, navitime, here, transitous };

/**
 * 1つの API で引きます。
 * yahoo は worker.js の中にあるので、呼ぶ側から渡してもらいます
 * （deps.yahoo(q) → /yahoo/transit と同じ形の答え）。
 */
export async function searchWith(name, q, env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  if (!available(name, env)) {
    throw new TransitError("not_configured", `${LABELS[name] ?? name} は使えるように設定されていません`, { status: 503 });
  }
  if (q.search === "last" && !SUPPORTS_LAST.has(name)) {
    throw new TransitError("unsupported", `${LABELS[name]} は終電を探せません`, { status: 400 });
  }
  if (name === "yahoo") {
    if (!deps.yahoo) throw new TransitError("not_configured", "Yahoo!路線情報は使えません", { status: 503 });
    const out = await deps.yahoo(q);
    return { ...out, provider: "yahoo", providerLabel: LABELS.yahoo };
  }
  const run = SEARCH[name];
  if (!run) throw new TransitError("bad_request", `知らない API です: ${name}`, { status: 400 });
  const { routes, url } = await run(q, env, fetchImpl);
  return choose(routes, q, {
    provider: name, providerLabel: LABELS[name],
    reason: `${LABELS[name]} から経路が返りませんでした`,
    ...(url ? { url } : {}),
  });
}

/**
 * 決まった順に試します。答えが「経路なし」でも次へ進みます
 * （無料の Transitous は地域によってバスが入っていないため）。
 * 全部だめなら、最後のわけを付けて routed:false を返します。
 */
export async function searchAuto(q, env, deps = {}) {
  const tried = [];
  let last = null;
  for (const name of orderFrom(env)) {
    if (!available(name, env)) continue;
    if (q.search === "last" && !SUPPORTS_LAST.has(name)) continue;
    try {
      const out = await searchWith(name, q, env, deps);
      tried.push({ provider: name, routed: Boolean(out.routed) });
      if (out.routed) return { ...out, tried };
      last = out;
    } catch (e) {
      if (!(e instanceof TransitError)) throw e;
      tried.push({ provider: name, error: e.code });
    }
  }
  return { routed: false, reason: last?.reason ?? "使える乗り換え検索がありません", tried };
}

/** POST /transit の本体。 */
export async function transitHandler(body, env, deps = {}) {
  const q = readQuery(body);
  const name = String(body?.provider ?? "auto").toLowerCase();
  if (name === "auto") return searchAuto(q, env, deps);
  return searchWith(name, q, env, deps);
}
