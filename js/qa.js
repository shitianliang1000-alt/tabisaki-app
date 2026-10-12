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
 * アイデア・候補を求める言い方（「デートスポットを考えて」「穴場を教えて」）。
 * 行き先や日数が決まっていない頼みなので、旅程は組まず、AIが案を挙げる。
 * 「箱根へ1泊2日で組んで」のように日数や「組んで」があれば旅程のほう。
 */
const IDEA = /(スポット|デート|アイデア|候補|おすすめ|オススメ|穴場|ランキング|定番|名所|場所|ところ).*(考えて|教えて|紹介|提案|挙げて|あげて|知りたい|ない[?？]?$|ある[?？]|どこ)/;
const BUILD = /(泊|日帰り|組んで|旅程|プランを?(?:作|組)|作って|つくって)/;

/**
 * 送られた文を、どう扱うか。
 *   "plan"   … 旅程を組む・直す頼みだと言い切れる（地名だけ、日数つき、など）
 *   "ask"    … あいさつ。質問として答える
 *   "either" … 決めきれない。AIに「質問か、旅程の頼みか」を聞いて振り分ける
 *
 * AIにつながらないときは、"either" も質問として答えます（isQuestion）。
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
    "・「デートスポットを考えて」のように案や候補を求められたら、あなた自身が具体的な場所を3〜5つ、一言の理由つきで挙げる。"
      + "最後に、気に入った場所があれば「◯◯へ日帰りで」と送れば旅程にできる、と添える。",
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
    ...(opts.mayPlan
      ? [
        "まず、この文が旅程づくりの頼みか判断してください。",
        "旅程づくりの頼み＝行き先・日程・条件を決めて旅程を作る/直す頼み（「箱根へ日帰りで」「もう少しゆっくり」「来週の土曜にして」）。",
        "それ以外（質問・雑談・知識・案や候補の相談）は頼みではない。",
        '旅程づくりの頼みなら {"plan": true} だけを出力。そうでなければ {"answer": "答えの文"} を出力。',
      ]
      : ['出力は {"answer": "答えの文"} の JSON だけ。']),
  ].join("\n");
  try {
    const out = await call(prompt, { temperature: 0.3, search, signal: opts.signal });
    if (opts.mayPlan && out?.plan === true && !out?.answer) {
      return { ok: true, plan: true, answer: "", sources: [] };
    }
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
