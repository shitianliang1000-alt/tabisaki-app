// 検証済みの訪問順を、画面に出せる時刻付きの旅程に組み立てる。
//
// 判定はすべて verify.js が済ませた後なので、ここは「並べる」ことに集中します。
// 食事と宿泊は、このアプリが在庫を持たない領域なので、時間枠だけ確保して
// 実際の店選びは Google マップ側に渡します（links.js）。
//
// 日をまたぐ旅では、その日の拠点（宿のあるエリア）が変わります。
// 変わる日の朝には移動が入り、夜の宿はその日のエリアに取ります。

import { TUNING } from "./config.js";
import { addMinutes, atHour, estimateMinutes, haversineKm, profileOf }
  from "./feasibility.js";
import { describeHours, hoursFor } from "./hours.js";
import { pickLodging } from "./lodging.js";
import { dedupeAreaNames, joinAreaNames, regionOfDay } from "./stays.js";
import { END_MODES, dayEnd, nightsOf, returnsToStart } from "./trip.js";

let seq = 0;
const nextId = () => `it-${++seq}`;

/** これより短い待ちは、「自由時間」の行として立てません。 */
const MIN_FREE_MIN = 20;
/**
 * 予定と予定のあいだが、これ以上あいたら「自由時間」として書きます。
 * 30分の空きは移動の余裕ですが、2時間半は過ごしかたの話です。
 */
const MIN_IDLE_MIN = 60;

/**
 * 移動の項目に、公共交通の中身（路線・乗換・待ち時間）を足します。
 *
 * 分からないときは何も足しません。「乗換0回」と書いてしまうと、
 * 実際には乗り換えがあるのに直通だと読まれます。
 * 空欄のほうが、間違った断定より役に立ちます。
 */
/**
 * その区間で乗る乗り物の種類（js/modes.js の classifyLine による）。
 *
 * routes.js の yahooLeg が、調べた経路の路線名から見分けて kinds に
 * 入れています。preferMet は「指定した乗り物で組めたか」です
 * （フェリーを指定したのに船の便が無かった、など）。
 */
function vehicleOf(leg) {
  if (!leg || !Array.isArray(leg.kinds) || !leg.kinds.length) return null;
  return { kinds: [...leg.kinds], preferMet: leg.preferMet !== false };
}

function withTransit(item, transit) {
  if (!transit) return item;
  item.transit = transit;
  if (transit.headline) item.detail = `${item.detail}・${transit.headline}`;
  return item;
}

function freeTimeHint(region, minutes) {
  const g = new Set(region?.genres ?? []);
  if (minutes >= 150) {
    if (g.has("onsen")) return "温泉に浸かったり、宿でゆっくり過ごす時間に";
    if (g.has("sea")) return "海沿いを歩いたり、景色を眺めてのんびり";
    if (g.has("city") || g.has("food")) return "街歩き、カフェ、買い物などに";
    return "まとまった空き時間。周辺を自由に散策できます";
  }
  if (g.has("food")) return "お茶や食べ歩きに";
  return "お土産を見たり、カフェで休んだり";
}

/**
 * @param {object} input
 * @param {object} input.trip
 * @param {Array}  input.stays    planStays の結果（エリアと滞在日）
 * @param {Array}  input.visits   verifyOrder が返した visits（時刻・day 入り）
 * @param {Array}  input.meals    同上
 * @param {Array}  input.moves    日をまたぐ拠点移動
 * @param {Map}    input.reasons  spotId → 選定理由
 * @param {object} input.legs     { outbound, inbound } 実測または推定
 * @param {(a,b)=>number} [input.travelFn]
 */
export function buildItinerary(input) {
  const { trip, visits, reasons, legs } = input;
  const stays = input.stays?.length
    ? input.stays
    : [{ region: input.region, days: 1, dayFrom: 0, dayTo: 0,
         station: { lat: input.region.stationLat, lng: input.region.stationLng,
                    name: input.region.station } }];
  const meals = input.meals ?? [];
  const moves = input.moves ?? [];
  const travelFn = input.travelFn ?? estimateMinutes;
  // その日を終える時刻。選んでもらった時間帯があればそちらを使います
  // （TUNING の値は、聞いていないときの既定です）。
  const dayEndHour = Number.isFinite(trip.dayEndHour)
    ? trip.dayEndHour : TUNING.dayEndHour;
  const dayStartHour = Number.isFinite(trip.dayStartHour)
    ? trip.dayStartHour : TUNING.dayStartHour;
  // 区間の中身（路線・乗換・待ち時間）を引く関数。分からなければ null。
  // 「たぶんこの路線」で埋めるくらいなら、何も出さないほうが安全です。
  const legDetail = input.legDetail ?? (() => null);
  const nights = nightsOf(trip);
  const firstRegion = stays[0].region;
  const items = [];
  let totalCost = 0;
  /** 営業時間まわりの注意。同じ文が並ばないよう集合で持ちます。 */
  const hoursWarnings = new Set();

  // --- 往路 ---
  const outMin = legs?.outbound?.minutes
    ?? travelFn(trip.origin, stays[0].station);
  // 実際に乗る便の時刻に合わせます。
  //
  // これまでは「出発できる時刻」から所要時間を足しているだけでした。
  // 4:00に家を出ることにすると、旅程は 4:00発・3時間55分。ところが
  // 説明には「14:50発→18:40着」と出ます。**同じ行の中で食い違います。**
  // 実際に乗れるのは次の便なので、そちらに合わせて時刻を動かします。
  // 夜行は、乗る時刻も着く時刻も表から決まっています（js/trains.js）。
  // 「出発できる時刻＋所要時間」では着きません。
  const overnight = legs?.outbound?.overnight ? legs.outbound : null;
  const board = overnight?.boardAt_
    ?? boardingTime(trip.departAt, legs?.outbound);
  const outFits = overnight ? true : legFitsRow(trip.departAt, legs?.outbound);
  const arriveStation = overnight?.arriveAt
    ? new Date(overnight.arriveAt)
    : addMinutes(trip.departAt, outMin);
  // 着く先の名前は、**その滞在の拠点**から取ります。エリアの station 欄
  // ではありません。出発地が拠点そのものになることがあり（東京駅発で
  // 1日目が千代田区なら、拠点は東京駅です）、そのときエリアの欄を見ると
  // 「東京駅 → 竹橋駅」と、行きもしない駅が1行目に出ます。
  const firstStation = stays[0].station ?? {
    name: firstRegion.station || firstRegion.name,
    lat: firstRegion.stationLat, lng: firstRegion.stationLng,
  };
  // 出発地がもう拠点なら、この行は要りません。0分の移動を1行目に置くと、
  // 「東京駅から東京駅へ移動」を読ませることになります。
  const alreadyThere = haversineKm(trip.origin, firstStation) < 0.3;
  if (!alreadyThere) items.push(withTransit({
    id: nextId(), kind: "transit",
    start: board ?? trip.departAt, end: arriveStation,
    title: `${trip.origin.name} → ${firstStation.name ?? firstRegion.name}`,
    // 「（推定）」は書きません。実測か推定かは、確からしさの印
    // （confidence.js）が別に出します。二重に書くと読みにくくなります。
    // Yahoo!の答えには発着時刻も所要時間も入っています。そこへ
    // 「・約238分」と足すと、数えかたの違う数字が2つ並びます
    // （待ち時間を含む・含まない）。実際の時刻があるほうを出します。
    detail: legs?.outbound?.line && outFits
      ? legs.outbound.line
        + (board && !overnight ? `（${fmtHm(trip.departAt)}発の次の便）` : "")
      : (legs?.outbound?.taxi ? "タクシー" : "") + `約${outMin}分`,
    alternatives: outFits ? (legs?.outbound?.alternatives ?? []) : [],
    from: trip.origin,
    to: firstStation,
    routed: Boolean(legs?.outbound?.routed) && outFits,
    noTransit: legs?.outbound?.noTransit === true,
    taxi: legs?.outbound?.taxi === true,
    // 調べた便の中身。これを渡していなかったので、Yahoo!で引いた往路が
    // 画面では「収録データ・Googleの経路」と出ていました。
    yahoo: outFits ? (legs?.outbound?.yahoo ?? null) : null,
    // 何に乗る区間か（飛行機・船・高速バス…）。routes.js が調べた
    // 結果に付けています。これが無いと、飛行機の区間が「電車」の顔で
    // 並び、搭乗手続きの断り書きも出ません。
    vehicle: outFits ? vehicleOf(legs?.outbound) : null,
    km: haversineKm(trip.origin, firstStation),
    costYen: 0,
    reason: overnight
      ? `${overnight.train}で夜のうちに移動します（車中泊）`
      : legs?.outbound?.yahoo
      ? "Yahoo!路線情報で調べた実際の便"
      : legs?.outbound?.routed
        ? "Google マップの経路検索による所要時間"
        : "経路APIを使えないため距離からの推定",
  }, outFits ? legs?.outbound?.transit : null));

  // --- 日ごとに組み立てる ---
  //
  // 予定の入らない日に拠点を移すと、その日は「移動して、寝るだけ」に
  // なります（4:00 浅草→名古屋、22:30 名古屋に宿泊。それだけ）。
  // 人はそうしません。前の街にもう一晩いて、翌朝に移ります。
  // 立ち寄りのある日まで、移動を遅らせます。
  const visitDays = new Set(visits.map((v) => v.day ?? 0));
  const shifted = moves.map((m) => {
    let day = m.day;
    while (day < nights && !visitDays.has(day)) day++;
    if (day === m.day) return m;
    // 遅らせたぶん、時刻もその日の朝に置き直します。
    const start = atHour(
      new Date(trip.departAt.getTime() + day * 86400000), dayStartHour);
    return { ...m, day, start, end: addMinutes(start, m.minutes) };
  });
  const movesByDay = new Map(shifted.map((m) => [m.day, m]));

  /** その日の拠点。移動を遅らせたぶん、前の街の滞在が伸びます。 */
  const baseOfDay = (day) => {
    let idx = 0;
    for (const [i, m] of shifted.entries()) if (day >= m.day) idx = i + 1;
    return stays[Math.min(idx, stays.length - 1)]?.region
      ?? regionOfDay(stays, day) ?? firstRegion;
  };
  let prevEnd = arriveStation;
  // 直前に置いた宿。予定の無い日は、新しく置かずにこれを延ばします。
  let lastLodging = null;
  // いまどこにいるか。区間の中身を引くには「どこから」が要ります。
  let cur = stays[0].station;

  for (let day = 0; day <= nights; day++) {
    const region = baseOfDay(day);
    // その日を後ろへずらす分（実際に乗れる便に合わせたぶん）。
    let shiftMin = 0;

    // 拠点が変わる日は、朝いちで移動する
    const mv = movesByDay.get(day);
    if (mv) {
      // 拠点を移す区間も、調べた結果があるなら使います。
      //
      // ここは routed:false を**決め打ち**していました。区間ごとに
      // Yahoo!へ聞いているのに、拠点の移動だけは必ず「推定」と出ます。
      // 1日目は実測なのに2日目から推定になる、の正体がこれです。
      const leg = legDetail(mv.from, mv.to);
      // 実際に乗る便の時刻に合わせます（往路と同じ考え方です）。
      // 「4:00 名古屋駅 → 難波駅」と書いてある行の中身が
      // 「12:16発→13:40着」では、どちらを信じてよいか分かりません。
      const board = boardingTime(mv.start, leg);
      const fits = legFitsRow(mv.start, leg);
      const start = board ?? mv.start;
      const end = board
        ? addMinutes(board, leg.rideMinutes ?? leg.minutes ?? mv.minutes)
        : mv.end;
      items.push(withTransit({
        id: nextId(), kind: "transit",
        start, end,
        title: `${mv.from.name ?? "拠点"} → ${mv.to.name ?? region.name}`,
        detail: leg?.line && fits
          ? `拠点を移します・${leg.line}`
            + (board ? `（${fmtHm(mv.start)}発の次の便）` : "")
          : `拠点を移します・${leg?.taxi ? "タクシー" : ""}約${mv.minutes}分`,
        from: mv.from, to: mv.to,
        routed: Boolean(leg?.routed) && fits, costYen: 0,
        noTransit: leg?.noTransit === true,
        taxi: leg?.taxi === true,
        yahoo: fits ? (leg?.yahoo ?? null) : null,
        vehicle: fits ? vehicleOf(leg) : null,
        alternatives: fits ? (leg?.alternatives ?? []) : [],
        km: haversineKm(mv.from, mv.to),
        reason: `${day + 1}日目から${region.name}を拠点にするため`,
      }, fits ? leg?.transit : null));
      prevEnd = end;
      cur = mv.to;
      // 便に合わせて出発が遅れたぶん、その日の予定も後ろへずらします。
      // ずらさないと「13:40に着く」と書いた下に「5:51から見学」が並びます。
      shiftMin = Math.max(0, Math.round((end - mv.end) / 60000));
    }

    // その日の食事と訪問を、時刻順に混ぜる
    const push = (d) => (shiftMin ? addMinutes(d, shiftMin) : d);
    const dayEntries = [
      ...meals.filter((m) => (m.day ?? 0) === day)
        .map((m) => ({ at: push(m.start),
                       meal: { ...m, start: push(m.start), end: push(m.end) } })),
      ...visits.filter((v) => (v.day ?? 0) === day)
        .map((v) => ({ ...v, arrive: push(v.arrive), end: push(v.end) }))
        .map((v) => ({ at: addMinutes(v.arrive, -(v.travel + v.wait)), visit: v })),
    ].sort((a, b) => a.at - b.at);

    for (const entry of dayEntries) {
      if (entry.meal) {
        const m = entry.meal;
        // 予定と予定のあいだが空くなら、空いていると書きます。
        //
        // 「14:59に見学が終わって、次は17:30の夕食」。そのあいだの
        // 2時間31分は、何も書かれていませんでした。**書いていない時間は、
        // 旅程ではありません。** 近くに足せる場所があれば足しますが
        // （pipeline.js の fillEmptyDays）、足しきれないぶんは、
        // 自由に使える時間として置きます。黙って空けるより役に立ちます。
        const idle = Math.round((m.start - prevEnd) / 60000);
        if (idle >= MIN_IDLE_MIN) {
          items.push({
            id: nextId(), kind: "free", start: new Date(prevEnd),
            end: new Date(m.start), title: "自由時間",
            detail: freeTimeHint(region, idle),
            costYen: 0, reason: "次の予定まで時間があるため",
          });
        }
        items.push(mealItem(m.start, m.end,
          m.kind === "dinner" ? "夕食" : "昼食", region));
        totalCost += TUNING.mealYen;
        if (m.end > prevEnd) prevEnd = m.end;
        continue;
      }
      const v = entry.visit;
      if (v.travel > 0) {
        // その区間を実際に調べた結果です。
        //
        // ここは区間ごとの結果を**見ていませんでした**。往路と拠点移動
        // だけが Yahoo!の時刻を出し、日中の移動は調べてあっても
        // 「移動約413分・約2.7km」としか出ません。しかも確からしさの印は
        // legs.local.routed（その日ぜんぶが引けたときだけ true）を見て
        // いたので、1区間でも引けないと、実際に調べた区間まで
        // 「目安」の印が付いていました。
        const leg = legDetail(cur, v.spot);
        const routed = Boolean(leg?.routed);
        const leave = addMinutes(v.arrive, -(v.travel + v.wait));
        // 実際に乗る便の時刻から始めます。
        //
        // 頼んだ時刻に便がなければ、Yahoo!が返す所要時間には**次の便を
        // 待つ時間**が入っています。本数の少ないバス区間では、それが
        // 数時間になります。2.7kmの移動が「約413分」と出ていたのは
        // これで、待っている時間まで動いていることにしていました。
        // 乗る時刻から乗る時刻までを移動にして、その手前は空き時間です。
        const board = boardingTime(leave, leg);
        // 調べた便が、この行の時刻に合っているか。合っていないなら
        // 発着時刻は出しません（間違った時刻より「分かりません」）。
        const fits = legFitsRow(leave, leg);
        // 歩く区間かどうかは、**調べた側が決めています**。
        //
        // ここは距離だけで見ていました（1.5km以内なら徒歩）。ところが
        // routes.js は「乗るより歩くほうが早い」区間も徒歩にします。
        // 2.2kmを35分、2.9kmを46分——どちらも歩く速さの数字なのに、
        // 距離が1.5kmを超えているので「移動約35分 🟡目安」と出ていました。
        // 歩くと決めた区間を、調べられなかった区間と同じ顔で並べています。
        const onFoot = leg?.walk === true || isWalkLeg(v.km);
        items.push(withTransit({
          id: nextId(), kind: "transit",
          start: board ?? leave,
          end: addMinutes(v.arrive, -v.wait),
          title: `${v.spot.name}へ移動`,
          // 引けているなら、発着時刻のある一行を出します。
          // 「約413分」は、頼んだ時刻から着くまで（便を待つ時間を含む）
          // なので、移動時間として読むと桁が違って見えます。
          // 徒歩かどうかは、かかる分ではなく**距離**で決めます。
          // 25分以内なら徒歩、としていたので、3.1kmを「徒歩約18分」と
          // 書いていました（時速10km。走っています）。18分という数字は
          // 電車・バスの見積もりで、歩きの見積もりではありません。
          detail: leg?.line && fits
            ? leg.line + (board ? `（${fmtHm(leave)}発の次の便）` : "")
              + (v.km ? `・約${v.km.toFixed(1)}km` : "")
            : (onFoot ? "徒歩" : leg?.taxi ? "タクシー" : "移動")
              + `約${v.travel}分`
              + (v.km ? `・約${v.km.toFixed(1)}km` : ""),
          // 歩ける区間なら、歩きます。そのときタクシーの印を残すと、
          // 行には「徒歩約7分」、確からしさの印には「タクシー」と出て、
          // 読む人がどちらを信じてよいか分からなくなります。
          from: cur, to: v.spot,
          walk: onFoot, km: v.km ?? 0,
          // 車で行く区間か。電車＋現地の車では、同じ旅程の中に
          // 新幹線の区間と運転の区間が並びます。絵と言葉を区間ごとに
          // 変えないと、新幹線に車の絵が付きます（pipeline.js の
          // modeGroups が区間に書いています）。
          drive: leg?.mode === "DRIVE" && !onFoot,
          routed: routed && fits,
          noTransit: leg?.noTransit === true && !onFoot,
          taxi: leg?.taxi === true && !onFoot,
          yahoo: fits ? (leg?.yahoo ?? null) : null,
          vehicle: fits ? vehicleOf(leg) : null,
          alternatives: fits ? (leg?.alternatives ?? []) : [],
          costYen: 0,
          reason: routed && fits
            ? "Yahoo!路線情報で調べた実際の便"
            : leg?.noTransit
              ? "近くに駅・バス停が無いため、タクシーでの移動として見積もり"
              : "時刻を引けなかったため距離からの目安",
        }, fits ? leg?.transit : null));
      }
      cur = v.spot;
      // 待ち時間を「自由時間」として立てるのは、それが**予定として意味を持つ**
      // ときだけです。「9分の自由時間」と書かれても、できることはありません。
      // 数分の待ちは、旅程の行を増やすだけで、読む手間が増えます。
      if (v.wait >= MIN_FREE_MIN) {
        items.push({
          id: nextId(), kind: "free",
          start: addMinutes(v.arrive, -v.wait), end: v.arrive,
          title: "自由時間",
          detail: `${v.spot.name}が開くまで約${v.wait}分`,
          costYen: 0, reason: "開館時刻に合わせた待ち時間",
        });
      }
      const prof = profileOf(v.spot, trip.pace);
      // その日の営業時間。閉館だけでなく最終入場も出します。
      // 「営業中」と「入場できる」は別で、旅程を狂わせるのは後者です。
      const day = hoursFor(v.spot, v.arrive, trip.pace);
      if (day.riskyNote) hoursWarnings.add(`${v.spot.name}: ${day.riskyNote}`);
      items.push({
        id: nextId(), kind: "spot",
        start: v.arrive, end: v.end,
        title: v.spot.name,
        detail: v.spot.description ?? "",
        spotId: v.spot.id,
        place: v.spot,
        costYen: prof.fee,
        estimated: prof.estimated,
        hoursText: describeHours(v.spot, v.arrive, trip.pace),
        hoursNote: day.note || null,
        lastEntry: day.lastEntry,
        reason: reasons?.get(v.spot.id) ?? "ご希望に合う場所です",
      });
      totalCost += prof.fee;
      prevEnd = v.end;
    }

    // 夜は、その日のエリアに泊まる。
    // ただし、まだ現地に着いていない夜（長距離の移動中）に宿は取れません。
    // 東京発パリ行きは17時間かかるので、最初の夜は機内です。
    if (day < nights) {
      const anchor = dayEntries.length ? prevEnd
        : atHour(new Date(trip.departAt.getTime() + day * 86400000),
                 dayEndHour);
      if (anchor < arriveStation) {
        items.push({
          id: nextId(), kind: "free",
          start: anchor, end: addMinutes(anchor, 60),
          title: overnight ? `${overnight.train}で移動中` : "移動中",
          detail: overnight
            ? `${overnight.boardAt} ${overnight.departure}発。`
              + `翌朝 ${overnight.arrival} に ${overnight.alightAt} へ着きます`
            : `${firstRegion.name}へ向かう途中です（機内・車内泊）`,
          costYen: 0,
          reason: "現地に着く前の夜のため、宿は取りません",
        });
      } else if (!dayEntries.length && !mv && lastLodging) {
        // 何も予定が入らなかった日に、宿だけを置きません。
        // 置くと「12日目 21:30 寄居町に宿泊」だけの日ができて、
        // 旅程が1日ぶん増えたように見えます。実際には前の晩の宿に
        // 連泊しているので、その宿を延ばして数えます。
        lastLodging.nights += 1;
        lastLodging.costYen += TUNING.lodgingYen;
        lastLodging.checkOut = addMinutes(lastLodging.checkIn,
                                          lastLodging.nights * 24 * 60);
        lastLodging.detail = `${lastLodging.nights}連泊（宿泊費は目安）`;
        totalCost += TUNING.lodgingYen;
      } else {
        lastLodging = pushLodging(items, trip, region, day, anchor, input.kb);
        totalCost += TUNING.lodgingYen;
      }
      prevEnd = anchor;
    }
  }

  // --- 復路 or 終点への移動 ---
  const lastRegion = baseOfDay(nights);
  const end = dayEnd(trip, nights);
  if (end.place) {
    const backMin = legs?.inbound?.minutes
      ?? travelFn(visits.at(-1)?.spot ?? trip.origin, end.place);
    const limit = addMinutes(trip.arriveBy, -TUNING.safetyBufferMin);
    const startBack = new Date(Math.max(prevEnd.getTime(),
                                        addMinutes(limit, -backMin).getTime()));
    // 帰りまでの空きに「自由時間」を置きます。ただし日はまたぎません。
    //
    // またぐと 23時間41分 の自由時間ができ、「いちばん長い1日は29時間」
    // という表示になっていました。夜をまたぐ空きは自由時間ではなく、
    // 「まだ予定を埋められていない日」です。そちらは
    // verify.js の underfilled が別に伝えます。
    const dayCap = atHour(prevEnd, dayEndHour);
    const freeEnd = new Date(Math.min(
      startBack.getTime(),
      Math.max(dayCap.getTime(), prevEnd.getTime())));
    const gap = Math.round((freeEnd - prevEnd) / 60000);
    if (gap >= 15 && gap <= 8 * 60) {
      items.push({
        id: nextId(), kind: "free", start: prevEnd, end: freeEnd,
        title: "自由時間", detail: freeTimeHint(lastRegion, gap),
        costYen: 0, reason: "次の予定まで時間があるため",
      });
    }
    // 帰りは、**最後に立ち寄った場所から**です。所要時間もそこから
    // 測っています（backMin）。拠点の駅の名前を出していたので、
    // 宮島から広島駅へ戻る旅程が「広島駅 → 広島駅 約90分」と出ていました。
    const backFrom = visits.at(-1)?.spot?.name
      || lastRegion.station || lastRegion.name;
    const label = returnsToStart(trip)
      ? `${backFrom} → ${end.place.name}`
      : `${backFrom} → ${end.place.name}（最終目的地）`;
    // 帰りの便も、乗る路線の手順を付けます（行きと同じ形）。
    items.push(withTransit({
      id: nextId(), kind: "transit",
      start: startBack, end: addMinutes(startBack, backMin),
      title: label,
      detail: `${legs?.inbound?.line ? legs.inbound.line + "・" : ""}`
        + (legs?.inbound?.taxi ? "タクシー" : "") + `約${backMin}分`
        + (legs?.inbound?.routed ? "" : "（推定）"),
      from: null, to: end.place,
      routed: Boolean(legs?.inbound?.routed),
      vehicle: vehicleOf(legs?.inbound),
      noTransit: legs?.inbound?.noTransit === true,
      taxi: legs?.inbound?.taxi === true,
      km: haversineKm(visits.at(-1)?.spot ?? lastRegion, end.place),
      costYen: 0,
      reason: trip.endMode === END_MODES.RETURN_TO_ORIGIN
        ? "帰着時刻に間に合う便" : "最終目的地に向かう便",
    }, legs?.inbound?.transit));
  }

  // --- 日をまたぐ区間は、着いた日にも「着いた」を置く ---
  //
  // 夜行に乗る旅程が、こうなっていました。
  //
  //   1日目  21:50–09:58  東京駅 → 出雲市駅（サンライズ出雲・車中泊）
  //   2日目  09:58–10:29  出雲大社へ移動
  //
  // **2日目に「出雲市駅に着いた」という行がありません。** 着いた時刻は
  // 1日目の行の右端にしか書かれていないので、2日目だけを見ると
  // 「09:58 に出雲大社へ移動」から始まります。どこから移動するのかが、
  // その日のどこにも書かれていません。
  //
  // 日をまたぐのは夜行列車だけではありません。夜行の高速バス、
  // 長距離のフェリー、深夜便の空路も同じです。区間の終わりが別の日に
  // なるなら、その日の頭に着地を置きます。
  //
  // 時間の幅は持ちません（0分です）。旅程の時計を進めるものではなく、
  // 「その日はここから始まる」という目印だからです。
  const arrivals = [];
  const dayOf = (t) => new Date(t).setHours(0, 0, 0, 0);
  for (const item of items) {
    if (item.kind !== "transit") continue;
    if (dayOf(item.end) <= dayOf(item.start)) continue;
    const where = item.to?.name ?? item.title;
    arrivals.push({
      id: nextId(), kind: "arrive",
      start: new Date(item.end), end: new Date(item.end),
      title: `${where} 着`,
      // 何に乗って、いつ出たのか。これが無いと「着」だけが浮きます。
      detail: `${item.detail ? `${String(item.detail).split("・")[0]}で` : ""}`
        + `${fmtHm(new Date(item.start))}に${item.from?.name ?? "出発地"}を`
        + "出て、ここから今日が始まります",
      place: item.to ?? null,
      from: item.from ?? null, to: item.to ?? null,
      km: 0, costYen: 0,
      routed: item.routed === true,
      reason: "日をまたぐ移動の到着",
    });
  }
  items.push(...arrivals);

  // --- 日ごとに分ける ---
  const days = [];
  for (const item of items) {
    const key = new Date(item.start).setHours(0, 0, 0, 0);
    let day = days.find((d) => d.key === key);
    if (!day) { day = { key, date: new Date(item.start), items: [] }; days.push(day); }
    day.items.push(item);
  }
  days.sort((a, b) => a.key - b.key);
  // 同じ時刻に並ぶときは、着地を先にします。
  //
  // 着いた時刻と、そこから次へ動き出す時刻は同じです（09:58着で
  // 09:58発）。時刻だけで並べると、どちらが先になるか決まりません。
  // 「出雲大社へ移動」が先に来ると、まだ着いていない駅から動くことに
  // なります。
  const rank = (i) => (i.kind === "arrive" ? 0 : 1);
  for (const d of days) {
    d.items.sort((a, b) => a.start - b.start || rank(a) - rank(b));
  }

  const spotCount = items.filter((i) => i.kind === "spot").length;
  const warnings = [];
  if (!spotCount) {
    warnings.push("時間が短く、立ち寄れる場所を組めませんでした。滞在時間を延ばしてください。");
  }
  if (!legs?.outbound?.routed) {
    warnings.push(legs?.routeError
      ? `移動時間は直線距離からの推定です（Routes API: ${legs.routeError}）。`
      : "移動時間は直線距離からの推定です。js/config.js に Maps API キーを"
        + "設定すると実際の経路になります。");
  }
  if (legs?.modeNote && legs?.local?.routed) {
    warnings.push(`${legs.modeNote}。`);
  }
  if (items.some((i) => i.kind === "spot" && i.estimated)) {
    warnings.push("一部スポットの営業時間・料金は分類ごとの目安です。訪問前に公式情報をご確認ください。");
  }

  // 同じ土地を指す名前は、1つにまとめます。収録のエリア名は出どころで
  // 粒度が違い、「京都・東山・京都市」のように同じ名前が2回並んで
  // いました（js/stays.js の dedupeAreaNames）。
  const regionName = dedupeAreaNames(stays.map((s) => s.region.name))
    .join("・");
  return {
    regionId: firstRegion.id, regionName,
    title: joinAreaNames(stays.map((s) => s.region.name)),
    prefecture: [...new Set(stays.map((s) => s.region.prefecture))].join("・"),
    stays: stays.map((s) => ({ id: s.region.id, name: s.region.name,
                               days: s.days, dayFrom: s.dayFrom })),
    days, totalCostYen: totalCost, spotCount, warnings,
    hoursWarnings: [...hoursWarnings],
    endMode: trip.endMode,
    // 何で回る旅か。画面と確かめかたが、これで変わります。車の旅に
    // 「時刻を引けませんでした」と出しても、引くべき時刻がありません。
    transport: trip.transport ?? "any",
    // 宿の取りかた。連泊なら、どこに連泊するかも持ちます
    // （画面で「◯◯に3連泊」と言えるようにするためです）。
    stayStyle: trip.stayStyle ?? "auto",
    usedRoutesApi: Boolean(legs?.outbound?.routed || legs?.local?.routed),
  };
}

/**
 * その区間で実際に乗る便の発車時刻。
 *
 * Yahoo!が返した発車時刻を、旅の当日に当てはめます。頼んだ日時で
 * 調べているので、返ってくる時刻はその日のものです。
 */
/**
 * その区間で実際に乗る便の時刻。置けなければ null。
 *
 * 「待ち時間があるときだけ」という条件を外しました。waitMinutes は
 * **調べたときの時刻**から数えた待ちで、旅程に出る時刻から数えた待ちでは
 * ありません。組み直しで行の時刻が動くと、両者はずれます。
 * 「11:08 夢の島熱帯植物館へ移動／11:19発→11:21着」は、これでした。
 * 行に出すのは「その便が出る時刻」です。時計を見て駅に立つ人にとって、
 * 意味があるのはそちらだけです。
 */
function boardingTime(from, leg) {
  const hm = leg?.yahoo?.departure;
  if (!hm) return null;
  const [h, m] = hm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const at = new Date(from);
  at.setHours(h, m, 0, 0);
  // 日をまたぐ便（23:50発など）は、翌日にはしません。
  // 過ぎた時刻の便も置きません。調べたときより行が後ろへ動いた
  // ときに出るもので、もう乗れない便です。
  if (at < from) return null;
  // **駅まで歩く時間を、前に戻します。**
  //
  // 行に出ていたのは、電車が出る時刻でした。
  //
  //   8:53  八ッ場ダムへ移動   19分
  //         08:53発→08:58着（5分）…前後の徒歩14分を含めて23分
  //   9:12  八ッ場ダム
  //
  // 8:53に「移動」が始まることになっていますが、駅までの徒歩が
  // 先にあるので、**動き出すのは8:49**です。行の長さ（19分）と
  // 中の数字（23分）も合いません。歩き始める時刻から始めます。
  const walkA = leg?.walkA ?? 0;
  if (!(walkA > 0)) return at;
  const leave = new Date(at.getTime() - walkA * 60000);
  return leave < from ? from : leave;
}

/**
 * 調べた便が、いま出す行の時刻に合っているか。
 *
 * 合っていない便の「11:19発→11:21着」を出すと、行の時刻（11:08）と
 * 中で食い違います。読む人にはどちらが本当か分かりません。
 * 合っていないなら、発着時刻は出さずに所要時間だけにします。
 * **間違った時刻を出すくらいなら、分からないと言うほうがましです。**
 */
function legFitsRow(from, leg) {
  const hm = leg?.yahoo?.departure;
  if (!hm) return true;           // 発着時刻が無いなら、食い違いようがない
  const [h, m] = hm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return true;
  const rowMin = from.getHours() * 60 + from.getMinutes();
  const legMin = h * 60 + m;
  // 便が行より**前**なら、調べたときの時刻のままです（もう乗れません）。
  // 後ろなら、それは待ち時間なので、そのまま出して構いません。
  return legMin >= rowMin - 1;
}

function fmtHm(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** その区間を歩くか。歩ける距離（既定1km）までを徒歩と呼びます。 */
function isWalkLeg(km) {
  return Number.isFinite(km) && km > 0 && km <= (TUNING.walkableKm ?? 1.0);
}

function mealItem(start, end, title, region) {
  return {
    id: nextId(), kind: "meal", start, end, title,
    detail: `${region?.name ?? ""}で。お店は地図から選べます`,
    costYen: TUNING.mealYen,
    near: { lat: region?.lat, lng: region?.lng, regionName: region?.name },
    reason: title === "昼食" ? "昼の時間帯に差しかかったため" : "夕食の時間帯",
  };
}

function pushLodging(items, trip, region, dayIndex, after, kb) {
  const lodging = trip.lodging?.[dayIndex];
  // 宿はエリアの中心ではなく、人が集まる地点に取ります。
  // 中心座標は収録スポットの重心なので、富士山エリアなら山頂付近になります。
  const spot = pickLodging({ region, kb, explicit: lodging });
  const fallbackStart = atHour(after, TUNING.dayEndHour + 1);
  const start = lodging?.checkInBy
    ?? (fallbackStart > after ? fallbackStart : addMinutes(after, 30));
  const item = {
    id: nextId(), kind: "lodging",
    start, end: addMinutes(start, 60),
    title: `${spot.regionName}に宿泊`,
    detail: lodging?.place ? "" : `${spot.reason}。宿は地図から探せます（宿泊費は目安）`,
    costYen: TUNING.lodgingYen,
    place: lodging?.place ?? null,
    near: { lat: spot.place.lat, lng: spot.place.lng,
            regionName: spot.regionName },
    movedFrom: spot.movedFrom,
    checkIn: start,
    checkOut: addMinutes(start, 24 * 60),
    nights: 1,
    reason: spot.movedFrom
      ? `${spot.movedFrom}には宿が少ないため` : "翌日も旅が続くため",
  };
  items.push(item);
  return item;
}
