// 「明日晴れていて、東京に近いところへ日帰りで」に答える。
//
// 行き先の名前が書かれていない頼みでも、**条件で行き先を絞る**ことは
// できます。ここでは2つを読みます。
//
//   晴れ … 「晴れている」「天気のいい」「雨が降らない」
//           → 出発日の予報で、晴れ・曇りの見込みのエリアだけに絞る
//   近い … 「東京に近い」「近場」「近く」
//           → 出発地から日帰りで行ける距離のエリアだけに絞る
//
// 「東京に近い」の「東京」は行き先ではありません。行き先として読むと、
// 都内の旅程が返ります（実際にそうなる作りでした）。地名の絞り込みからは
// 外し、出発地として扱います（js/chatread.js がその名前を出発地に入れます）。
//
// 予報は Open-Meteo から、エリアの座標をまとめて1回で聞きます（キー不要）。
// 取れなければ、晴れの条件は使わずに組み、そう伝えます。

import { haversineKm } from "./feasibility.js";
import { FORECAST_HORIZON_DAYS } from "./weather.js";
import { requestSignal } from "./endpoints.js";

const API = "https://api.open-meteo.com/v1/forecast";

/** 「晴れ」を頼む言い方。 */
const SUNNY = /晴れ(?:て|た|る|の|間)|晴天|快晴|天気(?:が|の)?(?:いい|良い|よい|良さ)|雨(?:が)?(?:降らない|ふらない|降ってない|の心配がない)|雨じゃない/;
/** 「近い」を頼む言い方。前の語は、どこから近いか。 */
const NEAR = /([一-龯々ヶァ-ヴー]{1,8}?)(?:駅)?(?:に|から)近(?:い|く|め)|近場|近く(?:の|で|へ|に)|遠くない|遠すぎない/;

/**
 * 希望文から、晴れ・近いの頼みを読みます。
 * @returns {{ sunny: boolean, near: boolean, nearPlace: string|null }}
 */
export function readWish(note) {
  const t = String(note ?? "").normalize("NFKC");
  const m = t.match(NEAR);
  return {
    sunny: SUNNY.test(t),
    near: Boolean(m),
    nearPlace: m?.[1] && !/^(ここ|家|自宅|会社|うち)$/.test(m[1]) ? m[1] : null,
  };
}

/** 地名の絞り込みに渡す前に、「◯◯に近い」の部分を消します。 */
export function stripNear(text) {
  return String(text ?? "").normalize("NFKC")
    .replace(/[一-龯々ヶァ-ヴー]{1,8}?(?:駅)?(?:に|から)近(?:い|く|め)(?:ところ|所|場所|とこ|エリア)?/g, " ");
}

/**
 * 出発地からの距離の上限（km、直線）。日帰りは片道2時間ほど、
 * 泊まるならもう少し遠くまで。「近い」と書かれたら、さらに縮めます。
 */
export function radiusFor(nights, near) {
  const base = nights > 0 ? 260 : 130;
  return near ? Math.round(base * 0.8) : base;
}

/** 出発地から上限の内にあるエリア（近い順）。 */
export function regionsWithin(regions, origin, km) {
  if (!origin || !Number.isFinite(origin.lat)) return [];
  return regions
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .map((r) => ({ r, km: haversineKm(origin, r) }))
    .filter((x) => x.km <= km)
    .sort((a, b) => a.km - b.km)
    .map((x) => x.r);
}

/**
 * WMO の天気コードを3つに分けます。
 *   0〜3 … 晴れ〜曇り（雨なし）　45・48 … 霧　それ以外 … 雨や雪
 */
export function skyOf(code, rainProb) {
  if (!Number.isFinite(code)) return "unknown";
  if (code <= 3 && (!Number.isFinite(rainProb) || rainProb <= 30)) return code <= 1 ? "clear" : "cloudy";
  if (code === 45 || code === 48) return "fog";
  return "wet";
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 同じ日・同じ問い合わせは、組み立て中（3案ぶん）に使い回します。 */
const memo = new Map();

/**
 * エリアごとの、その日の空の見込み。
 *
 * 座標は 0.2度（約20km）の升に丸め、升ごとに1点だけ聞きます。近い
 * エリアは同じ空なので、40エリアでも聞く点は十数か所になります。
 *
 * @returns {Promise<Map<string, {sky: string, rain: number|null, code: number|null}>|null>}
 *   取れなければ null
 */
export async function skiesFor(regions, date, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl || !regions.length) return null;
  const days = (new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000;
  if (!opts.fetch && (days < 0 || days >= FORECAST_HORIZON_DAYS)) return null;
  const cell = (r) => `${Math.round(r.lat * 5) / 5},${Math.round(r.lng * 5) / 5}`;
  const cells = [...new Set(regions.map(cell))].slice(0, 60);
  const key = `${ymd(new Date(date))}|${cells.join(";")}`;
  // 試験で差し替えた fetch のときは、覚えません（試験どうしが混ざります）。
  if (opts.fetch) memo.delete(key);
  if (!memo.has(key)) {
    const params = new URLSearchParams({
      latitude: cells.map((c) => c.split(",")[0]).join(","),
      longitude: cells.map((c) => c.split(",")[1]).join(","),
      daily: "weather_code,precipitation_probability_max",
      timezone: "Asia/Tokyo",
      start_date: ymd(new Date(date)),
      end_date: ymd(new Date(date)),
    });
    memo.set(key, (async () => {
      try {
        const res = await fetchImpl(`${API}?${params}`, { signal: requestSignal(opts.signal, 8000) });
        if (!res.ok) return null;
        const data = await res.json();
        const list = Array.isArray(data) ? data : [data];
        const out = new Map();
        cells.forEach((c, i) => {
          const d = list[i]?.daily;
          const code = Number(d?.weather_code?.[0]);
          const rain = Number(d?.precipitation_probability_max?.[0]);
          out.set(c, {
            code: Number.isFinite(code) ? code : null,
            rain: Number.isFinite(rain) ? rain : null,
            sky: skyOf(code, rain),
          });
        });
        return out;
      } catch {
        return null;
      }
    })());
  }
  const byCell = await memo.get(key);
  if (!byCell) {
    memo.delete(key);
    return null;
  }
  return new Map(regions.map((r) => [r.id, byCell.get(cell(r)) ?? { sky: "unknown", rain: null, code: null }]));
}

/**
 * 頼みに合わせて、行き先にしてよいエリアを決めます。
 *
 * @returns {Promise<{ regionIds: Set<string>|null, notes: string[] }>}
 *   regionIds が null なら、絞りません
 */
export async function wishScope(wish, { regions, origin, date, nights = 0, fetch, signal } = {}) {
  const notes = [];
  if (!wish?.sunny && !wish?.near) return { regionIds: null, notes };
  const km = radiusFor(nights, wish.near);
  const near = regionsWithin(regions ?? [], origin, km);
  if (!near.length) return { regionIds: null, notes };
  if (!wish.sunny) {
    notes.push(`${origin.name ?? "出発地"}から約${km}km以内のエリアから選びました。`);
    return { regionIds: new Set(near.map((r) => r.id)), notes };
  }
  const pool = near.slice(0, 80);
  const skies = await skiesFor(pool, date, { fetch, signal });
  const when = `${new Date(date).getMonth() + 1}月${new Date(date).getDate()}日`;
  if (!skies) {
    notes.push(`${when}の天気予報を取れなかったので、晴れかどうかは見ずに選びました。`
      + "出かける前に予報を確かめてください。");
    return { regionIds: wish.near ? new Set(near.map((r) => r.id)) : null, notes };
  }
  const clear = pool.filter((r) => skies.get(r.id)?.sky === "clear");
  const dry = pool.filter((r) => ["clear", "cloudy"].includes(skies.get(r.id)?.sky));
  const pick = clear.length >= 3 ? clear : dry;
  if (!pick.length) {
    notes.push(`${when}は、${origin.name ?? "出発地"}から行ける範囲のどこも雨の予報でした。`
      + "雨の日でも回れるか、旅程の天気の欄も見てください。");
    return { regionIds: new Set(near.map((r) => r.id)), notes };
  }
  notes.push(`${when}の予報で${pick === clear ? "晴れ" : "雨の降らない"}見込みのエリア`
    + `（${origin.name ?? "出発地"}から約${km}km以内の${pick.length}か所）から選びました。`
    + "予報は変わるので、前の日にも確かめてください。");
  return { regionIds: new Set(pick.map((r) => r.id)), notes };
}
