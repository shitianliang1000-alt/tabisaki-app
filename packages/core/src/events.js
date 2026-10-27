// 「その時期ならではのもの」を旅程に入れる。
//
// 9月の京都と11月の京都は、同じ場所でも別の旅です。紅葉、桜、新緑、
// 雪。場所と時間だけを見ていると、これが全部こぼれます。
//
// ここで扱うのは **時期で決まるもの** だけです。
//
// 個別の催しの日程（花火大会、祭り、企画展）は毎年変わるので、
// こちらでは持ちません。持てば必ず古くなり、古い日程を自信ありげに
// 出すのは、何も言わないより悪いからです。そちらはAIが調べたぶんを
// 受け取り、日付と場所を機械的に確かめてから使います。

/** その時期らしさが効く期間と、効く分類。 */
export const SEASONS = [
  {
    key: "sakura", label: "桜", from: "03-20", to: "04-20",
    categories: ["公園", "庭園", "城", "史跡", "神社", "寺院", "川", "湖",
                 "町並み", "高原"],
    text: "桜の時期です。開花はその年の気温で1〜2週間ずれます。",
  },
  {
    key: "green", label: "新緑", from: "04-25", to: "06-10",
    categories: ["渓谷", "滝", "山", "高原", "国立公園", "国定公園",
                 "自然", "庭園", "公園"],
    text: "新緑の時期です。人出は紅葉の時期より落ち着いています。",
  },
  {
    key: "summer", label: "夏", from: "07-01", to: "08-31",
    categories: ["海岸", "湖", "川", "滝", "渓谷", "漁港", "高原", "山"],
    text: "夏の盛りです。日中の暑さと、日焼け・水分にご注意ください。",
  },
  {
    key: "autumn", label: "紅葉", from: "10-20", to: "12-05",
    categories: ["渓谷", "滝", "山", "高原", "庭園", "公園", "寺院", "神社",
                 "城", "国立公園", "国定公園", "自然", "湖"],
    text: "紅葉の時期です。見ごろは標高と天候で前後し、"
      + "週末は道路も社寺も混みます。",
  },
  {
    key: "winter", label: "冬", from: "12-15", to: "02-28",
    categories: ["スキー場", "温泉", "温泉地", "山", "高原", "展望台",
                 "ロープウェイ", "湖"],
    text: "冬の時期です。積雪や路面凍結で、閉鎖される道や施設があります。",
  },
];

const mmdd = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}-`
  + String(d.getDate()).padStart(2, "0");

/** 年をまたぐ期間（12-15 〜 02-28）も扱います。 */
function inRange(today, from, to) {
  if (from <= to) return today >= from && today <= to;
  return today >= from || today <= to;
}

/**
 * その場所・その日にあてはまる時期。
 * 分類が合わないものには言いません（美術館に紅葉の話をしない）。
 */
export function seasonalFor(spot, date) {
  if (!spot || !(date instanceof Date)) return [];
  const today = mmdd(date);
  return SEASONS.filter((s) =>
    inRange(today, s.from, s.to) && s.categories.includes(spot.category));
}

/**
 * 旅程ぜんぶぶんの、時期の注意。
 * 同じ注意を何度も並べません（読み飛ばされます）。
 */
export function eventNotesFor(itin) {
  const seen = new Map();   // 時期のkey → 場所の名前
  for (const day of itin?.days ?? []) {
    for (const item of day?.items ?? []) {
      if (item.kind !== "spot" || !item.place) continue;
      for (const s of seasonalFor(item.place, item.start ?? day.date)) {
        if (!seen.has(s.key)) seen.set(s.key, { season: s, names: [] });
        const e = seen.get(s.key);
        if (!e.names.includes(item.place.name)) e.names.push(item.place.name);
      }
    }
  }
  return [...seen.values()].map(({ season, names }) =>
    `${names.slice(0, 3).join("・")}`
    + (names.length > 3 ? `ほか${names.length - 3}か所` : "")
    + ` — ${season.text}`);
}

// --- AIが調べたイベント -----------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * AIが返したイベントを、使える形に絞ります。
 *
 * 日付が読めないもの、旅の期間とかぶらないものは落とします。
 * 「たぶんこの時期」で旅程に入れると、行ってみたら終わっていた、
 * ということが起きます。
 *
 * @param {Array} list AIの返答
 * @param {{from:Date, to:Date}} span 旅の期間
 */
export function validateEvents(list, span) {
  const from = span?.from instanceof Date ? span.from : null;
  const to = span?.to instanceof Date ? span.to : null;
  if (!from || !to) return [];

  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const name = String(e?.name ?? "").trim();
    if (!name || name.length > 60) continue;
    const s = String(e?.from ?? "");
    const t = String(e?.to ?? s);
    if (!ISO.test(s) || !ISO.test(t)) continue;

    const a = new Date(`${s}T00:00`);
    const b = new Date(`${t}T23:59`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) continue;
    // 旅の期間と1日でも重なるか
    if (b < from || a > to) continue;

    out.push({
      name, from: s, to: t,
      place: String(e?.place ?? "").slice(0, 40),
      note: String(e?.note ?? "").slice(0, 120),
      url: /^https:\/\//.test(e?.url ?? "") ? e.url : "",
      source: "ai", verified: false,
    });
    if (out.length >= 8) break;
  }
  return out;
}
