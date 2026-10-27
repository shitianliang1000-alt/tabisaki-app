// 次の区間だけを、いまの時刻で引き直す。
//
// 旅程は**組んだときの時刻**でできています。
//
//   13:52 出発  出雲大社前駅 → 電鉄出雲市駅（18:40発の次の便）
//
// 当日、写真を撮っていて10分遅れました。この行はまだ「13:52 出発」と
// 書いてあります。本当に知りたいのは1つだけです。
//
//   **いまから駅へ行くと、次の電車は何時か。**
//
// これまでは、旅程ぜんぶを組み直すしかありませんでした。1〜2分かかり、
// 経路検索も何十回か走り、そのうえ**残りの旅程が別のものに変わります**。
// もう入った喫茶店も、これから行く約束も、まとめて作り直されます。
// 10分遅れただけの人が払う代償としては、大きすぎます。
//
// 引き直すのは**次の1区間だけ**にします。聞くのは1回、変えるのは
// その行の説明だけです。
//
// ■ 決めごと
//
//   ・**旅程を書き換えません。** 時刻も順番も、こちらでは動かしません。
//     「いま出ると次は19:05発で、予定より25分あとです」と書くまでです。
//     組み直すかどうかは本人が決めます（その手は今までどおりあります）。
//   ・聞けなければ、何も言いません。「分かりませんでした」とだけ
//     出しても、駅の前では何の役にも立ちません。
//   ・目安だけで組んだ区間は引き直せません。どの駅から乗るのかが
//     分からないので、聞く相手がいません。

import { clockMinutes, lateMinutes, stationsOf } from "../packages/core/src/lasttrain.js";

/** これ以上ずれたら、「この先が押します」と書きます（分）。 */
export const PUSH_MIN = 10;

/**
 * いまから乗る区間。
 *
 * 見るのは**まだ乗っていない移動**だけです。乗っている最中の電車を
 * 引き直しても、降りる先は変わりません。
 *
 * 歩きと運転は外します（便がありません）。調べた便（yahoo）の付いて
 * いないものも外します。
 *
 * @param {object} itin
 * @param {Date} now
 * @returns {object|null}
 */
export function nextRide(itin, now = new Date()) {
  const rides = [];
  for (const day of itin?.days ?? []) {
    for (const item of day?.items ?? []) {
      if (item.kind !== "transit" || item.walk || item.drive === true) continue;
      if (!item.yahoo?.departure || !item.start) continue;
      if (new Date(item.start) <= now) continue;
      rides.push(item);
    }
  }
  if (!rides.length) return null;
  rides.sort((a, b) => new Date(a.start) - new Date(b.start));
  return rides[0];
}

/**
 * 予定の便と、いま引き直した便の差（分）。
 *
 * 日をまたぐ便があるので、午前4時より前の発車は「翌日」として
 * 数えます（packages/core/src/lasttrain.js と同じ数えかたです）。
 *
 * @returns {number|null} 正なら遅い便になった、負なら早い便に乗れる
 */
export function shiftMinutes(planned, found) {
  const a = lateMinutes(planned);
  const b = lateMinutes(found);
  if (a == null || b == null) return null;
  return b - a;
}

/**
 * 引き直した結果を、読める一文にします。
 *
 * **数えられることだけ**を書きます。「急げば間に合います」のような、
 * こちらでは確かめようのない言いかたはしません。
 *
 * @param {{departure?:string, arrival?:string, line?:string}} found
 * @param {{departure?:string, station?:string, to?:string, title?:string}} planned
 * @param {{now?:Date, restMin?:number}} [ctx]
 *   restMin … この区間より後に残っている予定の合計（分）。
 *   押したときに何が起きるかを書くために使います。
 * @returns {{level:string, shiftMin:number|null, text:string}|null}
 *   level … "same"（同じ便）/ "early"（早い便に乗れる）/
 *           "push"（後ろにずれる）/ "late"（少しずれる）
 */
export function requeryNote(found, planned = {}, ctx = {}) {
  const dep = String(found?.departure ?? "").trim();
  if (!clockMinutes(dep)) return null;
  const where = planned.station ? `${planned.station} ` : "";
  const arrive = found?.arrival ? `${found.arrival}着` : "";
  const tail = arrive ? `（${arrive}）` : "";
  const line = found?.line ? `${found.line}・` : "";
  const head = `いま出ると、次は ${where}${dep} 発です${tail}。${line}`;
  // 出どころを必ず添えます。ダイヤそのものを持っているわけではありません。
  const src = "（Yahoo!路線情報でいま引き直しました。遅延は含みません）";

  const shift = shiftMinutes(planned.departure, dep);
  if (shift == null) {
    return { level: "same", shiftMin: null, text: head + src };
  }
  if (shift === 0) {
    return {
      level: "same", shiftMin: 0,
      text: `${head}旅程に入っている便と同じです。予定どおりです。${src}`,
    };
  }
  if (shift < 0) {
    return {
      level: "early", shiftMin: shift,
      text: `${head}旅程の ${planned.departure} 発より ${-shift}分 早い便です。`
        + `この先に${-shift}分の余裕ができます。${src}`,
    };
  }
  const rest = Number.isFinite(ctx.restMin) && ctx.restMin > 0
    ? `このあとの予定（残り約${Math.round(ctx.restMin / 60)}時間ぶん）が、`
      + `まとめて${shift}分 後ろにずれます。`
    : `このあとの予定が${shift}分 後ろにずれます。`;
  return {
    level: shift >= PUSH_MIN ? "push" : "late",
    shiftMin: shift,
    text: `${head}旅程の ${planned.departure} 発より ${shift}分 あとです。`
      + (shift >= PUSH_MIN ? rest : "") + src,
  };
}

/**
 * その区間より後に、**その日**に残っている予定の長さ（分）。
 *
 * 数えるのは同じ日のぶんだけです。3泊の旅で「残り50時間ぶんが25分
 * ずれます」と書いても意味がありません。押されるのは、その日の
 * 終わりまでです（翌日は一晩で吸収されます）。
 */
export function restMinutesAfter(itin, item) {
  const end = item?.end ? new Date(item.end) : null;
  if (!end || Number.isNaN(end.getTime())) return 0;
  const day = (itin?.days ?? []).find((d) =>
    (d?.items ?? []).some((i) => i === item || i?.id === item?.id));
  if (!day) return 0;
  let last = end;
  for (const i of day.items ?? []) {
    const e = i?.end ? new Date(i.end) : null;
    if (e && !Number.isNaN(e.getTime()) && e > last) last = e;
  }
  return Math.max(0, Math.round((last - end) / 60000));
}

/**
 * 次の区間だけを、いまの時刻で引き直します。
 *
 * **旅程は書き換えません。** 返すのは、その行に添える一言だけです。
 *
 * @param {object} itin
 * @param {(from:string, to:string, when:Date) => Promise<object|null>} ask
 *   引き直す関数。呼ぶ側が渡します（この段は通信を知りません）。
 * @param {{now?:Date}} [opts]
 * @returns {Promise<{item:object, note:object}|null>}
 *   引き直せなければ null（「分かりませんでした」も返しません）
 */
export async function requeryNextLeg(itin, ask, opts = {}) {
  if (typeof ask !== "function") return null;
  const now = opts.now ?? new Date();
  const item = nextRide(itin, now);
  if (!item) return null;
  const st = stationsOf(item);
  if (!st) return null;

  let res = null;
  try {
    res = await ask(st.from, st.to, now);
  } catch {
    return null;
  }
  if (!res?.routed || !res?.meta?.departure) return null;

  const note = requeryNote(
    { departure: res.meta.departure, arrival: res.meta.arrival,
      line: res.meta.legs?.[0]?.line ?? null },
    { departure: item.yahoo.departure, station: st.from, to: st.to,
      title: item.title },
    { restMin: restMinutesAfter(itin, item) });
  if (!note) return null;

  // 行に貼り付けます。**時刻は動かしません。**
  item.requeried = { ...note, at: now.toISOString(),
                     departure: res.meta.departure,
                     arrival: res.meta.arrival ?? null };
  return { item, note };
}
