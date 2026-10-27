// 宿をどこに取るかを決める。
//
// これまでは「そのエリアの中心座標」で宿を探していました。エリアの中心は
// 収録スポットの重心なので、富士山エリアなら**山頂付近**、祖谷渓なら
// **谷底**になります。そこにホテルはありません。
// （実際に「とんでもないところで提案してくる」状態でした。）
//
// 宿は地形ではなく人の営みのあるところにあります。判断の材料は
//
//   ・そのエリアに宿がありそうか（温泉地・街・門前町か、山・渓谷だけか）
//   ・駅や港など、人が集まる地点はどこか
//   ・無さそうなら、近くのどの町に取るか
//
// で、どれも収録データから機械的に出せます。中心座標を使わないこと自体が
// 修正の核心です。

import { haversineKm } from "./feasibility.js";

/** 宿がある土地の性格。 */
const STAY_GENRES = { onsen: 3, city: 3, food: 2, art: 1, sea: 1 };

/** 宿が無さそうな場所の分類。ここしか無いエリアは拠点に向きません。 */
const WILD_CATEGORIES = new Set([
  "山", "登山", "丘", "渓谷", "滝", "湖", "川", "海岸", "展望台", "灯台",
  "国立公園", "国定公園", "ロープウェイ", "スキー場", "牧場",
]);

/** 人が集まる地点の目印。 */
const HUB_WORDS = /(駅|港|ターミナル|温泉|街|町|市)/;

/**
 * そのエリアに泊まれそうか。大きいほど泊まりやすい。
 *
 * @param {object} region
 * @param {Array} [spots] そのエリアの収録スポット
 * @returns {number}
 */
export function lodgingScore(region, spots = []) {
  let score = 0;
  for (const g of region.genres ?? []) score += STAY_GENRES[g] ?? 0;

  const cats = spots.map((s) => s.category);
  const wild = cats.filter((c) => WILD_CATEGORIES.has(c)).length;
  const town = cats.length - wild;
  if (cats.length) {
    // 山や渓谷しか無いエリアは、宿を取る場所ではありません
    if (town === 0) score -= 4;
    else score += Math.min(3, town);
  }
  if (HUB_WORDS.test(region.station ?? "")) score += 1;

  // 温泉と名の付くスポットがあるなら、まず宿はあります
  if (spots.some((s) => /温泉/.test(s.name) || s.category === "温泉")) score += 3;
  return score;
}

/** 泊まれると判断する下限。 */
export const STAYABLE = 3;

const stationOf = (region) => ({
  lat: region.stationLat ?? region.lat,
  lng: region.stationLng ?? region.lng,
  name: region.station || region.name,
});

/**
 * その夜の宿を取る場所を決めます。
 *
 * @param {object} args
 * @param {object} args.region       その日に回るエリア
 * @param {object} args.kb           近くの町を探すための知識ベース
 * @param {object} [args.explicit]   利用者が指定した宿（あればこれが最優先）
 * @param {number} [args.maxDetourKm] 隣町まで許す距離
 * @returns {{place:{lat,lng,name}, regionName:string, reason:string,
 *            movedFrom:string|null}}
 */
export function pickLodging({ region, kb, explicit = null, maxDetourKm = 45 }) {
  if (explicit?.place) {
    return {
      place: explicit.place, regionName: explicit.place.name,
      reason: "指定された宿泊地です", movedFrom: null,
    };
  }

  const spots = kb?.spotsByRegion?.get(region.id) ?? [];
  const here = lodgingScore(region, spots);
  const station = stationOf(region);

  if (here >= STAYABLE) {
    // 探すときの名前は、宿がある土地の呼び名にします。
    // 「富士山 ホテル」で探すと山を探しに行ってしまうので、
    // 温泉地や街でないエリアは駅名（＝麓の町）で探します。
    const townish = (region.genres ?? []).some((g) => g === "onsen" || g === "city");
    const name = townish ? region.name : (region.station || region.name);
    return {
      place: station, regionName: name,
      reason: `${name}の周辺に宿を取ります`, movedFrom: null,
    };
  }

  // 泊まりにくいエリア（山・渓谷など）。近くの町を探します。
  let best = null;
  for (const other of kb?.regions ?? []) {
    if (other.id === region.id) continue;
    const otherSpots = kb.spotsByRegion.get(other.id) ?? [];
    const score = lodgingScore(other, otherSpots);
    if (score < STAYABLE) continue;
    const km = haversineKm(station, stationOf(other));
    if (km > maxDetourKm) continue;
    // 近いほど、泊まりやすいほど良い
    const value = score - km / 12;
    if (!best || value > best.value) best = { region: other, km, value };
  }

  if (best) {
    return {
      place: stationOf(best.region),
      regionName: best.region.name,
      reason: `${region.name}には宿が少ないため、`
        + `約${Math.round(best.km)}km離れた${best.region.name}に宿を取ります`,
      movedFrom: region.name,
    };
  }

  // 近くに町が無い場合でも、中心座標だけは使いません。
  // 駅・港・バス停の周りにしか宿は無いからです。
  return {
    place: station, regionName: region.station || region.name,
    reason: `${region.station || region.name}の周辺で宿を探します`,
    movedFrom: null,
  };
}

/**
 * 泊まる場所として不適切な座標を弾く安全網。
 * 「中心座標のまま宿を探していないか」を、あとから確かめられるようにします。
 */
export function isPlausibleLodging(place, region) {
  if (!place) return false;
  const c = { lat: region.lat, lng: region.lng };
  // エリアの中心そのものは、山頂や谷底になりうるので採用しない
  return haversineKm(place, c) > 0.05
    || haversineKm({ lat: region.stationLat, lng: region.stationLng }, c) <= 0.05;
}
