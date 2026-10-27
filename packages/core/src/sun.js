// 日の出と日の入り。
//
// 「夕日が見たい」は所要時間の計算では作れません。海・展望台・岬は、
// 何時に着くかで体験がまるごと変わります。日没だけは天気と違って
// 事前に正確に分かるので、旅程に組み込めます。
//
// NOAA の計算式をそのまま実装しています。外部APIは使いません
// （通信も課金も発生しないので、オフラインでも動きます）。

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** その日の通し番号（1月1日が1）。 */
function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

/**
 * 日の出・日の入りの時刻。
 *
 * @param {Date} date         日付（時刻は無視します）
 * @param {number} lat        緯度
 * @param {number} lng        経度
 * @param {number} [tzOffsetH] 標準時のずれ。日本は +9
 * @returns {{sunrise:Date|null, sunset:Date|null, dayLengthMin:number}}
 *   極夜・白夜のように太陽が昇らない／沈まない日は null を返します。
 */
export function sunTimes(date, lat, lng, tzOffsetH = 9) {
  const n = dayOfYear(date);

  // 太陽の赤緯と均時差（NOAA の簡易式）
  const gamma = (2 * Math.PI / 365) * (n - 1 + (12 - 12) / 24);
  const eqTime = 229.18 * (0.000075
    + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

  // 太陽高度 -0.833°（大気差と太陽の視半径のぶん）での時角
  const zenith = 90.833 * RAD;
  const latR = lat * RAD;
  const cosH = (Math.cos(zenith) - Math.sin(latR) * Math.sin(decl))
    / (Math.cos(latR) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) {
    return { sunrise: null, sunset: null, dayLengthMin: cosH > 1 ? 0 : 1440 };
  }
  const ha = Math.acos(cosH) * DEG;

  // 分単位（UTC）→ 現地時刻
  const noonUtc = 720 - 4 * lng - eqTime;
  const riseUtc = noonUtc - 4 * ha;
  const setUtc = noonUtc + 4 * ha;

  const at = (minUtc) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() + (minUtc + tzOffsetH * 60) * 60000);
  };
  return {
    sunrise: at(riseUtc), sunset: at(setUtc),
    dayLengthMin: Math.round(setUtc - riseUtc),
  };
}

/** 夕景・朝景が目当てになりやすい場所か。 */
const SCENIC = new Set([
  "展望台", "海岸", "湖", "灯台", "丘", "山", "登山", "渓谷", "国立公園",
  "国定公園", "漁港", "橋",
]);

export function isScenic(spot) {
  return SCENIC.has(spot?.category)
    || (spot?.genres ?? []).includes("view")
    || /夕日|夕陽|日の出|展望|岬|浜|浦/.test(spot?.name ?? "");
}

/**
 * 旅程に、日の入りにまつわる注記を付けます。
 *
 * 「間に合う」だけでなく「もう暗い」も言います。18時に閉まる展望台に
 * 17時に着いても、冬なら日没後で何も見えません。
 *
 * @param {object} itin
 * @returns {Array<{itemId:string, text:string, kind:string}>}
 */
export function sunNotes(itin) {
  const out = [];
  const byDay = new Map();

  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind !== "spot" || !item.place || !isScenic(item.place)) continue;
      const key = day.key;
      if (!byDay.has(key)) {
        byDay.set(key, sunTimes(item.start, item.place.lat, item.place.lng));
      }
      const { sunset } = byDay.get(key);
      if (!sunset) continue;

      const endMin = (item.end - sunset) / 60000;
      const startMin = (item.start - sunset) / 60000;
      const hhmm = `${sunset.getHours()}:${String(sunset.getMinutes()).padStart(2, "0")}`;

      if (startMin >= 30) {
        out.push({ itemId: item.id, kind: "dark",
          text: `この日の日の入りは${hhmm}です。到着時にはすでに暗くなっています。` });
      } else if (endMin >= -20 && startMin <= 20) {
        out.push({ itemId: item.id, kind: "golden",
          text: `この日の日の入りは${hhmm}。ちょうど夕景の時間に重なります。` });
      } else if (endMin < -90) {
        out.push({ itemId: item.id, kind: "early",
          text: `この日の日の入りは${hhmm}です。夕景を狙うなら`
            + `${hhmm}の30分前に着くよう組み直せます。` });
      }
    }
  }
  return out;
}
