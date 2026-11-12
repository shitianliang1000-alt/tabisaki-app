// スポットの取り込み・書き出し（CSV・GeoJSON・KML・JSON）と、重なりの見つけかた。
//
// ユーザーKB（userkb.mjs）に入れる前の「外のファイル ⇄ スポットの項目」の変換だけを受け持ちます。
// ファイルを書く・ユーザーKBに入れるのは呼ぶ側（packages/cli/bin/spotkb.mjs）です。
// 形の決まりは docs/user-kb.md の「取り込み・書き出し」にあります。

import { SPOT_FIELDS, validateSpot } from "./userkb.mjs";
import { licenseSummary, sourcesOf } from "./src/provenance.js";

/** 書き出すファイルの形の版。CSV では列の並び、GeoJSON・KML・JSON では中に書きます。 */
export const EXPORT_SCHEMA = "tabisaki.spots/1";
export const FORMATS = ["csv", "geojson", "kml", "json"];
/** 取り込む行の上限。これより多いファイルは、分けて取り込んでもらいます。 */
export const MAX_ROWS = 20000;

/** CSV の列。この並びで書き出します（id は書き出しにだけ入り、取り込みでは使いません）。 */
export const CSV_COLUMNS = ["id", "name", "lat", "lng", "category", "genres", "regionId", "description",
  "address", "url", "wikipedia", "tel", "fame_tier", "dwell", "open", "close", "fee"];

/** 書き出しにだけ付く列（その行のデータの出どころ）。 */
export const SOURCES_COLUMN = "sources";

// 取り込むときの列名の言いかえ（小文字にしてから引きます）。
const ALIASES = {
  name: ["name", "名前", "名称", "スポット名", "title", "施設名"],
  lat: ["lat", "緯度", "latitude", "y"],
  lng: ["lng", "lon", "long", "経度", "longitude", "x"],
  category: ["category", "分類", "種類", "カテゴリ", "カテゴリー"],
  genres: ["genres", "genre", "ジャンル"],
  regionId: ["regionid", "region_id", "エリアid"],
  description: ["description", "説明", "紹介", "desc", "メモ"],
  address: ["address", "住所", "所在地"],
  url: ["url", "website", "web", "ホームページ", "公式サイト"],
  wikipedia: ["wikipedia"],
  tel: ["tel", "phone", "電話", "電話番号"],
  fame_tier: ["fame_tier", "知名度"],
  dwell: ["dwell", "滞在", "滞在時間", "滞在（分）"],
  open: ["open", "開館", "開始"],
  close: ["close", "閉館", "終了"],
  fee: ["fee", "料金", "入場料"],
};
const COLUMN_OF = new Map();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) COLUMN_OF.set(n, field);

// --- 文字コード -----------------------------------------------------------------------

/**
 * ファイルの中身を文字にします。UTF-8 として読めなければ Shift_JIS（Excel の CSV に多い）で読みます。
 * @param {Uint8Array} bytes
 * @param {string} [encoding] "utf-8" / "shift_jis" / "euc-jp" を決めて読むとき
 * @returns {{text: string, encoding: string}}
 */
export function decodeText(bytes, encoding) {
  const tryDecode = (enc, fatal) => new TextDecoder(enc, { fatal, ignoreBOM: false }).decode(bytes);
  if (encoding) {
    let text;
    try { text = tryDecode(encoding, true); } catch (e) {
      if (e instanceof RangeError) throw new Error(`文字コード「${encoding}」は使えません（utf-8 / shift_jis / euc-jp）`);
      throw new Error(`「${encoding}」として読めない字があります。--encoding を確かめてください`);
    }
    return { text: text.replace(/^﻿/, ""), encoding };
  }
  try {
    return { text: tryDecode("utf-8", true).replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    try {
      return { text: tryDecode("shift_jis", true), encoding: "shift_jis" };
    } catch {
      throw new Error("文字コードが分かりません（UTF-8 でも Shift_JIS でも読めません）。--encoding=euc-jp などで決めてください");
    }
  }
}

/** ファイル名と中身から、形を当てます。 */
export function detectFormat(fileName = "", text = "") {
  const ext = String(fileName).toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "geojson") return "geojson";
  if (ext === "kml") return "kml";
  if (ext === "json") {
    try {
      const j = JSON.parse(text);
      return j?.type === "FeatureCollection" || j?.type === "Feature" ? "geojson" : "json";
    } catch { return "json"; }
  }
  const t = text.trimStart();
  if (t.startsWith("<")) return "kml";
  if (t.startsWith("{") || t.startsWith("[")) return /"FeatureCollection"|"Feature"/.test(t.slice(0, 2000)) ? "geojson" : "json";
  return "csv";
}

// --- CSV -------------------------------------------------------------------------

/** CSV（RFC 4180。引用符・改行入りの欄・CRLF・タブ区切り）を行の配列にします。 */
export function parseCsv(text, { delimiter } = {}) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const d = delimiter ?? (firstLine.split("\t").length > firstLine.split(",").length ? "\t" : ",");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === d) { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new Error("CSV の引用符（\"）が閉じていません");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const csvCell = (v) => {
  if (v === undefined || v === null) return "";
  let s = Array.isArray(v) ? v.join(";") : String(v);
  // 表計算ソフトで開いたときに式として動かないよう、頭の = + - @ を文字にします。
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(spots) {
  // 最後の列 sources は、その行のデータの出どころです（#426。例: wikipedia;osm）。
  // 表には入れ子を書けないので、ライセンスの名前は docs/data-licenses.md の表で引きます。
  // 取り込みでは読みません（出どころは、取り込む人が決めるものではないためです）。
  const lines = [[...CSV_COLUMNS, SOURCES_COLUMN].join(",")];
  for (const s of spots) lines.push([...CSV_COLUMNS.map((c) => csvCell(s[c])), csvCell(sourcesOf(s).join(";"))].join(","));
  return lines.join("\r\n") + "\r\n";
}

function csvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { records: [], errors: ["CSV が空です"] };
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, "").toLowerCase());
  const fields = header.map((h) => COLUMN_OF.get(h) ?? (h === "id" ? "id" : null));
  const errors = [];
  if (!fields.includes("name")) errors.push("名前の列（name・名前）がありません");
  if (!fields.includes("lat") || !fields.includes("lng")) errors.push("緯度・経度の列（lat・lng / 緯度・経度）がありません");
  const unknown = header.filter((h, i) => h && !fields[i] && h !== SOURCES_COLUMN);
  const records = rows.slice(1).map((r, n) => {
    const raw = {};
    fields.forEach((f, i) => {
      if (!f || f === "id") return;
      const v = (r[i] ?? "").trim();
      if (v === "") return;
      raw[f] = f === "genres" ? v.split(/[;；、,|]/).map((g) => g.trim()).filter(Boolean)
        : SPOT_FIELDS[f]?.type === "string" || SPOT_FIELDS[f]?.type === "url" ? v.replace(/^'(?=[=+\-@])/, "") : v;
    });
    return { line: n + 2, raw };
  });
  return { records, errors, ignored: unknown };
}

// --- GeoJSON ---------------------------------------------------------------------

export function toGeoJson(spots) {
  return JSON.stringify({
    type: "FeatureCollection",
    tabisaki: { schema: EXPORT_SCHEMA, license_summary: licenseSummary(spots) },
    features: spots.map((s) => {
      const { lat, lng, ...props } = s;
      return { type: "Feature", id: s.id, geometry: { type: "Point", coordinates: [lng, lat] }, properties: props };
    }),
  }, null, 2) + "\n";
}

function geoJsonRecords(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return { records: [], errors: [`GeoJSON として読めません: ${e.message}`] }; }
  const feats = j?.type === "Feature" ? [j] : Array.isArray(j?.features) ? j.features : null;
  if (!feats) return { records: [], errors: ["FeatureCollection ではありません"] };
  const records = feats.map((f, n) => {
    const p = f?.properties && typeof f.properties === "object" ? f.properties : {};
    const raw = {};
    for (const [k, v] of Object.entries(p)) {
      const field = SPOT_FIELDS[k] ? k : COLUMN_OF.get(String(k).toLowerCase());
      if (field && field !== "lat" && field !== "lng" && v !== null && v !== "") raw[field] = v;
    }
    const g = f?.geometry;
    if (g?.type === "Point" && Array.isArray(g.coordinates)) {
      raw.lng = g.coordinates[0];
      raw.lat = g.coordinates[1];
    } else {
      raw.__geometry = g?.type ?? "なし";
    }
    return { line: n + 1, raw };
  });
  return { records, errors: [] };
}

// --- KML -------------------------------------------------------------------------

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// タグを外します。1回外した結果に、また タグの形が現れることがある（<scr<b>ipt> など）ので、
// 変わらなくなるまで繰り返します。
const stripTags = (s) => {
  let out = String(s);
  for (let prev = null; prev !== out;) {
    prev = out;
    out = out.replace(/<[^>]+>/g, "");
  }
  return out;
};
// 要素の中身を、ただの文字にします（HTML ではありません。画面に出す側が、文字として出します）。
const xmlText = (s) => stripTags(String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, "\u0000amp;").replace(/</g, "\u0000lt;")))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&")
  .replace(/\u0000amp;/g, "&").replace(/\u0000lt;/g, "<")
  .trim();

export function toKml(spots) {
  const data = (s) => CSV_COLUMNS.filter((c) => !["name", "lat", "lng", "description"].includes(c) && s[c] !== undefined && s[c] !== null)
    .map((c) => `        <Data name="${c}"><value>${xmlEscape(Array.isArray(s[c]) ? s[c].join(";") : s[c])}</value></Data>`).join("\n");
  const marks = spots.map((s) => [
    `    <Placemark id="${xmlEscape(s.id)}">`,
    `      <name>${xmlEscape(s.name)}</name>`,
    s.description ? `      <description>${xmlEscape(s.description)}</description>` : null,
    `      <ExtendedData>\n${data(s)}\n      </ExtendedData>`,
    `      <Point><coordinates>${s.lng},${s.lat}</coordinates></Point>`,
    "    </Placemark>",
  ].filter(Boolean).join("\n"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>旅さき ユーザーKB</name>
    <ExtendedData>
      <Data name="schema"><value>${EXPORT_SCHEMA}</value></Data>
      <Data name="license_summary"><value>${xmlEscape(JSON.stringify(licenseSummary(spots)))}</value></Data>
    </ExtendedData>
${marks.join("\n")}
  </Document>
</kml>
`;
}

function kmlRecords(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { records: [], errors: ["DOCTYPE・ENTITY を含む KML は読みません"] };
  if (!/<kml[\s>]/i.test(text)) return { records: [], errors: ["KML ではありません（<kml> がありません）"] };
  const records = [];
  const re = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(text))) {
    n++;
    const body = m[1];
    const tag = (t) => {
      const x = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, "i").exec(body);
      return x ? xmlText(x[1]) : undefined;
    };
    const raw = {};
    const name = tag("name");
    if (name) raw.name = name;
    const desc = tag("description");
    if (desc) raw.description = desc;
    for (const d of body.matchAll(/<Data\b[^>]*name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>\s*<\/Data>/gi)) {
      const k = d[1];
      const field = SPOT_FIELDS[k] ? k : COLUMN_OF.get(k.toLowerCase());
      if (!field || field === "name" || field === "lat" || field === "lng") continue;
      const v = xmlText(d[2]);
      if (v !== "") raw[field] = field === "genres" ? v.split(/[;,]/).map((g) => g.trim()).filter(Boolean) : v;
    }
    const point = /<Point\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i.exec(body);
    if (point) {
      const [lng, lat] = point[1].trim().split(/[\s,]+/).map(Number);
      raw.lng = lng;
      raw.lat = lat;
    } else raw.__geometry = /<(LineString|Polygon|MultiGeometry)\b/i.exec(body)?.[1] ?? "なし";
    records.push({ line: n, raw });
  }
  return { records, errors: records.length ? [] : ["Placemark がありません"] };
}

// --- JSON（旅さきの形） --------------------------------------------------------------

export function toJson(spots) {
  return JSON.stringify({ schema: EXPORT_SCHEMA, license_summary: licenseSummary(spots), spots }, null, 2) + "\n";
}

function jsonRecords(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return { records: [], errors: [`JSON として読めません: ${e.message}`] }; }
  const list = Array.isArray(j) ? j : Array.isArray(j?.spots) ? j.spots : null;
  if (!list) return { records: [], errors: ["スポットの一覧（spots）がありません"] };
  if (j?.schema && j.schema !== EXPORT_SCHEMA) {
    const v = Number(/\/(\d+)$/.exec(j.schema)?.[1]);
    if (v > 1) return { records: [], errors: [`新しい版の書き出し（${j.schema}）です。旅さきを新しくしてから取り込んでください`] };
  }
  return {
    records: list.map((s, n) => {
      const raw = {};
      for (const [k, v] of Object.entries(s ?? {})) if (SPOT_FIELDS[k] && v !== null) raw[k] = v;
      return { line: n + 1, raw };
    }),
    errors: [],
  };
}

// --- 取り込み ----------------------------------------------------------------------

/** 日本のあたりか（緯度・経度が入れ替わっていないかを見るのに使います）。 */
const inJapan = (lat, lng) => lat >= 20 && lat <= 46.5 && lng >= 122 && lng <= 154.5;

/**
 * ファイルの中身を、スポットの項目にします。おかしい行は落とさず、行番号と理由を返します。
 * @param {string} text
 * @param {{format?: string, fileName?: string}} [opts]
 * @returns {{format: string, ok: {line: number, spot: object}[], bad: {line: number, errors: string[]}[], errors: string[], ignored: string[]}}
 */
export function parseSpots(text, { format, fileName } = {}) {
  const fmt = format ?? detectFormat(fileName, text);
  if (!FORMATS.includes(fmt)) throw new Error(`形は ${FORMATS.join(" / ")} のどれかです: ${fmt}`);
  const { records, errors, ignored = [] } = { csv: csvRecords, geojson: geoJsonRecords, kml: kmlRecords, json: jsonRecords }[fmt](text);
  if (records.length > MAX_ROWS) {
    return { format: fmt, ok: [], bad: [], errors: [`行が多すぎます（${records.length}行。${MAX_ROWS}行までに分けてください）`], ignored };
  }
  const ok = [];
  const bad = [];
  if (errors.length && fmt === "csv") return { format: fmt, ok, bad, errors, ignored };
  for (const { line, raw } of records) {
    const errs = [];
    if (raw.__geometry) errs.push(`点ではありません（${raw.__geometry}）。点（Point）だけを取り込みます`);
    delete raw.__geometry;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    const swapped = Number.isFinite(lat) && Number.isFinite(lng) && !inJapan(lat, lng) && inJapan(lng, lat);
    const { value, errors: v } = validateSpot(raw);
    // 入れ替わりは範囲外の知らせより先に、それだけを伝えます（直しかたがはっきりするため）
    if (swapped) errs.push("緯度と経度が入れ替わっているようです", ...v.filter((e) => !/^(lat|lng)\b/.test(e)));
    else errs.push(...v);
    if (!v.length && !swapped && value.lat === 0 && value.lng === 0) errs.push("緯度・経度が 0,0 です（座標が入っていないようです）");
    if (errs.length) bad.push({ line, name: raw.name, errors: errs });
    else ok.push({ line, spot: value });
  }
  return { format: fmt, ok, bad, errors, ignored };
}

/** 書き出します。 */
export function formatSpots(spots, format) {
  if (format === "csv") return toCsv(spots);
  if (format === "geojson") return toGeoJson(spots);
  if (format === "kml") return toKml(spots);
  if (format === "json") return toJson(spots);
  throw new Error(`形は ${FORMATS.join(" / ")} のどれかです: ${format}`);
}

// --- 重なり ------------------------------------------------------------------------

export function meters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 近くて名前が同じものを探すための索引（約1km四方の格子）。
 * @param {object[]} spots
 */
export function nearIndex(spots = []) {
  const cell = (lat, lng) => `${Math.floor(lat * 100)},${Math.floor(lng * 100)}`;
  const grid = new Map();
  const add = (s) => {
    if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) return;
    const k = cell(s.lat, s.lng);
    const list = grid.get(k);
    if (list) list.push(s); else grid.set(k, [s]);
  };
  for (const s of spots) add(s);
  return {
    /** あとから1件足します（同じファイルの中の重なりを見るのに使います）。 */
    add,
    /** p から radius m 以内で、名前が同じものを指すもの。 */
    find(p, { radius = 100, sameThing = (a, b) => a === b, except } = {}) {
      const out = [];
      const cx = Math.floor(p.lat * 100);
      const cy = Math.floor(p.lng * 100);
      // 1マスは緯度で約1.1km。経度は高緯度ほど狭いので、そのぶん多く見ます
      const rx = Math.ceil(radius / 1100);
      const ry = Math.ceil(radius / (1110 * Math.max(Math.cos((p.lat * Math.PI) / 180), 0.1)));
      for (let dx = -rx; dx <= rx; dx++) {
        for (let dy = -ry; dy <= ry; dy++) {
          for (const s of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
            if (s === except || (except && s.id === except.id)) continue;
            const d = meters(p, s);
            if (d <= radius && (s.name === p.name || sameThing(s.name, p.name))) out.push({ spot: s, meters: Math.round(d) });
          }
        }
      }
      return out.sort((a, b) => a.meters - b.meters);
    },
  };
}
