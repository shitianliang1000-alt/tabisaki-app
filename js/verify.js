// AI が出した案を、実際の時刻で検証する。
//
// 流れは「AIが案を出す → ここで検証 → 問題を理由付きで返す → AIが直す」。
// 検証結果は人間向けの文章ではなく構造化データにしてあります。そのまま
// 画面にも出せるし、次のプロンプトにも入れられるからです。
//
// ここが「もっともらしいが実行できない旅程」を止める最後の砦なので、
// 判定はすべて具体的な時刻に基づいて行い、推測はしません。
//
// 時計は「日」を意識して進みます。これが無いと、9泊10日の旅程が
// 10日間ぶっ通しの1日として扱われ、深夜も観光し続ける計算になります
// （実際にそうなっていました）。夜になったら宿に入り、翌朝また動き出す。

import { TUNING } from "./config.js";
import { hoursFor } from "./hours.js";
import {
  REJECT, addMinutes, atHour, estimateMinutes, haversineKm,
  profileOf,
} from "./feasibility.js";

/**
 * 置いてきた拠点へ戻らないための線引き。
 *
 * 「前の拠点のほうが BACKTRACK_RATIO 倍以上近い」かつ「今日の拠点から
 * BACKTRACK_MIN_KM 以上離れている」なら、戻る移動です。近い場所には
 * かけません。県境あたりでは、どちらの拠点からも同じくらいの距離に
 * なることがあり、そこまで弾くと行ける場所が減ります。
 */
const BACKTRACK_RATIO = 3;
const BACKTRACK_MIN_KM = 25;

const LUNCH = [11.5, 14.0];
const DINNER = [17.5, 20.0];
const hourOf = (d) => d.getHours() + d.getMinutes() / 60;

function nextDayAt(d, hour) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + 1);
  return new Date(x.getTime() + hour * 3600000);
}

/**
 * 提案された訪問順を、時刻を進めながら検証します。
 *
 * @param {Array<object>} spots  訪問順に並んだスポット
 * @param {object} ctx
 * @param {{lat,lng,name}} ctx.start   出発地点（初日の拠点）
 * @param {Date}   ctx.startAt         出発時刻
 * @param {{lat,lng,name}} ctx.end     旅の終点
 * @param {Date}   ctx.endBy           終点に着くべき時刻
 * @param {number} [ctx.nights]        泊数。0 なら日帰り
 * @param {Array<{lat,lng,name}>} [ctx.baseByDay] 日ごとの拠点（宿の最寄り）
 * @param {number} [ctx.dayStartHour]  行動を始める時刻
 * @param {number} [ctx.dayEndHour]    行動を終える時刻
 * @param {string} [ctx.pace]
 * @param {(a,b)=>number} [ctx.travelFn]
 * @returns {{ok:boolean, issues:Array, visits:Array, meals:Array,
 *            nightsUsed:number, daysUsed:number, moves:Array,
 *            underfilled:{days:number}|null, arriveEnd:Date|null,
 *            slackMin:number}}
 */
export function verifyOrder(spots, ctx) {
  const travelFn = ctx.travelFn ?? estimateMinutes;
  const pace = ctx.pace ?? "balanced";
  const nights = Math.max(0, ctx.nights ?? 0);
  const dayStartHour = ctx.dayStartHour ?? TUNING.dayStartHour;
  const dayEndHour = ctx.dayEndHour ?? TUNING.dayEndHour;
  const baseByDay = ctx.baseByDay ?? [];

  const issues = [];
  const visits = [];
  const meals = [];
  const moves = [];   // 日をまたぐ拠点の移り変わり（別エリアへ渡る日）

  let clock = new Date(ctx.startAt);
  let cur = ctx.start;
  let dayIndex = 0;
  let hadLunch = false;
  let hadDinner = false;
  let visitsToday = 0;
  // その日、最初の予定が始まった時刻。食事が要る日かどうかの判定に使います。
  let dayFirstAt = null;
  let arrivedAtNight = false;
  // 1日が始まる前に着いてしまい、何もできなかった時間の合計。
  let morningIdleMin = 0;

  const isLastDay = () => dayIndex >= nights;
  const dayLimit = () => atHour(clock, dayEndHour);

  /** 深夜・早朝の到着。その時刻から見学は始められません。 */
  const atNight = (d) => hourOf(d) >= 22 || hourOf(d) < 6;

  /** 夜を越えて翌朝へ。宿が別エリアなら、その移動もここで時間を使います。 */
  function advanceDay() {
    closeOutDay();
    const prevBase = baseByDay[dayIndex] ?? cur;
    dayIndex++;
    clock = nextDayAt(clock, dayStartHour);
    const base = baseByDay[dayIndex] ?? prevBase;
    // 拠点が同じ日に「移動」を作らないこと。距離0でも推定は数分を返すため、
    // 座標で比べます（毎朝「徳島駅 → 徳島駅」が出ていました）。
    const moved = Math.abs(prevBase.lat - base.lat) > 1e-6
      || Math.abs(prevBase.lng - base.lng) > 1e-6;
    const transfer = moved ? Math.round(travelFn(prevBase, base)) : 0;
    if (transfer > 0) {
      moves.push({ day: dayIndex, from: prevBase, to: base, minutes: transfer,
                   start: new Date(clock), end: addMinutes(clock, transfer) });
      clock = addMinutes(clock, transfer);
    }
    cur = base;
    hadLunch = false;
    hadDinner = false;
    visitsToday = 0;
    dayFirstAt = null;
  }

  // 見学を始めてよい、いちばん早い時刻。行動開始が早くても、これより
  // 前には見学を置きません（暗いうちに神社へ着いても、見えません）。
  const earliest = Math.max(dayStartHour,
                            TUNING.earliestVisitHour ?? dayStartHour);

  /** いまの時刻・いまの日で、このスポットに行けるか。 */
  function attempt(spot) {
    const prof = profileOf(spot, pace);
    const travel = Math.round(travelFn(cur, spot));
    let arrive = addMinutes(clock, travel);
    let wait = 0;

    // 早すぎる到着は、朝まで待ちます。「いつでも入れる」場所も同じです。
    // ここを素通りしていたので、午前4時の参拝が旅程に入っていました。
    //
    // このぶんは「待ち時間」に数えません。現地で開くのを待っているのでは
    // なく、**まだ1日が始まっていない**だけだからです。3時間の「自由時間」
    // として旅程に立てても、できることはありません。早すぎる出発は、
    // 待ち時間ではなく助言として伝えます（morningIdleMin）。
    const dawn = atHour(arrive, earliest);
    let dawnWait = 0;
    if (arrive < dawn) {
      dawnWait = Math.round((dawn - arrive) / 60000);
      arrive = dawn;
    }

    // その日の開き方。定休日・年末年始・冬期休業・曜日ごとの時間、
    // そして最終入場まで、hours.js が一箇所で決めます。
    const day = hoursFor(spot, arrive, pace);
    if (day.closed) {
      return { kind: "closed", prof,
        issue: { spotId: spot.id, name: spot.name, reason: REJECT.CLOSED_TODAY,
                 detail: `${spot.name}は${fmtDate(arrive)}が`
                   + `${day.reason}です。` } };
    }

    if (!day.alwaysOpen) {
      if (arrive < day.open) {
        wait += Math.round((day.open - arrive) / 60000);
        if (wait > TUNING.maxWaitMin) {
          return { kind: "issue",
            issue: { spotId: spot.id, name: spot.name,
                     reason: REJECT.WAIT_TOO_LONG,
                     detail: `${spot.name}の開館は${fmtTime(day.open)}で、`
                       + `${fmtTime(arrive)}到着では${wait}分待つことになります。` } };
        }
        arrive = new Date(day.open);
      }
      if (arrive >= day.close) {
        return { kind: "late", prof,
          issue: { spotId: spot.id, name: spot.name, reason: REJECT.TOO_LATE,
                   detail: `${spot.name}は${fmtTime(day.close)}に閉まりますが、`
                     + `到着は${fmtTime(arrive)}になります。` } };
      }
      // 「営業中」と「入場できる」は別です。ここを閉館時刻で通すと、
      // 現地で「開いているのに入れない」旅程ができあがります。
      if (day.lastEntry && arrive > day.lastEntry) {
        return { kind: "late", prof,
          issue: { spotId: spot.id, name: spot.name,
                   reason: REJECT.AFTER_LAST_ENTRY,
                   detail: `${spot.name}の最終入場は${fmtTime(day.lastEntry)}`
                     + `（閉館${fmtTime(day.close)}）で、`
                     + `到着は${fmtTime(arrive)}になります。` } };
      }
      if (addMinutes(arrive, prof.dwell) > day.close) {
        return { kind: "late", prof,
          issue: { spotId: spot.id, name: spot.name, reason: REJECT.TOO_LATE,
                   detail: `${spot.name}は${fmtTime(day.close)}閉館のため、`
                     + `${fmtTime(arrive)}から${prof.dwell}分の見学は収まりません。` } };
      }
    }

    const end = addMinutes(arrive, prof.dwell);
    // 泊まりの旅で、その日の行動終了時刻を越えるなら「今日はここまで」。
    // 最終日は帰りの期限のほうが厳しいので、この判定はしません。
    if (!isLastDay() && end > dayLimit()) {
      return { kind: "dayFull", prof,
        issue: { spotId: spot.id, name: spot.name, reason: REJECT.DAY_FULL,
                 detail: `${spot.name}の見学を終えるのは${fmtTime(end)}で、`
                   + `その日の行動時間（${fmtHour(dayEndHour)}まで）を越えます。` } };
    }
    return { kind: "ok", prof, arrive, end, travel, wait, dawnWait,
             km: haversineKm(cur, spot) };
  }

  // 到着が深夜・早朝なら、朝まで待ちます。
  // これが無いと、長距離の移動で夜中に着いた瞬間から見学を始める計算になり、
  // 「開館まで7時間待ち」で候補が全部落ちていました。
  if (atNight(clock)) {
    if (hourOf(clock) >= 22 && nights > 0) {
      // 夜に着いた → その晩は宿。翌朝から動きます
      advanceDay();
    } else {
      // 早朝に着いた → 同じ日の行動開始時刻まで待ちます
      clock = atHour(clock, dayStartHour);
    }
    arrivedAtNight = true;
  }

  // 日付のずれを合わせます。
  //
  // 長距離の移動では、着いたときにはもう翌日になっています。それでも
  // 「1日目」のまま数えると、旅程の日数が暦より1日多くなり、帰る便より
  // 後ろに宿泊が入ります（実際にそうなりました）。
  // 出発日からの経過日数で数え直します。
  if (ctx.day0) {
    const startOfDay = (d) => new Date(d).setHours(0, 0, 0, 0);
    const shift = Math.round(
      (startOfDay(clock) - startOfDay(ctx.day0)) / 86400000);
    dayIndex = Math.min(nights, Math.max(dayIndex, shift));
    cur = baseByDay[dayIndex] ?? cur;
  }

  // 同じ名前の場所を、2度入れません。
  //
  // 収録には、**同じ名前で座標の違うもの**があります。
  //
  //   久住山  32.97385, 131.39778
  //   久住山  33.08222, 131.24083   （12km 離れています）
  //
  // どちらかの座標が誤っているのですが、どちらかは決められません。
  // ただ、旅程に「久住山 → 移動30分 → 久住山」と並ぶのは、どう転んでも
  // 誤りです。読んだ人は2つの山があると思い、行った先で同じ山を見ます。
  // **先に入ったほうを使い、同じ名前の2つ目は入れません。**
  const takenNames = new Set();
  const nameKey = (sp) => String(sp?.name ?? "").normalize("NFKC")
    .replace(/[\s　]+/g, "").toLowerCase();

  for (const spot of spots) {
    // 同じ名前は1度だけ。
    const nk = nameKey(spot);
    if (nk && takenNames.has(nk)) {
      issues.push({ spotId: spot.id, reason: REJECT.DUPLICATE,
                    detail: `「${spot.name}」は、もう旅程に入っています` });
      continue;
    }

    // そのスポットを回る日が決まっている（＝どのエリアに滞在している日か）
    // なら、そこまで日を進めます。これが無いと、拠点は徳島のままで
    // 高松のスポットを回る、という旅程ができてしまいます。
    const floor = ctx.dayFloorById?.get(spot.id) ?? 0;
    while (dayIndex < floor && dayIndex < nights) advanceDay();

    // その日、拠点はもう別のエリアです。
    //
    // 下限（何日目以降）しか無かったので、前が押すと拠点を移したあとの
    // 日へずれ込んでいました。「2日目 4:00 金沢→三ノ宮、7:20 近江町市場へ
    // 移動（247km）」という旅程が実際に出ています。247km戻るのは、
    // その日に回る場所ではありません。諦めて、理由を残します。
    const blocked = baseMoved(spot);
    if (blocked) { issues.push(blocked); continue; }

    // 食事の時間を、検証の時点で確保します。あとから空きに差し込む方式だと
    // 予定が詰まっている日には食事が消え、逆に押し込むと帰りの便に
    // 間に合わなくなります。最初から時間を取っておけば、どちらも起きません。
    takeMeals();

    let out = attempt(spot);

    // 今日はもう無理でも、明日がある旅なら明日に回します。
    //
    // 無条件に日を進めると、朝いちの定休日1件で丸一日を捨ててしまいます。
    // 逆にまったく進めないと、夕方に1件閉館しただけで、以降の候補が
    // 同じ時刻のまま全滅します（実際にそうなっていました）。
    // そこで「その日の行動時間を越えた」ときは必ず翌日へ、
    // 個々の閉館・定休日は午後遅く（14時以降）に限って翌日へ回します。
    const lateInDay = hourOf(clock) >= 14;
    const worthTomorrow = out.kind === "dayFull"
      || ((out.kind === "late" || out.kind === "closed")
          && visitsToday > 0 && lateInDay);
    if (worthTomorrow && !isLastDay()) {
      advanceDay();
      // **日を進めたら、拠点の検査もやり直します。**
      //
      // ここが抜けていました。1日目の判定を通った立ち寄りが、入りきらず
      // 翌日へ回されます。ところが翌日は別の街に移っているかもしれず、
      // そのまま入れると戻る旅程になります。実際に出ていたのがこれです。
      //
      //   3日目 09:00  本部町中心部 → 豊見城市中心部（62.9km）
      //         10:35  本部町立博物館へ移動（61.2km）   ← 62km戻る
      //
      // 判定そのものは上と同じものを使います（2か所に書くと、片方だけ
      // 直して食い違います）。
      const after = baseMoved(spot);
      if (after) { issues.push(after); continue; }
      takeMeals();
      out = attempt(spot);
    }

    if (out.kind !== "ok") {
      issues.push(out.issue);
      continue;
    }

    morningIdleMin += out.dawnWait ?? 0;
    dayFirstAt ??= out.arrive;
    if (nk) takenNames.add(nk);
    visits.push({ spot, arrive: out.arrive, end: out.end, travel: out.travel,
                  wait: out.wait, km: out.km, dwell: out.prof.dwell,
                  fee: out.prof.fee, estimated: out.prof.estimated,
                  day: dayIndex });
    clock = out.end;
    cur = spot;
    visitsToday++;
  }

  // 見学後に昼どきへ入った場合の食事（帰りの前）
  if (visits.length) { takeMeals(); closeOutDay(); }

  /**
   * その日を締めるときの食事。
   *
   * takeMeals() は「いまの時刻が昼どきなら」入れるので、朝のうちに
   * 予定が終わった日には昼食が入りません。実際、1日目も2日目も
   * 昼食が抜けていました（8時に見学が終わり、次は17:30の夕食）。
   * 食事は、予定の詰まり具合とは別に要るものです。
   */
  /**
   * その日に回れる場所か。回れないなら、理由を返します。
   *
   * 2つ見ます。
   *
   *   1. 滞在への割り当てが「何日目まで」と言っているか
   *   2. 置いてきた拠点のほうが、桁違いに近くないか
   *
   * 1だけでは足りません。割り当てがずれると素通りするからです。
   */
  function baseMoved(spot) {
    const ceil = ctx.dayCeilById?.get(spot.id);
    if (Number.isFinite(ceil) && dayIndex > ceil) {
      return { spotId: spot.id, name: spot.name, reason: REJECT.BASE_MOVED,
        detail: `${spot.name}は${ceil + 1}日目までのエリアにありますが、`
          + `${dayIndex + 1}日目には別のエリアへ移っています。` };
    }
    // 置いてきたエリアへ、戻らない。
    //
    //   3日目 09:00  本部町中心部 → 豊見城市中心部（62.9km）
    //         10:35  本部町立博物館へ移動（61.2km）   ← 戻っている
    //
    // 62km南下して、すぐ61km北上します。割り当てがどうであれ、これは
    // 道順として成り立ちません。**前にいた拠点のほうが桁違いに近い
    // 場所**は、その拠点にいるあいだに回るものです。
    const base = ctx.baseByDay?.[dayIndex];
    if (!base) return null;
    const here = haversineKm(spot, base);
    const wasCloser = (ctx.baseByDay ?? []).some((b, d) =>
      d < dayIndex && b && haversineKm(spot, b) * BACKTRACK_RATIO < here);
    if (here > BACKTRACK_MIN_KM && wasCloser) {
      return { spotId: spot.id, name: spot.name, reason: REJECT.BASE_MOVED,
        detail: `${spot.name}は${dayIndex + 1}日目の拠点から`
          + `約${Math.round(here)}km離れています。`
          + "前の拠点にいるあいだに回る場所です。" };
    }
    return null;
  }

  /**
   * その日の、すでに埋まっている時間帯。
   *
   * 立ち寄りだけでなく、**そこへ向かう移動も**埋まっています。
   * ここを見ずに食事を置いていたので、こうなっていました。
   *
   *   11:22-13:04  北海道駒ヶ岳へ移動（33.9km）
   *   12:00-13:00  昼食
   *
   * 102分の移動の途中で、食事はとれません。
   */
  function busyToday() {
    return visits
      .filter((v) => (v.day ?? 0) === dayIndex)
      .map((v) => [
        new Date(v.arrive.getTime() - (v.travel + v.wait) * 60000),
        new Date(v.end),
      ])
      .sort((a, b) => a[0] - b[0]);
  }

  /**
   * 空いている時刻を探します。見つからなければ null。
   *
   * 希望の時刻から始めて、ぶつかるたびにその予定の終わりまで送ります。
   * 遅らせてよい上限（latestHour）を超えたら、諦めます。遅い昼食は
   * ありえますが、15時の「昼食」は夕食と区別がつきません。
   */
  function freeSlotAt(want, minutes, latestHour) {
    const busy = busyToday();
    let at = new Date(want);
    for (let guard = 0; guard < busy.length + 1; guard++) {
      const end = addMinutes(at, minutes);
      const hit = busy.find(([s, e]) => at < e && end > s);
      if (!hit) return hourOf(at) <= latestHour ? at : null;
      at = new Date(hit[1]);
    }
    return null;
  }

  function closeOutDay() {
    if (!visitsToday) return;
    // 昼を過ぎてから始まった日に、昼食は要りません（15時から動きだした
    // 日に「12:00 昼食」を足すと、過ぎた時刻の予定になります）。
    const sawNoon = dayFirstAt && hourOf(dayFirstAt) <= LUNCH[1];
    if (!hadLunch && sawNoon) {
      const at = freeSlotAt(atHour(clock, LUNCH[0] + 0.5),   // 12:00
                            TUNING.mealMin, LUNCH[1] + 1);
      if (at) {
        meals.push({ kind: "lunch", start: at,
                     end: addMinutes(at, TUNING.mealMin), day: dayIndex });
        hadLunch = true;
      }
    }
    const dinnerOk = ctx.allowDinner ?? !isLastDay();
    if (dinnerOk && !hadDinner) {
      const want = hourOf(clock) < DINNER[0] ? atHour(clock, DINNER[0]) : clock;
      const at = freeSlotAt(want, TUNING.mealMin, DINNER[1]);
      if (at) {
        meals.push({ kind: "dinner", start: at,
                     end: addMinutes(at, TUNING.mealMin), day: dayIndex });
        hadDinner = true;
      }
    }
  }

  function takeMeals() {
    if (!hadLunch && hourOf(clock) >= LUNCH[0] && hourOf(clock) <= LUNCH[1]) {
      const end = addMinutes(clock, TUNING.mealMin);
      meals.push({ kind: "lunch", start: new Date(clock), end, day: dayIndex });
      clock = end;
      hadLunch = true;
    }
    const dinnerOk = ctx.allowDinner ?? !isLastDay();
    if (dinnerOk && !hadDinner
        && hourOf(clock) >= DINNER[0] && hourOf(clock) <= DINNER[1]) {
      const end = addMinutes(clock, TUNING.mealMin);
      meals.push({ kind: "dinner", start: new Date(clock), end, day: dayIndex });
      clock = end;
      hadDinner = true;
    }
  }

  // --- 終点に間に合うか -------------------------------------------------
  let arriveEnd = null;
  let slackMin = 0;
  let underfilled = null;

  if (ctx.end && ctx.endBy) {
    const back = Math.round(travelFn(cur, ctx.end));
    arriveEnd = addMinutes(clock, back);

    if (dayIndex < nights) {
      // 最終日より前に予定が尽きた。物理的には間に合いますが、
      // 「10日間の旅で4か所」のようなスカスカの旅程はここで検出します。
      const unused = nights - dayIndex;
      underfilled = { days: unused, plannedDays: dayIndex + 1,
                      totalDays: nights + 1 };
      slackMin = Math.max(0, Math.round((dayLimit() - clock) / 60000));
    } else {
      const limit = addMinutes(ctx.endBy, -TUNING.safetyBufferMin);
      slackMin = Math.round((limit - arriveEnd) / 60000);
      if (arriveEnd > limit) {
        const over = Math.round((arriveEnd - limit) / 60000);
        issues.push({
          spotId: null, name: ctx.end.name ?? "終点",
          reason: REJECT.CANNOT_FINISH,
          detail: `この順で回ると${ctx.end.name ?? "終点"}への到着が`
            + `${fmtTime(arriveEnd)}となり、期限（${fmtTime(ctx.endBy)}）を`
            + `${over}分超過します。立ち寄りを減らすか、近い場所に替えてください。`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0, issues, visits, meals, moves, arrivedAtNight,
    daysUsed: dayIndex + 1, nightsUsed: dayIndex,
    underfilled, arriveEnd, slackMin, morningIdleMin,
  };
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 検証結果を、次のプロンプトに入れる文章にまとめます。
 * モデルには「何がだめだったか」だけでなく「どうすれば直るか」も渡します。
 */
export function issuesToPrompt(result, spotsById) {
  const lines = [];
  if (result.issues.length) {
    lines.push("前回の案には次の問題がありました。これを解消してください。");
    for (const issue of result.issues) lines.push(`・${issue.detail}`);
  }
  if (result.underfilled) {
    const u = result.underfilled;
    lines.push(
      `・${u.totalDays}日間の旅程ですが、${u.plannedDays}日分しか予定が埋まって`
      + `いません。残り${u.days}日ぶんの立ち寄り先を必ず追加してください`
      + "（1日あたり3〜4か所が目安です）。");
  }
  if (!lines.length) return "";
  const dropped = result.issues.filter((i) => i.spotId).map((i) => i.spotId);
  if (dropped.length) {
    lines.push("",
      `次のIDは今回の日程では訪問できません。使わないでください: ${dropped.join(", ")}`);
  }
  if (result.visits.length) {
    const ok = result.visits.map((v) => v.spot.name).join("、");
    lines.push("", `時間的に問題なかったのは: ${ok}`);
  }
  void spotsById;
  return lines.join("\n");
}

/** 検証を通った訪問だけを残した並び。再計画しない場合の妥協案に使います。 */
export function keepFeasible(result) {
  return result.visits.map((v) => v.spot);
}

/**
 * 期限に間に合うまで、後ろから立ち寄りを削ります。
 *
 * これが無いと、検証で「終点に間に合わない」と分かっていても旅程が
 * 組まれてしまい、帰りの便が期限を過ぎて出発する表示になります。
 * 少ない立ち寄りでも実行できる旅程のほうが、多くて破綻した旅程よりましです。
 *
 * 予定が足りない（underfilled）のは削って直る種類の問題ではないので、
 * ここでは触りません。作り直しのプロンプトに回します。
 *
 * @returns {{result: object, spots: Array, dropped: Array}}
 */
export function trimToFit(spots, ctx, maxDrops = 12) {
  // 「必ず行く」と指定された場所は、時間が足りなくても削りません。
  // 削ってよいものと削ってはいけないものを混ぜると、利用者が
  // いちばん大事にしている予定から先に消えていきます。
  const pinned = new Set(ctx.pinnedIds ?? []);
  let current = [...spots];
  const dropped = [];
  const conflicts = [];
  let result = verifyOrder(current, ctx);

  for (let i = 0; i < maxDrops; i++) {
    // 個別スポットの問題（閉館など）は、その分だけ除いて再計算
    const bad = result.issues.filter((x) => x.spotId);
    const stuck = bad.filter((x) => pinned.has(x.spotId));
    for (const c of stuck) {
      if (!conflicts.some((x) => x.spotId === c.spotId)) conflicts.push(c);
    }
    const badIds = new Set(bad.filter((x) => !pinned.has(x.spotId))
      .map((x) => x.spotId));
    if (badIds.size) {
      const removed = current.filter((s) => badIds.has(s.id));
      dropped.push(...removed);
      current = current.filter((s) => !badIds.has(s.id));
      result = verifyOrder(current, ctx);
      continue;
    }
    // 終点に間に合わないなら、削ってよい立ち寄りを後ろから1件落とす
    const cannotFinish = result.issues.some(
      (x) => x.reason === REJECT.CANNOT_FINISH);
    if (!cannotFinish) break;
    const idx = lastIndexWhere(current, (s) => !pinned.has(s.id));
    if (idx < 0) break;            // 残りは全部「必ず行く」。これ以上は削れない
    dropped.push(current[idx]);
    current = [...current.slice(0, idx), ...current.slice(idx + 1)];
    result = verifyOrder(current, ctx);
  }
  return { result, spots: current, dropped, conflicts };
}

/**
 * trimToFit と同じですが、**選んだ場所より先に、穴埋めの場所を外します**。
 *
 * 旅程は、選んだ場所（AIや検索が希望に合わせて選んだもの）のあとに、
 * 空いた時間を埋める場所を足して組んでいます。実際の経路で時刻を
 * 組み直すと、距離の目安より遅れることがあり、そのとき後ろから
 * 押し出されるのは、選んだ場所のほうでした。実際に出ていた旅程:
 *
 *   「宮島に行きたい」（広島駅から日帰り）
 *     9:00 広島駅総合案内所  ← 空き時間の穴埋め
 *    14:16 広島東照宮        ← 同じく穴埋め
 *    16:28 宮島表参道商店街
 *          厳島神社は、時間が合わずに落ちていました
 *
 * 宮島へ行きたい人の旅程から、厳島神社を落として案内所を残すのは逆です。
 * 選んだ場所が落ちるときは、穴埋めを1つずつ外して組み直し、
 * 落ちる選んだ場所が減るなら、そちらを採ります。
 *
 * 外した穴埋めは dropped に入れません。あとから足した場所なので、
 * 「時間が合わず外した」と言うものではありません。
 *
 * @param {Set<string>} fillerIds 穴埋めで足した場所のID
 */
export function trimKeepingPicks(spots, ctx, fillerIds, maxDrops = 12) {
  let best = trimToFit(spots, ctx, maxDrops);
  if (!fillerIds?.size) return best;
  const lostPicks = (t) => t.dropped.filter((s) => !fillerIds.has(s.id));
  const lost = lostPicks(best);
  if (!lost.length) return best;
  // 落ちた選んだ場所より**前にある**穴埋めだけを、後ろから順に外します。
  // 後ろの穴埋めを外しても、前の場所の時刻は早まりません。
  // 1つずつ戻して試すのではなく、外したまま次を試します。2つ外して
  // 初めて入る、ということがあるためです（1つ外しただけでは変わらない）。
  const lostIds = new Set(lost.map((s) => s.id));
  const last = spots.findLastIndex((s) => lostIds.has(s.id));
  let current = spots;
  for (let i = last - 1; i >= 0; i--) {
    if (!fillerIds.has(current[i].id)) continue;
    current = [...current.slice(0, i), ...current.slice(i + 1)];
    const t = trimToFit(current, ctx, maxDrops);
    if (lostPicks(t).length < lostPicks(best).length) best = t;
    if (!lostPicks(best).length) break;
  }
  return best;
}

function lastIndexWhere(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 「9月12日(土)」。休みの理由を書くときに使います。 */
function fmtDate(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEK[d.getDay()]})`;
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm ? `${hh}:${String(mm).padStart(2, "0")}` : `${hh}時`;
}
