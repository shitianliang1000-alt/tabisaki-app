// 「どこに何日いるか」を決める。
//
// 1エリアに固定していたころ、10日間の旅程が4スポットになりました。
// 収録6スポットのエリアに10日いれば当然そうなります。人はそういう旅を
// しません。四国を10日なら松山・高知・徳島・高松と拠点を移します。
//
// ここは制約の担当です。どのエリアが希望に合うか（＝意味）は ai.js が
// 選び、その並びを地理的に無理のない順に直し、日数を割り振るのがここ。

import { estimateMinutes } from "./feasibility.js";

/** 1日に回れるスポット数の目安。ペースで変えます。 */
// 1日あたりの行き先の数。
//
// 以前は 3 / 4 / 5 でした。実際に使うと「せっかく行ったのに、
// 昼過ぎで予定が終わってしまう」という形になりがちです。移動と
// 滞在で入りきらないぶんは verify.js が後ろから削るので、
// ここは多めに出しておくほうが、結果として1日が埋まります。
export const SPOTS_PER_DAY = { relaxed: 4, balanced: 5, packed: 7 };

/**
 * 宿の取りかた。
 *
 * 同じ3泊4日でも、「1か所に泊まって日帰りで回る」旅と「泊まるたびに
 * 土地を変える」旅は、まるで別の旅です。前者は荷物を置いておけて
 * 戻る安心がありますが、遠くへは行けません。後者は広く回れますが、
 * 毎朝荷物をまとめ、毎晩チェックインします。
 *
 * どちらが良いかは**好みの問題**なので、こちらで決めません。
 * 既定（auto）はこれまでどおり、日数から自然な数のエリアを回ります。
 */
export const STAY_STYLES = /** @type {const} */ ({
  AUTO: "auto",   // 日数に任せる（これまでの動き）
  BASE: "base",   // 連泊。宿は動かさず、日帰りで回る
  TOUR: "tour",   // 周遊。泊まるたびに土地が変わる
});

export const STAY_STYLE_LABEL = {
  auto: "おまかせ",
  base: "1か所に連泊",
  tour: "泊まるたびに移動",
};

/** そのエリアだけで無理なく過ごせる日数（収録スポット数から）。 */
export function capacityDays(spotCount, perDay = 4) {
  return Math.max(1, Math.ceil(spotCount / Math.max(2, perDay - 1)));
}

/**
 * 何エリアを回るのが自然か。
 * 2日にひとつを目安にしつつ、移動ばかりにならないよう上限を置きます。
 *
 * 上限は 4 で固定していました。そのため「最長片道切符の経路をたどりたい」の
 * ような、日本を縦断する長い旅を頼まれても、答えは4エリアどまりでした
 * （12日間で「寄居町〜新潟市ほか4エリア・8か所」）。長い旅は、長いなりに
 * 拠点が増えるのが自然なので、日数に応じて上限も伸ばします。
 * それでも 2日にひとつという目安は変えません。1日ごとに拠点を移すのは、
 * 旅ではなく移動になります。
 */
export function suggestRegionCount(days, maxRegions = null, style = "auto") {
  if (days <= 2) return 1;
  const cap = maxRegions ?? Math.min(10, Math.max(4, Math.round(days / 2)));
  // 連泊なら、日中に回るエリアも絞ります。
  //
  // 宿を動かさない旅で、エリアだけ4つ選ぶと、毎晩遠くから戻ることに
  // なります。戻れるかどうかは verify.js が数えますが、そこで削られる
  // ぶんは**最初から選ばない**ほうが、旅程として素直です。
  if (style === STAY_STYLES.BASE) {
    return Math.min(cap, 3, Math.max(1, Math.ceil(days / 3)));
  }
  // 周遊なら、泊まるたびに土地が変わります（1日ひとつ）。
  if (style === STAY_STYLES.TOUR) return Math.min(maxRegions ?? days, days);
  return Math.min(cap, Math.max(1, Math.ceil(days / 2)));
}

const stationOf = (region) => ({
  lat: region.stationLat, lng: region.stationLng,
  name: region.station || region.name,
  // 国をここで落とすと、国際線の上乗せが効かなくなります
  country: region.country ?? "日本",
});

/**
 * 回る順を、実際の移動距離が短くなるように並べ替えます。
 * エリア数は多くても4件なので、全順列を試して差し支えありません。
 */
export function orderRegions(regions, { origin, end, travelFn = estimateMinutes }) {
  if (regions.length <= 1) return [...regions];
  const idx = regions.map((_, i) => i);
  const stations = regions.map(stationOf);
  const cost = (perm) => {
    let sum = 0;
    let prev = origin;
    for (const i of perm) { sum += travelFn(prev, stations[i]); prev = stations[i]; }
    return end ? sum + travelFn(prev, end) : sum;
  };

  // 7エリアを超えると全順列は 5040通りを超え、日数を伸ばすほど跳ね上がります
  // （10エリアで362万通り）。数が増えたら、近いほうから順に並べたうえで
  // 2辺の入れ替え（2-opt）で直します。最短とは限りませんが、
  // 「行って戻ってまた行く」ような並びは残りません。
  if (regions.length > 7) return twoOpt(nearestFirst(idx, stations, origin, travelFn),
                                        cost).map((i) => regions[i]);

  let best = null;
  for (const perm of permutations(idx)) {
    const c = cost(perm);
    if (!best || c < best.cost) best = { cost: c, perm };
  }
  return best.perm.map((i) => regions[i]);
}

function nearestFirst(idx, stations, origin, travelFn) {
  const rest = new Set(idx);
  const out = [];
  let prev = origin;
  while (rest.size) {
    let pick = null;
    for (const i of rest) {
      const d = travelFn(prev, stations[i]);
      if (pick === null || d < pick.d) pick = { i, d };
    }
    out.push(pick.i);
    rest.delete(pick.i);
    prev = stations[pick.i];
  }
  return out;
}

function twoOpt(perm, cost) {
  let best = perm;
  let bestCost = cost(perm);
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const next = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(),
                      ...best.slice(j + 1)];
        const c = cost(next);
        if (c < bestCost - 0.001) { best = next; bestCost = c; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

function* permutations(arr) {
  if (arr.length <= 1) { yield [...arr]; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

/**
 * 日数をエリアに割り振ります。
 *
 * 収録スポットが少ないエリアに長く留めても手持ち無沙汰になるだけなので、
 * まず各エリアの「持ちこたえられる日数」で上限を切り、余りを収録数の
 * 多い順に配ります。最後は必ず全日が埋まります。
 */
export function allocateDays(regions, days, spotCounts, perDay = 4,
                             style = "auto") {
  const n = regions.length;
  if (n === 0) return [];
  if (n === 1) return [days];
  const caps = regions.map((r, i) =>
    capacityDays(spotCounts[i] ?? 0, perDay));
  const alloc = new Array(n).fill(1);
  let left = days - n;
  // 周遊では、1エリア1日から始めます。収録の多いエリアに何日も
  // 積むと、「泊まるたびに移動する」と選んだのに連泊になります。
  // エリアより日数が多いぶんだけ、あとで順に足します。
  if (style === STAY_STYLES.TOUR) {
    for (let i = 0; left > 0; i = (i + 1) % n, left--) alloc[i]++;
    return alloc;
  }
  // まず上限まで、収録の多いエリアから
  const order = regions.map((_, i) => i)
    .sort((a, b) => (spotCounts[b] ?? 0) - (spotCounts[a] ?? 0));
  while (left > 0) {
    let placed = false;
    for (const i of order) {
      if (left <= 0) break;
      if (alloc[i] < caps[i]) { alloc[i]++; left--; placed = true; }
    }
    if (!placed) break;    // どこも上限。残りは最後に足す
  }
  // 上限を超えてもまだ余るなら、順に1日ずつ配ります。
  // 最初のエリアにまとめて足すと「徳島に4日、あとは2日ずつ」のような
  // 偏った旅程になり、収録の少ないエリアで手持ち無沙汰の日が出ます。
  for (let i = 0; left > 0; i = (i + 1) % n, left--) alloc[i]++;
  return alloc;
}

/**
 * 滞在計画を作ります。
 *
 * @param {Array<{region:object, spots:Array}>} chosen 訪れるエリア（AIの並び）
 * @param {object} opts
 * @returns {{stays:Array, baseByDay:Array, regionByDay:Array}}
 */
export function planStays(chosen, { days, origin, end, pace = "balanced",
                                   stayStyle = STAY_STYLES.AUTO,
                                   travelFn = estimateMinutes } = {}) {
  const perDay = SPOTS_PER_DAY[pace] ?? 4;
  const regions = orderRegions(chosen.map((c) => c.region), { origin, end, travelFn });
  const byId = new Map(chosen.map((c) => [c.region.id, c]));
  const counts = regions.map((r) => byId.get(r.id)?.spots?.length ?? 0);
  const alloc = allocateDays(regions, days, counts, perDay, stayStyle);

  const stays = [];
  const baseByDay = [];
  const regionByDay = [];
  let day = 0;
  for (const [i, region] of regions.entries()) {
    const nDays = alloc[i];
    const stay = { region, station: stationOf(region), dayFrom: day,
                   dayTo: day + nDays - 1, days: nDays,
                   spots: byId.get(region.id)?.spots ?? [] };
    stays.push(stay);
    for (let d = 0; d < nDays; d++) {
      baseByDay.push(stay.station);
      regionByDay.push(region);
      day++;
    }
  }

  // 連泊なら、宿は1か所。日中に回るエリアは変わっても、夜は同じ場所に
  // 帰ります。どの日も同じ拠点を渡しておけば、時刻の突き合わせ
  // （verify.js）が毎晩そこまでの移動を数え、戻れない日は削られます。
  // ここで「戻れるはず」と決めつけないのが大事なところです。
  let basedAt = null;
  if (stayStyle === STAY_STYLES.BASE && stays.length) {
    basedAt = pickBase(stays, travelFn);
    for (let i = 0; i < baseByDay.length; i++) baseByDay[i] = basedAt;
  }
  return { stays, baseByDay, regionByDay, perDay, stayStyle, basedAt };
}

/**
 * 連泊する1か所を選びます。
 *
 * 選ぶのは「そこから全部のエリアへ行き帰りする合計がいちばん短い」場所
 * です。滞在日数で重みを付けます。3日いるエリアと1日のエリアを同じに
 * 扱うと、1日しかいない遠いエリアのために宿が遠くなります。
 */
export function pickBase(stays, travelFn = estimateMinutes) {
  let best = null;
  for (const home of stays) {
    let sum = 0;
    for (const other of stays) {
      if (other === home) continue;
      // 行きと帰りで2回ぶん。日帰りは往復です。
      sum += 2 * travelFn(home.station, other.station) * other.days;
    }
    if (!best || sum < best.sum) best = { sum, station: home.station };
  }
  return best?.station ?? null;
}

/** その日のエリア。 */
export function regionOfDay(stays, dayIndex) {
  for (const s of stays) {
    if (dayIndex >= s.dayFrom && dayIndex <= s.dayTo) return s.region;
  }
  return stays.at(-1)?.region ?? null;
}

/**
 * 同じ土地を指す名前かどうか。
 *
 * 収録のエリア名は、出どころによって粒度が違います。
 *
 *   京都・東山・京都市    ← 「京都」と「京都市」は同じ土地です
 *   出雲・出雲市          ← 同じ
 *
 * これがそのまま旅の題になり、「京都・東山・京都市」と出ていました。
 * 同じ名前が2回並んでいるようにしか見えません。
 *
 * **市区町村の呼び名を落として突き合わせます。** 落としてなお違うもの
 * （東山と京都）は、別のエリアとして残します。中に入っているかどうか
 * まで見にいくと、「出雲」と「出雲大社」のような別物まで混ざります。
 */
function areaKey(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    // 末尾の市区町村・郡だけを落とします。頭や途中の字は残します
    //（「市川」の「市」を落とすと別の土地になります）。
    .replace(/(市|区|町|村|郡)$/, "");
}

/**
 * 同じ土地を指す名前を、1つにまとめます。
 *
 * 残すのは**先に出てきたほう**です。並びの先頭は、いちばん長く
 * 泊まるエリアだからです（stays の順）。ただし「京都」と「京都市」の
 * ように片方が呼び名つきなら、**短いほう**を残します（題は短いほうが
 * 読めます）。
 */
export function dedupeAreaNames(names) {
  const out = [];
  for (const name of (names ?? []).filter(Boolean)) {
    const key = areaKey(name);
    if (!key) continue;
    const at = out.findIndex((n) => areaKey(n) === key);
    if (at < 0) { out.push(name); continue; }
    if (name.length < out[at].length) out[at] = name;
  }
  return out;
}

/**
 * エリア名の並びを、見出しに使える短さにまとめます。
 * 4エリアを「・」で全部つなぐと、見出しが説明文になってしまいます。
 */
export function joinAreaNames(names) {
  const list = dedupeAreaNames([...new Set((names ?? []).filter(Boolean))]);
  if (list.length <= 3) return list.join("・");
  return `${list[0]}〜${list.at(-1)}ほか${list.length}エリア`;
}
