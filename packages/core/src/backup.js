// 予定どおりに行けなかったときの、次の一手。
//
// 旅程は「晴れていて、どこも開いている」前提で組まれています。
// 現地ではそうならないことがあります。朝から雨、行ってみたら休館、
// 工事中。そのとき困るのは、**その場で代わりを探すことになる**点です。
// 電波の弱い場所で地図を開き、開いているかどうかも分からない店を
// 見比べることになります。
//
// なので、出発前に1つだけ決めておきます。
// 「ここが駄目だったら、すぐ近くのここ」。それ以上は出しません。
// 5つ並べたら、選ぶ手間が現地に残るだけです。
//
// いちばん大事にしたこと
// ----------------------
// **代わりは、近いものだけ。** 雨で行けない海岸の代わりに、
// 40km先の美術館を出しても意味がありません。半日かけて移動したうえ、
// 元の旅程は崩れています。歩いて行ける距離（車なら少し広く）に
// 無ければ、代わりは**出しません**。
//
// そして、代わりの候補は旅程を作ったときと同じ候補集合から取ります。
// ここで知識ベース全体を引くと、旅程と関係のない土地が混ざります。
//
// 「閉まっていたら」の代わりに選ぶのは、**休館のない場所**です。
// 休館の心配がある施設の代わりに別の施設を出しても、そちらも
// 休みかもしれません。神社や海岸のように、いつでも入れる場所なら
// その心配がありません。

import { haversineKm } from "./feasibility.js";
import { hoursFor } from "./hours.js";
import { indoorness } from "./replan.js";

/** 徒歩・近場の範囲。これを超えたら「代わり」ではなく別の旅程です。 */
export const BACKUP_MAX_KM = 5;
/** 車なら少し広く見ます（それでも寄り道の範囲に収めます）。 */
export const BACKUP_MAX_KM_CAR = 15;

/** これより屋外寄りなら、雨で行けなくなる場所として扱います。 */
const OUTDOOR_LIMIT = 0.35;
/** 代わりに入れるなら、これより屋内寄りであること。 */
const INDOOR_ENOUGH = 0.65;

const FAME = { major: 2, known: 1, hidden: 0 };

/**
 * その場所が、予定どおりに行けなくなる心当たり。
 *
 * @param {object} spot
 * @param {Date} date 訪れる日
 * @returns {{rain:boolean, closed:boolean}}
 */
export function risksOf(spot, date) {
  const rain = indoorness(spot) <= OUTDOOR_LIMIT;

  // 休館の心配は、次のどちらかがあるときだけ言います。
  //   ・その曜日に休みが多い分類（hours.js が riskyDay として持っています）
  //   ・営業時間そのものが分類の目安で、定休日が分かっていない施設
  // いつでも入れる場所（alwaysOpen）には、この心配がありません。
  let closed = false;
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    const h = hoursFor(spot, date);
    closed = !h.alwaysOpen && (h.riskyDay || h.estimated);
  }
  return { rain, closed };
}

/**
 * 代わりの候補を1つ選びます。条件に合うものが無ければ null。
 *
 * @param {object} spot 元の場所
 * @param {Array} candidates 候補集合（旅程を作ったときと同じもの）
 * @param {object} [opts]
 * @param {Date} [opts.date] 訪れる日（開いているかを見ます）
 * @param {Set} [opts.exclude] 除外するスポットID
 * @param {number} [opts.maxKm]
 * @returns {object|null}
 */
export function pickBackup(spot, candidates, opts = {}) {
  const risks = opts.risks ?? risksOf(spot, opts.date);
  if (!risks.rain && !risks.closed) return null;

  const maxKm = opts.maxKm ?? BACKUP_MAX_KM;
  const exclude = opts.exclude ?? new Set();
  const date = opts.date;

  const pool = [];
  for (const c of candidates ?? []) {
    if (!c || c.id === spot?.id || exclude.has(c.id)) continue;
    const km = haversineKm(spot, c);
    if (!Number.isFinite(km) || km > maxKm) continue;

    const h = date instanceof Date ? hoursFor(c, date) : null;
    // その日に閉まっている場所は、代わりになりません
    if (h?.closed) continue;

    // 雨の代わりは屋内、休館の代わりはいつでも入れる場所。
    // 両方が心配な場所（屋外で時間も目安）は、雨のほうを優先します。
    // 雨は当日にならないと分かりませんが、屋外が濡れるのは確かです。
    if (risks.rain) {
      if (indoorness(c) < INDOOR_ENOUGH) continue;
    } else if (h && !h.alwaysOpen) {
      continue;
    }
    pool.push({ spot: c, km });
  }
  if (!pool.length) return null;

  // 近い順。同じ距離なら知名度の高いほう（外れが少ない）。
  pool.sort((a, b) => a.km - b.km
    || (FAME[b.spot.fame_tier] ?? 1) - (FAME[a.spot.fame_tier] ?? 1));
  const best = pool[0];
  return describeBackup(spot, best.spot, best.km, risks);
}

/** 距離の書き方。1km未満はメートルで出します（歩けるかどうかが分かります）。 */
export function distanceText(km) {
  if (!Number.isFinite(km)) return "";
  if (km < 1) return `約${Math.max(50, Math.round(km * 1000 / 50) * 50)}m`;
  return `約${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

/**
 * 画面に出すぶんだけを持った、代わりの案。
 *
 * スポットの丸ごとは持ちません。保存した旅程（history.js）に
 * 候補が全部入ると、1件あたりの大きさが倍になります。
 */
function describeBackup(spot, alt, km, risks) {
  const why = risks.rain && risks.closed ? "雨や休館のときは"
    : risks.rain ? "雨なら" : "閉まっていたら";
  const dist = distanceText(km);
  return {
    id: alt.id,
    name: alt.name,
    category: alt.category ?? null,
    lat: alt.lat, lng: alt.lng,
    km,
    why: risks.rain && risks.closed ? "rain-closed"
      : risks.rain ? "rain" : "closed",
    text: `${why}、${dist}の「${alt.name}」`
      + `${alt.category ? `（${alt.category}）` : ""}へ。`,
  };
}

/**
 * 旅程の各スポットに、代わりの案を1つ付けます。
 *
 * 旅程そのものは変えません。付けるのは説明だけです。
 *
 * @param {object} itin buildItinerary の結果
 * @param {Array} candidates 候補集合
 * @param {object} [opts]
 * @param {string} [opts.transport] "car" なら範囲を広く見ます
 * @returns {number} 案を付けられたスポットの数
 */
export function attachBackups(itin, candidates, opts = {}) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const pool = candidates ?? [];
  if (!pool.length) return 0;

  const maxKm = (opts.transport ?? itin?.transport) === "car"
    ? BACKUP_MAX_KM_CAR : BACKUP_MAX_KM;

  // 旅程に入っている場所は、代わりにしません（その日に行くからです）
  const visiting = new Set(days.flatMap((d) => d?.items ?? [])
    .map((i) => i.spotId ?? i.place?.id).filter(Boolean));

  let n = 0;
  for (const day of days) {
    // 同じ日のなかでは、同じ代わりを使い回しません。
    // 1日の予定が全部「雨なら◯◯美術館」になると、案として役に立ちません。
    const usedToday = new Set(visiting);
    for (const item of day?.items ?? []) {
      if (item.kind !== "spot" || !item.place) continue;
      const alt = pickBackup(item.place, pool, {
        date: item.start, exclude: usedToday, maxKm,
      });
      if (!alt) continue;
      item.backup = alt;
      usedToday.add(alt.id);
      n += 1;
    }
  }
  return n;
}
