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

import { callModelJson, canGround, hasApiKey, lastGrounding } from "./ai.js";

/** 旅程を組む頼みの言い方。これがあれば、質問の形でも組みます。 */
const PLAN_ASK = /(行きたい|いきたい|行ってみたい|旅程を|プランを|組んで|作って|つくって|考えて|探して|さがして|連れて|にして|変えて|かえて|増やして|減らして|外して|入れて|足して|直して|どこ(?:に|へ)?(?:行|い)(?:け|こう|く)|どこが(?:いい|おすすめ)|おすすめ(?:の|な)?(?:場所|旅|行き先|旅先|所|ところ)|行き先)/;
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
 * 旅程を組む頼みではないか（＝ふつうのAIとして答える側か）。
 *
 * 旅程の頼みだと分かるものだけを組むほうに回し、それ以外は全部
 * 質問・会話として答えます（あいさつ・雑談・知識の質問・旅の質問）。
 * 地名だけの短い入力（「鎌倉」）は、従来どおり旅程の頼みです。
 */
export function isQuestion(text) {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t) return false;
  if (GREETING.test(t)) return true;
  if (PLAN_ASK.test(t)) return false;
  if (ASK.test(t) || GENERAL.test(t)) return true;
  if (TRIP_CUES.test(t)) return false;
  // 地名だけのような短い入力は、旅程の頼み。長い文は、会話として答える。
  return t.length > 12;
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
 * 質問に答えます。
 *
 * @param {string} question
 * @param {object} ctx
 * @param {object} [ctx.itin] いま出ている旅程
 * @param {{q: string, a: string}[]} [ctx.history] これまでの質問と答え（新しいものが後ろ）
 * @param {object} [opts] { signal, call } call は試験用（callModelJson の代わり）
 * @returns {Promise<{ answer: string, sources: {title: string, url: string}[], ok: boolean }>}
 */
export async function answerQuestion(question, ctx = {}, opts = {}) {
  const call = opts.call ?? ((p, o) => callModelJson(p, o));
  if (!opts.call && !hasApiKey()) {
    return {
      ok: false, sources: [],
      answer: "いまはAIにつながらないので、質問にはお答えできません。"
        + "旅程を組むこと（「◯◯へ日帰りで」など）はできます。",
    };
  }
  const search = !opts.call && canGround();
  const today = new Date();
  const prompt = [
    "あなたは旅行に強い、なんでも答えられるアシスタントです。日本語で答えてください。",
    "旅行の質問だけでなく、あいさつや雑談、地名・建物・歴史・食べ物など旅行以外の質問にも、ふつうのAIのように答えます。",
    "守ること:",
    "・2〜5文で、まず答えを言う。あいさつには、あいさつを返す。前置きはしない。",
    "・旅行と関わりのある話題（場所・名所・食べ物など）なら、答えのあとに旅の一言を添えてよい。無理にこじつけない。",
    "・これまでのやりとりを覚えているものとして、「それ」「さっきの」も前の話から読み取る。",
    "・下の旅程に関わる質問なら、旅程の時刻や場所をもとに答える。",
    "・料金・営業時間・運行のように変わるものは、"
      + (search ? "検索で確かめ、確かめられなければそう書く。" : "確かでなければ「公式で確かめてください」と書く。"),
    "・分からないことを推測で埋めない。分からなければ、分からないと書く。",
    "・旅程を組み直したいときは、そのまま書いて送れば組み直せる、と添えてよい。",
    "",
    `今日: ${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`,
    "",
    "いまの旅程:",
    itineraryContext(ctx.itin),
    ...(ctx.history?.length
      ? ["", "これまでのやりとり（古い順）:", ...ctx.history.slice(-8).flatMap((h) => [`Q: ${h.q}`, `A: ${h.a}`])]
      : []),
    "",
    `質問: ${question}`,
    "",
    '出力は {"answer": "答えの文"} の JSON だけ。',
  ].join("\n");
  try {
    const out = await call(prompt, { temperature: 0.3, search, signal: opts.signal });
    const answer = String(out?.answer ?? "").trim();
    if (!answer) throw new Error("空の答え");
    const sources = search ? (lastGrounding().sources ?? []).slice(0, 3) : [];
    return { ok: true, answer, sources };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return {
      ok: false, sources: [],
      answer: "うまく答えを作れませんでした。少し言い方を変えて、もう一度送ってください。",
    };
  }
}
