// この旅程は、どこまで確かめてあるか。
//
// このアプリの値打ちは「AIが旅程を書けること」ではありません。書くだけなら
// どこでもできます。**実際に行けるかどうかを確かめてあること**が違いです。
// ところが、確かめた事実は旅程の中に散らばっていて、画面からは見えません。
// 見えなければ、無いのと同じです。
//
// ここでは、散らばっている事実を1か所に集めて数えます。作り直しません。
// 判定はすでに verify.js（時刻）・hours.js（営業時間）・routes.js（移動）が
// 済ませています。ここがするのは、**数えて、言葉にする**ことだけです。
//
//   移動時間  実際の時刻表から取れた区間は、いくつか
//   営業時間  収録の実データで確かめた場所は、いくつか
//   帰り      帰着の期限まで、どれくらい余裕があるか
//   休み      休みの日に当たっている場所はないか
//
// 星の数は「良い旅程か」ではなく「**どこまで裏が取れているか**」です。
// 良い旅程かどうかは別の物差し（score.js の無理のなさ）で出しています。

import { slackLevel } from "./score.js";

/** 移動の出どころ。区間の中身から見分けます。 */
export function travelSource(item) {
  if (!item || item.kind !== "transit") return null;
  if (item.yahoo) return { key: "yahoo", label: "Yahoo!路線情報" };
  if (item.routed) return { key: "routes", label: "Googleの経路" };
  // 歩きは距離で足ります（confidence.js と同じ見かたです）。
  if (item.walk) return { key: "walk", label: "徒歩（距離から）" };
  // 近くに駅・バス停が無い区間。タクシーで行くものとして組んであります。
  // 作り直しても同じ答えなので、「調べそこねた区間」とは分けて数えます。
  if (item.noTransit === true) {
    return { key: "no-transit", label: "タクシー（距離から）" };
  }
  return { key: "estimate", label: "距離からの推定" };
}

/**
 * 目安のまま残った区間を、**もう一度調べて直るものと、直らないもの**に
 * 分けます。
 *
 * 「まだ目安があります。作り直しますか」に答えるための数です。
 * 近くに駅・バス停が無い区間は、何度作り直しても目安のままです。
 * そこへ「作り直す」を勧めるのは、直らないことに時間を使わせることです。
 *
 * @param {object} itin
 * @returns {{total:number, retryable:number, noTransit:number}}
 *          total は目安のまま残った区間の数（徒歩は数えません）
 */
/** 車（またはバイク）で回る旅か。 */
function byCar(itin) { return itin?.transport === "car"; }
/** 区間で乗るものが変わる旅（電車で行って、現地は車）。 */
function mixedRide(itin) { return itin?.transport === "transit+car"; }

export function estimatedTravel(itin) {
  const moves = (itin?.days ?? [])
    .flatMap((d) => d?.items ?? [])
    .filter((i) => i.kind === "transit");
  let retryable = 0;
  let noTransit = 0;
  for (const m of moves) {
    const key = travelSource(m)?.key;
    if (key === "estimate") retryable++;
    else if (key === "no-transit") noTransit++;
  }
  return { total: retryable + noTransit, retryable, noTransit };
}

const pct = (a, b) => (b > 0 ? a / b : 1);

/**
 * 旅程の裏の取れ具合。
 *
 * @param {object} itin
 * @returns {{stars:number, level:"high"|"mixed"|"low", summary:string,
 *            checks:Array<{ok:boolean, label:string, detail:string}>}}
 */
export function tripReliability(itin) {
  const items = (itin?.days ?? []).flatMap((d) => d?.items ?? []);
  const moves = items.filter((i) => i.kind === "transit");
  const spots = items.filter((i) => i.kind === "spot");

  const est = estimatedTravel(itin);
  const realMoves = moves.filter((i) => {
    const key = travelSource(i)?.key;
    return key !== "estimate" && key !== "no-transit";
  });
  const realHours = spots.filter((s) => s.estimated !== true);
  const slack = slackLevel(itin?.score?.slackMin ?? itin?.slackMin);
  const closedRisk = (itin?.hoursWarnings ?? []).length;

  const checks = [
    {
      ok: moves.length > 0 && realMoves.length === moves.length,
      label: byCar(itin) ? "運転時間" : "移動時間",
      // 「残り3区間は距離からの目安です」で止めていました。読んだ人に
      // できることが書いていないので、作り直すしかありません。そして
      // 駅もバス停も無い区間は、作り直しても目安のままです。
      // **直るものと直らないものを分けて言います。**
      //
      // 車の旅では「便」も「時刻表」も出てきません。引くのは道のりです。
      detail: !moves.length ? "移動がありません。"
        // 電車で行って現地は車。同じ旅程に、便で決まる区間と道のりで
        // 決まる区間が並びます。ひとまとめに「◯区間は実際の便から」と
        // 書くと、運転する区間にも便があるように読めます。
        : mixedRide(itin)
          // 0区間しか取れていないのに「遠出は実際の便」と書くと、
          // 取れているように読めます。取れた数で言い分けます。
          ? (realMoves.length === 0
            ? `${moves.length}区間はすべて距離からの目安です`
              + "（もう一度調べると、遠出は便の時刻、現地は道のりが"
              + "入ることがあります）。"
            : `${moves.length}区間のうち${realMoves.length}区間は確認済み`
              + "（遠出は実際の便、現地は経路検索の道のり）。"
              + (est.retryable
                ? `残り${est.retryable}区間は距離からの目安です`
                  + "（もう一度調べると入ることがあります）。"
                : ""))
        : byCar(itin)
          ? `${moves.length}区間のうち${realMoves.length}区間は経路検索で確認。`
            + (est.retryable
              ? `残り${est.retryable}区間は距離からの目安です`
                + "（もう一度調べると道のりが入ることがあります）。"
              : "")
          : `${moves.length}区間のうち${realMoves.length}区間は実際の便から。`
            + (est.noTransit
              ? `${est.noTransit}区間は近くに駅・バス停が無いので、`
                + "タクシーで行くものとして組んでいます。"
              : "")
            + (est.retryable
              ? `${est.retryable}区間は時刻を引けませんでした`
                + "（もう一度調べると入ることがあります）。"
              : ""),
    },
    {
      ok: spots.length > 0 && realHours.length === spots.length,
      label: "営業時間",
      detail: spots.length
        ? `${spots.length}か所のうち${realHours.length}か所は収録の実データ。`
          + (realHours.length < spots.length
            ? `残り${spots.length - realHours.length}か所は分類ごとの目安です。`
            : "")
        : "立ち寄り先がありません。",
    },
    {
      ok: slack.level === "safe",
      label: "帰りの余裕",
      detail: slack.text,
    },
    {
      ok: closedRisk === 0,
      label: "休みの日",
      detail: closedRisk
        ? `${closedRisk}か所に、休みの可能性の注意が出ています。`
        : "休みに当たりそうな場所はありません。",
    },
  ];

  // 星は、移動と営業時間の裏の取れ具合が主です。帰りの余裕と休みは、
  // 崩れたときだけ引きます（そこは「確かめた結果、危ない」なので、
  // 確かめていないこととは意味が違います）。
  const base = pct(realMoves.length, moves.length) * 0.6
    + pct(realHours.length, spots.length) * 0.4;
  const penalty = (slack.level === "risky" ? 0.25
    : slack.level === "tight" ? 0.1 : 0) + (closedRisk ? 0.1 : 0);
  const stars = Math.max(1, Math.min(5, Math.round((base - penalty) * 5)));
  const level = stars >= 4 ? "high" : stars >= 3 ? "mixed" : "low";

  const summary = level === "high"
    ? "実際の便と営業時間で確かめてあります。"
    : level === "mixed"
      ? "一部は目安のままです。時間に余裕を持ってお出かけください。"
      : "確かめられていない部分が多く残っています。";

  return { stars, level, summary, checks };
}
