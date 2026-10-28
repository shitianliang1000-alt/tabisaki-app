// 知識ベースの分類・エリアを直すルール（tools/fix_kb_quality.mjs と tests/kb-quality.test.js が使います）。
//
// 名前を見れば分類がはっきり決まるものだけを直します。名前だけでは決めきれないもの
// （「記念館」が美術館か博物館か、など）は触りません。

export function km(a, b) {
  const R = 6371;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const SKI = /スキー場|スノーパーク|スキーリゾート|スノーリゾート/;
const SHRINE = /(神社|大社|神宮)$/;
const TEMPLE = /(寺|院)$/;
const KAMI = /神社|大社|神宮|八幡宮|天満宮/;
const MUSEUM = /(博物館|資料館|歴史館|郷土館|科学館)$/;

/**
 * 名前と分類が食い違っているとき、正しい分類を返します。直さなくてよければ null。
 * @returns {{to: string, why: string} | null}
 */
export function categoryFix(s) {
  const name = String(s.name ?? "");
  const cat = s.category;
  if (SKI.test(name) && cat !== "スキー場") return { to: "スキー場", why: "名前がスキー場" };
  if (name.startsWith("道の駅") && (cat === "温泉" || cat === "観光名所")) return { to: "道の駅", why: "名前が道の駅" };
  if (name.endsWith("美術館") && (cat === "博物館" || cat === "文化施設")) return { to: "美術館", why: "名前が美術館" };
  if (MUSEUM.test(name) && !name.includes("美術") && cat === "美術館") return { to: "博物館", why: "名前が博物館・資料館" };
  if (TEMPLE.test(name) && !KAMI.test(name) && cat === "神社") return { to: "寺院", why: "名前が寺・院" };
  if (SHRINE.test(name) && cat === "寺院") return { to: "神社", why: "名前が神社" };
  return null;
}

/**
 * スポットが別の県のエリアにぶら下がっている、またはエリアの中心から遠すぎるとき、
 * 同じ県でいちばん近いエリアを返します。直さなくてよければ null。
 * @param {object} s スポット
 * @param {string} pref スポットが入っている県（シャードの県）
 * @param {Map<string, object>} byId エリアの表
 * @param {object[]} regions エリアの一覧
 */
export function regionFix(s, pref, byId, regions) {
  const cur = byId.get(s.regionId);
  let best = null;
  let bestKm = Infinity;
  for (const r of regions) {
    if (r.prefecture !== pref || typeof r.lat !== "number") continue;
    const d = km(s, r);
    if (d < bestKm) { best = r; bestKm = d; }
  }
  if (!best || !cur || best.id === cur.id) return null;
  if (cur.prefecture !== pref) return best;
  const curKm = km(s, cur);
  if (curKm > 40 && bestKm < curKm / 2) return best;
  return null;
}
