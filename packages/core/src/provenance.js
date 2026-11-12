// データの出どころを、項目ごとに追う（Issue #426）。
//
// 収録の1件は、いくつもの出どころが混ざってできています。名前は県の観光地
// の一覧、座標は OpenStreetMap、説明はウィキペディア、分類と「定番か穴場か」
// は旅さきが付けたもの、というふうにです。出どころが違えば、ライセンスも
// 違います（CC BY-SA 4.0・ODbL・CC0・クレジットの表記が要るもの）。
//
// ここは、それを**機械で追えるようにする**ところです。
//
//   provenanceOf(spot)   項目 → 出どころ
//   splitBySource(spot)  出どころごとに項目を分けた形（保存・受け渡し用）
//   joinSources(record)  分けた形を、元の1件に戻す
//   licenseSummary(spots) 使っている出どころ・ライセンス・書くべき表記
//   attributionText(...)  画面・Markdown・.ics に添える1行
//
// 決まりは収録の印（src・geo・osm・overture・osmInfo）から読みます。印は
// 取り込みの道具（tools/import_*.py・tools/osm_enrich.py）が1件ずつ残して
// います。**推測で出どころを決めません。** 知らない印は unknown とし、
// 点検（tools/kb_provenance.mjs --check）で止めます。
//
// 通信はしません。ブラウザでも Node でも同じに動きます。

export const SPLIT_SCHEMA = "tabisaki.spot-sources/1";
export const SUMMARY_SCHEMA = "tabisaki.license-summary/1";

/**
 * 出どころの台帳。
 *
 * attribution は、相手が求めている書きかたのままです（言葉を変えません）。
 * required は「使ったら表記が要る」印です。Wikidata（CC0）と、名前だけを借りた
 * 県の観光サイトには表記の義務がないので、まとめ（sources）には出しますが、
 * 添える1行（attribution）には入れません。credits.html と同じ線引きです。
 * shareAlike は「同じ条件で配る義務（継承）がある」印です。
 */
export const SOURCES = Object.freeze({
  tabisaki_original: {
    name: "旅さきの独自データ",
    nameEn: "Tabisaki original data",
    license: "PolyForm-Noncommercial-1.0.0",
    licenseUrl: "https://polyformproject.org/licenses/noncommercial/1.0.0",
    attribution: "旅さき",
    external: false,
  },
  user: {
    name: "あなたが足したデータ",
    nameEn: "Your own data",
    license: "user",
    attribution: "",
    external: false,
  },
  wikipedia: {
    required: true,
    name: "Wikipedia",
    nameEn: "Wikipedia",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/deed.ja",
    url: "https://ja.wikipedia.org/",
    attribution: "Wikipedia の執筆者（CC BY-SA 4.0）",
    attributionEn: "Wikipedia contributors (CC BY-SA 4.0)",
    shareAlike: true,
    external: true,
  },
  wikidata: {
    name: "Wikidata",
    nameEn: "Wikidata",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/deed.ja",
    url: "https://www.wikidata.org/",
    attribution: "Wikidata（CC0）",
    attributionEn: "Wikidata (CC0)",
    external: true,
  },
  osm: {
    required: true,
    name: "OpenStreetMap",
    nameEn: "OpenStreetMap",
    license: "ODbL 1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    url: "https://www.openstreetmap.org/copyright",
    attribution: "© OpenStreetMap contributors（ODbL）",
    attributionEn: "© OpenStreetMap contributors (ODbL)",
    shareAlike: true,
    external: true,
  },
  overture: {
    required: true,
    name: "Overture Maps",
    nameEn: "Overture Maps",
    // 1件ごとに違います（CDLA-Permissive-2.0 か Apache-2.0）。収録の license を優先します。
    license: "CDLA-Permissive-2.0",
    licenseUrl: "https://docs.overturemaps.org/attribution/",
    url: "https://docs.overturemaps.org/attribution/",
    attribution: "© Overture Maps Foundation, overturemaps.org",
    external: true,
  },
  yahoo: {
    required: true,
    name: "Yahoo! JAPAN の Web サービス",
    nameEn: "Yahoo! JAPAN Web Services",
    license: "Yahoo! JAPAN Web Services terms",
    licenseUrl: "https://developer.yahoo.co.jp/attribution/",
    url: "https://developer.yahoo.co.jp/sitemap/",
    attribution: "Web Services by Yahoo! JAPAN",
    external: true,
  },
  gsi: {
    required: true,
    name: "国土地理院",
    nameEn: "Geospatial Information Authority of Japan",
    license: "国土地理院コンテンツ利用規約",
    licenseUrl: "https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html",
    url: "https://www.gsi.go.jp/",
    attribution: "国土地理院",
    attributionEn: "Geospatial Information Authority of Japan",
    external: true,
  },
  mlit_river: {
    required: true,
    name: "川の防災情報（国土交通省）",
    nameEn: "MLIT River Disaster Information",
    license: "公共データ利用規約（PDL1.0）",
    licenseUrl: "https://www.digital.go.jp/resources/open_data/public_data_license_v1.0",
    url: "https://www.river.go.jp/",
    attribution: "川の防災情報（国土交通省）を加工して作成",
    attributionEn: "MLIT River Disaster Information (edited)",
    external: true,
  },
  tourlist: {
    name: "各都道府県の公式観光サイト（名前の一覧）",
    nameEn: "Official prefectural tourism sites (names only)",
    license: "facts-only",
    attribution: "各都道府県の公式観光サイト",
    attributionEn: "Official prefectural tourism sites",
    external: true,
  },
  unknown: {
    name: "出どころが分かりません",
    nameEn: "Unknown source",
    license: "unknown",
    attribution: "",
    external: true,
  },
});

/** 表記を並べる順。義務の重いものを先に出します。 */
const ORDER = ["wikipedia", "osm", "yahoo", "overture", "gsi", "mlit_river", "wikidata", "tourlist",
  "tabisaki_original", "user", "unknown"];

const USER_ID_PREFIX = "u:";

/** Overture の施設データが1件ごとに持つライセンス（提供元で違います）。 */
const OVERTURE_LICENSES = new Set(["CDLA-Permissive-2.0", "Apache-2.0", "CC0-1.0"]);

/** 座標の取得元（geo）→ 出どころ。tools/import_tourism_coords.py が残す名前です。 */
function geoSource(geo) {
  const g = String(geo ?? "");
  if (g.startsWith("Yahoo")) return "yahoo";
  if (g === "国土地理院") return "gsi";
  if (g === "Photon" || g === "Nominatim") return "osm"; // どちらも OpenStreetMap の検索です
  if (g === "Wikipedia") return "wikipedia";
  if (g.startsWith("Web調査")) return "tabisaki_original"; // 手で調べた座標
  return "unknown";
}

/**
 * 取り込みの印（src）ごとの決まり。
 *   name … 名前の出どころ
 *   point … 座標の出どころ
 *   text … 説明の出どころ
 */
function ruleOf(spot) {
  switch (spot.src) {
    case undefined: case null: case "":
      return { name: "tabisaki_original", point: "tabisaki_original", text: "tabisaki_original" };
    case "opendata": {
      // data/extra-spots.csv。ダムは川の防災情報、ほかはウィキペディアの一覧記事。
      // 説明は分類から作った決まり文句（「◯◯市にある灯台。」）で、旅さきの文です。
      const from = spot.category === "ダム" ? "mlit_river" : "wikipedia";
      return { name: from, point: from, text: "tabisaki_original" };
    }
    case "wikidata":
      return { name: "wikidata", point: "wikidata", text: "wikipedia", contact: "wikidata" };
    case "wikipedia":
      return { name: "wikipedia", point: "wikipedia", text: "wikipedia" };
    case "wikipedia-tourlist":
      return { name: "tourlist", point: "wikipedia", text: "wikipedia" };
    case "osm-tourlist":
      return { name: "tourlist", point: "osm", text: "wikipedia" };
    case "overture-tourlist":
      return { name: "tourlist", point: "overture", text: "wikipedia" };
    case "tourlist-geocoded":
      return { name: "tourlist", point: geoSource(spot.geo), text: "wikipedia" };
    default:
      return { name: "unknown", point: "unknown", text: "unknown" };
  }
}

/** 収録が読み込みのときに足す項目（出どころの話に入れません）。 */
const DERIVED = new Set(["source", "verified", "dataSource", "vector"]);

/**
 * 1件の、項目 → 出どころ。
 * @returns {Record<string, string>} 項目の名前 → SOURCES の鍵
 */
export function provenanceOf(spot) {
  const out = {};
  if (!spot || typeof spot !== "object") return out;
  const mine = String(spot.id ?? "").startsWith(USER_ID_PREFIX);
  const rule = ruleOf(spot);
  for (const [k, v] of Object.entries(spot)) {
    if (v === undefined || k === "id") continue;
    if (mine) { out[k] = "user"; continue; }
    switch (k) {
      case "name": out[k] = rule.name; break;
      case "lat": case "lng": out[k] = rule.point; break;
      case "geo": out[k] = rule.point; break;
      case "description": out[k] = rule.text; break;
      // 記事の題。名前と同じなら名前の写しです（読み込みのときに名前で埋める
      // こともあります。kb.js の hydrate）。記事から来た中身ではないので、
      // 名前と同じ出どころにします。違う題のときだけ、ウィキペディアのものです。
      case "wikipedia": out[k] = v === spot.name ? rule.name : "wikipedia"; break;
      case "url": case "tel": out[k] = rule.contact ?? "tabisaki_original"; break;
      case "osm": case "osmInfo": out[k] = "osm"; break;
      case "overture": out[k] = "overture"; break;
      // Overture から来た1件に付く license は、その出どころの持ちものです。
      case "license": out[k] = spot.overture ? "overture" : "tabisaki_original"; break;
      case "listedIn": case "listedAs": out[k] = "tourlist"; break;
      default: out[k] = "tabisaki_original";
    }
  }
  return out;
}

/** 1件が使っている出どころ（表記の順）。 */
export function sourcesOf(spot) {
  const used = new Set(Object.values(provenanceOf(spot)));
  return ORDER.filter((id) => used.has(id));
}

/**
 * 出どころごとに項目を分けた形にします。
 *
 *   { schema, id, tabisaki_original: {…}, wikipedia: {…}, osm: {…}, license_summary }
 *
 * 1つの項目は、必ず1つの出どころにだけ入ります。だから joinSources で
 * 元の1件にそのまま戻せます（tests/provenance.test.js が全件で確かめます）。
 */
export function splitBySource(spot, { summary = true } = {}) {
  const prov = provenanceOf(spot);
  const out = { schema: SPLIT_SCHEMA, id: spot.id };
  for (const id of ORDER) {
    const part = {};
    for (const [k, src] of Object.entries(prov)) {
      if (src === id && !DERIVED.has(k)) part[k] = spot[k];
    }
    if (Object.keys(part).length) out[id] = part;
  }
  if (summary) out.license_summary = licenseSummary([spot], { counts: false });
  return out;
}

/** 分けた形かどうか。 */
export function isSplit(record) {
  return Boolean(record) && typeof record === "object" && record.schema === SPLIT_SCHEMA;
}

/** 分けた形を、元の1件に戻します。分けていない1件は、そのまま返します。 */
export function joinSources(record) {
  if (!isSplit(record)) return record;
  const out = { id: record.id };
  for (const id of ORDER) {
    const part = record[id];
    if (!part || typeof part !== "object") continue;
    for (const [k, v] of Object.entries(part)) {
      if (k in out && k !== "id") throw new Error(`同じ項目が2つの出どころにあります: ${record.id} の ${k}`);
      out[k] = v;
    }
  }
  return out;
}

/**
 * 使っている出どころ・ライセンス・書くべき表記をまとめます。
 *
 * @param {Array} spots  収録の1件（読み込んだあとの形でも、生の形でも）
 * @returns {{schema, sources: Array, licenses: string[], shareAlike: string[], attribution: string[], complete: boolean}}
 */
export function licenseSummary(spots, { counts = true, lang = "ja" } = {}) {
  const fields = new Map();
  const n = new Map();
  const own = new Map(); // 1件ごとにライセンスを持つ出どころ（Overture）
  for (const spot of spots ?? []) {
    if (!spot || typeof spot !== "object") continue;
    const seen = new Set();
    if (spot.overture && typeof spot.license === "string") {
      if (!own.has("overture")) own.set("overture", new Set());
      own.get("overture").add(spot.license);
    }
    for (const [k, src] of Object.entries(provenanceOf(spot))) {
      if (DERIVED.has(k)) continue;
      if (!fields.has(src)) fields.set(src, new Set());
      fields.get(src).add(k === "lat" || k === "lng" ? "lat,lng" : k);
      seen.add(src);
    }
    for (const src of seen) n.set(src, (n.get(src) ?? 0) + 1);
  }
  const en = lang === "en";
  const sources = ORDER.filter((id) => fields.has(id)).map((id) => {
    const s = SOURCES[id];
    return {
      id,
      name: en ? s.nameEn : s.name,
      license: own.has(id) ? [...own.get(id)].sort().join(" / ") : s.license,
      ...(s.licenseUrl ? { licenseUrl: s.licenseUrl } : {}),
      ...(s.url ? { url: s.url } : {}),
      ...(s.shareAlike ? { shareAlike: true } : {}),
      attribution: (en ? s.attributionEn : null) ?? s.attribution,
      attributionRequired: Boolean(s.required),
      fields: [...fields.get(id)].sort(),
      ...(counts ? { spots: n.get(id) ?? 0 } : {}),
    };
  });
  return {
    schema: SUMMARY_SCHEMA,
    sources,
    licenses: [...new Set(sources.map((s) => s.license))],
    shareAlike: sources.filter((s) => s.shareAlike).map((s) => s.id),
    // 書かなければいけない表記（義務のあるものだけ）。
    attribution: sources.filter((s) => s.attributionRequired).map((s) => s.attribution),
    // 出どころの分からない項目が1つも無い、という印です。
    complete: !fields.has("unknown"),
  };
}

/** 旅程の1行が指している収録の1件（無ければ null）。旅程は place に持っています。 */
export function spotOfItem(item) {
  const s = item?.place ?? item?.spot;
  return s && typeof s === "object" && s.id !== undefined && s.id !== null ? s : null;
}

/** 旅程に出てくる収録の1件（同じものは1度だけ）。 */
export function spotsOfItinerary(itinerary) {
  const byId = new Map();
  for (const day of itinerary?.days ?? []) {
    for (const item of day?.items ?? []) {
      const s = spotOfItem(item);
      if (s && !byId.has(s.id)) byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

/** 旅程ひとつ分のまとめ。 */
export function itineraryLicenseSummary(itinerary, opts) {
  return licenseSummary(spotsOfItinerary(itinerary), opts);
}

/**
 * 添える1行（「出典: A／B／C」）。外から来たデータが無ければ空です。
 * @param {object|Array} from  licenseSummary の結果か、収録の1件の並び
 */
export function attributionText(from, { lang = "ja", label } = {}) {
  const sum = Array.isArray(from) ? licenseSummary(from, { lang }) : from;
  const list = sum?.attribution ?? [];
  if (!list.length) return "";
  const en = lang === "en";
  return `${label ?? (en ? "Data sources: " : "出典: ")}${list.join(en ? " / " : "／")}`;
}

/**
 * 収録ぜんたいの点検。
 * @returns {{spots: number, bySource: Record<string, number>, problems: string[]}}
 */
export function auditSpots(spots, { limit = 20 } = {}) {
  const bySource = {};
  const problems = [];
  let count = 0;
  for (const spot of spots ?? []) {
    count++;
    const prov = provenanceOf(spot);
    const used = new Set(Object.values(prov));
    for (const id of used) bySource[id] = (bySource[id] ?? 0) + 1;
    if (used.has("unknown") && problems.length < limit) {
      const which = Object.entries(prov).filter(([, v]) => v === "unknown").map(([k]) => k).join("・");
      problems.push(`${spot.id}（${spot.name ?? ""}）: ${which} の出どころが分かりません（src=${spot.src ?? ""} geo=${spot.geo ?? ""}）`);
    }
    if (spot.overture && !OVERTURE_LICENSES.has(spot.license) && problems.length < limit) {
      problems.push(`${spot.id}: Overture の1件に、知っているライセンスが付いていません（${spot.license ?? "なし"}）`);
    }
  }
  return { spots: count, bySource, problems };
}
