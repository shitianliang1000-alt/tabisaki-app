// Research Agent（ReAct を状態機械にしたもの。Issue #436）。
//
// 収録（kb）に無い要望（「夏目友人帳の舞台をめぐりたい」）は、決まった
// 流れ（pipeline.js）では行き先が出ません。そこで、
//
//   ASSESS     kb で答えられるかを見る（search_spots・search_special_journey）
//   QUERY      調べる語を作る（AI があれば AI、無ければ語の組み立て）
//   SEARCH     ネットで調べる（web_search）
//   INTEGRATE  結果に出てくる場所を、kb のスポットに結び付ける
//   PLAN       見つけたスポットを回る順に並べる（calculate_route）
//   DONE / OUT_OF_SCOPE
//
// の順に進めます。SEARCH は最大3回（maxSearches）。1回で場所が見つかれば
// そこで打ち切ります（Single-hop が基本。遅さを抑えるため）。
//
// 道具はすべて tools.js の登録所から呼びます。AI（llm）は「調べる語」と
// 「結果から場所の名前を拾う」ところだけを手伝い、時刻や移動の計算は
// しません。AI が無くても、失敗しても、語の組み立てで最後まで進みます。
//
// 対応できないとき（海外・調べても見つからない）は、そう正直に言い、
// 手元で出せる代わりの案を添えます。

import { extractKeywords, GENERIC_TERMS } from "./keywords.js";
import { spotBrief } from "./tools.js";
import { straightKm } from "./providers.js";

export const MAX_SEARCHES = 3;

export const STATES = Object.freeze({
  ASSESS: "assess", QUERY: "query", SEARCH: "search", INTEGRATE: "integrate",
  PLAN: "plan", DONE: "done", OUT_OF_SCOPE: "out_of_scope",
});

// 旅さきは日本の中だけを扱います。
const OVERSEAS = /海外|ハワイ|グアム|パリ|ロンドン|ニューヨーク|ソウル|釜山|台湾|台北|香港|上海|北京|バンコク|シンガポール|ベトナム|バリ島|セブ島|ヨーロッパ|イタリア|フランス|スペイン|ドイツ|アメリカ|韓国|中国|オーストラリア|カナダ|エジプト/;

/** 希望文が日本の外を指しているか。指していれば、その語。 */
export function overseasWord(text) {
  return OVERSEAS.exec(String(text ?? ""))?.[0] ?? null;
}

// 調べる語に足すと、観光の場所が出やすくなる語。回ごとに変えます。
const QUERY_TAILS = ["観光 場所", "ゆかりの地 どこ", "モデル 舞台 市町村"];

/** AI が無いときの調べる語。 */
export function heuristicQuery(unknown, round) {
  const base = unknown.join(" ").slice(0, 60);
  return `${base} ${QUERY_TAILS[Math.min(round, QUERY_TAILS.length - 1)]}`.trim().slice(0, 80);
}

/**
 * kb のスポットの名前の索引（長い名前から当てる）。
 * 3字未満の名前と、一般の語（「展望台」「公園」）だけの名前は使いません。
 */
function nameIndex(kb) {
  if (kb.__researchNames) return kb.__researchNames;
  const seen = new Map();
  for (const s of kb.spots) {
    const n = s.name;
    if (!n || n.length < 3 || GENERIC_TERMS.has(n) || /^(展望台|公園|神社|寺|城跡|温泉|美術館|博物館|資料館)$/.test(n)) continue;
    if (!seen.has(n) || (s.fame_score ?? 0) > (seen.get(n).fame_score ?? 0)) seen.set(n, s);
  }
  const list = [...seen.values()].sort((a, b) => b.name.length - a.name.length);
  Object.defineProperty(kb, "__researchNames", { value: list, enumerable: false });
  return list;
}

/**
 * 文の中に出てくる kb のスポットを拾います。長い名前を先に当て、
 * その中に含まれる短い名前は数えません（「人吉城跡」の中の「人吉城」など）。
 */
export function spotsMentioned(kb, text, names = []) {
  const body = `${text}\n${names.join("\n")}`;
  const found = [];
  const taken = [];
  for (const s of nameIndex(kb)) {
    let at = body.indexOf(s.name);
    if (at < 0) continue;
    while (at >= 0 && taken.some(([a, b]) => at >= a && at < b)) at = body.indexOf(s.name, at + 1);
    if (at < 0) continue;
    taken.push([at, at + s.name.length]);
    found.push(s);
  }
  return found;
}

/** いちばん多く出てくる県。旅程は1つの土地にまとめます。 */
function mainPrefecture(spots) {
  const count = new Map();
  for (const s of spots) if (s.prefecture) count.set(s.prefecture, (count.get(s.prefecture) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const safeLlm = async (llm, task, payload, schema) => {
  if (typeof llm !== "function") return null;
  try {
    return await llm(task, payload, schema);
  } catch {
    return null;
  }
};

/**
 * 調べて、行き先を決めます。
 *
 * @param {{wish: string, tools: ReturnType<import("./tools.js").createToolRegistry>,
 *          origin?: {name: string, lat: number, lng: number}, llm?: Function,
 *          maxSearches?: number, maxSpots?: number}} opts
 *   llm は async (task, payload, schema) → JSON。task は "query" か "extract"。
 * @returns {Promise<{status: "answered"|"kb"|"special"|"out_of_scope", message: string,
 *   spots: object[], order: object[], prefecture: string|null, sources: object[],
 *   searches: number, question: object|null, alternatives: object[], trace: object[]}>}
 */
export async function runResearch({ wish, tools, origin = null, llm = null,
  maxSearches = MAX_SEARCHES, maxSpots = 6 } = {}) {
  const text = String(wish ?? "").trim();
  const kb = tools.ctx.kb;
  const limit = Math.max(0, Math.min(MAX_SEARCHES, maxSearches));
  const trace = [];
  const sources = [];
  const tried = [];
  let state = STATES.ASSESS;
  let unknown = [];
  let covered = [];
  let journey = null;
  let found = [];
  let searches = 0;
  let query = "";
  let lastResults = [];
  const result = { status: null, message: "", spots: [], order: [], prefecture: null, sources,
    searches: 0, question: null, alternatives: [], journey: null, special: null, trace };

  const act = async (thought, tool, args) => {
    const obs = await tools.call(tool, args);
    trace.push({ state, thought, action: { tool, args }, observation: brief(obs) });
    return obs;
  };
  act.trace = trace;

  // 状態は前へしか進みません（SEARCH ⇄ QUERY だけ、回数の上限まで戻れます）。
  for (let guard = 0; guard < 20 && state !== STATES.DONE && state !== STATES.OUT_OF_SCOPE; guard++) {
    if (state === STATES.ASSESS) {
      const abroad = overseasWord(text);
      if (abroad) {
        result.message = `「${abroad}」は日本の外なので、旅さきでは組めません（収録は日本国内だけです）。`
          + "近い雰囲気の国内の行き先なら出せます。";
        result.alternatives = await alternativesFor(text.replace(OVERSEAS, " "), tools, act, origin);
        state = STATES.OUT_OF_SCOPE;
        continue;
      }
      const j = await act("名のある旅のしかたか確かめる", "search_special_journey", { text: text.slice(0, 200) });
      if (j.ok && j.data.found) journey = j.data.journey;
      // 特殊な旅の形（青春18きっぷ・世界遺産全制覇…）は、ネットで調べず、
      // その形の処理（special.js）に回します。
      if (j.ok && j.data.special) {
        result.status = "special";
        result.special = j.data.special;
        result.message = `「${j.data.special.name}」の旅として、専用の組みかたで組みます。`;
        state = STATES.DONE;
        continue;
      }
      const { keywords } = extractKeywords(text);
      for (const k of keywords.slice(0, 8)) {
        const r = await act(`「${k}」が収録にあるか`, "search_spots", { keywords: [k], limit: 5 });
        (r.ok && r.data.total > 0 ? covered : unknown).push(k);
      }
      if (journey || !unknown.length) {
        // kb で答えられます。決まった流れ（pipeline.js）に任せます。
        result.status = "kb";
        result.message = journey ? `「${journey.name}」として、収録から組みます。` : "収録の中から組めます。";
        state = STATES.DONE;
      } else if (!limit || !tools.available().includes("web_search")) {
        result.message = `「${unknown.join("・")}」は収録に無く、ネットで調べる手段も使えません。`;
        state = STATES.OUT_OF_SCOPE;
      } else state = STATES.QUERY;
      continue;
    }

    if (state === STATES.QUERY) {
      const ai = await safeLlm(llm, "query", { wish: text, unknown, tried, round: searches },
        { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 2, maxLength: 80 } } });
      const q = typeof ai?.query === "string" && ai.query.trim().length >= 2 ? ai.query.trim().slice(0, 80) : "";
      query = q && !tried.includes(q) ? q : heuristicQuery(unknown, searches);
      if (tried.includes(query)) query = `${query} ${searches + 1}`.slice(0, 80);
      tried.push(query);
      state = STATES.SEARCH;
      continue;
    }

    if (state === STATES.SEARCH) {
      searches++;
      const r = await act(`収録に無い「${unknown.join("・")}」をネットで調べる（${searches}/${limit}回目）`,
        "web_search", { query });
      lastResults = r.ok ? r.data.results : [];
      for (const x of lastResults) if (!sources.some((s) => s.url === x.url)) sources.push({ title: x.title, url: x.url });
      state = STATES.INTEGRATE;
      continue;
    }

    if (state === STATES.INTEGRATE) {
      const body = lastResults.map((x) => `${x.title}\n${x.snippet}`).join("\n");
      const ai = body ? await safeLlm(llm, "extract", { wish: text, unknown, results: lastResults },
        { type: "object", required: ["places"], properties: { places: { type: "array", maxItems: 12, items: { type: "string", maxLength: 40 } } } }) : null;
      const names = Array.isArray(ai?.places) ? ai.places.filter((p) => typeof p === "string") : [];
      const hit = spotsMentioned(kb, body, names);
      trace.push({ state, thought: "調べた結果に出てくる場所を、収録のスポットに結び付ける",
        action: null, observation: { matched: hit.slice(0, 10).map((s) => s.name) } });
      for (const s of hit) if (!found.some((f) => f.id === s.id)) found.push(s);
      if (found.length) state = STATES.PLAN;
      else if (searches < limit) state = STATES.QUERY;
      else {
        result.message = `「${unknown.join("・")}」を${searches}回調べましたが、収録にある場所に結び付きませんでした。`;
        state = STATES.OUT_OF_SCOPE;
      }
      continue;
    }

    if (state === STATES.PLAN) {
      const pref = mainPrefecture(found);
      const picked = found.filter((s) => !pref || s.prefecture === pref).slice(0, maxSpots);
      const r = await act(`${pref ?? ""}の${picked.length}か所を回る順に並べる`, "calculate_route",
        { spotIds: picked.map((s) => s.id), ...(origin ? { start: { name: origin.name, lat: origin.lat, lng: origin.lng } } : {}) });
      result.status = "answered";
      result.prefecture = pref;
      result.spots = picked.map((s) => spotBrief(s));
      result.order = r.ok ? r.data.order : result.spots;
      result.message = `「${unknown.join("・")}」をネットで調べ（${searches}回）、`
        + `${pref ? `${pref}の` : ""}${result.order.map((s) => s.name).join("・")}を見つけました。`
        + "調べた先の情報は変わることがあるので、出かける前に確かめてください。";
      state = STATES.DONE;
      continue;
    }
  }

  if (state === STATES.OUT_OF_SCOPE) {
    result.status = "out_of_scope";
    if (!result.alternatives.length) result.alternatives = await alternativesFor(text, tools, act, origin);
    if (!overseasWord(text)) {
      const q = await act("どのあたりか分かれば組めるので、利用者に聞く", "ask_user", {
        question: "行きたい場所の都道府県か、近くの駅の名前を教えてください。そこから組み直します。",
      });
      if (q.ok) result.question = q.data;
    }
    if (result.alternatives.length) {
      result.message += ` かわりに、${result.alternatives.slice(0, 3).map((s) => s.name).join("・")}はいかがですか。`;
    }
  }
  result.searches = searches;
  result.journey = journey;
  return result;
}

/**
 * 代わりの案。希望のジャンル（温泉・城…）が読めれば、それで収録を探します。
 * 読めなければ、出発地の近く（約150km）の知られた場所を出します。
 * 「舞台」のような、ジャンルでない残りの語では探しません（「淡路夢舞台」が出るため）。
 */
async function alternativesFor(text, tools, act, origin) {
  const { genres, keywords } = extractKeywords(text);
  const words = [...new Set([...keywords.filter((k) => genres.length && k.length >= 2)])].slice(0, 4);
  if (words.length) {
    const r = await act("代わりに出せる国内の場所を、希望のジャンルで探す", "search_spots", { keywords: words, limit: 5 });
    if (r.ok && r.data.spots.length) return r.data.spots;
  }
  const kb = tools.ctx.kb;
  if (!origin || !kb?.spots?.length) return [];
  const near = kb.spots
    .filter((s) => (s.fame_tier === "major") && straightKm(origin, s) <= 150)
    .sort((a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0))
    .slice(0, 5)
    .map((s) => spotBrief(s));
  noteDirect(act, near);
  return near;
}

// 収録から直に選んだときも、記録に残します（道具は使っていません）。
function noteDirect(act, spots) {
  act.trace?.push({ state: STATES.OUT_OF_SCOPE, thought: "出発地の近くの知られた場所を代わりに出す",
    action: null, observation: { top: spots.slice(0, 3).map((s) => s.name) } });
}

/** 道具の答えを、記録に残す短い形にします。 */
function brief(obs) {
  if (!obs.ok) return { ok: false, error: obs.error };
  const d = obs.data;
  if (Array.isArray(d?.spots)) return { ok: true, total: d.total, top: d.spots.slice(0, 3).map((s) => s.name) };
  if (Array.isArray(d?.results)) return { ok: true, results: d.results.length };
  if (Array.isArray(d?.order)) return { ok: true, order: d.order.map((s) => s.name), totalMinutes: d.totalMinutes };
  return { ok: true, ...d };
}

/**
 * AI のモデル（ai.js の callModelJson など。prompt → JSON）を、Research Agent の
 * llm の形にします。AI に頼むのは「調べる語」と「結果に出てくる場所の名前」だけです。
 * @param {(prompt: string, opts?: object) => Promise<object>} callJson
 */
export function modelLlm(callJson) {
  return async (task, payload) => {
    if (task === "query") {
      return callJson("旅行の希望に出てくる、旅行案内の収録に無い語を、ネットで調べます。"
        + "その語にゆかりのある日本の観光地が見つかるような、短い検索語（日本語・40字まで）を1つ作ってください。\n"
        + `希望: ${payload.wish}\n収録に無い語: ${payload.unknown.join("、")}\n`
        + (payload.tried.length ? `もう使った検索語（同じものは避ける）: ${payload.tried.join(" / ")}\n` : "")
        + '答えは {"query": "検索語"} の JSON だけで返してください。', { temperature: 0 });
    }
    if (task === "extract") {
      const lines = payload.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`).join("\n");
      return callJson("次の検索結果から、希望に合う日本の観光地・名所・施設の固有名を拾ってください。"
        + "検索結果に書かれていない名前は足さないでください。\n"
        + `希望: ${payload.wish}\n検索結果:\n${lines}\n`
        + '答えは {"places": ["名前", ...]} の JSON だけで返してください（12件まで）。', { temperature: 0 });
    }
    return null;
  };
}
