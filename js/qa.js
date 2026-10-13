// チャットで聞かれた旅の質問に、文で答える。
//
// 「鶴岡八幡宮は何時まで？」「雨だったらどうする？」のような返信は、
// 旅程を組み直す頼みではありません。以前は、何を書いても組み直しに
// なっていました。聞いたことに答えが返らず、旅程だけが変わります。
//
// ここでは、質問かどうかを見分け（isQuestion）、質問ならいまの旅程を
// 添えてAIに聞きます（answerQuestion）。旅程そのものには触りません。
// 組み立ての途中でも答えます（組み立ては止めません）。
//
// 答えは「分からないことは分からないと言う」を守らせます。料金や
// 営業時間のように変わるものは、検索が使えるときは検索させ、出典を
// 添えます。使えないときは、公式で確かめるよう書かせます。

import { callModel, canGround, extractJson, hasApiKey, lastGrounding } from "./ai.js";

/** 旅程を組む頼みの言い方。これがあれば、質問の形でも組みます。 */
const PLAN_ASK = /(行きたい|いきたい|行ってみたい|行ってみる|行ってみよう|行こう|行きます|旅程を|プランを|組んで|作って|つくって|考えて|探して|さがして|連れて|にして|変えて|かえて|増やして|減らして|外して|入れて|足して|直して|どこ(?:に|へ)?(?:行|い)(?:け|こう|く)|どこが(?:いい|おすすめ)|おすすめ(?:の|な)?(?:場所|旅|行き先|旅先|所|ところ)|行き先)/;
/** あいさつ・お礼。旅の頼みではなく、ふつうに話しかけられたものとして返す。 */
const GREETING = /^(こんにちは|こんにちわ|こんばんは|おはよう(?:ございます)?|やあ|どうも|はじめまして|初めまして|ありがとう(?:ございます)?|ありがと|助かった|お疲れ(?:様|さま)?|hello|hi|hey|thanks?)[!！。.、\s]*$/i;
/** 旅に限らない質問の言い方（「富士山について」「東京タワーの高さ」）。 */
const GENERAL = /(について|とは|ってなに|って何|の高さ|標高|何メートル|何キロ|歴史|由来|いわれ|だれ|誰|どんな|どうして|いつ(?:から|まで|の)|違い|意味)/;
/** 質問の言い方。 */
const ASK = /([?？]\s*$|ですか|ますか|でしょうか|かな[?？]?\s*$|教えて|おしえて|知りたい|どのくらい|どれくらい|いくら|何時|何分|何円|何曜|なんじ|どう(?:すれば|したら|なる|やって|いう)|なぜ|なんで|って何|とは[?？]?\s*$|ある[?？]|いる[?？]|できる[?？]|大丈夫[?？]|混んで(?:る|いる)[?？]?|(?:天気|雨)(?:は|って)|持ち物)/;

/**
 * 旅程づくり・旅程の修正に使う言葉。これがあれば、頼みとして組みます。
 * 日付・日数・条件の言い直し（「来週の土曜」「もう少し安く」）も含みます。
 */
const TRIP_CUES = /(日帰り|泊|旅|観光|ドライブ|巡[るり]|周遊|縦断|ゆっくり|のんびり|温泉|グルメ|出発|スタート|予算|万円|ランチ|たい|もっと|もう少し|少し|安く|高く|短く|長く|早く|遅く|多め|少なめ|増や|減ら|外し|追加|変更|変え|午前|午後|明日|明後日|あさって|今日|今週|来週|週末|連休|土曜|日曜|月曜|\d+\s*(?:月|日|時|人|分|円|km|キロ))/;

/**
 * アイデア・候補を求める言い方（「デートスポットを考えて」「穴場を教えて」）。
 * 行き先や日数が決まっていない頼みなので、旅程は組まず、AIが案を挙げる。
 * 「箱根へ1泊2日で組んで」のように日数や「組んで」があれば旅程のほう。
 */
const IDEA = /(スポット|デート|アイデア|候補|おすすめ|オススメ|穴場|ランキング|定番|名所|場所|ところ).*(考えて|教えて|紹介|提案|挙げて|あげて|知りたい|ない[?？]?$|ある[?？]|どこ)/;
const BUILD = /(泊|日帰り|組んで|旅程|プランを?(?:作|組)|作って|つくって)/;

const WEEK = "日月火水木金土";
const ymd = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}曜日）`;
const DAYS = [["明々後日", 3], ["しあさって", 3], ["明後日", 2], ["あさって", 2], ["明日", 1], ["あした", 1],
              ["今日", 0], ["きょう", 0], ["本日", 0], ["昨日", -1], ["きのう", -1], ["一昨日", -2], ["おととい", -2]];

/**
 * 今日・明日などの日付、曜日、いまの時刻を聞かれたときの答え。
 * 日付はAIに聞くより、端末の時計で答えるほうが確かなので、AIを使わずに返す。
 * 当てはまらなければ null。
 */
export function dateAnswer(text, now = new Date()) {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (/(今何時|いま何時|現在の時刻|今の時刻|何時ですか)/.test(t) && !/(まで|から|に)/.test(t)) {
    return `いまは${now.getHours()}時${String(now.getMinutes()).padStart(2, "0")}分です（お使いの端末の時計）。`;
  }
  if (!/(日付|何日|なんにち|何曜|曜日|日にち|いつ)/.test(t)) return null;
  const hit = DAYS.find(([w]) => t.includes(w)) ?? (/(日付|今日|何日)/.test(t) ? ["今日", 0] : null);
  if (!hit) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + hit[1]);
  const label = hit[1] === 0 ? "今日" : hit[0];
  return `${label}は${ymd(d)}です。`;
}

/**
 * 送られた文を、どう扱うか。
 *   "plan"   … 旅程を組む・直す頼みだと言い切れる（地名だけ、日数つき、など）
 *   "ask"    … あいさつ。質問として答える
 *   "either" … 決めきれない。AIに「質問か、旅程の頼みか」を聞いて振り分ける
 *
 * AIが使えるときは、この判定は使わず、AIが毎回「質問か、旅程の頼みか」を
 * 決めます（js/app.js の send）。ここは AIが使えないとき、つながらなかった
 * ときの代わりです。AIがないときは、"either" も質問として答えます（isQuestion）。
 */
export function routeText(text) {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t) return "plan";
  if (GREETING.test(t)) return "ask";
  if (IDEA.test(t) && !BUILD.test(t)) return "either";
  if (PLAN_ASK.test(t)) return "plan";
  if (ASK.test(t) || GENERAL.test(t)) return "either";
  if (TRIP_CUES.test(t)) return "plan";
  // 地名だけのような短い入力は、旅程の頼み。長い文は、AIに聞く。
  return t.length > 12 ? "either" : "plan";
}

/** 旅程の頼みではない（質問・会話として答える側）か。AIが使えないときの判定。 */
export function isQuestion(text) {
  return routeText(text) !== "plan";
}

/** 覚えておくやりとりの数（ryo の頼み：前の10件ほど）。 */
export const MEMORY_SIZE = 10;
/** AIに渡すとき、1件をこの字数で切ります（枠＝TPMを食わないため）。 */
const MEMORY_CLIP = 140;

const clip = (t, n) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * やりとりを1件覚えます（新しいものが後ろ、MEMORY_SIZE 件まで）。
 * place は、その答えで話していた行き先（「富士山」など）。あとで
 * 「そこ行ってみたい」と言われたときの「そこ」に使います。
 */
export function rememberQa(history, q, a, place = "") {
  history.push({ q: clip(q, 200), a: clip(a, 400), ...(place ? { place } : {}) });
  if (history.length > MEMORY_SIZE) history.splice(0, history.length - MEMORY_SIZE);
  return history;
}

/** 「そこ」「さっきの所」のように、前の話の場所を指す言い方。 */
const REF = /(そこ|あそこ|そちら|さっきの(?:場所|所|ところ|山|町|街|島)?|その(?:場所|山|町|街|島|辺り|あたり)|ここ)/;

/**
 * 「そこ行ってみたい」の「そこ」を、前の話の行き先に置き換えます。
 * AIが使えないとき（AIが行き先を補えないとき）の代わりです。
 * 指す言い方が無い、または覚えている行き先が無ければ、そのまま返します。
 */
export function resolveRef(text, history = []) {
  const t = String(text ?? "").trim();
  if (!REF.test(t)) return t;
  const place = [...history].reverse().find((h) => h?.place)?.place;
  return place ? t.replace(REF, place) : t;
}

/** いまの旅程を、AIに渡す短い文にします。 */
export function itineraryContext(itin) {
  if (!itin) return "（まだ旅程はありません）";
  const lines = [`旅先: ${itin.title ?? itin.regionName ?? ""}${itin.prefecture ? `（${itin.prefecture}）` : ""}`];
  const fmt = (d) => {
    const x = new Date(d);
    return Number.isFinite(x.getTime())
      ? `${x.getHours()}:${String(x.getMinutes()).padStart(2, "0")}` : "";
  };
  for (const [i, day] of (itin.days ?? []).entries()) {
    const date = day.date instanceof Date ? day.date : new Date(day.date);
    lines.push(`${i + 1}日目（${date.getMonth() + 1}月${date.getDate()}日）`);
    for (const item of day.items ?? []) {
      if (item.kind === "free") continue;
      const name = item.title ?? item.place?.name ?? "";
      if (!name) continue;
      lines.push(`  ${fmt(item.start)} ${item.kind === "transit" ? "移動" : ""}${name}`);
    }
  }
  if (itin.weatherNote) lines.push(`天気: ${itin.weatherNote}`);
  return lines.slice(0, 80).join("\n");
}

/**
 * モデルの返事を {answer} / {plan} に読む。
 *
 * 雑談や知識の質問では、モデルは JSON ではなく文でそのまま答えることが多い。
 * 以前は JSON に読めないと「うまく答えを作れませんでした」になっていた。
 * JSON ならそれを使い、読めなければ返事の文そのものを答えにする。
 */
export function readReply(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw ?? "").trim();
  if (!text) return {};
  try {
    const j = extractJson(text);
    if (j && typeof j === "object" && ("answer" in j || "plan" in j)) return j;
  } catch { /* 文として扱う */ }
  // 壊れた JSON（改行が生のまま、途中で切れた、など）は、答えの文だけを拾う。
  const m = text.match(/"answer"\s*:\s*"([\s\S]*?)"?\s*\}?\s*(?:```)?$/);
  if (m && /^\s*(?:```[a-z]*\s*)?\{/.test(text)) {
    return { answer: m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim() };
  }
  const plain = text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  return { answer: plain };
}

/** AIが返した行き先の名前を、ボタンに載せられる形にします（長すぎ・空は捨てる）。 */
function placeName(raw) {
  const t = String(raw ?? "").replace(/[「」『』"]/g, "").trim();
  if (!t || t.length > 20 || /^(なし|無し|ない|空|none|null)$/i.test(t)) return "";
  return t;
}

/**
 * 質問に答えます。
 *
 * @param {string} question
 * @param {object} ctx
 * @param {object} [ctx.itin] いま出ている旅程
 * @param {{q: string, a: string, place?: string}[]} [ctx.history] これまでの質問と答え（新しいものが後ろ）
 * @param {object} [opts] { signal, call } call は試験用（callModel の代わり。返り値は文でも {answer}/{plan} でもよい）
 * @returns {Promise<{ answer: string, sources: {title: string, url: string}[], ok: boolean,
 *   place?: string, plan?: boolean, note?: string }>}
 *   place … 答えで話した行き先（「ここへ行くプランを作る」に使う）
 *   note  … 旅程の頼みだったとき、「そこ」を行き先に置き換えた頼みの文
 */
export async function answerQuestion(question, ctx = {}, opts = {}) {
  const local = dateAnswer(question);
  if (local) return { ok: true, answer: local, sources: [] };
  const call = opts.call ?? ((p, o) => callModel(p, o));
  if (!opts.call && !hasApiKey()) {
    return {
      ok: false, sources: [],
      answer: "いまはAIにつながらないので、質問にはお答えできません。"
        + "旅程を組むこと（「◯◯へ日帰りで」など）はできます。",
    };
  }
  const search = !opts.call && canGround();
  const today = new Date();
  // 枠（TPM）が少ないので、指示は短く、やりとりは字数を切って渡します。
  const prompt = [
    "あなたは旅行に強い、なんでも答えられるアシスタントです。日本語で答えます。",
    "旅行以外の質問・あいさつ・雑談にも、ふつうのAIのように答えます。",
    "・2〜5文で、まず答えを言う。前置きはしない。",
    "・案や候補を求められたら、具体的な場所を3〜5つ、一言の理由つきで挙げる。",
    "・これまでのやりとりを覚えているものとして、「それ」「そこ」「さっきの」を前の話から読み取る。",
    "・料金・営業時間・運行のように変わるものは、"
      + (search ? "検索で確かめ、確かめられなければそう書く。" : "確かでなければ「公式で確かめてください」と書く。"),
    "・分からないことを推測で埋めない。",
    `今日: ${ymd(today)}`,
    ...(ctx.itin ? ["いまの旅程:", itineraryContext(ctx.itin)] : []),
    ...(ctx.history?.length
      ? ["これまでのやりとり（古い順）:",
         ...ctx.history.slice(-MEMORY_SIZE).flatMap((h) => [`Q: ${clip(h.q, MEMORY_CLIP)}`, `A: ${clip(h.a, MEMORY_CLIP)}`])]
      : []),
    `質問: ${question}`,
    "",
    ...(opts.mayPlan
      ? [
        "この文が旅程づくりの頼み（行き先・日程・条件を決めて旅程を作る/直す。「箱根へ日帰りで」「そこ行ってみたい」「来週の土曜にして」）なら、",
        '{"plan": true, "note": "頼みの文"} だけを出力。note は「そこ」「さっきの」を前のやりとりの行き先に置き換えた頼みの文（例: 前の話が箱根なら「箱根へ行ってみたい」）。',
        '頼みでなければ（質問・雑談・知識・案の相談）{"answer": "答えの文", "place": "答えで話した行き先の地名。無ければ空"} を出力。',
      ]
      : ['出力は {"answer": "答えの文", "place": "答えで話した行き先の地名。無ければ空"} の JSON だけ。']),
  ].join("\n");
  try {
    const out = readReply(await call(prompt, { temperature: 0.3, search, system: false, signal: opts.signal }));
    if (opts.mayPlan && out?.plan === true && !out?.answer) {
      const note = String(out?.note ?? "").trim();
      return { ok: true, plan: true, answer: "", sources: [], ...(note ? { note } : {}) };
    }
    const answer = String(out?.answer ?? "").trim();
    if (!answer) throw new Error("空の答え");
    const sources = search ? (lastGrounding().sources ?? []).slice(0, 3) : [];
    const place = placeName(out?.place);
    return { ok: true, answer, sources, ...(place ? { place } : {}) };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    // 中継が落ちている・時間切れのときは、言い方を変えても直らない。
    const relay = ["UPSTREAM_TIMEOUT", "UPSTREAM_ERROR", "NOT_CONFIGURED", "RATE_LIMITED", "UPSTREAM_LIMIT"];
    return {
      ok: false, sources: [],
      answer: relay.includes(e?.code)
        ? "AIからの返事が届きませんでした（混み合っているか、一時的に止まっています）。少し待ってから、同じ文をもう一度送ってください。"
        : "うまく答えを作れませんでした。少し言い方を変えて、もう一度送ってください。",
    };
  }
}
