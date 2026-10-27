// 天気を取ってくる。
//
// 「雨なら屋内へ」をやるには、まず雨が降るかどうかを知る必要があります。
// Open-Meteo（キー不要・CORS可）から、時間ごとの降水確率と気温だけを
// もらいます。座標を1か所ぶん投げて、1日ぶんの配列が返ってくるだけの
// 素直なAPIです。
//
// 三つのことを守っています。
//
//   1. 取れなくても旅程は出す。天気は旅程の本体ではありません。
//      つながらない、応答が壊れている、どれも「分からない」だけです。
//   2. 予報の効く範囲（16日）を超えたら、呼びません。投げても
//      返らないものに通信を使う理由がありません。
//   3. 同じ日・同じ場所は二度取りに行かない（3時間キャッシュ）。
//
// 課金されないので quota.js のゲートは通していません。
// そのかわり、上の3点で呼ぶ回数そのものを抑えています。

import { requestSignal } from "./endpoints.js";

const KEY = "tabisaki.weather";
const API = "https://api.open-meteo.com/v1/forecast";

/** 予報が効く日数。これを超えたら呼びません。 */
export const FORECAST_HORIZON_DAYS = 16;

/** キャッシュの寿命。予報は数時間で更新されます。 */
const TTL_MS = 3 * 3600 * 1000;

/** 「雨」と呼ぶ降水確率のしきい値（%）。 */
export const RAIN_THRESHOLD = 55;

const ymd = (d) => `${d.getFullYear()}-`
  + `${String(d.getMonth() + 1).padStart(2, "0")}-`
  + `${String(d.getDate()).padStart(2, "0")}`;

/** 場所と日付のキー。座標は小数2桁（約1km）に丸めます。 */
function cacheKey(at, date) {
  return `${at.lat.toFixed(2)},${at.lng.toFixed(2)}|${ymd(date)}`;
}

function load(storage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const doc = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of Object.entries(doc)) {
      if (!v || now - (v.at ?? 0) > TTL_MS) delete doc[k];
    }
    return doc;
  } catch { return {}; }
}

function save(storage, doc) {
  try { storage?.setItem(KEY, JSON.stringify(doc)); } catch { /* 任意 */ }
}

export function clearWeatherCache(storage = globalThis.localStorage) {
  try { storage?.removeItem(KEY); } catch { /* 消せなくても動きます */ }
}

/**
 * その場所・その日の予報。
 *
 * @param {{lat:number,lng:number}} at
 * @param {Date} date
 * @param {{fetchImpl?:Function, storage?:object, now?:Date,
 *          signal?:AbortSignal}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, date?:string,
 *                     rows?:Array<{at:Date,rain:number,temp:number,code:number}>}>}
 */
export async function forecastFor(at, date, opts = {}) {
  const now = opts.now ?? new Date();
  const ahead = (date - now) / 86400000;
  if (ahead > FORECAST_HORIZON_DAYS) {
    return { ok: false,
      reason: `出発が${Math.round(ahead)}日先のため、天気予報はまだ出ていません`
        + `（${FORECAST_HORIZON_DAYS}日先まで）。` };
  }
  if (ahead < -1) {
    return { ok: false, reason: "過ぎた日付のため、予報は取得しません。" };
  }

  const storage = opts.storage ?? globalThis.localStorage ?? null;
  const key = cacheKey(at, date);
  const doc = load(storage);
  if (doc[key]) return reviveRows(doc[key].value);

  const day = ymd(date);
  const url = `${API}?latitude=${at.lat.toFixed(4)}`
    + `&longitude=${at.lng.toFixed(4)}`
    + "&hourly=precipitation_probability,temperature_2m,weather_code"
    + `&timezone=auto&start_date=${day}&end_date=${day}`;

  let value;
  try {
    const send = opts.fetchImpl ?? globalThis.fetch;
    const res = await send(url, { signal: requestSignal(opts.signal, 20_000) });
    if (!res?.ok) {
      return { ok: false, reason: `天気を取得できませんでした（${res?.status}）。` };
    }
    const data = await res.json();
    value = parse(data, day);
  } catch {
    // つながらないのは、旅程の失敗ではありません
    return { ok: false, reason: "天気を取得できませんでした（通信）。" };
  }
  if (!value.ok) return value;

  doc[key] = { at: Date.now(), value };
  save(storage, doc);
  return reviveRows(value);
}

function parse(data, day) {
  const h = data?.hourly;
  const times = Array.isArray(h?.time) ? h.time : null;
  if (!times?.length) {
    return { ok: false, reason: "天気の応答を読み取れませんでした。" };
  }
  const rows = times.map((t, i) => ({
    iso: t,
    rain: num(h.precipitation_probability?.[i]),
    temp: num(h.temperature_2m?.[i]),
    code: num(h.weather_code?.[i]),
  }));
  return { ok: true, date: day, rows };
}

const num = (v) => (Number.isFinite(v) ? v : 0);

/** 保存から戻すときに、時刻を Date に直します。 */
function reviveRows(value) {
  if (!value?.ok) return value;
  return { ...value,
    rows: value.rows.map((r) => ({ ...r, at: new Date(r.iso) })) };
}

/** 時間ごとの一覧。 */
export function hourly(forecast) {
  return forecast?.ok ? forecast.rows : [];
}

/** その時刻の降水確率（%）。分からなければ 0。 */
export function rainAt(forecast, when) {
  if (!forecast?.ok || !(when instanceof Date)) return 0;
  const hour = when.getHours();
  const row = forecast.rows.find((r) => new Date(r.iso).getHours() === hour);
  return row?.rain ?? 0;
}

/** その時刻の気温（℃）。分からなければ null。 */
export function tempAt(forecast, when) {
  if (!forecast?.ok || !(when instanceof Date)) return null;
  const hour = when.getHours();
  const row = forecast.rows.find((r) => new Date(r.iso).getHours() === hour);
  return row ? row.temp : null;
}

/**
 * その日をひとことで。
 * 数字だけ並べても行動が決まらないので、「何時ごろ降るか」を書きます。
 */
export function summarizeDay(forecast) {
  if (!forecast?.ok) return forecast?.reason ?? "天気は分かりません。";
  // 観光する時間帯（8〜19時）だけを見ます
  const day = forecast.rows.filter((r) => {
    const h = new Date(r.iso).getHours();
    return h >= 8 && h <= 19;
  });
  if (!day.length) return "天気は分かりません。";

  const temps = day.map((r) => r.temp);
  const lo = Math.round(Math.min(...temps));
  const hi = Math.round(Math.max(...temps));
  const wet = day.filter((r) => r.rain >= RAIN_THRESHOLD);

  if (!wet.length) {
    const max = Math.max(...day.map((r) => r.rain));
    return `日中は ${lo}〜${hi}℃。降水確率は最大 ${Math.round(max)}% で、`
      + "傘は要らなさそうです。";
  }
  const hours = wet.map((r) => new Date(r.iso).getHours());
  const from = Math.min(...hours);
  const to = Math.max(...hours);
  const peak = Math.round(Math.max(...wet.map((r) => r.rain)));
  const span = from === to ? `${from}時ごろ` : `${from}時〜${to}時ごろ`;
  return `日中は ${lo}〜${hi}℃。${span}に雨の可能性があります`
    + `（最大 ${peak}%）。`;
}
