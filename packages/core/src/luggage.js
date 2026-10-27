// 荷物をどうするか。
//
// 泊まりの旅で、旅程はたいてい「ホテル → 観光 → 観光 → ホテル」と
// 書かれます。でも実際には、チェックアウトのあとは荷物を持って
// 歩くことになります。スーツケースを引いて石段を登るのと、
// 手ぶらで登るのは、まったく別の旅です。
//
// 旅程の時刻は合っているのに現地でつらい、という差がここに出ます。
//
// ここでやるのは「どこで手放せるか」を出すことだけです。
// コインロッカーの空き状況までは分かりませんし、分からないものを
// 分かると言わないのが、このアプリの方針です。

/** 荷物を持って行くのがつらい分類と、その理由。 */
const HARD_WITH_BAGS = {
  山: "登り道です", 登山: "登山道です", 丘: "坂と階段があります",
  高原: "歩く距離があります", 渓谷: "足場が整っていない道があります",
  滝: "遊歩道を歩きます", 海岸: "砂浜では車輪が使えません",
  漁港: "段差があります", 史跡: "屋外を歩きます",
  スキー場: "雪道です", 温泉: "館内に持ち込めないことがあります",
  ロープウェイ: "乗り場まで歩きます", 城: "石段があります",
  寺院: "石段や砂利道があります", 神社: "石段や砂利道があります",
  国立公園: "歩く距離があります", 国定公園: "歩く距離があります",
  町並み: "石畳や坂があります",
};

/** 泊まりで、宿を出たあとにまだ観光がある日があるか。 */
export function needsLuggagePlan(itin) {
  return luggagePlanFor(itin).days.length > 0;
}

/**
 * 荷物をどうするかの案。
 *
 * @returns {{days:Array, summary:string}}
 */
export function luggagePlanFor(itin) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const out = [];

  // 前の日に宿があり、その翌日にまだ観光がある日を探します。
  for (let i = 1; i < days.length; i++) {
    const stayed = (days[i - 1].items ?? [])
      .find((x) => x.kind === "lodging");
    if (!stayed) continue;

    const spots = (days[i].items ?? [])
      .filter((x) => x.kind === "spot" && x.place);
    if (!spots.length) continue;

    // その日にまた同じ宿へ戻るなら、持ち歩く必要はありません
    const staysAgain = (days[i].items ?? []).some((x) => x.kind === "lodging");

    const hard = spots
      .filter((s) => HARD_WITH_BAGS[s.place.category])
      .map((s) => ({ name: s.place.name,
                     why: HARD_WITH_BAGS[s.place.category] }));

    const where = stayed.near?.regionName ?? "宿";
    out.push({
      day: i,
      staysAgain,
      spots: spots.map((s) => s.place.name),
      hard,
      options: [
        { kind: "hotel", label: "宿に預ける",
          text: `${where}の宿は、チェックアウト後も荷物を預かってくれる`
            + "ことがほとんどです。まずここを当たってください。無料です。" },
        { kind: "locker", label: "駅のコインロッカー",
          text: "大きい荷物は数が少なく、休日は昼前に埋まります。"
            + "朝のうちに入れておくのが確実です。" },
        { kind: "counter", label: "手荷物預かり所",
          text: "主要駅や観光案内所にあります。ロッカーより大きい荷物も"
            + "預かってもらえますが、閉まる時刻が早いことがあります。" },
        { kind: "carry", label: "持ち歩く",
          text: hard.length
            ? `${hard.map((h) => h.name).join("・")}では、`
              + "荷物があると負担になります。おすすめしません。"
            : "この日の行き先なら、持ち歩いても大きな支障はなさそうです。" },
      ],
    });
  }

  return { days: out, summary: summarize(out) };
}

function summarize(days) {
  if (!days.length) return "";
  const hard = days.flatMap((d) => d.hard);
  const head = `${days.map((d) => `${d.day + 1}日目`).join("・")}は、`
    + "宿を出たあとにも立ち寄り先があります。";
  if (!hard.length) {
    return `${head}荷物は宿に預けるか、駅のロッカーに入れておくと`
      + "身軽に回れます。";
  }
  return `${head}${hard.slice(0, 2).map((h) => `${h.name}（${h.why}）`).join("・")}`
    + `${hard.length > 2 ? "ほか" : ""}があるので、`
    + "荷物は宿かロッカーに置いていくことをおすすめします。";
}

/**
 * 荷物を手放すのにかかる時間の目安（分）。
 *
 * 宿のフロントで預けるのは早く、駅のロッカーは探す時間が入ります。
 * どちらも列に並ぶことがあるので、短く見積もりすぎないようにします。
 */
export const LUGGAGE_MIN = { hotel: 10, locker: 15 };

/**
 * 「荷物を預ける」を、その日の最初の一手として旅程に入れます。
 *
 * 案（luggagePlanFor）は旅程の下のほうに出ていました。読めば分かる
 * のですが、**朝いちに何をするかは旅程の側に書いていないと動けません**。
 * 現地では旅程の行を上から追うので、下の囲みは読まれません。
 *
 * 時刻をどう扱うか
 * ----------------
 * 預ける10分ぶんを、あとの予定にずらして足すことはしません。旅程は
 * 営業時間と便に合わせて組まれていて、10分ずらすと入場や乗り継ぎが
 * 崩れます。代わりに、**出発の前**に置きます。8:50に預けて9:00に
 * 出る、という形です。朝の支度が10分早くなるだけで、旅程は動きません。
 *
 * 同じ宿にもう1泊する日には、何も入れません。部屋に置いておけます。
 *
 * @param {object} itin buildItinerary の結果
 * @returns {number} 入れた手数
 */
export function attachLuggage(itin) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const plan = luggagePlanFor(itin);
  let n = 0;

  for (const entry of plan.days) {
    const day = days[entry.day];
    const items = day?.items ?? [];
    const first = items[0];
    if (!first?.start) continue;
    // すでに入っているなら、二度入れません（組み直しで通ることがあります）
    if (items.some((x) => x.kind === "luggage")) continue;

    const lastNight = (days[entry.day - 1]?.items ?? [])
      .find((x) => x.kind === "lodging");
    const tonight = items.find((x) => x.kind === "lodging");

    // 同じ宿にもう1泊するなら、荷物は部屋に置いておけます。
    //
    // ここは「その日に宿があるか」では判定できません。泊まるたびに
    // 土地を変える旅（stays.js の周遊）では、毎日どこかに宿があるのに
    // **毎日荷物を持って移動します**。同じ宿かどうかを見ます。
    if (tonight && lastNight && lodgingKey(tonight) === lodgingKey(lastNight)) {
      continue;
    }

    // 今夜も同じ土地に泊まるなら、宿に預けて夕方に受け取れます。
    // 土地が変わる日と最後の日は、取りに戻ることになるので、
    // 帰りに通る駅のロッカーを先に書きます。
    const sameArea = Boolean(tonight && lastNight
      && tonight.near?.regionName === lastNight.near?.regionName);
    const where = sameArea ? "hotel" : "locker";
    const minutes = LUGGAGE_MIN[where];
    const start = new Date(first.start.getTime() - minutes * 60000);

    items.unshift({
      id: `luggage-${entry.day}`,
      kind: "luggage",
      start, end: new Date(first.start),
      title: sameArea ? "荷物を預ける（宿）" : "荷物を預ける（駅のロッカー）",
      detail: sameArea
        ? "今夜も同じ土地に泊まります。チェックアウトのときにフロントへ"
          + "預けておけば、夕方そのまま受け取れます。無料です。"
        : tonight
          // 土地が変わる日。持って回るか、先に送るかの分かれ目です。
          ? "今夜は別の土地に泊まります。日中だけ駅のロッカーに入れるか、"
            + "宿から今夜の宿へ送る（宅配）手もあります。"
            + "送るなら午前中の受付が締め切りのことが多いです。"
          : "宿に預けると取りに戻ることになります。"
            + "帰りに通る駅のロッカーのほうが早いこともあります。",
      // この時間は旅程をずらしていません。朝の支度がその分早くなります。
      costYen: 0,
      hard: entry.hard,
      reason: entry.hard.length
        ? `${entry.hard[0].name}（${entry.hard[0].why}）があるため`
        : "宿を出たあとにも立ち寄り先があるため",
    });
    n += 1;
  }
  return n;
}

/** 宿を見分ける鍵。同じ宿にもう1泊するかどうかの判定に使います。 */
function lodgingKey(item) {
  return item?.place?.id ?? `${item?.title ?? ""}@${item?.near?.regionName ?? ""}`;
}
