// 行き先の注意報・警報（気象庁）と、もしものときの案内（#448）。
//
// 旅程は AI と計算で作った案です。大雨や台風の日に、それをそのまま
// 信じて出かけると危ないことがあります。そこで、
//
//   1. 行き先の府県予報区に出ている注意報・警報を、気象庁から取って
//      旅程に添えます（今日・明日の旅だけ。警報は「いま」の情報なので、
//      来週の旅に今日の警報を出しても役に立ちません）。
//   2. ハザードマップと避難場所（国土地理院）、気象庁の警報のページへの
//      入口を、行き先ごとに出します。
//   3. 「最後は自分で確かめてください」の一文を、いつも添えます。
//
// 位置情報は使いません。聞くのは**行き先の府県予報区**だけで、気象庁へ
// 送るのは全国の一覧を取る1回の GET です（どこへ行くかも送りません）。
//
// データ: 気象庁「気象警報・注意報」（2026年5月からの新しい防災気象情報。
// https://www.jma.go.jp/bosai/warning/data/r8/map.json）。
// 出典: 気象庁ホームページ（公共データ利用規約 第1.0版）。画面には「加工して作成」と添えます。
import { JMA_CLASS10, JMA_OFFICES } from "./jma-areas.js";

export const JMA_WARNING_URL = "https://www.jma.go.jp/bosai/warning/data/r8/map.json";
const CACHE_MS = 5 * 60_000;

/**
 * 注意報・警報の種類（2026年5月からのコード）。
 * level は警戒レベル（大雨・土砂災害・高潮）か、それに合わせた重さです。
 *   2 = 注意報、3 = 警報、4 = 危険警報、5 = 特別警報
 * 気象庁の警報のページ（bosai/warning/）が使っている対応表と同じです。
 * 河川ごとの氾濫の情報（20〜53 の一部）は、別の仕組みなのでここでは扱いません。
 */
export const JMA_KINDS = {
  10: ["大雨注意報", 2], "03": ["大雨警報", 3], 43: ["大雨危険警報", 4], 33: ["大雨特別警報", 5],
  29: ["土砂災害注意報", 2], "09": ["土砂災害警報", 3], 49: ["土砂災害危険警報", 4], 39: ["土砂災害特別警報", 5],
  19: ["高潮注意報", 2], "08": ["高潮警報", 3], 48: ["高潮危険警報", 4], 38: ["高潮特別警報", 5],
  15: ["強風注意報", 2], "05": ["暴風警報", 3], 35: ["暴風特別警報", 5],
  13: ["風雪注意報", 2], "02": ["暴風雪警報", 3], 32: ["暴風雪特別警報", 5],
  12: ["大雪注意報", 2], "06": ["大雪警報", 3], 36: ["大雪特別警報", 5],
  16: ["波浪注意報", 2], "07": ["波浪警報", 3], 37: ["波浪特別警報", 5],
  14: ["雷注意報", 2], 17: ["融雪注意報", 2], 20: ["濃霧注意報", 2], 21: ["乾燥注意報", 2],
  22: ["なだれ注意報", 2], 23: ["低温注意報", 2], 24: ["霜注意報", 2],
  25: ["着氷注意報", 2], 26: ["着雪注意報", 2],
};

/** 都道府県の名前 → 番号（府県予報区のコードの先頭2桁）。 */
const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県",
  "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県",
  "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];

// 1つの県に府県予報区が複数あるところ（北海道・鹿児島・沖縄）は、
// いちばん近い区の目安の点で選びます。区の境目の近くでは隣を選ぶことが
// あるので、画面には区の名前を必ず出します。
const OFFICE_POINTS = {
  "011000": [45.2, 142.0], "012000": [44.0, 142.0], "013000": [43.9, 144.0],
  "014030": [42.9, 143.2], "014100": [43.2, 144.8], "015000": [42.5, 142.2],
  "016000": [43.1, 141.3], "017000": [41.9, 140.3],
  "460040": [28.3, 129.5], "460100": [31.6, 130.6],
  "471000": [26.4, 127.8], "472000": [25.85, 131.25], "473000": [24.8, 125.3],
  "474000": [24.4, 124.1],
};

/** 府県予報区のコード。分からなければ null。 */
export function officeFor(place) {
  const name = String(place?.prefecture ?? "").trim();
  const idx = PREFS.findIndex((p) => p === name || p.replace(/[都府県]$/, "") === name);
  if (idx < 0) return null;
  const head = String(idx + 1).padStart(2, "0");
  const codes = Object.keys(JMA_OFFICES).filter((c) => c.startsWith(head));
  if (codes.length <= 1) return codes[0] ?? null;
  const { lat, lng } = place ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null; let bestD = Infinity;
  for (const c of codes) {
    const p = OFFICE_POINTS[c];
    if (!p) continue;
    const d = (p[0] - lat) ** 2 + ((p[1] - lng) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * 全国の一覧から、その府県予報区に**いま出ている**ものを拾います。
 * 「解除」と「発表警報・注意報はなし」は捨てます。
 * @returns {{office:string, officeName:string, reportedAt:string|null,
 *            headline:string, items:{area:string, areaName:string,
 *            code:string, name:string, level:number, status:string}[]}}
 */
export function activeWarnings(map, office) {
  // 一覧には、府県予報区ごとに電文の種類（大雨・土砂災害・風・波…。
  // dataTypeCode）ごとの最新の1通が入っています。同じ種類が2通あれば、
  // 新しいほうだけを使います。
  const latest = new Map();
  for (const r of Array.isArray(map) ? map : []) {
    if (!(r?.warning?.class10Items ?? []).some((it) => JMA_CLASS10[it.areaCode]?.[1] === office)) continue;
    const key = String(r.dataTypeCode ?? latest.size);
    const had = latest.get(key);
    if (!had || String(r.reportDatetime) > String(had.reportDatetime)) latest.set(key, r);
  }
  const reports = [...latest.values()];
  const items = [];
  let reportedAt = null; let headline = "";
  for (const r of reports) {
    if (!reportedAt || String(r.reportDatetime) > reportedAt) {
      reportedAt = String(r.reportDatetime ?? "") || null;
      headline = String(r.headlineText ?? "");
    }
    for (const it of r.warning.class10Items ?? []) {
      if (JMA_CLASS10[it.areaCode]?.[1] !== office) continue;
      for (const k of it.kinds ?? []) {
        if (!k?.code || k.status === "解除") continue;
        const kind = JMA_KINDS[k.code] ?? JMA_KINDS[Number(k.code)];
        if (!kind) continue;
        items.push({ area: it.areaCode, areaName: JMA_CLASS10[it.areaCode]?.[0] ?? it.areaCode,
                     code: String(k.code), name: kind[0], level: kind[1], status: String(k.status ?? "") });
      }
    }
  }
  items.sort((a, b) => b.level - a.level || a.area.localeCompare(b.area));
  return { office, officeName: JMA_OFFICES[office] ?? office, reportedAt, headline, items };
}

/** 同じ種類を区域ごとにまとめた1行（「大雨警報（東京地方・伊豆諸島北部）」）。 */
export function describeWarnings(w) {
  const byName = new Map();
  for (const it of w.items) {
    const list = byName.get(it.name) ?? { level: it.level, areas: [] };
    if (!list.areas.includes(it.areaName)) list.areas.push(it.areaName);
    byName.set(it.name, list);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].level - a[1].level)
    .map(([name, v]) => `${name}（${v.areas.join("・")}）`);
}

/** もしものときの入口。行き先の点を地図に渡すだけで、利用者の位置は使いません。 */
export function emergencyLinks(place, office) {
  const links = [];
  if (office) {
    links.push({ label: "気象庁の警報・注意報",
      url: `https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=${office}` });
  }
  if (Number.isFinite(place?.lat) && Number.isFinite(place?.lng)) {
    links.push({ label: "ハザードマップと避難場所（国土地理院）",
      url: `https://disaportal.gsi.go.jp/maps/?ll=${place.lat.toFixed(4)},${place.lng.toFixed(4)}&z=13` });
  }
  return links;
}

/** 旅程の終わりに、いつも添える一文。 */
export const FINAL_CHECK = "この旅程は AI と計算で作った案です。出発前と当日に、"
  + "気象庁と行き先の自治体の最新の情報を確かめてください。"
  + "避難の呼びかけが出たら、旅程より避難を優先してください。";

let cached = null;

/** テスト用。 */
export function clearAlertCache() { cached = null; }

/** 全国の一覧を取ります（5分は使い回します）。 */
export async function fetchWarningMap(opts = {}) {
  const now = opts.now ?? Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.map;
  // 待ちすぎないように（旅程の表示を、警報の取得で止めません）。
  const signal = opts.signal ?? AbortSignal.timeout?.(8000);
  const res = await (opts.fetch ?? globalThis.fetch)(JMA_WARNING_URL, { signal });
  if (!res.ok) throw new Error(`気象庁 ${res.status}`);
  const map = await res.json();
  cached = { at: now, map };
  return map;
}

/** 日本時間の日付（YYYY-MM-DD）。 */
function jstDate(ms) {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 旅程の日付（日本時間）。旅程の日付は Date で持っています（planner.js）。
 * 「2026-11-12」のような文字は、その日として読みます。
 */
function dayOf(v) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? jstDate(t) : "";
}

/**
 * 旅程の行き先に出ている注意報・警報と、もしものときの入口。
 *
 * 取れなくても旅程は成立します。取れなかったことは ok:false で返し、
 * 入口と最後の一文だけは出します（そちらは通信が要りません）。
 * @returns {Promise<{ok:boolean, checked:boolean, offices:object[],
 *   lines:string[], top:number, links:object[], note:string, source:string}>}
 */
export async function alertsForItinerary(itin, opts = {}) {
  const now = opts.now ?? Date.now();
  const today = jstDate(now);
  const tomorrow = jstDate(now + 86_400_000);
  const places = [];
  for (const day of itin?.days ?? []) {
    for (const i of day?.items ?? []) {
      if (i?.kind === "spot" && i.place) places.push({ place: i.place, date: dayOf(i.start ?? day.date) });
    }
  }
  const offices = new Map();   // office → 最初の場所
  let soon = false;
  for (const { place, date } of places) {
    const o = officeFor(place);
    if (o && !offices.has(o)) offices.set(o, place);
    if (date === today || date === tomorrow) soon = true;
  }
  const first = places[0]?.place;
  const links = emergencyLinks(first, officeFor(first));
  const base = { ok: true, checked: false, offices: [], lines: [], top: 0, links,
                 note: FINAL_CHECK, source: "気象庁" };
  // 来週の旅に、今日の警報を出しても役に立ちません。
  if (!soon || !offices.size) return base;
  try {
    const map = await (opts.fetchMap ?? fetchWarningMap)({ ...opts, now });
    const found = [...offices.keys()].map((o) => activeWarnings(map, o));
    const lines = found.filter((w) => w.items.length)
      .map((w) => `${w.officeName}: ${describeWarnings(w).join("、")}`);
    const top = Math.max(0, ...found.flatMap((w) => w.items.map((i) => i.level)));
    return { ...base, checked: true, offices: found, lines, top };
  } catch {
    return { ...base, ok: false };
  }
}
