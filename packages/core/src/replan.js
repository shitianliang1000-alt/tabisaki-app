// 天気・日没・混雑を見て、旅程を見直す。
//
// ここもAIには任せません。「雨の時間帯に屋外のスポットが入っているか」は、
// 降水確率と分類を突き合わせれば決まります。AIに聞くと、同じ旅程でも
// 聞くたびに違う答えが返り、なぜそうなったのかも説明できません。
//
// 出すのは**変更案**であって、旅程そのものではありません。
// 採用されたら、これまでと同じエンジン（verify.js）が組み直します。
//
// いちばん大事にしたこと
// ----------------------
// **黙って変えない。** 雨だからと勝手に行き先を差し替えられたら、
// 楽しみにしていた場所が理由も分からず消えます。理由を添えて提案し、
// 押されたときだけ組み直します。
//
// そして、分からないことは分からないと言います。予報の効かない先の
// 日付では、天気の話をいっさいしません。

import { crowdLevel } from "./crowd.js";
import { RAIN_THRESHOLD, rainAt } from "./weather.js";

/**
 * 分類ごとの「屋内らしさ」。0 = 完全に屋外、1 = 完全に屋内。
 *
 * 温泉を高めに置いているのは、露天であっても雨で中止にはならないからです。
 * 逆に展望台は屋内の建物であっても、雨では何も見えません。
 */
const INDOORNESS = {
  美術館: 0.98, 博物館: 0.98, 文化施設: 0.95, 水族館: 0.95,
  温泉: 0.85, 温泉地: 0.7, 酒蔵: 0.9, 飲食店: 0.9,
  商業施設: 0.92,
  // 市場と商店街は、屋根があるとは限りません（高知の日曜市は屋外です）。
  // 「市場だから屋内」で差し替えると、雨の中を歩かせることになります。
  市場: 0.5, 商店街: 0.55, 建築: 0.6,
  寺院: 0.45, 神社: 0.3, 教会: 0.7, 城: 0.5, 世界遺産: 0.35,
  ロープウェイ: 0.35, 乗り物: 0.6,
  町並み: 0.2, 史跡: 0.15, 庭園: 0.15, 公園: 0.1, 動物園: 0.15,
  展望台: 0.2, 灯台: 0.2, 海岸: 0.05, 漁港: 0.1, 湖: 0.05, 川: 0.05,
  滝: 0.05, 渓谷: 0.05, 山: 0.05, 丘: 0.05, 高原: 0.05, 登山: 0.02,
  国立公園: 0.05, 国定公園: 0.05, 自然: 0.05, 牧場: 0.1,
  スキー場: 0.15, テーマパーク: 0.35, 年中行事: 0.2, 観光名所: 0.4,
};

/** 知らない分類は真ん中に置きます。決めつけないためです。 */
const UNKNOWN_INDOORNESS = 0.45;

export function indoorness(spot) {
  return INDOORNESS[spot?.category] ?? UNKNOWN_INDOORNESS;
}

/** これより屋外寄りなら、雨のときに見直す対象にします。 */
const OUTDOOR_LIMIT = 0.35;
/** 代わりに入れるなら、これより屋内寄りであること。 */
const INDOOR_ENOUGH = 0.65;

/** 「夕景が見どころ」の分類。日没に間に合うかを見ます。 */
const SUNSET_SPOTS = new Set(["展望台", "灯台", "海岸", "湖", "丘", "山",
                              "高原", "渓谷", "ロープウェイ"]);

/** これを超える混雑度なら、時間をずらす提案をします。 */
const CROWD_LIMIT = 70;

const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:`
  + String(d.getMinutes()).padStart(2, "0");

/**
 * 旅程を見直して、変更案を出します。
 *
 * @param {object} itin buildItinerary の結果
 * @param {object} ctx
 * @param {Object<number, object>} ctx.weather  日index → forecastFor の結果
 * @param {Object<number, Date>}  [ctx.sunset]  日index → 日没時刻
 * @param {Array} [ctx.candidates] 差し替え候補になるスポット
 * @returns {{suggestions:Array, notes:string[]}}
 */
export function suggestReplan(itin, ctx = {}) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const suggestions = [];
  const notes = [];
  const candidates = ctx.candidates ?? [];

  // すでに旅程に入っている場所は、差し替え先にしません
  const used = new Set(days.flatMap((d) => (d?.items ?? []))
    .map((i) => i.spotId ?? i.place?.id).filter(Boolean));

  days.forEach((day, di) => {
    const items = (day?.items ?? []).filter((i) => i.kind === "spot" && i.place);
    const forecast = ctx.weather?.[di];
    const sunset = ctx.sunset?.[di];

    // --- 雨 ---
    if (forecast?.ok) {
      for (const item of items) {
        const rain = rainAt(forecast, item.start);
        if (rain < RAIN_THRESHOLD) continue;
        if (indoorness(item.place) > OUTDOOR_LIMIT) continue;

        const alt = pickIndoorAlternative(item.place, candidates,
                                          { exclude: used });
        const when = `${di + 1}日目 ${fmtTime(item.start)}`;
        suggestions.push({
          kind: "rain", day: di, itemId: item.id,
          spotId: item.spotId ?? item.place.id,
          alternative: alt,
          text: alt
            ? `${when}の「${item.place.name}」は屋外です。`
              + `この時間の降水確率は ${Math.round(rain)}% なので、`
              + `屋内の「${alt.name}」に入れ替えられます。`
            : `${when}の「${item.place.name}」は屋外です。`
              + `この時間の降水確率は ${Math.round(rain)}% です`
              + "（近くに屋内の代わりが見つかりませんでした）。",
          apply: alt
            ? { avoid: item.spotId ?? item.place.id, pin: alt.id }
            : null,
        });
        if (alt) used.add(alt.id);
      }
    } else if (forecast?.reason && !notes.includes(forecast.reason)) {
      notes.push(forecast.reason);
    }

    // --- 日没 ---
    if (sunset instanceof Date) {
      for (const item of items) {
        if (!SUNSET_SPOTS.has(item.place.category)) continue;
        if (item.start <= sunset) continue;
        suggestions.push({
          kind: "sunset", day: di, itemId: item.id,
          spotId: item.spotId ?? item.place.id,
          text: `${di + 1}日目の「${item.place.name}」は `
            + `${fmtTime(item.start)} 着ですが、この日の日没は `
            + `${fmtTime(sunset)} です。着くころには暗くなっています。`
            + "先に回すよう組み直せます。",
          apply: { pinFirst: item.spotId ?? item.place.id },
        });
      }
    }

    // --- 混雑 ---
    for (const item of items) {
      const c = crowdLevel(item.place, item.start);
      if (c.score < CROWD_LIMIT) continue;
      // 朝いちに回して意味があるか（すでに朝なら言いません）
      if (item.start.getHours() <= 9) continue;
      suggestions.push({
        kind: "crowd", day: di, itemId: item.id,
        spotId: item.spotId ?? item.place.id,
        text: `${di + 1}日目の「${item.place.name}」は `
          + `${fmtTime(item.start)} 着です。${c.label}の時間帯なので`
          + `（${c.reasons.slice(0, 2).join("・")}）、`
          + "朝いちに回すと落ち着いて見られます。",
        apply: { pinFirst: item.spotId ?? item.place.id },
      });
    }
  });

  return { suggestions, notes };
}

/**
 * 雨のときの代わりになる場所を選びます。
 *
 * 近いこと、屋内であること、まだ旅程に入っていないこと。
 * 条件に合うものが無ければ **null を返します**。無理に差し替えると、
 * 遠くの関係ない場所が旅程に入り込みます。
 */
export function pickIndoorAlternative(spot, candidates, opts = {}) {
  const exclude = opts.exclude ?? new Set();
  const pool = (candidates ?? []).filter((c) =>
    c && c.id !== spot?.id && !exclude.has(c.id)
    && indoorness(c) >= INDOOR_ENOUGH);
  if (!pool.length) return null;

  // 近い順。距離が同じなら、知名度の高いほうを選びます
  const near = pool.map((c) => ({
    spot: c,
    km: distanceKm(spot, c),
    fame: { major: 2, known: 1, hidden: 0 }[c.fame_tier] ?? 1,
  })).sort((a, b) => a.km - b.km || b.fame - a.fame);
  return near[0].spot;
}

function distanceKm(a, b) {
  if (!Number.isFinite(a?.lat) || !Number.isFinite(b?.lat)) return Infinity;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 採用された提案を、条件に反映します。元の条件は書き換えません。
 *
 * 組み直しは、これまでと同じ pipeline.js が行います。
 * ここでやるのは「この場所を外す」「この場所を入れる」だけです。
 */
export function applyReplan(trip, suggestions) {
  const next = {
    ...trip,
    must: {
      ...trip.must,
      spotIds: [...(trip.must?.spotIds ?? [])],
      avoidSpotIds: [...(trip.must?.avoidSpotIds ?? [])],
    },
  };
  for (const s of suggestions ?? []) {
    const a = s?.apply;
    if (!a) continue;
    if (a.avoid && !next.must.avoidSpotIds.includes(a.avoid)) {
      next.must.avoidSpotIds.push(a.avoid);
    }
    for (const id of [a.pin, a.pinFirst].filter(Boolean)) {
      if (!next.must.spotIds.includes(id)) next.must.spotIds.push(id);
    }
  }
  // 外すと入れるがぶつかったら、入れるほうを残します
  next.must.avoidSpotIds = next.must.avoidSpotIds
    .filter((id) => !next.must.spotIds.includes(id));
  return next;
}
