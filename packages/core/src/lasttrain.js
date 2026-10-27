// 終電の線 — 「あと何分いられるか」を、数えられる形にする。
//
// 旅程には帰りの移動が1本書いてあります。
//
//   18:40  出雲大社前駅 → 出雲市駅（約25分）
//
// これは「18:40に出れば帰れます」としか言っていません。当日に本当に
// 知りたいのは、その隣にある数です。
//
//   その駅の終電は何時か。あと何分ここにいられるのか。
//
// これが無いと、2つのことが起きます。
//
//   ① **粘れません。** 夕暮れがきれいでも、日が沈むまで待てるのか
//      分かりません。20分後の電車に乗るのが怖いので、1本前で帰ります。
//   ② **帰れない旅程に気づけません。** 立ち寄りを1つ足して帰りが
//      23:40発になったとき、その駅の終電が22:58なら、その旅程では
//      帰れません。組んだ側は何も言いませんでした。
//
// ■ 持っているもの
//
// Yahoo!路線情報には終電の検索があります（検索欄の type=2。画面の
// 「終電」のラジオボタンそのものです）。**あるものを聞くだけ**で、
// こちらで推し量る話ではありません。小田原→東京を引くと、見出しが
// 「終電」になり 22:58発・22:56発が返ります。
//
// ■ 持っていないもの
//
//   ・**その日その駅のダイヤ**は持っていません。聞けるのは経路検索の
//     答えだけです。だから「終電は22:58です」ではなく
//     「Yahoo!路線情報では22:58が最後です」と書きます。
//   ・**遅延**は分かりません。終電に10分前に着く計画は、実際には
//     間に合わないことがあります。余裕が少ないときは、そう書きます。
//   ・聞けなかったときは、**書きません**。「終電は分かりません」と
//     だけ出しても、現地では何の役にも立ちません（何も書かないのと
//     同じです）。黙って空けます。

/** 余裕がこれ以下なら、「ぎりぎりです」と書きます。 */
export const TIGHT_MIN = 30;

/** 「HH:MM」を分に。読めなければ null。 */
export function clockMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 29 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/**
 * 終電の並びで見たときの、発車時刻（分）。
 *
 * 午前4時より前の発車は「その日の終電」です（終電は1時ごろまで、
 * 始発は4時半ごろから。あいだに発車はありません）。00:10発を10分と
 * 数えると、22:58発より早いことになってしまいます。
 */
export function lateMinutes(hm) {
  const m = clockMinutes(hm);
  if (m == null) return null;
  return m < 4 * 60 ? m + 1440 : m;
}

/**
 * 予定の発車と、終電の発車から、余裕を数えます。
 *
 * @param {string} plannedDeparture 「18:40」
 * @param {string} lastDeparture    「22:58」
 * @returns {number|null} 分。読めなければ null
 */
export function marginMinutes(plannedDeparture, lastDeparture) {
  const a = lateMinutes(plannedDeparture);
  const b = lateMinutes(lastDeparture);
  if (a == null || b == null) return null;
  return b - a;
}

/**
 * 終電の一言。
 *
 * **数えられることだけを書きます。** 余裕がどれだけあるか、間に合うか。
 * 「まだ大丈夫です」のような、根拠のない言いかたはしません。
 *
 * @param {{departure?:string, arrival?:string, summary?:string}} last
 *   終電の検索結果（Yahoo!）
 * @param {{departure?:string, station?:string, to?:string}} planned
 *   旅程に入っている帰りの便
 * @returns {{level:string, text:string, marginMin:number|null}|null}
 *   level … "ok"（余裕あり）/ "tight"（ぎりぎり）/ "over"（間に合わない）
 *   書くことが無ければ null
 */
export function lastTrainNote(last, planned = {}) {
  const dep = String(last?.departure ?? "").trim();
  if (!clockMinutes(dep)) return null;
  const where = planned.station ? `${planned.station} ` : "";
  const to = planned.to ? `${planned.to}へ向かう` : "";
  const arrive = last?.arrival ? `${last.arrival}着` : "";
  const tail = arrive ? `（${arrive}）` : "";

  const margin = marginMinutes(planned.departure, dep);
  const head = `${to}最終は、${where}${dep} 発です${tail}。`;
  // 出どころを必ず添えます。ダイヤそのものを持っているわけではありません。
  const src = "（Yahoo!路線情報の終電検索より。遅延は含みません）";

  if (margin == null) return { level: "ok", marginMin: null, text: head + src };
  if (margin < 0) {
    return {
      level: "over", marginMin: margin,
      text: `${head}この旅程の ${planned.departure} 発は、それより`
        + `${-margin}分 後です。この組み方では帰れません。`
        + "立ち寄りを減らすか、泊まる必要があります。" + src,
    };
  }
  if (margin <= TIGHT_MIN) {
    return {
      level: "tight", marginMin: margin,
      text: `${head}予定の ${planned.departure} 発から ${margin}分 しか`
        + "ありません。1本遅らせる余裕はほとんどありません。" + src,
    };
  }
  return {
    level: "ok", marginMin: margin,
    text: `${head}予定の ${planned.departure} 発のあと、${fmtSpan(margin)}`
      + "は粘れます。" + src,
  };
}

/** 分を「2時間18分」のように。 */
function fmtSpan(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}分`;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

/**
 * その日の、最後の「乗る」移動を選びます。
 *
 * 終電が要るのは帰りの1本だけです。日中の乗り継ぎに終電を書いても、
 * 読むものが増えるだけで、決めかたは変わりません。
 *
 * 歩きと運転は外します（終電がありません）。調べた便（yahoo）が
 * 付いていないものも外します。**どの駅から乗るのかが分からないと、
 * 終電も聞けません**（「出雲大社」の終電はありません。乗るのは
 * 「出雲大社前駅」です）。
 */
export function lastRideOf(day) {
  const rides = (day?.items ?? []).filter((i) =>
    i.kind === "transit" && !i.walk && i.drive !== true
    && i.yahoo?.departure);
  return rides.length ? rides.at(-1) : null;
}

/**
 * その移動が、どの駅からどの駅までだったか。
 *
 * 旅程の from / to は**場所**の名前です（出雲大社）。終電を聞く相手は
 * **駅**なので、調べた便に書いてある駅名を使います。同じ言葉で聞けば、
 * 同じ経路の終電が返ります。
 */
export function stationsOf(item) {
  const legs = Array.isArray(item?.yahoo?.legs) ? item.yahoo.legs : [];
  const from = legs[0]?.from ?? null;
  const to = legs.at(-1)?.to ?? null;
  return from && to ? { from, to } : null;
}

/**
 * 旅程に、終電の一言を足します。
 *
 * 時刻も経路も変えません。**変えるのは説明だけ**です。「帰れません」と
 * 分かったときに、こちらで勝手に立ち寄りを削らないのは、どれを削るかが
 * 本人の決めることだからです。
 *
 * @param {object} itin
 * @param {(from:string, to:string, when:Date) => Promise<object|null>} ask
 *   終電を聞く関数。呼ぶ側が渡します（この段は通信を知りません。
 *   試験でも、同じ形の作り物を渡せば通ります）。
 * @param {{limit?:number}} [opts]
 *   limit … 聞く回数の上限。Yahoo!への問い合わせは旅程1本で何十回も
 *   走るので、終電のために際限なく増やしません。既定は3（3泊まで）。
 * @returns {Promise<number>} 書き足した移動の数
 */
export async function attachLastTrain(itin, ask, opts = {}) {
  if (typeof ask !== "function") return 0;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 3;
  let asked = 0;
  let n = 0;
  for (const day of itin?.days ?? []) {
    if (asked >= limit) break;
    const ride = lastRideOf(day);
    if (!ride) continue;
    const st = stationsOf(ride);
    if (!st) continue;
    asked += 1;
    let res = null;
    try {
      res = await ask(st.from, st.to, new Date(ride.start));
    } catch {
      // 聞けなかったときは、黙って空けます。「終電は分かりません」と
      // だけ出しても、現地では何の役にも立ちません。
      res = null;
    }
    if (!res?.routed || !res?.meta?.departure) continue;
    const note = lastTrainNote(res.meta, {
      departure: ride.yahoo.departure,
      station: st.from,
      to: st.to,
    });
    if (!note) continue;
    ride.lastTrain = {
      ...note,
      departure: res.meta.departure,
      arrival: res.meta.arrival ?? null,
    };
    n += 1;
  }
  return n;
}
