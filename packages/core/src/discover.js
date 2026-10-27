// 収録に無い土地を、AIに調べさせる。
//
// これまでは「私が手で書いたエリアだけが通る」作りでした。四国を足せば
// 四国は通りますが、鳥取砂丘や青森ねぶたを入れれば同じ失敗（＝関係ない
// 土地が出る）が起きます。収録を増やす方向には終わりがありません。
//
// そこで、知識ベースを「唯一の正解」ではなく「確認済みの土台」と位置づけ、
// 足りない土地はモデルに調べさせて **その場で候補に加えます**。
//
// ただしモデルの出力をそのまま旅程に入れることはしません。
//
//   ・名前と座標が食い違っていないか（愛媛県と言いながら関東の座標、
//     フランスと言いながら南米の座標、など）
//   ・地球上の座標か
//   ・営業時間・滞在時間・料金が常識的な範囲か
//   ・既に収録しているものと重複していないか
//
// を機械的に確かめ、通ったものだけを候補にします。落としたものは件数と
// 理由を残すので、「なぜ出てこないのか」を画面で説明できます。
//
// 時刻と移動の判定は、これまでどおり verify.js の担当です。モデルが
// 増えても、その分担は変えません。

import { callModel, canGround, extractJson, hasApiKey, lastGrounding }
  from "./ai.js";
import { MACRO_AREAS, PREFECTURES, PREF_CENTER, detectAreas } from "./areas.js";
import { onEarth } from "./geo.js";
import { haversineKm } from "./feasibility.js";

/** 既知の分類。知らない分類は「観光名所」に寄せます（既定値が引けるように）。 */
const CATEGORIES = new Set([
  "温泉", "温泉地", "寺院", "神社", "教会", "城", "史跡", "世界遺産", "博物館",
  "美術館", "公園", "庭園", "国立公園", "国定公園", "山", "登山", "丘", "滝",
  "湖", "海岸", "川", "渓谷", "灯台", "展望台", "テーマパーク", "水族館",
  "動物園", "スキー場", "ロープウェイ", "市場", "酒蔵", "飲食店", "観光名所",
  "商店街", "町並み", "商業施設", "文化施設", "建築", "グルメ", "乗り物",
  "漁港", "牧場",
]);

const CATEGORY_GENRES = {
  温泉: ["onsen"], 温泉地: ["onsen"],
  神社: ["history"], 寺院: ["history"], 教会: ["history"], 城: ["history"],
  史跡: ["history"], 町並み: ["history"], 世界遺産: ["history"],
  庭園: ["nature"], 公園: ["nature"], 滝: ["nature"], 渓谷: ["nature"],
  登山: ["nature"], 山: ["nature"], 丘: ["nature"], 国立公園: ["nature"],
  国定公園: ["nature"], 牧場: ["nature"], 動物園: ["nature"], スキー場: ["nature"],
  湖: ["sea"], 海岸: ["sea"], 漁港: ["sea"], 水族館: ["sea"], 川: ["nature"],
  美術館: ["art"], 博物館: ["art"], 文化施設: ["art"], 建築: ["art"],
  商店街: ["food"], 市場: ["food"], グルメ: ["food"], 飲食店: ["food"],
  酒蔵: ["food"],
  展望台: ["view"], 灯台: ["view"], ロープウェイ: ["view"],
  商業施設: ["city"], 乗り物: ["city"], テーマパーク: ["city"],
  観光名所: ["city"],
};

const FAME_SCORE = { major: 86, known: 58, hidden: 28 };

const MAX_AREAS = 6;
const MAX_SPOTS_PER_AREA = 8;

// --- 検証 -------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 名乗った土地と座標が矛盾していないか。
 *
 * 都道府県で照合します。都道府県が分からないものは照合できないので
 * 「照合していない」と返し、そのことを利用者に伝えます（黙って通しません）。
 *
 * @returns {{ok:boolean, checked:boolean, reason?:string}}
 */
function agreesWithPlaceName({ lat, lng, prefecture, country }) {
  if (!onEarth(lat, lng)) return { ok: false, checked: true, reason: "座標が地球の範囲外" };

  if (prefecture && PREFECTURES.includes(prefecture)) {
    const [pLat, pLng, radius] = PREF_CENTER[prefecture];
    const away = haversineKm({ lat, lng }, { lat: pLat, lng: pLng });
    return away <= radius
      ? { ok: true, checked: true }
      : { ok: false, checked: true,
          reason: `${prefecture}から${Math.round(away)}km離れた座標` };
  }

  // 都道府県が分からなければ、照合の基準を持ちません。
  return { ok: true, checked: false };
}

function romanId(s, fallback) {
  const id = String(s ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return id.length >= 2 ? id.slice(0, 32) : fallback;
}

function clamp(v, lo, hi, dflt) {
  const n = num(v);
  if (n === null) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * モデルの応答を、知識ベースと同じ形に整えます。
 * 通らなかったものは rejected に理由つきで残します。
 *
 * @param {object} raw          モデルの JSON
 * @param {object} opts
 * @param {string} opts.term    利用者が書いた地名（「四国」など）
 * @param {string[]} [opts.allowedPrefectures] その地名が指す都道府県
 * @param {Set<string>} [opts.knownNames] 既に収録している名前（重複を防ぐ）
 * @returns {{regions:Array, spots:Array, rejected:Array}}
 */
export function validateDiscovered(raw, opts = {}) {
  const { term = "", allowedPrefectures = null, knownNames = new Set(),
          country: expectedCountry = null } = opts;
  const allowed = allowedPrefectures?.length ? new Set(allowedPrefectures) : null;
  const regions = [];
  const spots = [];
  const rejected = [];
  const unverifiedPlace = [];   // 国の表に無く、座標を照合できなかったもの
  const seenIds = new Set();
  const seenNames = new Set(knownNames);

  const drop = (what, why) => rejected.push({ name: what, reason: why });

  for (const area of Array.isArray(raw?.areas) ? raw.areas : []) {
    if (regions.length >= MAX_AREAS) break;

    const name = String(area?.name ?? "").trim();
    const pref = String(area?.prefecture ?? "").trim();
    const country = String(area?.country ?? expectedCountry ?? "").trim()
      || (PREFECTURES.includes(pref) ? "日本" : "");
    if (!name || name.length > 40) { drop(name || "(無名)", "エリア名が不正"); continue; }

    // このアプリは国内の旅だけを扱います。調べた先が日本でなければ、
    // 収録せずに理由を残します（黙って混ぜると、行けない旅程になります）。
    if (country && country !== "日本") {
      drop(name, `国外のため対象外: ${country}`); continue;
    }
    if (!PREFECTURES.includes(pref)) {
      drop(name, `都道府県名が不正: ${pref}`); continue;
    }
    if (allowed && !allowed.has(pref)) {
      drop(name, `「${term}」の範囲外の都道府県: ${pref}`); continue;
    }

    const lat = num(area?.lat);
    const lng = num(area?.lng);
    const agree = agreesWithPlaceName({ lat, lng, prefecture: pref,
                                        country });
    if (!agree.ok) { drop(name, agree.reason); continue; }
    if (!agree.checked) unverifiedPlace.push(name);

    let id = romanId(area?.id, `ai-${regions.length + 1}`);
    while (seenIds.has(id)) id = `${id}-x`;
    seenIds.add(id);

    const stLat = num(area?.stationLat) ?? lat;
    const stLng = num(area?.stationLng) ?? lng;
    const stationOk = onEarth(stLat, stLng)
      && haversineKm({ lat, lng }, { lat: stLat, lng: stLng }) < 60;

    const areaSpots = [];
    for (const sp of Array.isArray(area?.spots) ? area.spots : []) {
      if (areaSpots.length >= MAX_SPOTS_PER_AREA) break;
      const sname = String(sp?.name ?? "").trim();
      if (!sname || sname.length > 40) { drop(sname || "(無名)", "スポット名が不正"); continue; }
      if (seenNames.has(sname)) { drop(sname, "すでに収録済み"); continue; }

      const slat = num(sp?.lat);
      const slng = num(sp?.lng);
      if (!onEarth(slat, slng)) { drop(sname, "座標が地球の範囲外"); continue; }
      const d = haversineKm({ lat, lng }, { lat: slat, lng: slng });
      if (d > 70) { drop(sname, `エリア中心から${Math.round(d)}km離れています`); continue; }

      const open = clamp(sp?.open, 0, 24, 9);
      const close = clamp(sp?.close, 0, 24, 17);
      if (!(open < close)) { drop(sname, `営業時間が不正 (${open}-${close})`); continue; }
      const hours = cleanHours(sp, open, close);

      const category = CATEGORIES.has(String(sp?.category)) ? sp.category : "観光名所";
      const fame = ["major", "known", "hidden"].includes(sp?.fame) ? sp.fame : "known";

      seenNames.add(sname);
      areaSpots.push({
        id: `${id}-${areaSpots.length + 1}`,
        regionId: id, region: name, name: sname, category,
        genres: CATEGORY_GENRES[category] ?? ["city"],
        lat: slat, lng: slng, prefecture: pref || country,
        prefectureId: id, country,
        description: String(sp?.description ?? "").slice(0, 120),
        wikipedia: sname,
        fame_score: FAME_SCORE[fame], fame_tier: fame,
        dwell: Math.round(clamp(sp?.dwell, 15, 300, 50)),
        open, close, hours,
        fee: Math.round(clamp(sp?.fee, 0, 20000, 0)),
        // 予約。AIが「要る」と言った場合だけ立てます（言わなければ不明）。
        reservationRequired: sp?.reservationRequired === true,
        reservationUrl: /^https:\/\//.test(sp?.reservationUrl ?? "")
          ? sp.reservationUrl : "",
        // 出どころと、いつ取ったか。営業時間は必ず「要確認」として扱います。
        // 3か月前に調べた値を、今日確認したものと同じ顔で出さないためです。
        source: "ai", verified: false, fetchedAt: Date.now(),
      });
    }

    if (areaSpots.length < 2) { drop(name, "有効なスポットが2件未満"); continue; }

    regions.push({
      id, name, prefecture: pref || country, prefectureId: id, hub: "tokyo",
      country,
      lat, lng,
      station: String(area?.station ?? `${name}の中心`).slice(0, 30),
      stationLat: stationOk ? stLat : lat,
      stationLng: stationOk ? stLng : lng,
      genres: [...new Set(areaSpots.flatMap((s) => s.genres))],
      spotCount: areaSpots.length,
      tagline: String(area?.tagline ?? "").slice(0, 40),
      description: String(area?.description ?? "").slice(0, 200),
      source: "ai", verified: false, fetchedAt: Date.now(),
    });
    spots.push(...areaSpots);
  }

  return { regions, spots, rejected, unverifiedPlace };
}

/**
 * 営業まわりの値を、使える形にそろえます。
 *
 * おかしな値は**そのスポットごと捨てるのではなく、その項目だけ落とします**。
 * 「最終入場が 22時」は間違いですが、姫路城が実在しないわけではありません。
 * 分かる範囲を残し、分からない項目は無かったことにするほうが役に立ちます。
 */
function cleanHours(sp, open, close) {
  const hours = { open, close };

  // 最終入場。閉館より後はありえないので、閉館に丸めます。
  const le = num(sp?.lastEntry);
  if (le !== null && le > open) hours.lastEntry = Math.min(le, close);

  // 定休日。0〜6 の整数だけを残します。
  const days = (Array.isArray(sp?.closedDays) ? sp.closedDays : [])
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length) hours.closedDays = [...new Set(days)];

  // 休業日・休業期間。「MM-DD」として読める組だけを残します。
  const dates = cleanRanges(sp?.closedDates);
  if (dates.length) hours.closedDates = dates;
  const seasons = cleanRanges(sp?.closedSeasons);
  if (seasons.length) hours.closedSeasons = seasons;

  return hours;
}

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function cleanRanges(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const pair = Array.isArray(item) ? item : String(item).split("..");
    const from = String(pair[0] ?? "").trim();
    const to = String(pair[1] ?? from).trim();
    if (!MMDD.test(from) || !MMDD.test(to)) continue;
    out.push(Array.isArray(item) ? [from, to] : `${from}..${to}`);
  }
  return out;
}

// --- モデルに聞く -----------------------------------------------------------

const SHAPE = `{
  "areas": [{
    "id": "matsuyama",
    "name": "松山・道後",
    "country": "日本",
    "prefecture": "愛媛県（日本以外は空欄）",
    "lat": 33.8416, "lng": 132.7657,
    "station": "松山市駅", "stationLat": 33.8391, "stationLng": 132.7659,
    "tagline": "日本最古の湯と、坂の上の城下町",
    "description": "このエリアがどんな場所かを2文で",
    "spots": [{
      "name": "松山城", "category": "城",
      "lat": 33.8457, "lng": 132.7657,
      "dwell": 100, "open": 9, "close": 16.5, "lastEntry": 16, "fee": 520,
      "closedDays": [1], "closedDates": ["12-29..12-31"],
      "closedSeasons": [["12-01", "03-31"]],
      "reservationRequired": false,
      "reservationUrl": "",
      "fame": "major",
      "description": "この場所の特徴を1〜2文で"
    }]
  }]
}`;

function buildPrompt(term, { areaCount, spotCount, country, when, note }) {
  const where = country && country !== "日本"
    ? `${country}の「${term}」` : `「${term}」`;
  return [
    `${where}にある観光地を調べて、旅程作成に使えるデータにしてください。`,
    "検索を使って、いま実際に見学できる場所を確かめてください。",
    when ? `訪問時期: ${when}` : "",
    note ? `利用者の希望: 「${note}」（これに沿う場所を優先してください）` : "",
    "",
    "条件:",
    `・${where}の中で、観光の拠点になる地区を${areaCount}か所選ぶこと。`,
    `・各地区について、実在する観光地を${spotCount}か所挙げること。`,
    "・定番だけでなく、知る人ぞ知る場所も混ぜること。",
    "・緯度経度は実際の場所のものを、小数第4位まで書くこと。",
    "・country は「日本」「フランス」のように日本語の国名で書くこと。",
    "・日本国内なら prefecture に「愛媛県」のような正式名称を、"
      + "国外なら prefecture は空文字にすること。",
    "・open / close はその施設の一般的な開館・閉館時刻を24時間制の数値で"
      + "（16:30 なら 16.5）。終日出入りできる場所は 0 と 24。",
    "・lastEntry は**最終入場（受付終了）の時刻**。閉館時刻とは別なので、"
      + "分かる場合は必ず書くこと。分からなければ省略すること"
      + "（推測で書かないこと）。",
    "・closedDays は定休日の曜日（0=日曜 … 6=土曜）の配列。"
      + "毎週の休みが無ければ空配列にすること。",
    "・closedDates は年末年始などの休業日を \"MM-DD..MM-DD\" の形で。",
    "・closedSeasons は冬期休業などの長い休みを [\"MM-DD\", \"MM-DD\"] の形で。",
    "・reservationRequired は**事前予約が必須**のときだけ true。"
      + "「予約したほうが無難」程度なら false にすること。",
    "・reservationUrl は公式の予約ページ（https のみ）。無ければ空文字。",
    "・dwell はその場所で実際に過ごす標準的な分数。",
    "・fee は大人1名の入場料。**日本円に換算した概算**で書くこと。",
    "・fame は major（誰でも知っている）/ known（その地方では有名）/"
      + " hidden（穴場）のいずれか。",
    "・長期休館・工事中・閉業した場所は挙げないこと。",
    "・実在が確かでない場所は挙げないこと。数を揃えるより正確さを優先。",
    "",
    "次の形の JSON だけを返してください。",
    SHAPE,
  ].filter(Boolean).join("\n");
}

// --- 行き先の割り出し -------------------------------------------------------

const RESOLVE_SHAPE = `{
  "places": [{
    "name": "パリ",
    "country": "フランス",
    "kind": "city",
    "lat": 48.8566, "lng": 2.3522,
    "note": "この場所がどういうところか一文で"
  }],
  "intent": "利用者が求めていることの要約（30字程度）"
}`;

/**
 * 希望文から「どこの話か」を割り出します。
 *
 * 地名の辞書を持って照合する方式は、載っていない地名のぶんだけ黙って
 * 別の場所にすり替わります。地名ですらない言い方
 * （「一面の星空が見たい」）にはなおさら効きません。
 * 割り出し自体をモデルにやらせ、返ってきた座標をこちらで検証します。
 *
 * @returns {{ok:boolean, places:Array, intent:string, sources:Array}}
 */
export async function resolveDestination(text, opts = {}) {
  const note = String(text ?? "").trim();
  const call = opts.call ?? callModel;
  if (!note) return { ok: false, places: [], intent: "", sources: [] };
  if (!opts.call && !hasApiKey()) {
    return { ok: false, places: [], intent: "", sources: [],
             reason: "AIキーが未設定です" };
  }
  // ここは「いま何が open で、何が行われているか」を聞く場所です。
  // 学習した知識だけでは答えられません。検索できないモデルで動かすと、
  // 調べたつもりの推測が返ります。そうなるくらいなら、やりません。
  if (!opts.call && !canGround()) {
    return { ok: false, places: [], intent: "", sources: [],
             reason: "いまのモデルは検索による裏取りができないため、"
               + "収録済みの範囲だけで旅程を組みます" };
  }

  const prompt = [
    "次の旅行の希望文を読んで、どこへ行きたいのかを割り出してください。",
    "",
    `希望文: 「${note}」`,
    "",
    "条件:",
    "・地名がはっきり書かれていればそれを。国内・国外は問いません。",
    "・「オーロラが見たい」のように地名が無くても、その体験ができる場所を"
      + "1〜3か所挙げてください（検索して確かめること）。",
    "・地名も体験も特定できない（例:「温泉でのんびり」）場合は places を"
      + "空配列にしてください。無理に挙げないこと。",
    "・lat / lng はその場所の代表的な座標。",
    "・country は日本語の国名。日本国内なら「日本」。",
    "・kind は country / region / city / spot のいずれか。",
    "",
    "次の形の JSON だけを返してください。",
    RESOLVE_SHAPE,
  ].join("\n");

  let raw;
  try {
    raw = extractJson(await call(prompt,
      { temperature: 0.1, search: true, signal: opts.signal }));
  } catch (e) {
    return { ok: false, places: [], intent: "", sources: [],
             reason: `行き先を割り出せませんでした: ${e?.message ?? e}` };
  }

  const places = [];
  for (const p of Array.isArray(raw?.places) ? raw.places : []) {
    const name = String(p?.name ?? "").trim();
    const lat = num(p?.lat);
    const lng = num(p?.lng);
    if (!name || !onEarth(lat, lng)) continue;
    const country = String(p?.country ?? "").trim() || "日本";
    // 名前と座標が食い違っていないかは、ここでも確かめます
    const agree = agreesWithPlaceName({ lat, lng, prefecture: null, country });
    if (!agree.ok) continue;
    places.push({
      name, country, lat, lng,
      kind: ["country", "region", "city", "spot"].includes(p?.kind)
        ? p.kind : "region",
      note: String(p?.note ?? "").slice(0, 100),
      verifiedPlace: agree.checked,
    });
    if (places.length >= 3) break;
  }

  const { sources } = lastGrounding();
  return { ok: places.length > 0, places,
           intent: String(raw?.intent ?? "").slice(0, 60), sources };
}

// --- キャッシュ -------------------------------------------------------------

const CACHE_VERSION = 1;
const CACHE_PREFIX = "tabisaki.discover.";
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

function cacheGet(term) {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_PREFIX + term);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    if (doc.v !== CACHE_VERSION) return null;
    if (Date.now() - doc.at > CACHE_TTL_MS) return null;
    return doc.data;
  } catch { return null; }
}

function cacheSet(term, data) {
  try {
    globalThis.localStorage?.setItem(CACHE_PREFIX + term,
      JSON.stringify({ v: CACHE_VERSION, at: Date.now(), data }));
  } catch { /* 容量超過などは無視。キャッシュは無くても動きます */ }
}

/** 調べた結果を消します（データを取り直したいとき）。 */
export function clearDiscoveryCache() {
  const ls = globalThis.localStorage;
  if (!ls) return 0;
  const keys = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  for (const k of keys) ls.removeItem(k);
  return keys.length;
}

/**
 * 地名を1つ調べます。
 *
 * @param {string} term    「四国」「鳥取砂丘」など、利用者が書いた地名
 * @param {object} [opts]
 * @param {object} [opts.kb]        重複を避けるための既存データ
 * @param {number} [opts.areaCount] 調べる地区の数
 * @param {number} [opts.spotCount] 地区あたりのスポット数
 * @param {Function} [opts.call]    モデル呼び出し（テストで差し替え）
 * @param {boolean} [opts.useCache]
 * @returns {Promise<{ok:boolean, term:string, regions:Array, spots:Array,
 *                     rejected:Array, cached:boolean, reason?:string}>}
 */
export async function discoverArea(term, opts = {}) {
  const name = String(term ?? "").trim();
  const call = opts.call ?? callModel;
  const useCache = opts.useCache ?? true;
  const empty = { ok: false, term: name, regions: [], spots: [], rejected: [],
                  cached: false };

  if (!name) return { ...empty, reason: "地名が空です" };
  if (!opts.call && !hasApiKey()) {
    return { ...empty, reason: "AIキーが未設定のため、収録に無い土地は調べられません" };
  }
  if (!opts.call && !canGround()) {
    return { ...empty,
             reason: "いまのモデルは検索による裏取りができないため、"
               + "収録に無い土地は調べられません" };
  }

  if (useCache) {
    const hit = cacheGet(name);
    if (hit) return { ...hit, ok: true, term: name, cached: true };
  }

  const areaCount = opts.areaCount ?? 4;
  const spotCount = opts.spotCount ?? 6;
  const country = opts.country ?? null;

  // その地名がどの都道府県を指すかが分かるなら、答え合わせに使います。
  const detected = detectAreas(name, opts.kb ?? { regions: [] });
  const allowedPrefectures = (!country || country === "日本")
    ? (MACRO_AREAS[name]
       ?? detected.find((a) => a.term === name)?.prefectures
       ?? detected[0]?.prefectures
       ?? null)
    : null;

  let raw;
  try {
    raw = extractJson(await call(
      buildPrompt(name, { areaCount, spotCount, country,
                          when: opts.when, note: opts.note }),
      { temperature: 0.2, search: true, signal: opts.signal }));
  } catch (e) {
    return { ...empty, reason: `調べられませんでした: ${e?.message ?? e}` };
  }

  const knownNames = new Set((opts.kb?.spots ?? []).map((s) => s.name));
  const result = validateDiscovered(raw, { term: name, allowedPrefectures,
                                           knownNames, country });
  if (!result.regions.length) {
    return { ...empty, ...result,
      reason: `「${name}」について、確かなデータを得られませんでした` };
  }

  const { sources } = lastGrounding();
  const data = { regions: result.regions, spots: result.spots,
                 rejected: result.rejected,
                 unverifiedPlace: result.unverifiedPlace ?? [],
                 sources, country };
  if (useCache) cacheSet(name, data);
  return { ok: true, term: name, ...data, cached: false };
}
