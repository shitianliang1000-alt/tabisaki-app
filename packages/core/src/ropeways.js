// ロープウェイの乗り場（kb/ropeways.json、tools/build_ropeways.mjs で作成）。
//
// 山頂のスポットには、駅もバス停もありません。人が通るのは
//
//   麓のバス停・駅 → ロープウェイの山麓駅 →（ロープウェイ）→ 山頂駅
//   →（歩く）→ 山頂
//
// です。山頂を「位置」や「近くの停留所の名前」で Yahoo!路線情報に
// 聞いても答えは返らず、回数だけを使っていました。ロープウェイが
// 架かっているなら、聞く先は山麓駅です。架かっていないなら、
// それも旅程に書きます（「ロープウェイはありません。登山道を歩きます」）。

import { appUrl } from "./root.js";
import { haversineKm } from "./feasibility.js";

/**
 * 山頂駅からここまでなら、ロープウェイで上がって歩く道として案内します。
 * 黒岳ロープウェイの山頂駅（五合目）から黒岳の頂上まで約2.2km、
 * 旭岳ロープウェイの姿見駅から旭岳の頂上まで約2.9kmです（直線）。
 *
 * 広げすぎると、別の山の展望台へ上がるロープウェイを勧めます。
 * 明智平ロープウェイの山頂駅は男体山の頂上から約3.7kmですが、
 * 中禅寺湖を挟んだ向かいの展望台で、男体山へは登れません。
 */
export const ROPEWAY_REACH_KM = 3.2;

/** 1本待つ時間の目安（分）。多くは15〜20分おきに出ます。 */
const ROPEWAY_WAIT_MIN = 8;
/** 乗っている速さ（km/分）。毎秒5m前後で動きます。 */
const ROPEWAY_KM_PER_MIN = 0.3;

let loaded = null;
let injected = null;

async function load() {
  if (injected) return injected;
  loaded ??= (async () => {
    try {
      const url = appUrl("kb/ropeways.json");
      const res = await fetch(url);
      if (!res.ok) return [];
      const doc = await res.json();
      return Array.isArray(doc?.ropeways) ? doc.ropeways : [];
    } catch {
      // 読めなくても経路は組めます（ロープウェイを案内しないだけ）。
      return [];
    }
  })();
  return loaded;
}

/** 試験用に、一覧を差し替えます。null で元に戻します。 */
export function setRopewaysForTest(list) {
  injected = Array.isArray(list) ? list : null;
  loaded = null;
}

/** ロープウェイに乗っている時間と、1本待つ時間（分）。 */
export function ropewayMinutes(rw) {
  const ride = Math.max(3, Math.round((Number(rw?.km) || 1) / ROPEWAY_KM_PER_MIN));
  return { ride, wait: ROPEWAY_WAIT_MIN, total: ride + ROPEWAY_WAIT_MIN };
}

/**
 * その場所へ上がるロープウェイ。無ければ null。
 *
 * 山頂駅が近く、しかも山麓駅より山頂駅のほうが近いものだけです
 * （麓の温泉街にいる人に、ロープウェイを勧めても意味がありません）。
 *
 * @param {{lat:number,lng:number}} point
 * @returns {Promise<null|{name:string, base:object, top:object, km:number,
 *                         hikeKm:number}>}
 */
export async function ropewayNear(point, reachKm = ROPEWAY_REACH_KM) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return null;
  let best = null;
  for (const rw of await load()) {
    if (!rw?.top || !rw?.base) continue;
    const toTop = haversineKm(point, rw.top);
    if (toTop > reachKm) continue;
    if (haversineKm(point, rw.base) <= toTop) continue;
    if (!best || toTop < best.hikeKm) best = { ...rw, hikeKm: toTop };
  }
  return best;
}
