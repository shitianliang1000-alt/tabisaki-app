// 質問の選択肢を、AI が文脈から作る（#441）。
//
// 足りない条件を聞くとき（slots.js、#440）、選択肢は決め打ちでした。
// 「紅葉を見たい」と書いた人にも、「子どもと動物園」と書いた人にも、
// 行き先は「温泉地・海の近く・山・高原・街歩き」です。文脈に合いません。
//
// ここでは、頼んだ文と読み取れた条件を Gemma に渡し、質問ごとに選択肢を
// 作ってもらいます。ただし、AI に任せきりにはしません。
//
//   - **方向性だけ**。「紅葉の山へ」は良くて、「嵐山へ」「清水寺」はだめ。
//     スポット名・地名が入った選択肢は捨てます（行き先を決めるのは
//     旅程づくりの側で、ここで決めると収録に無い場所が混ざります）。
//   - **答えとして読めるものだけ**。日程と人数は、選んだ文が実際にその枠を
//     埋めるか（slots.js の extractSlots で読めるか）を確かめます。読めない
//     選択肢を押すと、同じ質問がまた出るからです。
//   - **「上記以外（自由に書く）」は必ず最後**。AI の返事に関係なく足します。
//   - **だめなら決め打ちへ戻る**。鍵が無い・時間切れ・返事が壊れている・
//     使える選択肢が2つ未満、のどれでも、もとの選択肢のまま聞きます。
//
// DOM は触りません。AI の呼び出しは call として外から渡します
// （画面は callModel、試験は偽物）。Gemma 以外は使いません（ai.js が決めます）。

import { OTHER, SLOTS, extractSlots, questionKey as QKEY } from "./slots.js";
import { MACRO_AREAS, NAMED_SETS, PREFECTURES, detectAreas } from "./areas.js";

/** 1つの質問に出す選択肢の数（「上記以外」は別）。 */
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 5;
/** 札に書く文字数の上限。長いと札が折り返して押しにくくなります。 */
const MAX_LABEL = 12;
const MAX_TEXT = 30;
/** 待つのはここまで。過ぎたら決め打ちのまま聞きます。 */
export const CHOICE_TIMEOUT_MS = 8000;

/** 収録が無くても分かる地名（都道府県・地方・名前のついた組）。 */
const PLAIN_PLACES = [
  ...PREFECTURES,
  ...PREFECTURES.map((p) => p.replace(/[都道府県]$/, "")).filter((p) => p.length >= 2),
  ...Object.keys(MACRO_AREAS),
  ...Object.keys(NAMED_SETS),
];

/**
 * 名前のついた場所らしい言いかた（「清水寺」「金沢駅」「旭山動物園」）。
 * 「お寺」「城下町」「古い町並み」のような、種類を言うだけの語は通します
 * （前に漢字・カタカナの名前が付いているときだけ引っかけます）。
 */
const NAMED_SPOT_RE = /[一-龯々ヶァ-ヴー]{2,}(?:寺|神社|神宮|大社|城|駅|空港|港|美術館|博物館|水族館|動物園|公園|タワー|ホテル|旅館|温泉郷|高原|山荘|岳|島|湖|峡|滝|岬|橋)(?![一-龯])/;
/** 種類を言うだけの語（上の形に見えても名前ではないもの）。 */
const KIND_WORDS = /^(?:古い|小さな|静かな|大きな|有名な|近くの|海辺の|山の|海の|歴史ある|景色のいい|紅葉の|雪の|星空の|朝の|夜の)/;

/**
 * 選択肢の文にスポット名・地名が入っていないか。
 *
 * @param {string} s
 * @param {(term: string) => boolean} [isPlace] 収録で引けるか（画面が渡します）
 */
export function mentionsPlace(s, isPlace = null) {
  const t = String(s ?? "").normalize("NFKC");
  if (!t) return false;
  if (PLAIN_PLACES.some((p) => t.includes(p))) return true;
  const m = t.match(NAMED_SPOT_RE);
  if (m && !KIND_WORDS.test(m[0])) return true;
  if (typeof isPlace === "function") {
    try { if (isPlace(t)) return true; } catch { /* 引けなければ、名前ではないとみなします */ }
  }
  return false;
}

/**
 * 収録の名前の索引（kb/names.json）に、種類を言うだけの名前が入っています
 * （「水族館」「道の駅」「離島」）。これに当たっても地名とはみなしません。
 * 「水族館めぐり」は方向性です。
 */
const KIND_NAMES = new Set([
  "海水浴場", "スキー", "スキー場", "キャンプ場", "酒蔵", "露天風呂", "動物園", "植物園", "水族館",
  "離島", "道の駅", "日本庭園", "釣り", "美術館", "博物館", "展望台", "灯台", "公園", "牧場", "夜景",
  "花畑", "城下町", "港町", "宿場町", "温泉", "温泉街", "足湯", "秘湯", "朝市", "商店街", "棚田",
  "竹林", "遊園地", "庭園", "市場", "屋台", "横丁", "雲海", "渓谷", "湿原", "高原", "砂浜", "ビーチ",
  "ロープウェイ", "遊覧船", "川下り", "鍾乳洞", "ワイナリー", "神社", "お寺", "城跡", "古民家",
]);

/**
 * 収録（知識ベース）を使って「その文に、収録のエリア名・スポット名が
 * 入っているか」を見る関数を作ります。画面と CLI が generateChoices の
 * isPlace に渡します。
 *
 * @param {object} kb loadKnowledgeBase の結果。names（kb/names.json）が
 *   読めていればそれを、無ければ読み込み済みのスポット名を使います。
 * @returns {((text: string) => boolean)|null}
 */
export function placeChecker(kb) {
  if (!kb) return null;
  const all = typeof kb.names === "string" && kb.names
    ? kb.names.split("\n") : (kb.spots ?? []).map((sp) => sp?.name);
  // 長い名前（「登別温泉の地獄谷と…」）は選択肢の札に入りようがありません。
  const names = [...new Set(all)].filter((n) => n && n.length >= 2 && n.length <= 12 && !KIND_NAMES.has(n));
  return (t) => {
    try { if (detectAreas(t, kb).length) return true; } catch { /* エリアの一覧が無いとき */ }
    return names.some((n) => t.includes(n));
  };
}

/**
 * Gemma に渡す頼みごと。返してほしい JSON の形も書きます
 * （Gemma には構造化出力がありません。ai.js の extractJson で拾います）。
 *
 * @param {string} text 頼んだ文
 * @param {object} slots extractSlots の結果
 * @param {{slot: string, part?: string, question: string}[]} questions
 * @param {{now?: Date}} [opts]
 */
export function buildChoicePrompt(text, slots, questions, { now = new Date() } = {}) {
  const known = SLOTS
    .filter((def) => slots?.[def.id]?.filled && slots[def.id].label)
    .map((def) => `- ${def.label}: ${slots[def.id].label}`);
  const asks = questions.map((q) => `- id: "${QKEY(q)}" 質問: ${q.question}（${hint(q)}）`);
  const month = now.getMonth() + 1;
  return [
    "旅の相談で、足りない条件を利用者に聞きます。質問ごとに、押すだけで答えられる選択肢を作ってください。",
    "",
    `利用者の頼み: 「${String(text ?? "").trim() || "（なし）"}」`,
    `今日: ${now.getFullYear()}年${month}月${now.getDate()}日（${season(month)}）`,
    known.length ? `すでに分かっている条件:\n${known.join("\n")}` : "すでに分かっている条件: なし",
    "",
    "聞く質問:",
    ...asks,
    "",
    "決まり:",
    `- 1つの質問に ${MIN_CHOICES + 1}〜${MAX_CHOICES} 個。頼みの内容・季節・分かっている条件に合うものを選ぶ。`,
    "- **方向性だけ**を書く。スポット名・地名・駅名・施設名・店名は絶対に書かない（例: ×「嵐山」「清水寺」「箱根」 ○「紅葉の名所」「古い町並み」）。",
    `- label は札に出す短い言葉（${MAX_LABEL}文字以内）。text は希望文に足す言葉（${MAX_TEXT}文字以内、「〜で」「〜へ」で終える）。`,
    "- 日程の質問は、日付や日数がはっきり分かる言いかたにする（例: 「今週末に」「1泊2日で」）。",
    "- 人数の質問は、人数か連れが分かる言いかたにする（例: 「2人で」「子どもと家族で」）。",
    "- 「おまかせ」「上記以外」は作らない（こちらで足します）。",
    "",
    "JSON だけを返してください。形:",
    '{"questions":[{"id":"destination","choices":[{"label":"紅葉の山","text":"紅葉がきれいな山へ"}]}]}',
  ].join("\n");
}

function hint(q) {
  if (q.slot === "destination") return "どんな所へ行きたいかの方向性";
  if (q.part === "start") return "いつ出かけるか";
  if (q.part === "nights") return "何泊何日か";
  if (q.slot === "travelers") return "誰と・何人で行くか";
  return "";
}

function season(month) {
  if (month >= 3 && month <= 5) return "春";
  if (month >= 6 && month <= 8) return "夏";
  if (month >= 9 && month <= 11) return "秋";
  return "冬";
}

/**
 * AI が返した選択肢を確かめて、使えるものだけにします。
 *
 * @param {unknown} list AI の返した choices
 * @param {{slot: string, part?: string}} q
 * @param {{isPlace?: (term: string) => boolean, now?: Date}} [opts]
 * @returns {{id: string, label: string, text: string, ai: true}[]}
 */
export function sanitizeChoices(list, q, { isPlace = null, now = new Date() } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (out.length >= MAX_CHOICES) break;
    const label = clean(c?.label);
    const text = clean(c?.text) || label;
    if (!label || label.length > MAX_LABEL || text.length > MAX_TEXT) continue;
    // こちらで足すもの（おまかせ・上記以外）は作らせません。
    if (/おまかせ|お任せ|上記以外|その他|自由/.test(label)) continue;
    if (mentionsPlace(label, isPlace) || mentionsPlace(text, isPlace)) continue;
    if (!answers(q, text, now)) continue;
    const key = label.replace(/\s/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `ai${out.length + 1}`, label, text, ai: true });
  }
  return out;
}

function clean(s) {
  return String(s ?? "").normalize("NFKC").replace(/[\r\n\t]/g, " ").replace(/\s{2,}/g, " ")
    .replace(/^[「『"'\s]+|[」』"'\s]+$/g, "").trim();
}

/**
 * その文を答えとして読めるか。日程と人数は、押したら本当に埋まる
 * ものだけ通します。行き先は方向性なので、読めなくても通します
 * （押した答えは「聞いた」と覚えるので、同じ質問は出ません）。
 */
function answers(q, text, now) {
  if (q.slot === "destination") return true;
  const s = extractSlots(text, { now });
  if (q.part) return Boolean(s[q.slot]?.parts?.[q.part]?.filled);
  return Boolean(s[q.slot]?.filled);
}

/**
 * AI の返事から、質問ごとの選択肢を取り出します。
 *
 * @returns {Record<string, object[]>} "destination" や "dates.start" をキーにした選択肢
 */
export function readChoiceReply(reply, questions, opts = {}) {
  const list = Array.isArray(reply?.questions) ? reply.questions : [];
  const byId = new Map(list.map((x) => [String(x?.id ?? ""), x?.choices]));
  const out = {};
  for (const q of questions) {
    const got = sanitizeChoices(byId.get(QKEY(q)), q, opts);
    if (got.length >= MIN_CHOICES) out[QKEY(q)] = got;
  }
  return out;
}

/**
 * 選択肢の先頭は「おまかせ」（決め打ちにあれば）、最後は「上記以外」。
 * AI の選択肢はそのあいだに入ります。
 */
export function withFixedEnds(q, aiChoices) {
  const def = SLOTS.find((s) => s.id === q.slot);
  const fixed = (q.part ? def?.parts?.[q.part]?.choices : def?.choices) ?? [];
  const any = fixed.find((c) => c.id === "any");
  return [...(any ? [any] : []), ...aiChoices, OTHER];
}

/**
 * やりとり（slots.js の startDialog の結果）の質問に、AI の選択肢を付けます。
 * 何があっても投げません。使えなかったときは、もとのやりとりをそのまま返します。
 *
 * @param {object} d startDialog / answerDialog の結果
 * @param {object} opts
 * @param {(prompt: string, o?: object) => Promise<string>} opts.call モデルを呼ぶ関数（ai.js の callModel）
 * @param {(term: string) => boolean} [opts.isPlace]
 * @param {Date} [opts.now]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} choices（キー→選択肢）を足したやりとり
 */
export async function generateChoices(d, { call, isPlace = null, now = new Date(),
  timeoutMs = CHOICE_TIMEOUT_MS, signal } = {}) {
  if (typeof call !== "function" || d?.phase !== "asking" || !d.questions?.length) return d;
  // まだ AI の選択肢が無い質問だけを頼みます。
  const need = d.questions.filter((q) => !d.choices?.[QKEY(q)]);
  if (!need.length) return d;
  const prompt = buildChoicePrompt(d.base, d.slots, need, { now });
  let reply;
  try {
    const raw = await withTimeout(call(prompt, { temperature: 0.7, system: false, signal }), timeoutMs);
    reply = typeof raw === "string" ? parseJson(raw) : raw;
  } catch {
    return d;
  }
  const got = readChoiceReply(reply, need, { isPlace, now });
  if (!Object.keys(got).length) return d;
  const choices = { ...(d.choices ?? {}), ...got };
  return {
    ...d,
    choices,
    questions: d.questions.map((q) => (choices[QKEY(q)]
      ? { ...q, choices: withFixedEnds(q, choices[QKEY(q)]), ai: true } : q)),
  };
}

function withTimeout(p, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer;
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** 返事から最初の JSON を拾います（前置きや ``` が付いていても読めます）。 */
function parseJson(raw) {
  const t = String(raw ?? "").replace(/```(?:json)?/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("JSON が見つかりません");
  return JSON.parse(t.slice(start, end + 1));
}
