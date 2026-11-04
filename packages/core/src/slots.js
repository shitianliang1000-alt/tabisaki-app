// 足りない条件だけを聞く（動的スロットフィリング）。
//
// 旅を頼む文には、書いてあることと書いていないことがあります。
// 「明後日から1泊2日、2人で金沢へ」と書いた人に「いつ行きますか？」
// 「何人ですか？」と聞き直すのは、読んでいないのと同じです。逆に
// 「温泉でゆっくりしたい」だけなら、いつ・何日・誰と、が分かりません。
// これまでは分からないまま「今日・日帰り・1人」で組んでいました。
//
// ここでは、旅の条件を枠（スロット）に分けて、
//
//   1. はじめの文から、**全部の枠を一度に**読み取る
//   2. 埋まらなかった枠のうち、**聞く枠だけ**を聞く（埋まった枠は聞かない）
//   3. 最後に、読み取った内容を並べて確かめ、追加の要望（任意）を受ける
//
// という流れにします。枠を読む部品は、もとからあるものを使います
// （chatread.js・intent.js・purpose.js・sunny.js・keywords.js）。
// 答えは「1泊2日で」のような**文に戻して**希望文に足します。旅程を組む
// 側（pipeline.js）は文を読むので、ここで別の経路を作らずに済みます。
//
// 画面（js/slotcard.js）とは分けてあり、DOM を触りません。CLI や API からも
// 同じ判断が使えます。

import { readChat, stripOriginPhrase } from "./chatread.js";
import { readIntent } from "./intent.js";
import { purposeLabel } from "./purpose.js";
import { readWish } from "./sunny.js";
import { GENERIC_TERMS, GENRE_TERMS, extractKeywords } from "./keywords.js";
import { MACRO_AREAS, NAMED_SETS, PREFECTURES, mostSpecific } from "./areas.js";

/**
 * 枠の定義。
 *
 *   ask      … 埋まらなかったとき聞くか。聞かない枠は、確かめの欄に
 *              「おまかせ」と出し、追加の要望で書けるようにします。
 *              全部を聞くと、5段の質問と変わりません。旅程の形が大きく
 *              変わる3つ（どこ・いつ／何日・誰と）だけを聞きます。
 *   choices  … 聞くときの選択肢。text は希望文に足す言葉です（"" は何も
 *              足さない＝おまかせ）。「上記以外（自由記述）」は画面が
 *              必ず添えます（OTHER）。これは AI が使えないときの選択肢で、
 *              使えるときは文脈から作ったもの（choices.js、#441）に差し替えます。
 */
export const SLOTS = [
  {
    id: "destination", label: "行き先", ask: true,
    question: "どのあたりへ行きたいですか？",
    choices: [
      { id: "any", label: "おまかせ", text: "" },
      { id: "near", label: "近場で", text: "近場で" },
      { id: "onsen", label: "温泉地", text: "温泉地へ" },
      { id: "sea", label: "海の近く", text: "海の近くへ" },
      { id: "mountain", label: "山・高原", text: "山や高原へ" },
      { id: "city", label: "街歩き", text: "街歩きができるところへ" },
    ],
  },
  {
    id: "dates", label: "日程", ask: true,
    question: "いつ、何日の旅にしますか？",
    // 日程は「いつ」と「何日」の2つに分けて、足りないほうだけ聞きます。
    parts: {
      start: {
        question: "いつ出かけますか？",
        choices: [
          { id: "today", label: "今日", text: "今日から" },
          { id: "tomorrow", label: "明日", text: "明日から" },
          { id: "weekend", label: "今週末", text: "今週末に" },
          { id: "nextweekend", label: "来週末", text: "来週の週末に" },
        ],
      },
      nights: {
        question: "何日の旅にしますか？",
        choices: [
          { id: "0", label: "日帰り", text: "日帰りで" },
          { id: "1", label: "1泊2日", text: "1泊2日で" },
          { id: "2", label: "2泊3日", text: "2泊3日で" },
          { id: "3", label: "3泊以上", text: "3泊4日で" },
        ],
      },
    },
  },
  {
    id: "travelers", label: "人数", ask: true,
    question: "誰と行きますか？",
    choices: [
      { id: "1", label: "ひとり", text: "ひとりで" },
      { id: "2", label: "2人", text: "2人で" },
      { id: "kids", label: "子ども連れ", text: "子どもと家族で" },
      { id: "group", label: "友達と", text: "友達4人で" },
    ],
  },
  { id: "pace", label: "ペース", ask: false },
  { id: "transport", label: "移動手段", ask: false },
  { id: "interests", label: "したいこと", ask: false },
  { id: "budget", label: "予算", ask: false },
  { id: "weather_constraint", label: "天気", ask: false },
];

const BY_ID = new Map(SLOTS.map((s) => [s.id, s]));

/** 「上記以外（自由記述）」。どの質問にも必ず添えます。 */
export const OTHER = Object.freeze({ id: "other", label: "上記以外（自由に書く）", free: true });

/** 1回の確かめで聞く数の上限。多すぎると、結局は固定の質問攻めです。 */
export const MAX_QUESTIONS = 3;

const GENRE_LABEL = {
  onsen: "温泉", nature: "自然", history: "歴史", food: "グルメ",
  art: "アート", sea: "海・水辺", city: "街歩き", view: "絶景",
};
const TRANSPORT_LABEL = {
  transit: "電車・バス", local: "普通列車", car: "車", air: "飛行機",
  ferry: "船", walk: "歩き",
};

/** 行き先を決めてもらう言いかた（「どこでもいい」は答えです。聞き直しません）。 */
const ANYWHERE_RE = /おまかせ|お任せ|どこでも|どこか|行き先は(?:決めて|任せ)|行き先(?:未定|おまかせ)/;
/** 行き先の方向性（「温泉地へ」「海の近くへ」）。地名でなくても、行き先の答えです。 */
const DIRECTION_RE = /(温泉地|温泉街|海の近く|海辺|山や高原|山|高原|街歩きができるところ|離島|島|雪国|南の方|北の方)(?:へ|に行|に旅)/;
const NEAR_RE = /近場|近い(?:ところ|所)|近く(?:で|の|に)/;
/** 行き先の代わりになる、旅の形（行き先を聞いても意味がありません）。 */
const SHAPE_RE = /日本(?:列島)?縦断|列島縦断|日本一周|最長往復|国道\d+号|青春18|18きっぷ|周遊|乗り鉄/;

const PACE_RELAXED = /ゆっくり|のんびり|まったり|ゆったり|癒され|ゆるく|詰め込まない|余裕を持/;
const PACE_PACKED = /たくさん(?:回|まわ|巡|めぐ)|詰め込|欲張|効率よく|できるだけ多く|弾丸|アクティブ/;

const WEATHER_RE = /雨でも|雨の日|雨天|屋内|室内|晴れ(?:る|た)?(?:所|ところ|場所|日)|天気(?:が|の)?(?:いい|良い)|暑さ|寒さ|雪(?:でも|を避|の日)/;
const KIDS_RE = /子ども|子供|こども|キッズ|親子|赤ちゃん|幼児/;
const GROUP_RE = /家族|友達|友人|仲間|みんなで|グループ|両親|親と|母と|父と/;

const PREF_SHORT = PREFECTURES.map((p) => p.replace(/[都府県]$/, "")).filter((p) => p.length >= 2);

/**
 * 収録（kb）なしで分かる地名を拾います。収録で拾えるときは、画面から
 * areas（detectAreas の結果）を渡してもらいます。
 */
function plainPlaces(text) {
  const out = [];
  for (const k of [...Object.keys(MACRO_AREAS), ...Object.keys(NAMED_SETS)]) {
    if (text.includes(k)) out.push(k);
  }
  for (const p of PREF_SHORT) if (text.includes(p) && !out.some((o) => o.includes(p))) out.push(p);
  if (out.length) return out;
  // 「金沢へ」「横浜でデート」「鎌倉を歩く」。地名の辞書が無くても、
  // 行き先の言いかたで拾います。旅のしかたの語（温泉・海…）は除きます。
  for (const m of text.matchAll(PLACE_SAID)) {
    const term = m[1];
    if (NOT_DEST.has(term) || GENRE_WORDS.some((w) => term === w || (w.length >= 2 && term.startsWith(w)))) continue;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

const PLACE_SAID = /([一-龯々ヶァ-ヴー]{2,6})(?:へ|に行|に旅|を(?:旅|観光|巡|めぐ|まわ|回|散策|歩|日帰り|ひとり|一人|訪|見)|で(?![はもすきし]))/g;
const GENRE_WORDS = Object.values(GENRE_TERMS).flat().filter((w) => w.length >= 1);
const NOT_DEST = new Set([...GENERIC_TERMS, "近場", "遠く", "どこか", "行き先", "旅", "家族", "友達",
  "子ども", "子供", "一人", "二人", "夜景", "週末", "日帰り", "電車", "新幹線", "列車", "車",
  "飛行機", "船", "バス", "全国", "日本", "国内", "海外", "現地", "近所", "地元", "自分", "雨", "晴れ"]);

function filled(value, label, source = "text") {
  return { filled: true, value, label, source };
}
const EMPTY = Object.freeze({ filled: false, value: null, label: "", source: null });

/**
 * はじめの文から、全部の枠を一度に読み取ります。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @param {{term?: string, name?: string}[]|string[]} [opts.areas]
 *   収録から見つけた行き先（packages/core/src/areas.js の detectAreas）。
 *   渡さなければ、都道府県・地方名などの分かる名前だけで読みます。
 * @param {{start?: boolean, nights?: boolean, travelers?: boolean, transport?: boolean, budget?: boolean}} [opts.set]
 *   利用者が画面の欄で自分で選んだもの（「＋」の日時など）。選んであれば、
 *   文に書いてなくても埋まっています（聞き直しません）。
 * @returns {Record<string, {filled: boolean, value: any, label: string, source: string|null, parts?: object}>}
 */
export function extractSlots(text, { now = new Date(), areas = null, set = {} } = {}) {
  const src = String(text ?? "").normalize("NFKC");
  const read = readChat(src, now);
  const intent = readIntent(src);
  const wish = readWish(src);
  const { genres } = extractKeywords(src);
  const out = {};

  // --- 行き先 -----------------------------------------------------------
  // 出発地（「名古屋から」）を行き先と読まないよう、先に消してから見ます。
  const forPlace = read.origin ? stripOriginPhrase(src, read.origin) : src;
  const named = (areas ?? []).map((a) => (typeof a === "string" ? a : a?.term ?? a?.name))
    .filter(Boolean);
  const places = mostSpecificNames(named.length ? named : plainPlaces(forPlace));
  if (places.length) out.destination = filled(places, places.join("・"));
  else if (intent.toward?.length) out.destination = filled(intent.toward, intent.toward.join("・"));
  else if (SHAPE_RE.test(src)) out.destination = filled("journey", "旅の形で決める");
  else if (DIRECTION_RE.test(forPlace)) out.destination = filled("direction", forPlace.match(DIRECTION_RE)[1]);
  else if (wish.near || NEAR_RE.test(src)) out.destination = filled("near", "近場");
  else if (ANYWHERE_RE.test(src)) out.destination = filled("any", "おまかせ");
  else out.destination = EMPTY;

  // --- 日程（いつ・何日） ------------------------------------------------
  const start = read.start ? filled(read.start, read.labels.find((l) => /から$/.test(l) && /月/.test(l)) ?? "")
    : set.start ? filled(null, "設定どおり", "settings") : EMPTY;
  const nights = read.nights != null
    ? filled(read.nights, read.nights === 0 ? "日帰り" : `${read.nights}泊${read.nights + 1}日`)
    : set.nights ? filled(null, "設定どおり", "settings") : EMPTY;
  out.dates = {
    filled: start.filled && nights.filled,
    value: { start: read.start, nights: read.nights },
    label: [start.label, nights.label].filter(Boolean).join("・"),
    source: start.source ?? nights.source,
    parts: { start, nights },
  };

  // --- 人数 -------------------------------------------------------------
  if (read.people) out.travelers = filled(read.people, read.people === 1 ? "ひとり" : `${read.people}人`);
  else if (KIDS_RE.test(src)) out.travelers = filled("kids", "子ども連れ");
  else if (read.purposes.includes("date")) out.travelers = filled(2, "2人（デート）");
  else if (GROUP_RE.test(src)) out.travelers = filled("group", src.match(GROUP_RE)[0]);
  else if (set.travelers) out.travelers = filled(null, "設定どおり", "settings");
  else out.travelers = EMPTY;

  // --- ペース -----------------------------------------------------------
  if (PACE_PACKED.test(src)) out.pace = filled("packed", "多めに回る");
  else if (PACE_RELAXED.test(src) || read.purposes.includes("relax")) out.pace = filled("relaxed", "ゆっくり");
  else out.pace = EMPTY;

  // --- 移動手段 ---------------------------------------------------------
  if (intent.transport) out.transport = filled(intent.transport, TRANSPORT_LABEL[intent.transport] ?? intent.transport);
  else if (/普通列車|鈍行|各駅停車|青春18|18きっぷ/.test(src)) out.transport = filled("transit", "普通列車");
  else if (set.transport) out.transport = filled(null, "設定どおり", "settings");
  else out.transport = EMPTY;

  // --- したいこと -------------------------------------------------------
  const wants = [...new Set([
    ...genres.map((g) => GENRE_LABEL[g]).filter(Boolean),
    ...read.purposes.map((p) => purposeLabel(p)),
  ])];
  out.interests = wants.length ? filled(wants, wants.join("・")) : EMPTY;

  // --- 予算 -------------------------------------------------------------
  if (read.budgetYen) out.budget = filled(read.budgetYen, `${(read.budgetYen / 10000).toLocaleString("ja-JP")}万円`);
  else if (/安く|節約|格安|お金をかけ(?:ない|ず)/.test(src)) out.budget = filled("low", "安めに");
  else if (/贅沢|ぜいたく|豪華|奮発/.test(src)) out.budget = filled("high", "ぜいたくに");
  else if (set.budget) out.budget = filled(null, "設定どおり", "settings");
  else out.budget = EMPTY;

  // --- 天気 -------------------------------------------------------------
  const w = src.match(WEATHER_RE);
  if (read.sunny) out.weather_constraint = filled("sunny", "晴れる所");
  else if (w) out.weather_constraint = filled(/雨|屋内|室内/.test(w[0]) ? "rain-ok" : w[0], w[0]);
  else out.weather_constraint = EMPTY;

  return out;
}

/** 「京都・京都府」のように重なる名前は、具体的なほうだけにします。 */
function mostSpecificNames(names) {
  const uniq = [...new Set(names)];
  try {
    return mostSpecific(uniq.map((term) => ({ term, prefectures: [], regionIds: [] })))
      .map((a) => a.term);
  } catch {
    return uniq;
  }
}

/**
 * 聞く質問を並べます。埋まった枠は出しません。
 *
 * @returns {{slot: string, part?: string, question: string, choices: object[]}[]}
 */
export function missingQuestions(slots, { max = MAX_QUESTIONS, choices = null } = {}) {
  const out = [];
  const push = (q, fixed) => {
    const ai = choices?.[questionKey(q)];
    out.push(ai?.length ? { ...q, choices: withEnds(fixed, ai), ai: true } : { ...q, choices: [...fixed, OTHER] });
  };
  for (const def of SLOTS) {
    if (!def.ask) continue;
    const s = slots?.[def.id];
    if (s?.filled) continue;
    if (def.parts) {
      for (const [part, p] of Object.entries(def.parts)) {
        if (s?.parts?.[part]?.filled) continue;
        push({ slot: def.id, part, question: p.question }, p.choices);
      }
    } else {
      push({ slot: def.id, question: def.question }, def.choices);
    }
  }
  return out.slice(0, max);
}

/** 質問を見分ける鍵（"destination"・"dates.start"）。 */
export function questionKey(q) {
  return q.part ? `${q.slot}.${q.part}` : q.slot;
}

/**
 * AI が作った選択肢（#441、choices.js）の前後に、決め打ちの「おまかせ」
 * （あれば）と「上記以外（自由に書く）」を付けます。「上記以外」は必ず最後です。
 */
function withEnds(fixed, ai) {
  const any = fixed.find((c) => c.id === "any");
  return [...(any ? [any] : []), ...ai, OTHER];
}

/** 確かめの欄に出す、いまの内容。埋まっていない枠は「おまかせ」。 */
export function confirmLines(slots) {
  return SLOTS.map((def) => {
    const s = slots?.[def.id];
    return { slot: def.id, label: def.label, value: s?.filled ? s.label || "指定あり" : "おまかせ", filled: Boolean(s?.filled) };
  });
}

/**
 * 答えを、希望文に足す言葉にします。
 *
 * @param {{slot: string, part?: string}} q
 * @param {{choice?: string, text?: string}} answer choice は選んだ id、text は自由記述
 * @returns {string}
 */
export function answerText(q, answer) {
  if (!answer) return "";
  if (answer.text != null && String(answer.text).trim()) return String(answer.text).trim();
  // AI の選択肢（#441）は、質問そのものが持っています。
  const own = q.choices?.find((c) => c.id === answer.choice);
  if (own && !own.free) return own.text ?? "";
  const def = BY_ID.get(q.slot);
  const list = q.part ? def?.parts?.[q.part]?.choices : def?.choices;
  return list?.find((c) => c.id === answer.choice)?.text ?? "";
}

/**
 * 元の文に、答えと追加の要望を足します（「温泉でゆっくり。明日から。1泊2日で」）。
 * 何も足さなければ、元の文のままです。
 */
export function composeNote(base, phrases = [], extra = "") {
  const parts = [String(base ?? "").trim(), ...phrases.map((p) => String(p ?? "").trim()),
    String(extra ?? "").trim()].filter(Boolean);
  return parts.join("。").replace(/。{2,}/g, "。");
}

// --- やりとり ---------------------------------------------------------------
//
// 画面はこれを呼ぶだけです。状態は素のオブジェクトで、関数は新しい
// 状態を返します（前の状態は書き換えません）。
//
//   const d = startDialog("温泉でゆっくり");      // phase: "asking"
//   const d2 = replyDialog(d, "明日から2人で");    // 返信で埋まった分は消える
//   const d3 = answerDialog(d2, {slot, part}, { choice: "1" }); // 札で答える
//   finishDialog(d3, "露天風呂つきの宿")           // → 組むのに使う文

/**
 * やりとりを始めます。足りない枠が無ければ phase は "ready" です
 * （聞かずに、そのまま組みます）。
 */
export function startDialog(text, opts = {}) {
  const base = String(text ?? "").trim();
  // choices … AI が作った選択肢（#441）。読み直しても消えないよう、ここに持ちます。
  return reread({ base, phrases: [], marks: [], choices: {}, opts, asked: 0 }, []);
}

/**
 * 文から読み直します。読み取れなかった答え（「おまかせ」や、読めない
 * 自由記述）は marks に残してあり、読み直しても消えません。消えると、
 * 答えた質問がまた出てきます。
 */
function reread(d, phrases) {
  let slots = extractSlots(composeNote(d.base, phrases), d.opts);
  for (const m of d.marks) if (!isFilled(slots[m.slot], m.part)) slots = markFilled(slots, m, m.label, m.source);
  const questions = missingQuestions(slots, { choices: d.choices });
  return { ...d, phrases, slots, questions, phase: questions.length ? "asking" : "ready" };
}

/** 質問に、札か自由記述で答えます。 */
export function answerDialog(d, q, answer) {
  const said = answerText(q, answer);
  const step = { ...d, asked: d.asked + 1 };
  // 「おまかせ」を選んだ。その枠は聞かないことにします（埋まった扱い）。
  if (!said) return reread({ ...step, marks: [...d.marks, mark(q, "おまかせ", "skip")] }, d.phrases);
  const phrases = [...d.phrases, said];
  const next = reread(step, phrases);
  if (isFilled(next.slots[q.slot], q.part)) return next;
  // 答えが読み取れなくても、聞いた枠は埋まったことにします（同じことを
  // 二度聞きません）。「海の見える温泉街」は行き先として読めなくても、
  // 希望文に入るのでAIには伝わります。
  return reread({ ...step, marks: [...d.marks, mark(q, said, answer.text ? "free" : "choice")] }, phrases);
}

function mark(q, label, source) {
  return { slot: q.slot, part: q.part, label, source };
}

/**
 * 質問の欄ではなく、チャットに返信したとき。書いたことから全部の枠を
 * 読み直します。埋まった枠の質問は消え、まだ足りない分だけが残ります。
 */
export function replyDialog(d, text) {
  const t = String(text ?? "").trim();
  if (!t) return d;
  const before = missingQuestions(d.slots, { max: 99 }).length;
  const next = reread({ ...d, asked: d.asked + 1 }, [...d.phrases, t]);
  // 何も読み取れない返信は、追加の要望として受け取り、それ以上は聞きません
  // （聞いても答えが返ってこない人に、同じ質問を繰り返さない）。
  if (missingQuestions(next.slots, { max: 99 }).length === before) {
    return { ...next, questions: [], phase: "ready" };
  }
  return next;
}

/** 聞くのをやめて、いまの内容で組む（「この内容で組む」「聞かずに組む」）。 */
export function finishDialog(d, extra = "") {
  return composeNote(d.base, d.phrases, extra);
}

function isFilled(slot, part) {
  return part ? Boolean(slot?.parts?.[part]?.filled) : Boolean(slot?.filled);
}

function markFilled(slots, q, said, source = "free") {
  const out = { ...slots };
  const cur = out[q.slot] ?? EMPTY;
  if (q.part) {
    const parts = { ...(cur.parts ?? {}), [q.part]: filled(said, said, source) };
    out[q.slot] = { ...cur, parts, filled: Object.values(parts).every((p) => p.filled),
      label: [cur.label, said].filter(Boolean).join("・") };
  } else {
    out[q.slot] = filled(said, said, source);
  }
  return out;
}
