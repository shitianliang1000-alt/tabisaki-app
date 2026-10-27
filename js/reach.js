// 「必ず行く場所」に入れたとき、出発地からどれくらい離れているかの目安。
//
// 旅程を組み始めてから「時間内に行けません」と言われるより、
// 入れた時点で「新幹線・特急で約3時間」と見えていたほうが、
// 日帰りでは無理だと先に気づけます。
//
// 直線距離から見積もる目安です（packages/core/src/geo.js の travelMinutes）。
// 経路は調べません。だから必ず「約」と「目安」を付けて出します。
import { haversineKm } from "../packages/core/src/feasibility.js";
import { travelLabel, travelMinutes } from "../packages/core/src/geo.js";
import { fmtMinutes } from "./orderdiff.js";

/** 日帰りで往復すると、観光の時間がほとんど残らない片道の長さ（分）。 */
export const FAR_FOR_DAY_MIN = 180;

/**
 * @param {{name?:string, lat:number, lng:number}|null} from 出発地
 * @param {{lat:number, lng:number}} spot
 * @returns {{text:string, far:boolean}|null} 座標が無ければ null
 */
export function reachOf(from, spot) {
  if (!Number.isFinite(from?.lat) || !Number.isFinite(from?.lng)) return null;
  if (!Number.isFinite(spot?.lat) || !Number.isFinite(spot?.lng)) return null;
  const km = haversineKm(from, spot);
  const head = from.name ? `${from.name}から` : "出発地から";
  if (travelLabel(km) === "徒歩") return { text: `${head}徒歩圏内`, far: false };
  // 10分単位に丸めます。直線からの見積もりに1分の桁を出すと、
  // 調べた数字のように見えてしまいます。
  const min = Math.max(10, Math.round(travelMinutes(from, spot) / 10) * 10);
  return {
    text: `${head}${travelLabel(km)}で約${fmtMinutes(min)}（目安）`,
    far: min >= FAR_FOR_DAY_MIN,
  };
}
