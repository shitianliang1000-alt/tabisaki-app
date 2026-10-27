// 16日より先の旅に、その時期の「ふつう」を出す。
//
// 天気予報は16日先までです（packages/core/src/weather.js の FORECAST_HORIZON_DAYS）。
// ところが旅程は、宿を取る都合で1か月も2か月も先に組みます。その旅に
// ついて、いまの画面は**天気の話をいっさいしません**。
//
//   「出発が48日先のため、天気予報はまだ出ていません」
//
// 正しいのですが、これだけでは持ち物も決められません。知りたいのは
// 予報ではなく、**その時期のふつう**です。
//
//   10月下旬の奥入瀬は、上着が要るのか。
//   9月の出雲は、まだ半袖でいいのか。
//   6月の屋久島は、どれくらい雨が降るのか。
//
// これは予報ではなく、過去の観測の平均です。**作り話ではありません。**
//
// ■ どこから取るか
//
// Open-Meteo の過去の観測（archive-api.open-meteo.com）から、同じ場所の
// 過去10年ぶんを1回で取り、旅の日の前後3日だけを取り出して平均します。
// 返ってくる形は予報（api.open-meteo.com）と同じ envelope です
// （daily: { time: [...], temperature_2m_max: [...] , ... }）。
//
//   ※ 書いた日、この機械からは過去の観測の入口が「1日の上限を
//     超えました」で断られ、**実際の応答で形を確かめられませんでした**。
//     予報の側の同じ形は確かめてあります。読み取りは、少しでも形が
//     違えば null を返します（下の parseNormals）。**違っていたときに
//     起きるのは「何も出ない」であって、嘘の数字が出ることではありません。**
//
// ■ 言うこと・言わないこと
//
//   言う   … 平均の最高・最低気温、その幅、雨の降った日の割合
//   言う   … **予報ではないこと**。これがいちばん大事です
//   言わない … 「10月20日は晴れます」。分かるはずがありません
//   言わない … 桜や紅葉の見ごろ。気温の平均からは決まりません
//     （packages/core/src/events.js の季節の話は、そちらで別に持っています）

import { requestSignal } from "./endpoints.js";

const KEY = "tabisaki.normals";
const API = "https://archive-api.open-meteo.com/v1/archive";

/** 何年ぶんを平均するか。 */
export const NORMALS_YEARS = 10;

/** 旅の日の前後、何日を同じ「ころ」として数えるか。 */
export const WINDOW_DAYS = 3;

/** 「雨が降った日」と数える降水量（mm）。 */
export const RAIN_MM = 1;

/**
 * 保存の寿命。
 *
 * 平年値は**変わりません**（去年までの観測です）。予報の3時間とは
 * 桁が違ってよいので、30日置きます。取り直しても同じ答えなのに
 * 毎回聞きにいくのは、相手にも失礼です。
 */
const TTL_MS = 30 * 24 * 3600 * 1000;

const p2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const mmdd = (d) => `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 場所と日付のキー。座標は小数1桁（約11km）に丸めます。 */
function cacheKey(at, date) {
  return `${at.lat.toFixed(1)},${at.lng.toFixed(1)}|${mmdd(date)}`;
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

export function clearNormalsCache(storage = globalThis.localStorage) {
  try { storage?.removeItem(KEY); } catch { /* 消せなくても動きます */ }
}

/**
 * 聞きにいく先。
 *
 * 10年ぶんを**1回で**取ります。年ごとに10回聞くと、相手の1日の
 * 上限をこちらだけで使い切ります。返るのは3650日ぶんですが、
 * 数字が3列だけなので、圧縮されれば数十KBです。
 */
export function normalsUrl(at, date, opts = {}) {
  const years = Number.isFinite(opts.years) ? opts.years : NORMALS_YEARS;
  // 去年まで。今年は途中までしか無く、年によって日数が違ってしまいます。
  const lastYear = (opts.now ?? new Date()).getFullYear() - 1;
  const start = new Date(lastYear - years + 1, 0, 1);
  const end = new Date(lastYear, 11, 31);
  return `${API}?latitude=${at.lat.toFixed(3)}`
    + `&longitude=${at.lng.toFixed(3)}`
    + `&start_date=${ymd(start)}&end_date=${ymd(end)}`
    + "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
    + "&timezone=Asia%2FTokyo";
}

/** その日が、旅の日の「ころ」に入るか（前後 WINDOW_DAYS 日）。 */
function nearDate(iso, date, window) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return false;
  // 同じ年に置き直してから、日数の差を見ます（年をまたぐ年末年始でも
  // 前後がつながるよう、前後の年にも置いて、いちばん近い差を採ります）。
  let best = Infinity;
  for (const y of [d.getFullYear() - 1, d.getFullYear(), d.getFullYear() + 1]) {
    const anchor = new Date(y, date.getMonth(), date.getDate());
    const diff = Math.abs((d - anchor) / 86400000);
    if (diff < best) best = diff;
  }
  return best <= window;
}

/**
 * 応答から、平年値を数えます。
 *
 * **形が少しでも違えば null を返します。** 0 で埋めたり、片方だけの
 * 数字で平均を出したりはしません。出るのは「何も出ない」であって、
 * 嘘の数字ではありません。
 *
 * @returns {{years:number, samples:number, tmaxMean:number, tmaxLo:number,
 *            tmaxHi:number, tminMean:number, rainDays:number,
 *            rainRate:number}|null}
 */
export function parseNormals(data, date, opts = {}) {
  const window = Number.isFinite(opts.window) ? opts.window : WINDOW_DAYS;
  const d = data?.daily;
  const time = Array.isArray(d?.time) ? d.time : null;
  const tmax = Array.isArray(d?.temperature_2m_max) ? d.temperature_2m_max : null;
  const tmin = Array.isArray(d?.temperature_2m_min) ? d.temperature_2m_min : null;
  const rain = Array.isArray(d?.precipitation_sum) ? d.precipitation_sum : null;
  if (!time?.length || !tmax || !tmin || !rain) return null;
  if (tmax.length !== time.length || tmin.length !== time.length
      || rain.length !== time.length) return null;

  const hi = [];
  const lo = [];
  let rainDays = 0;
  let rainKnown = 0;
  const years = new Set();
  // 欠測は null で来ます。**Number(null) は 0 です。** 通してしまうと
  // 「その日の最高気温は0℃」として平均に混ざり、11月の出雲が真冬に
  // なります。数であることを、値そのもので見ます。
  const real = (v) => typeof v === "number" && Number.isFinite(v);
  for (let i = 0; i < time.length; i++) {
    if (!nearDate(time[i], date, window)) continue;
    if (real(tmax[i]) && real(tmin[i])) {
      hi.push(tmax[i]);
      lo.push(tmin[i]);
      years.add(String(time[i]).slice(0, 4));
    }
    if (real(rain[i])) {
      rainKnown += 1;
      if (rain[i] >= RAIN_MM) rainDays += 1;
    }
  }
  // 数えられた日が少なすぎるときは、平均と呼びません。
  if (hi.length < 10 || rainKnown < 10) return null;

  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return {
    years: years.size,
    samples: hi.length,
    tmaxMean: Math.round(mean(hi) * 10) / 10,
    tmaxLo: Math.round(Math.min(...hi)),
    tmaxHi: Math.round(Math.max(...hi)),
    tminMean: Math.round(mean(lo) * 10) / 10,
    rainDays,
    rainRate: Math.round((rainDays / rainKnown) * 100),
  };
}

/**
 * 平年値を、そのまま読める一文にします。
 *
 * **「予報ではありません」を必ず書きます。** これを落とすと、
 * 「10月20日は24℃」と読まれます。そう読まれたら、この機能は
 * 無いほうがましです。
 */
export function describeNormals(n, date) {
  if (!n) return "";
  const when = date instanceof Date
    ? `${date.getMonth() + 1}月${date.getDate()}日ごろ` : "この時期";
  return `${when}の平年は、最高 ${n.tmaxMean}℃・最低 ${n.tminMean}℃ です`
    + `（過去${n.years}年の同じころ${n.samples}日の平均。`
    + `最高は ${n.tmaxLo}〜${n.tmaxHi}℃ の幅がありました）。`
    + `雨（1日${RAIN_MM}mm以上）が降ったのは ${n.rainDays}日、`
    + `${n.rainRate}% の日でした。`
    + "これは予報ではなく、過去の観測の平均です"
    + "（予報は16日先までしか出ません）。その年によって上下します。";
}

/**
 * その場所・その時期の平年値。
 *
 * 予報の効く範囲（16日）の中なら、**呼びません**。予報があるのに
 * 平均を出すのは、粗いほうの数字を見せることになります。
 *
 * @param {{lat:number,lng:number}} at
 * @param {Date} date
 * @param {{fetchImpl?:Function, storage?:object, now?:Date,
 *          signal?:AbortSignal, horizonDays?:number, years?:number,
 *          window?:number}} [opts]
 * @returns {Promise<{ok:boolean, reason?:string, text?:string,
 *                     value?:object}>}
 */
export async function normalsFor(at, date, opts = {}) {
  const now = opts.now ?? new Date();
  const horizon = Number.isFinite(opts.horizonDays) ? opts.horizonDays : 16;
  const lat = Number(at?.lat);
  const lng = Number(at?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
      || !(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { ok: false, reason: "場所か日付が分かりません。" };
  }
  const ahead = (date - now) / 86400000;
  if (ahead <= horizon) {
    return { ok: false, reason: "予報の出る範囲なので、予報のほうを出します。" };
  }

  const storage = opts.storage ?? globalThis.localStorage ?? null;
  const key = cacheKey({ lat, lng }, date);
  const doc = load(storage);
  if (doc[key]) {
    return { ok: true, value: doc[key].value,
             text: describeNormals(doc[key].value, date) };
  }

  let value = null;
  try {
    const send = opts.fetchImpl ?? globalThis.fetch;
    const res = await send(normalsUrl({ lat, lng }, date, opts),
      { signal: requestSignal(opts.signal, 25_000) });
    if (!res?.ok) {
      return { ok: false, reason: "過去の記録を取得できませんでした。" };
    }
    value = parseNormals(await res.json(), date, opts);
  } catch {
    // つながらないのは、旅程の失敗ではありません。
    return { ok: false, reason: "過去の記録を取得できませんでした（通信）。" };
  }
  if (!value) {
    return { ok: false, reason: "過去の記録を読み取れませんでした。" };
  }

  doc[key] = { at: Date.now(), value };
  save(storage, doc);
  return { ok: true, value, text: describeNormals(value, date) };
}
