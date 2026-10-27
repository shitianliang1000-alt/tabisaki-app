// 画面・出力の文を言語ごとに引く（locales/*.json）。ブラウザでも Node.js でも動くよう、ファイルは読みません。
// 決まりは docs/i18n.md にあります。
//
//     const i = createI18n("en", { ja, en });
//     i.t("plan.day", { n: 2 })          // "Day 2"
//     i.t("plan.days", { n: 1 })         // 数で形が変わる文は .one / .other を引く
//     i.time(date) / i.date(date) / i.yen(1200) / i.km(3.25)

/** 原文の言語。訳が無いときはこれに戻ります。 */
export const SOURCE_LANG = "ja";
/** いま出せる言語（locales/ にあるもの）。 */
export const LANGS = ["ja", "en"];
/** 旅程の時刻は、使う人の端末の時間帯によらず日本時間で出します。 */
export const TIME_ZONE = "Asia/Tokyo";

/**
 * "en-US"・"en_US.UTF-8"・"EN" などを、LANGS のどれかにします。当てはまらなければ null。
 * @param {string|undefined|null} input
 */
export function pickLang(input) {
  const base = String(input ?? "").trim().toLowerCase().split(/[-_.@]/)[0];
  return LANGS.includes(base) ? base : null;
}

const intlLocale = { ja: "ja-JP", en: "en-US" };

/**
 * @param {string} lang
 * @param {Record<string, Record<string, any>>} catalogs { ja: {...}, en: {...} }
 */
export function createI18n(lang, catalogs) {
  const want = pickLang(lang) ?? SOURCE_LANG;
  const own = catalogs[want] ?? {};
  const src = catalogs[SOURCE_LANG] ?? {};
  const locale = intlLocale[want];
  const plural = new Intl.PluralRules(locale);

  // 訳が無い鍵は原文（日本語）に戻す。原文にも無ければ鍵そのものを出す（気づけるように）。
  const lookup = (key) => own[key] ?? src[key];

  function t(key, vars = {}) {
    let s = lookup(key);
    if (s === undefined && Number.isFinite(vars.n)) {
      s = own[`${key}.${plural.select(vars.n)}`] ?? own[`${key}.other`] ?? src[`${key}.other`];
    }
    if (typeof s !== "string") return key;
    return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  }

  const timeFmt = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, month: want === "ja" ? "numeric" : "short", day: "numeric", weekday: "short" });
  const yenFmt = new Intl.NumberFormat(locale, { style: "currency", currency: "JPY" });

  return {
    lang: want,
    t,
    time: (d) => timeFmt.format(new Date(d)),
    date: (d) => dateFmt.format(new Date(d)),
    // 日本語は「1,200円」（いままでの出力と同じ）、ほかは通貨記号つき（¥1,200）。
    yen: (n) => (want === "ja" ? `${Math.round(n).toLocaleString("ja-JP")}円` : yenFmt.format(Math.round(n))),
    // 距離はどの言語も km（旅程の目安なので、マイルには直しません）。
    km: (n) => t("unit.km", { km: n.toFixed(1) }),
  };
}

/**
 * スポットの名前・説明を、訳の重ね合わせ（kb/i18n/<言語>/）から引きます。
 * 訳が無い・原文が変わって古くなった訳は使わず、原文を返します（original: true）。
 * @param {{id: string, name: string, description?: string}} spot
 * @param {Record<string, {name?: string, description?: string, sourceHash?: string}>|undefined} overlay
 */
export function localizeSpot(spot, overlay) {
  const tr = overlay?.[spot.id];
  const base = { name: spot.name, description: spot.description ?? "", original: true };
  if (!tr || tr.sourceHash !== sourceHash(spot)) return base;
  return { name: tr.name || spot.name, description: tr.description || base.description, original: false };
}

/**
 * 訳の元になった原文の指紋（名前と説明から作る短い値）。原文が直ったら値が変わり、訳は古いと分かります。
 * 32ビットの FNV-1a を16進8桁で。暗号ではなく、変わったかどうかを見るためだけのものです。
 */
export function sourceHash(spot) {
  const s = `${spot.name}\u0000${spot.description ?? ""}`;
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
