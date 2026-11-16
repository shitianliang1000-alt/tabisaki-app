// geohash（Base32）の符号化と近傍セル。自前エンジンの停留所マスタを
// Workers KV にセル分割で置くために使います（tools/own_convert.py の
// --kv が書き出すキーと、ここの読み取りで同じ符号化を使います）。
//
// 精度 5 のセルはおよそ 4.9km 四方です。半径 1,500m の最寄り探しなら、
// 自分のセルと周囲 8 セル（3×3）を読めば必ず足ります。

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** 緯度・経度を geohash（精度 precision）にします。 */
export function geohashEncode(lat, lon, precision = 5) {
  let latR = [-90, 90], lonR = [-180, 180];
  let hash = "", bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lonR[0] + lonR[1]) / 2;
      if (lon >= mid) { ch = ch * 2 + 1; lonR[0] = mid; } else { ch = ch * 2; lonR[1] = mid; }
    } else {
      const mid = (latR[0] + latR[1]) / 2;
      if (lat >= mid) { ch = ch * 2 + 1; latR[0] = mid; } else { ch = ch * 2; latR[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

/** geohash のセルの範囲（南西と北東の角）を返します。 */
export function geohashBounds(hash) {
  let latR = [-90, 90], lonR = [-180, 180], even = true;
  for (const c of hash) {
    const v = BASE32.indexOf(c);
    for (let n = 4; n >= 0; n--) {
      const bit = (v >> n) & 1;
      if (even) { const mid = (lonR[0] + lonR[1]) / 2; if (bit) lonR[0] = mid; else lonR[1] = mid; }
      else { const mid = (latR[0] + latR[1]) / 2; if (bit) latR[0] = mid; else latR[1] = mid; }
      even = !even;
    }
  }
  return { minLat: latR[0], maxLat: latR[1], minLon: lonR[0], maxLon: lonR[1] };
}

/** 自分のセルと周囲 8 セル（3×3）の geohash を返します。 */
export function geohashNeighbors(hash) {
  const b = geohashBounds(hash);
  const h = b.maxLat - b.minLat, w = b.maxLon - b.minLon;
  const clat = (b.minLat + b.maxLat) / 2, clon = (b.minLon + b.maxLon) / 2;
  const out = [];
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      out.push(geohashEncode(clat + dy * h, clon + dx * w, hash.length));
    }
  }
  return [...new Set(out)];
}
