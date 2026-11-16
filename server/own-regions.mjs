// 自前エンジン（own）が答える地域の定義。
//
// v1 は熊本のみ。bbox は、従来の OTP 地域定義（熊本）の osm.bbox を
// そのまま引き継いでいます。
//
// 将来は、この定義を Workers KV の地域レジストリ（bbox・採用フィード・
// 有効期限）へ移し、コードを変えずに地域を足せるようにします。
// ここに置くのは、その移行までの間の小さな表です。

export const OWN_REGIONS = [
  { id: "kumamoto", name: "熊本", bbox: [130.45, 32.60, 131.10, 33.05] },
];

const inside = (p, bbox) => p && p.lng >= bbox[0] && p.lat >= bbox[1] && p.lng <= bbox[2] && p.lat <= bbox[3];

/**
 * 出発・到着の両方が同じ採用地域の中にあるときだけ、その地域を返します。
 * 地域の外（または地域をまたぐ）なら null で、自前エンジンは試しません。
 */
export function ownRegionFor(fromAt, toAt) {
  for (const r of OWN_REGIONS) {
    if (inside(fromAt, r.bbox) && inside(toAt, r.bbox)) return r;
  }
  return null;
}
