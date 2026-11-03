// 未知の要望への汎用の流れ（Issue #443）。
//
// 「100名城を回りたい」「中山道を自転車で走破したい」のような要望は、
// 決まった旅程（1〜数日で、1つの土地をめぐる）の形に入りません。
// 専用の処理（#442 の特殊旅程ハンドラ）が無くても答えられるように、
// どの要望にも同じ順で当てる流れをここに置きます。
//
//   READ       要望の形を読む
//                list  … 決まった一覧を回る（◯◯100名城・百名山・滝百選…）
//                route … 道を通しで行く（中山道・◯◯街道・国道◯号…を走破）
//   COLLECT    一覧・沿う街をネットで取り、収録（kb）のスポット・街と照らす
//   GROUP      都道府県・地方でまとめる
//   SCHEDULE   距離と日数から日程に落とす（自転車は1日50km など）
//   FILL       宿・レンタサイクルのような足りない情報を、検索結果から補う
//
// 道具はすべて tools.js の登録所から呼びます（web_search・search_spots・
// search_historical_route・calculate_route）。AI（llm）は検索結果から
// 名前を拾うところだけを手伝います（research.js の modelLlm と同じ形）。
// 距離・日数・順番の計算は、ここで機械的にします。
//
// **一覧そのものは手元に持ちません。** 公式の一覧は選び直されることが
// あり（続日本100名城のように増えることも）、持てば古くなります。
// 調べて取れた分だけを、取れたと書いて使います。

import { blockOf } from "./areas.js";
import { findPlace } from "./places.js";
import { readJourney } from "./journeys.js";
import { straightKm } from "./providers.js";
import { spotBrief } from "./tools.js";
import { spotsMentioned } from "./research.js";

/** 一覧を取りに行く検索の上限。 */
export const MAX_LIST_SEARCHES = 3;
/** 足りない情報（宿・レンタル）を補う検索の上限。 */
export const MAX_FILL_SEARCHES = 2;

/** 直線距離を、道の長さの目安にする倍率。 */
export const ROAD_FACTOR = 1.3;

/**
 * 移動のしかたごとの、1日に進む距離（km）と、1日に回れる一覧の数。
 * 自転車の 50km は、荷物を積んで観光もしながらの無理のない目安です
 * （走るだけの人は 100km 以上も走りますが、旅程には余白を残します）。
 */
export const PACE = Object.freeze({
  bicycle:    { label: "自転車", perDayKm: 50,  perDaySpots: 2 },
  walk:       { label: "徒歩",   perDayKm: 20,  perDaySpots: 2 },
  motorcycle: { label: "バイク", perDayKm: 200, perDaySpots: 4 },
  car:        { label: "車",     perDayKm: 250, perDaySpots: 4 },
  transit:    { label: "電車・バス", perDayKm: 300, perDaySpots: 3 },
});

/** 1日の距離は、この割合までなら超えても1日にまとめます（街の切れ目に合わせるため）。 */
const SLACK = 1.2;

// ---------------------------------------------------------------------------
//  READ
// ---------------------------------------------------------------------------

const toHalf = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/** 移動のしかた。書いていなければ null。 */
export function readMode(text) {
  const s = String(text ?? "");
  if (/自転車|サイクリング|チャリ|ロードバイク|クロスバイク|輪行|cycling|bicycle/i.test(s)) return "bicycle";
  if (/バイク|ツーリング|オートバイ|motorcycle/i.test(s)) return "motorcycle";
  if (/歩いて|徒歩|歩き通|街道歩き|ウォーキング|walking|on foot/i.test(s)) return "walk";
  if (/レンタカー|マイカー|ドライブ|(?<![電列汽馬])車で/.test(s)) return "car";
  if (/電車|列車|鉄道|新幹線|バスで|青春18|18きっぷ/.test(s)) return "transit";
  return null;
}

// 決まった一覧。「日本100名城」「続日本100名城」「百名山」「日本の滝百選」「名水百選」…
const LIST_RE = /((?:続)?(?:日本|全国)?の?(?:[0-9０-９]{2,3}|百|二百|三百)(?:名城|名山|名瀑|名湯|名水|名橋|名園|名所|名刹|景)|[^\s、。をにで]{0,8}(?:[0-9０-９]{2,3}|百)選)/;
// 「全国の道の駅を全部回りたい」のような、数のない一覧。
const ALL_RE = /(?:日本|全国)(?:中)?の([^\s、。をにで]{2,10}?)を?(?:全部|すべて|全て|ぜんぶ|制覇|コンプリート|全制覇)/;

// 道を通しで行く。名前の付いた道（◯◯街道・◯◯古道・◯◯海道・国道◯号）と、
// 通しで行くことを表す語（走破・踏破…）か、人の力で進む移動のしかた。
const ROAD_RE = /([^\s、。をにで]{1,6}(?:街道|古道|往還|海道|遍路|巡礼道)|(?:国道|R|Ｒ)\s*[0-9０-９]{1,3}\s*号?線?)/;
const THROUGH_RE = /走破|踏破|完走|完歩|通しで|全行程|全区間|ゴールまで|端から端/;

/** 一覧の名前から、収録の分類（城・山・滝…）を当てます。分からなければ null。 */
export function categoryOfList(name) {
  const s = String(name ?? "");
  if (/城/.test(s)) return "城";
  if (/山/.test(s)) return "山";
  if (/滝|瀑/.test(s)) return "滝";
  if (/湯|温泉/.test(s)) return "温泉";
  if (/寺|刹/.test(s)) return "寺院";
  if (/道の駅/.test(s)) return "道の駅";
  if (/庭|園/.test(s)) return "庭園";
  return null;
}

/**
 * 要望の形を読みます。決まった一覧を回る（list）か、道を通しで行く（route）か。
 * どちらでもなければ null（いつもの流れ・Research Agent に任せます）。
 * @returns {{kind: "list"|"route", target: string, mode: string|null, category?: string|null,
 *   known?: object|null}|null}
 */
export function readQuest(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const mode = readMode(s);
  const list = LIST_RE.exec(s) ?? ALL_RE.exec(s);
  if (list) {
    const target = toHalf(list[1]).replace(/^の/, "");
    return { kind: "list", target, mode, category: categoryOfList(target) };
  }
  // 道。手元に沿う街を持つもの（中山道・東海道・日本縦断）は journeys.js から。
  const j = readJourney(s);
  const known = j?.along?.length && !j.spread ? j : null;
  const road = ROAD_RE.exec(s);
  const through = THROUGH_RE.test(s) || ["bicycle", "walk", "motorcycle"].includes(mode);
  if ((known || road) && through) {
    const target = known?.name ?? toHalf(road[1]).replace(/\s+/g, "");
    return { kind: "route", target, mode, known: known ? { name: known.name, along: known.along } : null };
  }
  return null;
}

// ---------------------------------------------------------------------------
//  道具の呼び出し（記録つき）
// ---------------------------------------------------------------------------

const safeLlm = async (llm, task, payload) => {
  if (typeof llm !== "function") return null;
  try {
    return await llm(task, payload);
  } catch {
    return null;
  }
};

function brief(obs) {
  if (!obs.ok) return { ok: false, error: obs.error };
  const d = obs.data;
  if (Array.isArray(d?.results)) return { ok: true, results: d.results.length };
  if (Array.isArray(d?.order)) return { ok: true, order: d.order.length, totalKm: d.totalKm };
  if (Array.isArray(d?.spots)) return { ok: true, total: d.total };
  if (Array.isArray(d?.along)) return { ok: true, found: d.found, along: d.along.length };
  return { ok: true, found: d?.found };
}

// ---------------------------------------------------------------------------
//  場所の座標
// ---------------------------------------------------------------------------

/**
 * 街の名前（「軽井沢」「馬籠」）を座標にします。出発地の一覧 → 収録のエリア
 * → 収録のスポット（「馬籠宿」）の順に探します。見つからなければ null。
 */
export function locateTown(name, kb) {
  const q = String(name ?? "").trim();
  if (!q) return null;
  const p = findPlace(q);
  if (p && (p.name === q || p.name.replace(/駅$/, "") === q)) return { name: q, lat: p.lat, lng: p.lng, via: "place" };
  const regions = kb?.regions ?? [];
  const r = regions.find((x) => x.name === q)
    ?? regions.find((x) => x.name.startsWith(q))
    ?? regions.find((x) => x.name.includes(q));
  if (r) return { name: q, lat: r.lat, lng: r.lng, prefecture: r.prefecture, regionId: r.id, via: "region" };
  const spot = (kb?.spots ?? []).filter((x) => x.name.startsWith(q))
    .sort((a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0))[0];
  if (spot) return { name: q, lat: spot.lat, lng: spot.lng, prefecture: spot.prefecture, via: "spot" };
  if (p) return { name: q, lat: p.lat, lng: p.lng, via: "place" };
  return null;
}

// ---------------------------------------------------------------------------
//  本体
// ---------------------------------------------------------------------------

/**
 * 未知の要望を、調べて・照らして・まとめて・日程に落とします。
 *
 * @param {{wish: string, tools: ReturnType<import("./tools.js").createToolRegistry>,
 *   origin?: {name: string, lat: number, lng: number}|null, days?: number|null,
 *   llm?: Function|null, quest?: object|null, maxListSearches?: number, maxFillSearches?: number}} opts
 * @returns {Promise<object|null>} 形が読めなければ null
 */
export async function runQuest({ wish, tools, origin = null, days = null, llm = null, quest = null,
  maxListSearches = MAX_LIST_SEARCHES, maxFillSearches = MAX_FILL_SEARCHES } = {}) {
  const text = String(wish ?? "").trim();
  const q = quest ?? readQuest(text);
  if (!q) return null;
  const trace = [];
  const sources = [];
  const act = async (state, thought, tool, args) => {
    const obs = await tools.call(tool, args);
    trace.push({ state, thought, action: { tool, args }, observation: brief(obs) });
    if (obs.ok && Array.isArray(obs.data?.results)) {
      for (const x of obs.data.results) if (!sources.some((s) => s.url === x.url)) sources.push({ title: x.title, url: x.url });
    }
    return obs;
  };
  const mode = q.mode ?? (q.kind === "route" ? "bicycle" : "transit");
  const pace = PACE[mode] ?? PACE.transit;
  const canSearch = tools.available().includes("web_search");
  const base = { kind: q.kind, target: q.target, mode, pace: { ...pace }, sources, trace,
    supplements: [], searches: 0, days: days ?? null };
  const out = q.kind === "list"
    ? await listQuest({ text, q, tools, origin, days, llm, act, pace, canSearch, limit: maxListSearches, base })
    : await routeQuest({ text, q, tools, origin, days, llm, act, pace, mode, canSearch, limit: maxListSearches, base });
  if (out.status === "answered" && canSearch && maxFillSearches > 0) {
    out.supplements = await fill({ out, act, mode, limit: maxFillSearches });
  }
  out.searches = trace.filter((t) => t.action?.tool === "web_search").length;
  return out;
}

// ---------------------------------------------------------------------------
//  list: 決まった一覧を回る
// ---------------------------------------------------------------------------

// 一覧を取る検索語。1回目は一覧そのもの、2回目からは東と西に分けて取りこぼしを拾います。
const LIST_TAILS = ["一覧", "一覧 北海道 東北 関東 中部", "一覧 近畿 中国 四国 九州 沖縄"];

async function listQuest({ text, q, tools, origin, days, llm, act, pace, canSearch, limit, base }) {
  const kb = tools.ctx.kb;
  const found = [];
  const extracted = new Set();
  let verified = true;
  if (canSearch) {
    for (let i = 0; i < Math.min(limit, LIST_TAILS.length); i++) {
      const r = await act("collect", `「${q.target}」の一覧をネットで取る（${i + 1}回目）`,
        "web_search", { query: `${q.target} ${LIST_TAILS[i]}`.slice(0, 80) });
      const results = r.ok ? r.data.results : [];
      if (!results.length) { if (i === 0) continue; break; }
      const body = results.map((x) => `${x.title}\n${x.snippet}`).join("\n");
      const ai = await safeLlm(llm, "extract", { wish: `${q.target}に選ばれている場所`, unknown: [q.target], results });
      const names = Array.isArray(ai?.places) ? ai.places.filter((p) => typeof p === "string") : [];
      for (const n of names) extracted.add(n);
      const hit = spotsMentioned(kb, body, names)
        // 一覧の分類（城・山…）が分かるときは、それらしい名前のものだけにします
        // （「松本城」の記事に出てくる「松本駅」「中町通り」を入れないため）。
        .filter((s) => !q.category || looksLike(s, q.category));
      for (const s of hit) if (!found.some((f) => f.id === s.id)) found.push(s);
    }
  }
  if (!found.length) {
    // 一覧が取れないとき。分類が分かれば、収録の同じ分類から近いものを出します。
    // 一覧に入っているかは確かめていない、と書きます。
    verified = false;
    if (q.category && kb?.spots?.length) {
      const pool = kb.spots.filter((s) => looksLike(s, q.category) && (s.fame_tier === "major" || (s.fame_score ?? 0) >= 60));
      found.push(...pool);
    }
  }
  if (!found.length) {
    return { ...base, status: "out_of_scope", verified: false, matched: [], groups: [], rounds: [], plan: null,
      message: `「${q.target}」の一覧を${canSearch ? "調べましたが、収録の場所と結び付きませんでした" : "取る手段（ネット検索）がいまは使えません"}。`
        + "回りたい場所の名前をいくつか書いてもらえれば、そこから組みます。",
      question: { question: `「${q.target}」のうち、まず回りたい場所や地方を教えてください。`, choices: [] } };
  }

  const groups = groupByPrefecture(found, origin);
  const rounds = roundsByBlock(found, pace);
  const plan = await pickTrip({ spots: found, origin, days: days ?? 2, pace, tools, act });
  const unmatched = [...extracted].filter((n) => !found.some((s) => s.name === n || n.includes(s.name)));
  const totalDays = rounds.reduce((s, r) => s + r.days, 0);
  const listed = verified
    ? `「${q.target}」を調べ、収録と照らせた${found.length}か所`
    : `「${q.target}」の一覧は取れなかったので、収録の${q.category}から知られた${found.length}か所`;
  const message = `${listed}を${groups.length}の都府県に分けました。`
    + `${pace.label}で1日${pace.perDaySpots}か所ずつなら、全部で約${totalDays}日（地方ごとに${rounds.length}回の旅）です。`
    + (plan ? `まずは${Math.max(plan.days.length, days ?? 0)}日で${[...new Set(plan.order.map((s) => s.prefecture))].join("・")}の`
      + `${plan.order.length}か所（${plan.order.map((s) => s.name).join("・")}）から始めるのが現実的です。` : "")
    + (verified ? "一覧の全部が収録にあるわけではありません。" : "一覧に入っているかは確かめていません。");
  return { ...base, status: "answered", verified, matched: found.map((s) => spotBrief(s)), unmatched,
    groups, rounds, plan, totalDays, message, question: null };
}

/** スポットが、一覧の分類（城・山…）らしいか。 */
function looksLike(spot, category) {
  if (spot.category === category) return true;
  const n = spot.name ?? "";
  if (category === "城") return /(城|城跡|城址|館|陣屋|五稜郭|チャシ)$/.test(n) || /城/.test(n) && spot.category === "史跡";
  if (category === "山") return /(山|岳|峰)$/.test(n);
  if (category === "滝") return /滝$/.test(n);
  if (category === "温泉") return /温泉/.test(n);
  return false;
}

/** 都道府県ごとにまとめ、出発地に近い順に並べます（出発地が無ければ数の多い順）。 */
function groupByPrefecture(spots, origin) {
  const by = new Map();
  for (const s of spots) {
    const k = s.prefecture || "（県不明）";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  const out = [...by.entries()].map(([prefecture, list]) => {
    const lat = list.reduce((a, s) => a + s.lat, 0) / list.length;
    const lng = list.reduce((a, s) => a + s.lng, 0) / list.length;
    return { prefecture, block: blockOf({ prefecture }), count: list.length,
      spots: list.map((s) => ({ id: s.id, name: s.name })),
      km: origin ? Math.round(straightKm(origin, { lat, lng })) : null };
  });
  return out.sort((a, b) => (a.km != null && b.km != null ? a.km - b.km : b.count - a.count));
}

/** 地方ごとに1回の旅とみなした、全部を回る目安。 */
function roundsByBlock(spots, pace) {
  const by = new Map();
  for (const s of spots) {
    const b = blockOf({ prefecture: s.prefecture });
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(s);
  }
  return [...by.entries()].map(([block, list]) => ({
    block, count: list.length,
    prefectures: [...new Set(list.map((s) => s.prefecture))],
    days: Math.max(1, Math.ceil(list.length / pace.perDaySpots)),
  })).sort((a, b) => b.count - a.count);
}

/**
 * 最初の1回の旅を選びます。出発地にいちばん近い場所を起点に、その近く
 * （移動のしかたで決まる範囲）のものを、日数×1日の数まで足します。
 */
async function pickTrip({ spots, origin, days, pace, tools, act }) {
  const n = Math.max(1, Math.min(14, Math.round(days))) * pace.perDaySpots;
  // 1回目の旅は、1日に1つの土地で済む範囲にまとめます（電車・バスなら約60km）。
  // 広く取ると、旅程の側で「必ず行く」を落とすことになります。
  const radius = Math.max(5, Math.min(60, pace.perDayKm * 0.2));
  const sorted = origin
    ? [...spots].sort((a, b) => straightKm(origin, a) - straightKm(origin, b))
    : [...spots].sort((a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0));
  const seed = sorted[0];
  if (!seed) return null;
  const near = spots.filter((s) => straightKm(seed, s) <= radius)
    .sort((a, b) => straightKm(seed, a) - straightKm(seed, b))
    .slice(0, Math.min(n, 20));
  const r = await act("schedule", `${seed.name}の近くの${near.length}か所を回る順に並べる`, "calculate_route",
    { spotIds: near.map((s) => s.id), ...(origin ? { start: { name: origin.name ?? "出発地", lat: origin.lat, lng: origin.lng } } : {}) });
  const order = r.ok ? r.data.order : near.map((s) => spotBrief(s));
  const dayCount = Math.max(1, Math.ceil(order.length / pace.perDaySpots));
  const dayList = [];
  for (let d = 0; d < dayCount; d++) {
    dayList.push({ day: d + 1, spots: order.slice(d * pace.perDaySpots, (d + 1) * pace.perDaySpots).map((s) => s.name) });
  }
  return { order, days: dayList, totalKm: r.ok ? r.data.totalKm : null, spotIds: order.map((s) => s.id) };
}

// ---------------------------------------------------------------------------
//  route: 道を通しで行く
// ---------------------------------------------------------------------------

async function routeQuest({ text, q, tools, origin, days, llm, act, pace, mode, canSearch, limit, base }) {
  const kb = tools.ctx.kb;
  let along = q.known?.along ?? [];
  let from = q.known ? "journeys" : null;
  if (!along.length) {
    const r = await act("collect", `「${q.target}」の沿う街を手元で調べる`, "search_historical_route", { name: q.target.slice(0, 40) });
    if (r.ok && r.data.found) { along = r.data.along; from = "historical"; }
  }
  if (!along.length && canSearch) {
    for (let i = 0; i < Math.min(limit, 2) && along.length < 2; i++) {
      const r = await act("collect", `「${q.target}」の宿場・経由地をネットで調べる（${i + 1}回目）`, "web_search",
        { query: `${q.target} ${i ? "ルート 起点 終点" : "宿場 一覧"}`.slice(0, 80) });
      const results = r.ok ? r.data.results : [];
      if (!results.length) continue;
      const ai = await safeLlm(llm, "extract", { wish: `${q.target}の起点から終点までの経由地（順番どおり）`, unknown: [q.target], results });
      const names = Array.isArray(ai?.places) ? ai.places : townsInText(results.map((x) => `${x.title}\n${x.snippet}`).join("\n"), kb);
      along = names.filter((n) => typeof n === "string" && locateTown(n, kb));
      from = "web";
    }
  }
  const points = along.map((n) => locateTown(n, kb)).filter(Boolean);
  if (points.length < 2) {
    return { ...base, status: "out_of_scope", stages: [], rounds: [], plan: null,
      message: `「${q.target}」の道筋が${canSearch ? "調べても" : "手元では"}分かりませんでした。起点と終点の街の名前を書いてもらえれば、そこから組みます。`,
      question: { question: `「${q.target}」の起点と終点の街を教えてください。`, choices: [] } };
  }
  // 出発地に近い端から始めます。
  if (origin && straightKm(origin, points[0]) > straightKm(origin, points.at(-1))) points.reverse();
  const stages = cutStages(points, pace.perDayKm, kb);
  const totalKm = Math.round(stages.reduce((s, x) => s + x.km, 0));
  const need = stages.length;
  const want = days ? Math.max(1, Math.round(days)) : need;
  const rounds = [];
  for (let i = 0; i < need; i += want) {
    const part = stages.slice(i, i + want);
    rounds.push({ round: rounds.length + 1, from: part[0].from, to: part.at(-1).to, days: part.length,
      km: Math.round(part.reduce((s, x) => s + x.km, 0)) });
  }
  // 沿う街の近くの、知られた立ち寄り先（1日に1〜2か所）。
  for (const st of stages) st.stops = nearbySights(kb, st.toPoint, st.fromPoint).map((s) => s.name);
  const access = origin && straightKm(origin, points[0]) > 30
    ? { from: origin.name ?? "出発地", to: points[0].name, km: Math.round(straightKm(origin, points[0]) * ROAD_FACTOR),
        note: mode === "bicycle" ? "起点までは輪行（自転車を袋に入れて電車）か、起点の近くで借りるのが楽です" : "起点までは電車で向かいます" }
    : null;
  const message = `「${q.target}」（${points[0].name}→${points.at(-1).name}）は、沿う街をつなぐと約${totalKm}km。`
    + `${pace.label}で1日${pace.perDayKm}kmなら${need}日かかります。`
    + (want < need
      ? `${want}日ずつなら${rounds.length}回に分けるのが現実的です（1回目は${rounds[0].from}→${rounds[0].to}、約${rounds[0].km}km）。`
      : `泊まる街は${stages.slice(0, -1).map((s) => s.to).join("・") || "なし"}です。`)
    + "距離は街どうしの直線距離からの目安で、道の上り下りは入っていません。";
  return { ...base, status: "answered", along: points.map((p) => p.name), alongFrom: from, stages: stages.map(stripPoints),
    totalKm, totalDays: need, rounds, access, plan: null, message, question: null };
}

const stripPoints = ({ fromPoint, toPoint, ...rest }) => rest;

/**
 * 沿う街を、1日の距離で区切ります。街の切れ目で区切り、1日の距離を
 * SLACK 倍まで超えるときだけ前の街で泊まります。街と街の間が1日より
 * 長いときは、その区間を等分して「途中泊」にします。
 */
export function cutStages(points, perDayKm, kb = null) {
  const stages = [];
  let start = points[0];
  let km = 0;
  let via = [];
  const close = (to, partial = null) => {
    stages.push({ day: stages.length + 1, from: start.name, to: partial ?? to.name, km: Math.round(km * 10) / 10,
      via: via.slice(), fromPoint: start, toPoint: to, midway: Boolean(partial) });
  };
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const d = straightKm(prev, cur) * ROAD_FACTOR;
    if (d > perDayKm * SLACK) {
      if (km > 0) { close(prev); start = prev; km = 0; via = []; }
      const parts = Math.ceil(d / perDayKm);
      for (let k = 1; k < parts; k++) {
        km = d / parts;
        const t = k / parts;
        const at = { lat: prev.lat + (cur.lat - prev.lat) * t, lng: prev.lng + (cur.lng - prev.lng) * t };
        // 途中の泊まりは、その位置にいちばん近い収録の街（15km まで）にします。
        const town = nearestTown(kb, at, 15, [prev.name, cur.name]);
        const mid = town ?? { name: `${prev.name}→${cur.name}の途中${parts > 2 ? `（${k}）` : ""}`, ...at };
        close(mid, mid.name);
        start = mid; via = [];
      }
      km = d / parts;
      close(cur); start = cur; km = 0; via = [];
      continue;
    }
    if (km > 0 && km + d > perDayKm * SLACK) {
      close(prev); start = prev; km = 0; via = [];
    }
    km += d;
    if (i < points.length - 1) via.push(cur.name);
  }
  if (km > 0) {
    // 最後の街は via に入れていないので、そのまま閉じます。
    const last = points.at(-1);
    if (via.at(-1) === last.name) via.pop();
    close(last);
  }
  for (const s of stages) s.via = s.via.filter((n) => n !== s.to && n !== s.from);
  return stages;
}

/** その位置にいちばん近い収録のエリア（maxKm まで）。名前は「市・町・村」を外します。 */
function nearestTown(kb, at, maxKm, skip = []) {
  let best = null;
  let bestKm = maxKm;
  for (const r of kb?.regions ?? []) {
    const name = String(r.name ?? "").replace(/(?<=..)[市町村]$/, "");
    if (!name || skip.some((n) => name.includes(n) || n.includes(name))) continue;
    const d = straightKm(at, r);
    if (d < bestKm) { best = { name, lat: r.lat, lng: r.lng, prefecture: r.prefecture }; bestKm = d; }
  }
  return best;
}

/** 区間の終わりの街の近く（10km以内）の、知られたスポット。 */
function nearbySights(kb, at, from) {
  if (!at || !kb?.spots?.length) return [];
  return kb.spots
    .filter((s) => (s.fame_tier === "major") && straightKm(at, s) <= 10 && (!from || straightKm(from, s) > 3))
    .sort((a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0))
    .slice(0, 2);
}

/** 文の中に出てくる、収録のエリアの名前（AI が無いときの拾いかた）。出てくる順。 */
function townsInText(text, kb) {
  const hits = [];
  for (const r of kb?.regions ?? []) {
    const n = String(r.name ?? "").replace(/[市町村]$/, "");
    if (n.length < 2) continue;
    const at = text.indexOf(n);
    if (at >= 0 && !hits.some((h) => h.name === n)) hits.push({ name: n, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.name);
}

// ---------------------------------------------------------------------------
//  FILL: 足りない情報を検索結果から補う
// ---------------------------------------------------------------------------

/**
 * 旅に要るのに収録に無いもの（宿・レンタサイクル）を調べます。
 * 見つけたのは手がかり（ページの題と URL と抜粋）だけで、空き・料金は
 * 確かめていません。そう書きます。
 */
async function fill({ out, act, mode, limit }) {
  const asks = [];
  if (out.kind === "route") {
    const first = out.stages[0];
    if (mode === "bicycle") asks.push({ need: "rental", place: first.from, query: `${first.from} レンタサイクル 乗り捨て` });
    const stay = out.stages.find((s) => !s.midway && s.day < out.stages.length)?.to;
    if (stay) asks.push({ need: "lodging", place: stay, query: `${stay} 宿 ${mode === "bicycle" ? "自転車 保管" : "素泊まり"}` });
  } else if (out.plan?.order?.length) {
    const pref = out.plan.order[0].prefecture;
    if (mode === "bicycle") asks.push({ need: "rental", place: out.plan.order[0].name, query: `${out.plan.order[0].name} レンタサイクル` });
    if ((out.plan.days?.length ?? 0) > 1) asks.push({ need: "lodging", place: pref, query: `${pref} ${out.plan.order[0].name} 周辺 宿` });
  }
  const label = { rental: "レンタサイクル", lodging: "宿" };
  const res = [];
  for (const a of asks.slice(0, limit)) {
    const r = await act("fill", `足りない「${label[a.need]}」を、${a.place}で調べる`, "web_search", { query: a.query.slice(0, 80) });
    const results = (r.ok ? r.data.results : [])
      .filter((x) => `${x.title}${x.snippet}`.includes(a.place.replace(/[都道府県]$/, "")))
      .slice(0, 3);
    res.push({ need: a.need, place: a.place, found: results.length > 0,
      sources: results.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet })),
      note: results.length ? "検索で見つけた手がかりです。空き・料金・貸し出しの条件は、先方で確かめてください。"
        : `${a.place}の${label[a.need]}は、検索では見つかりませんでした。` });
  }
  return res;
}
