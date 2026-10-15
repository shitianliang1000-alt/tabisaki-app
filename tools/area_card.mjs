// エリアのページの共有カード（og:image）を、収録の座標から描く道具。
//
// SNS やチャットに貼ったとき、箱根も金沢も同じ絵（og.png）では、どこの
// ページか見分けられません。かといって写真は使えません（撮った人の権利が
// あり、収録の写真は出典ごとに条件が違います）。地図のタイルも、配り元の
// 条件で焼き込んで配れないものがあります。
//
// そこで、収録している観光地の**点だけ**で描きます。5万か所の点を並べると
// 日本の形が浮かびます。
//   左: 日本ぜんたい。その県の点を色づけ。
//   右: その県だけを大きく。エリアのページなら、エリアの点と輪を重ねます。
// 字は入れません（ここでは日本語の字を描けません。題は共有先がカードの横に出します）。
//
// 絵の具は og.svg と同じ色です。依存なしの PNG（色番号つき）を書き出します。

import { deflateSync } from "node:zlib";

export const CARD_W = 1200;
export const CARD_H = 630;

/** 色番号。0 が下地です。 */
const PALETTE = [
  [0xF4, 0xF1, 0xEB], // 0 下地（og.svg の明るいほう）
  [0xE4, 0xEA, 0xEC], // 1 右の枠の下地
  [0xC9, 0xCC, 0xCC], // 2 ほかの県の点
  [0x8F, 0xC1, 0xC4], // 3 その県の点（薄）
  [0x15, 0x7A, 0x82], // 4 その県の点 / エリアの点
  [0x0F, 0x4C, 0x81], // 5 輪・枠の線
  [0xFF, 0xFD, 0xFA], // 6 輪の内側の白
];
const BG = 0, PANEL = 1, OTHER = 2, PREF_SOFT = 3, PREF = 4, INK = 5, WHITE = 6;

/** 沖縄と小笠原まで入れると本州が小さくなるので、左の日本は本土の範囲で描きます。 */
const JAPAN = { minLat: 30.9, maxLat: 45.6, minLng: 128.6, maxLng: 146.0 };

class Canvas {
  constructor(w, h, fill = BG) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h).fill(fill);
  }

  rect(x0, y0, x1, y1, c) {
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.h, y1 | 0); y++) {
      this.px.fill(c, y * this.w + Math.max(0, x0 | 0), y * this.w + Math.min(this.w, x1 | 0));
    }
  }

  /** 塗りの円。r が 0.5 以下なら1点。 */
  dot(cx, cy, r, c) {
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r + 0.25) this.px[y * this.w + x] = c;
      }
    }
  }

  /** 輪（内径 r0〜外径 r1）。 */
  ring(cx, cy, r0, r1, c) {
    for (let y = Math.max(0, Math.floor(cy - r1)); y <= Math.min(this.h - 1, Math.ceil(cy + r1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r1)); x <= Math.min(this.w - 1, Math.ceil(cx + r1)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d >= r0 && d <= r1) this.px[y * this.w + x] = c;
      }
    }
  }

  frame(x0, y0, x1, y1, t, c) {
    this.rect(x0, y0, x1, y0 + t, c);
    this.rect(x0, y1 - t, x1, y1, c);
    this.rect(x0, y0, x0 + t, y1, c);
    this.rect(x1 - t, y0, x1, y1, c);
  }

  png() {
    const raw = Buffer.alloc((this.w + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w + 1)] = 0;
      raw.set(this.px.subarray(y * this.w, (y + 1) * this.w), y * (this.w + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // 1画素8ビット
    ihdr[9] = 3; // 色番号
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk("IHDR", ihdr),
      chunk("PLTE", Buffer.from(PALETTE.flat())),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

const hasGeo = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);

/**
 * 緯度経度の範囲を、箱（x, y, w, h）の中へ縦横比を保って収める写し方。
 * 経度は緯度に応じて縮めます（北海道が横に伸びないように）。
 */
export function projector(bounds, box, pad = 0) {
  const k = Math.cos(((bounds.minLat + bounds.maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((bounds.maxLng - bounds.minLng) * k, 1e-6);
  const spanY = Math.max(bounds.maxLat - bounds.minLat, 1e-6);
  const s = Math.min((box.w - 2 * pad) / spanX, (box.h - 2 * pad) / spanY);
  const ox = box.x + (box.w - spanX * s) / 2;
  const oy = box.y + (box.h - spanY * s) / 2;
  return (lat, lng) => [ox + (lng - bounds.minLng) * k * s, oy + (bounds.maxLat - lat) * s];
}

/**
 * 点の範囲。外れ値（東京の伊豆・小笠原のような離島）で県が小さくならないよう、
 * 南北・東西の端の 3% ずつは捨てます。
 */
export function boundsOf(spots, trim = 0.03) {
  const geo = spots.filter(hasGeo);
  if (!geo.length) return null;
  const lats = geo.map((s) => s.lat).sort((a, b) => a - b);
  const lngs = geo.map((s) => s.lng).sort((a, b) => a - b);
  const cut = Math.floor(geo.length * trim);
  const lo = (a) => a[cut], hi = (a) => a[a.length - 1 - cut];
  const b = { minLat: lo(lats), maxLat: hi(lats), minLng: lo(lngs), maxLng: hi(lngs) };
  // 点が1か所に固まっていても、地図として読める広さは取ります。
  const minSpan = 0.25;
  for (const [a, z] of [["minLat", "maxLat"], ["minLng", "maxLng"]]) {
    if (b[z] - b[a] < minSpan) {
      const mid = (b[a] + b[z]) / 2;
      b[a] = mid - minSpan / 2;
      b[z] = mid + minSpan / 2;
    }
  }
  return b;
}

const inside = (b, lat, lng) => lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;

/**
 * 共有カードを1枚描きます。
 *
 * @param {{all: object[], pref: object[], region?: {lat:number,lng:number}|null, regionSpots?: object[]}} p
 *   all: 全国の点、pref: その県の点、region: エリアの中心（県のページなら無し）、
 *   regionSpots: エリアの点。
 * @returns {Buffer} PNG
 */
export function renderAreaCard({ all, pref, region = null, regionSpots = [] }) {
  const cv = new Canvas(CARD_W, CARD_H, BG);

  // 左: 日本ぜんたい
  const left = { x: 40, y: 30, w: 440, h: 570 };
  const pb = boundsOf(pref);
  // エリアが離島にあっても、右の地図から外れないようにします。
  if (pb && hasGeo(region)) {
    pb.minLat = Math.min(pb.minLat, region.lat - 0.1);
    pb.maxLat = Math.max(pb.maxLat, region.lat + 0.1);
    pb.minLng = Math.min(pb.minLng, region.lng - 0.1);
    pb.maxLng = Math.max(pb.maxLng, region.lng + 0.1);
  }
  // 沖縄のように本土の範囲の外にある県は、その県まで広げて描きます。
  const jb = pb ? { minLat: Math.min(JAPAN.minLat, pb.minLat), maxLat: Math.max(JAPAN.maxLat, pb.maxLat),
                    minLng: Math.min(JAPAN.minLng, pb.minLng), maxLng: Math.max(JAPAN.maxLng, pb.maxLng) } : JAPAN;
  const toJ = projector(jb, left, 10);
  const prefIds = new Set(pref.map((s) => s.id));
  for (const s of all) {
    if (!hasGeo(s) || prefIds.has(s.id) || !inside(jb, s.lat, s.lng)) continue;
    const [x, y] = toJ(s.lat, s.lng);
    cv.dot(x, y, 0.9, OTHER);
  }
  for (const s of pref) {
    if (!hasGeo(s) || !inside(jb, s.lat, s.lng)) continue;
    const [x, y] = toJ(s.lat, s.lng);
    cv.dot(x, y, 1.3, PREF);
  }

  // 右: その県を大きく
  const right = { x: 520, y: 30, w: 640, h: 570 };
  cv.rect(right.x, right.y, right.x + right.w, right.y + right.h, PANEL);
  cv.frame(right.x, right.y, right.x + right.w, right.y + right.h, 3, INK);
  if (pb) {
    // 左の地図に、右で拡大した範囲の枠を描きます。
    const [ax, ay] = toJ(pb.maxLat, pb.minLng);
    const [bx, by] = toJ(pb.minLat, pb.maxLng);
    const m = 4;
    cv.frame(Math.round(ax - m), Math.round(ay - m), Math.round(bx + m), Math.round(by + m), 2, INK);

    const toP = projector(pb, right, 36);
    const regionIds = new Set(regionSpots.map((s) => s.id));
    // 県境の外の点も薄く出すと、海と陸の形が分かります。
    for (const s of all) {
      if (!hasGeo(s) || prefIds.has(s.id) || !inside(pb, s.lat, s.lng)) continue;
      const [x, y] = toP(s.lat, s.lng);
      if (x > right.x + 4 && x < right.x + right.w - 4 && y > right.y + 4 && y < right.y + right.h - 4) {
        cv.dot(x, y, 1.2, OTHER);
      }
    }
    for (const s of pref) {
      if (!hasGeo(s) || regionIds.has(s.id)) continue;
      const [x, y] = toP(s.lat, s.lng);
      if (x > right.x + 4 && x < right.x + right.w - 4 && y > right.y + 4 && y < right.y + right.h - 4) {
        cv.dot(x, y, 2, region ? PREF_SOFT : PREF);
      }
    }
    for (const s of regionSpots) {
      if (!hasGeo(s)) continue;
      const [x, y] = toP(s.lat, s.lng);
      if (x > right.x + 4 && x < right.x + right.w - 4 && y > right.y + 4 && y < right.y + right.h - 4) {
        cv.dot(x, y, 3, PREF);
      }
    }
    if (hasGeo(region)) {
      const [x, y] = toP(region.lat, region.lng);
      cv.ring(x, y, 22, 30, WHITE);
      cv.ring(x, y, 26, 32, INK);
      cv.dot(x, y, 7, INK);
      // 左の日本地図にも、エリアの場所を印します。
      const [jx, jy] = toJ(region.lat, region.lng);
      cv.ring(jx, jy, 7, 10, INK);
    }
  }
  return cv.png();
}
