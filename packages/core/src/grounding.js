// 旅程の裏取り（ハルシネーション検証）。issue #447。
//
// AIは「もっともらしい名前」を書けます。存在しない列車、閉じた施設、
// 候補に無い寺。旅程に載れば、利用者はそれを信じて出かけます。
//
// ここは旅程が外へ出る**直前の最後の関門**です。planTrip は必ずここを
// 通ってから返ります（pipeline.js。素通りする道を作らないために、
// 組み立て本体は外へ出していません）。
//
// 確かめるのは、旅程の行ごとに「何を根拠にそう書いたか」です。
//
//   立ち寄り   収録（kb）に同じ id があるか。名前と場所が合っているか。
//              閉館・休館・宿ではないか。合わなければ外して、そう書きます
//   移動       時刻表・経路の検索で引いた区間か、距離からの目安か。
//              目安の区間に列車名・便名が書かれていたら、その名前は
//              時刻表の収録（trains.js）にあるものだけを残します
//   宿・食事   エリアの目安だけで、店や宿の名前は書いていません
//   AIの文     見出し・説明・各立ち寄りの理由に、旅程にも収録にも無い
//              固有名（◯◯寺・◯◯駅・◯◯号…）があれば、その文を差し替えます
//
// 加えて、危険の判断が要る場所（火山・山・海・川・冬の山道）には、
// 判断を**こちらでしない**で、確かめ先の公的な窓口を書きます。
//
// 結果は itin.grounding に数えて残し、行には item.grounding を付けます。

import { PREFECTURES } from "./areas.js";
import { whyNotASpot } from "./notaspot.js";
import { travelSource } from "./reliability.js";
import { spotTags } from "./tags.js";
import { NAMED_ROUTES, TIMETABLED } from "./trains.js";
import { haversineKm } from "./feasibility.js";

export const GROUNDING_VERSION = 1;

/** 収録の場所と「同じ場所」とみなす距離。座標の丸めの違いを吸収します。 */
const SAME_PLACE_KM = 1.0;

const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

// --- 固有名の見つけかた ---------------------------------------------------

// 漢字・カタカナ・英数字が続いた語のうち、施設や地名の終わりかたをするもの。
const NAME_RUN = /[一-龥々〆ヵヶァ-ヴーA-Za-z0-9]+/g;
const NAME_SUFFIX = [
  "大社", "神宮", "神社", "寺", "院", "宮", "城", "駅", "温泉", "山", "岳",
  "湖", "沼", "滝", "峠", "岬", "島", "浜", "海岸", "公園", "庭園", "美術館",
  "博物館", "資料館", "記念館", "水族館", "動物園", "植物園", "タワー",
  "展望台", "ホテル", "旅館", "号", "橋", "横丁", "市場",
];
// 固有名ではない、よく使う語。
const COMMON_WORDS = new Set([
  "登山", "下山", "火山", "沢山", "鉱山", "名山", "霊山", "里山", "雪山", "本山",
  "各駅", "最寄駅", "最寄り駅", "主要駅", "終着駅", "始発駅", "寺院", "病院",
  "国立公園", "国定公園", "県立公園", "古寺", "名城", "古城", "名湯温泉",
  "秘湯温泉", "露天風呂温泉", "日帰り温泉", "駅", "一号", "番号", "記号",
]);

function suffixOf(word) {
  return NAME_SUFFIX.find((s) => word.endsWith(s)) ?? null;
}

/**
 * 文の中の、固有名らしい語を返します。
 * @param {string} text
 * @returns {string[]}
 */
export function properNames(text) {
  const out = [];
  for (const run of String(text ?? "").match(NAME_RUN) ?? []) {
    const suf = suffixOf(run);
    if (!suf || run.length <= suf.length) continue;
    if (COMMON_WORDS.has(run)) continue;
    // 「名」「古」「各」のような1字＋終わりの語は、ふつうの言葉です
    if (run.length === suf.length + 1 && /[名古大小各本支新旧当同両別]/.test(run[0])) continue;
    if (!out.includes(run)) out.push(run);
  }
  return out;
}

/**
 * 旅程と収録から「確かめられる名前」の集まりを作ります。
 * @returns {{names:string[], hay:string}}
 */
function knownNames(itin, kb, trip) {
  const names = new Set();
  const add = (n) => { const s = String(n ?? "").trim(); if (s.length >= 2) names.add(s); };
  let hay = "";
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      add(item.title);
      add(item.place?.name);
      add(item.place?.region);
      add(item.place?.prefecture);
      add(item.from?.name);
      add(item.to?.name);
      add(item.near?.regionName);
      // 時刻表・経路の検索で引いた区間は、路線名や便名ごと根拠があります
      if (item.kind === "transit" && isLookedUp(item)) hay += `\n${item.title ?? ""}\n${item.detail ?? ""}`;
    }
  }
  for (const r of kb?.regions ?? kb?.regionsById?.values?.() ?? []) {
    add(r.name); add(r.station); add(String(r.station ?? "").replace(/駅$/, ""));
  }
  for (const p of PREFECTURES) { add(p); add(p.replace(/[都道府県]$/, "")); }
  for (const t of [...TIMETABLED, ...NAMED_ROUTES]) add(t.name);
  add(trip?.origin?.name);
  add(trip?.destination?.name);
  for (const s of trip?.stops ?? []) add(s?.name);
  const list = [...names];
  hay += `\n${list.join("\n")}`;
  return { names: list, hay };
}

/** その名前に根拠があるか。旅程・収録の名前そのもの、または「名前＋駅」のような形。 */
function nameIsKnown(word, known) {
  if (known.hay.includes(word)) return true;
  for (const n of known.names) {
    if (!word.startsWith(n)) continue;
    const rest = word.slice(n.length);
    if (!rest || NAME_SUFFIX.includes(rest)) return true;
  }
  return false;
}

/** 文の中の、根拠の無い固有名。 */
export function unknownNames(text, known) {
  return properNames(text).filter((w) => !nameIsKnown(w, known));
}

// --- 移動 -------------------------------------------------------------------

/** 時刻表・経路の検索で引いた区間か。 */
function isLookedUp(item) {
  const key = travelSource(item)?.key;
  return key === "transit" || key === "routes";
}

// 「特急まぼろし号」のように号で終わるなら、ひらがなも名前のうちです。
const TRAIN_NAME = new RegExp([
  "(?:特急|急行|快速|寝台)[ぁ-んァ-ヴー一-龥]{1,12}?号",
  "サンライズ[ァ-ヴー]*",
  "(?:特急|急行|快速|寝台)[ァ-ヴー一-龥]+",
  "[ァ-ヴー一-龥]{2,}(?:号|ライナー)",
].join("|"), "g");
const CATALOG = [...TIMETABLED, ...NAMED_ROUTES].map((t) => t.name);

/** 目安の区間に書かれた、時刻表の収録に無い列車名。 */
function unknownTrains(text) {
  const out = [];
  for (const m of String(text ?? "").match(TRAIN_NAME) ?? []) {
    const bare = m.replace(/^(特急|急行|快速|寝台)/, "").replace(/号$/, "");
    if (["特急", "急行", "快速", "寝台", "サンライズ"].includes(m)) continue;
    if (CATALOG.some((c) => c.includes(bare) || bare.includes(c) || m.includes(c))) continue;
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

// --- 立ち寄り ----------------------------------------------------------------

/**
 * 立ち寄りを収録と突き合わせます。
 * @returns {{status:"verified"|"rebound"|"removed", spot?:object, why?:string}}
 */
function matchSpot(item, kb) {
  const byId = item.spotId != null ? kb?.spotsById?.get(item.spotId) : null;
  let spot = byId;
  let rebound = false;
  if (spot) {
    // id は合っていても、名前か場所が違えば別物です（id の書き崩し）
    const nameOk = norm(spot.name) === norm(item.title) || norm(spot.name) === norm(item.place?.name);
    const near = item.place && Number.isFinite(item.place.lat)
      ? haversineKm(spot, item.place) <= SAME_PLACE_KM : true;
    if (!nameOk && !near) spot = null;
    else if (!nameOk || !near) rebound = true;
  }
  if (!spot) {
    // id で引けなければ、同じ名前で近くにある収録の場所を探します
    const name = norm(item.place?.name ?? item.title);
    const at = item.place && Number.isFinite(item.place.lat) ? item.place : null;
    for (const s of kb?.spotsById?.values?.() ?? []) {
      if (norm(s.name) !== name) continue;
      if (at && haversineKm(s, at) > SAME_PLACE_KM) continue;
      spot = s; rebound = true; break;
    }
  }
  if (!spot) return { status: "removed", why: "収録データで確かめられませんでした" };
  const not = whyNotASpot(spot);
  if (not) return { status: "removed", spot, why: `${not}のため` };
  return { status: rebound ? "rebound" : "verified", spot };
}

// --- 危険の判断が要る場所 ---------------------------------------------------

const SAFETY = [
  {
    key: "volcano",
    test: (s) => /火山|火口|噴火|噴煙/.test(`${s.name}${s.description ?? ""}`),
    text: (names) => `${names}は火山の近くです。噴火警戒レベルと立入規制は、`
      + "出かける前に気象庁の「火山登山者向けの情報」と地元の自治体の発表で確かめてください。",
  },
  {
    key: "mountain",
    test: (s) => ["山", "登山"].includes(s.category) || spotTags(s).includes("hiking"),
    text: (names) => `${names}は山道を歩きます。天気・登山道の状況・クマの出没情報は`
      + "地元の自治体やビジターセンターで確かめ、登山なら登山届（登山計画書）を出してください。"
      + "歩けるかどうかの判断は、こちらではしていません。",
  },
  {
    key: "water",
    test: (s) => s.category === "海水浴場" || ["beach", "rafting"].some((t) => spotTags(s).includes(t))
      || s.category === "渓谷",
    text: (names) => `${names}は水辺です。泳ぐ・川に入るなら、開設期間と監視員のいる時間に。`
      + "高波・離岸流・増水の情報は、海上保安庁や国土交通省「川の防災情報」、地元の自治体で確かめてください。",
  },
];

const WINTER_ROAD = (names) => `${names}へは冬の山道を走ります。通行止めやチェーン規制は、`
  + "日本道路交通情報センター（JARTIC）と道路の管理者の発表で、出発の前に確かめてください。";

function safetyNotes(spots, trip) {
  const notes = [];
  for (const rule of SAFETY) {
    const hit = spots.filter((s) => rule.test(s));
    if (!hit.length) continue;
    const names = [...new Set(hit.map((s) => s.name))];
    notes.push({ key: rule.key, spots: names, text: rule.text(names.join("・")) });
  }
  const month = trip?.departAt ? new Date(trip.departAt).getMonth() + 1 : null;
  const byCar = /car/.test(String(trip?.transport ?? ""));
  if (byCar && month && [12, 1, 2, 3].includes(month)) {
    const hit = spots.filter((s) => ["山", "登山", "峠", "高原", "スキー場"].includes(s.category)
      || spotTags(s).includes("ski_resort"));
    if (hit.length) {
      const names = [...new Set(hit.map((s) => s.name))];
      notes.push({ key: "winter_road", spots: names, text: WINTER_ROAD(names.join("・")) });
    }
  }
  return notes;
}

// --- 本体 ---------------------------------------------------------------------

/**
 * 旅程の全行を、収録・時刻表・経路の検索と突き合わせます。
 *
 * 旅程をその場で直して（外した行・差し替えた名前）、同じ旅程を返します。
 * 2度呼んでも同じです（2度目は何もしません）。
 *
 * @param {object} itin  buildItinerary / planTrip が組んだ旅程
 * @param {{kb?: object, trip?: object, fromModel?: boolean}} [ctx]
 * @returns {object} itin（itin.grounding に結果）
 */
export function groundItinerary(itin, ctx = {}) {
  if (!itin || typeof itin !== "object") return itin;
  if (itin.grounding?.version === GROUNDING_VERSION) return itin;
  const { kb, trip } = ctx;
  const fromModel = ctx.fromModel ?? itin.fromModel ?? false;

  const report = {
    version: GROUNDING_VERSION,
    checked: 0,
    verified: 0,
    estimated: 0,
    rebound: [],    // 名前・場所を収録に合わせ直した立ち寄り
    removed: [],    // 確かめられず外した立ち寄り
    trains: [],     // 目安の区間から消した、収録に無い列車名
    rewritten: [],  // 差し替えたAIの文
    safety: [],
    ok: true,
  };
  const keptSpots = [];

  for (const day of itin.days ?? []) {
    for (let i = 0; i < (day.items ?? []).length; i++) {
      const item = day.items[i];
      report.checked++;
      if (item.kind === "spot") {
        const m = matchSpot(item, kb);
        if (m.status === "removed") {
          const name = item.title ?? item.place?.name ?? "（名前なし）";
          report.removed.push({ name, why: m.why });
          // その場所へ向かう・そこから出る移動の行にも、名前が残っています
          for (const other of day.items) {
            if (other.kind !== "transit" || other.title == null) continue;
            if (other.to !== item.place && other.from !== item.place) continue;
            other.title = String(other.title).replaceAll(name, "（外した場所）");
          }
          day.items[i] = {
            id: item.id, kind: "free", start: item.start, end: item.end,
            title: "自由時間",
            detail: `「${name}」は${m.why}。旅程から外しました`,
            costYen: 0, reason: "根拠を確かめられなかった立ち寄りの代わり",
            grounding: { status: "removed", source: null, was: name },
          };
          continue;
        }
        if (m.status === "rebound") {
          report.rebound.push({ from: item.title, to: m.spot.name });
          item.title = m.spot.name;
          item.spotId = m.spot.id;
          item.place = m.spot;
        }
        keptSpots.push(m.spot);
        item.grounding = { status: "verified", source: "kb" };
        report.verified++;
        continue;
      }
      if (item.kind === "transit") {
        const src = travelSource(item);
        if (isLookedUp(item)) {
          item.grounding = { status: "verified", source: src.key };
          report.verified++;
          continue;
        }
        // 目安の区間。列車名や便名は、収録の時刻表にあるものだけを残します。
        const bad = unknownTrains(`${item.title ?? ""} ${item.detail ?? ""}`);
        for (const b of bad) {
          item.title = String(item.title ?? "").replaceAll(b, "").trim();
          item.detail = String(item.detail ?? "").replaceAll(b, "").replace(/^・|・(?=・)/g, "").trim();
          report.trains.push(b);
        }
        item.grounding = { status: "estimate", source: src?.key ?? "estimate" };
        report.estimated++;
        continue;
      }
      // 宿・食事・自由時間・着地・荷物は、エリアの目安か、利用者の入力です
      item.grounding = {
        status: "verified",
        source: item.kind === "lodging" && item.place ? "user" : "derived",
      };
      report.verified++;
    }
  }

  // AIが書いた文（見出し・説明・立ち寄りの理由）
  if (fromModel) {
    const known = knownNames(itin, kb, trip);
    for (const field of ["headline", "rationale"]) {
      const bad = unknownNames(itin[field], known);
      if (!bad.length) continue;
      report.rewritten.push({ field, names: bad });
      itin[field] = field === "headline" ? "" : neutralRationale(keptSpots);
    }
    for (const day of itin.days ?? []) {
      for (const item of day.items ?? []) {
        if (item.kind !== "spot") continue;
        const bad = unknownNames(item.reason, known);
        if (!bad.length) continue;
        report.rewritten.push({ field: "reason", spot: item.title, names: bad });
        item.reason = "ご希望に近い場所です";
      }
    }
  }

  report.safety = safetyNotes(keptSpots, trip);
  report.ok = !report.removed.length && !report.trains.length && !report.rewritten.length;

  const notes = [];
  if (report.removed.length) {
    notes.push(`確かめられなかった立ち寄り${report.removed.length}か所を外しました`
      + `（${report.removed.map((r) => `${r.name}：${r.why}`).join("、")}）。`);
  }
  if (report.trains.length) {
    notes.push(`時刻表で確かめられなかった列車名（${report.trains.join("・")}）を、`
      + "移動の案内から外しました。乗る便は乗換案内で確かめてください。");
  }
  if (report.rewritten.length) {
    const names = [...new Set(report.rewritten.flatMap((r) => r.names))];
    notes.push(`AIの説明に、旅程にも収録にも無い名前（${names.join("・")}）が`
      + "あったため、その文を差し替えました。");
  }
  itin.grounding = report;
  itin.safety = report.safety;
  itin.warnings = [...notes, ...report.safety.map((s) => s.text), ...(itin.warnings ?? [])];
  return itin;
}

function neutralRationale(spots) {
  const regions = [...new Set(spots.map((s) => s.region).filter(Boolean))];
  return regions.length
    ? `${regions.join("・")}で、ご希望に近い場所を選びました。`
    : "ご希望に近い場所を選びました。";
}
