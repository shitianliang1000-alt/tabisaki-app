// 混雑を避ける。
//
// 観光地の混雑は、行った人にとっては体験の質を落とし、住む人にとっては
// 生活の負担になります。旅程を組むアプリは、この二つに直接効けます。
// **時間をずらす**ことと、**行き先を散らす**ことです。
//
// ここで出すのは実測ではなく推定です。混雑の実データ（Places API の
// popular times 等）は有料で、しかも取得が保証されません。代わりに、
// 誰でも検証できる要素だけで組み立てます。
//
//   知名度 × 曜日 × 時間帯 × 季節 × 場所の性格
//
// 推定であることは画面にも書きます。数字を装って断定しないためです。

/** 混雑しやすい分類（狭い・並ぶ・一点に集まる）。 */
const CROWD_PRONE = {
  テーマパーク: 25, 展望台: 18, 世界遺産: 18, 水族館: 15, 城: 12,
  寺院: 8, 神社: 8, 商店街: 12, 市場: 12, 美術館: 8, 庭園: 6,
  温泉: 6, ロープウェイ: 15, 乗り物: 12, 建築: 6, 町並み: 10,
};

/** 逆に、広くて分散しやすい場所。 */
const CROWD_TOLERANT = new Set([
  "国立公園", "国定公園", "山", "登山", "渓谷", "滝", "川", "海岸", "湖",
  "公園", "丘", "牧場", "史跡",
]);

const FAME_WEIGHT = { major: 34, known: 16, hidden: 4 };

/** 日本の観光がとくに集中する時期。月日で判定します。 */
const PEAK_SEASONS = [
  { from: [3, 25], to: [4, 10], name: "桜の時期", add: 22 },
  { from: [4, 29], to: [5, 5], name: "ゴールデンウィーク", add: 28 },
  { from: [8, 10], to: [8, 16], name: "お盆", add: 24 },
  { from: [11, 10], to: [11, 30], name: "紅葉の時期", add: 20 },
  { from: [12, 29], to: [1, 3], name: "年末年始", add: 24 },
];

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function seasonOf(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const val = m * 100 + d;
  for (const s of PEAK_SEASONS) {
    const a = s.from[0] * 100 + s.from[1];
    const b = s.to[0] * 100 + s.to[1];
    const hit = a <= b ? (val >= a && val <= b) : (val >= a || val <= b);
    if (hit) return s;
  }
  return null;
}

/** 時間帯の係数。昼前後に人が集まります。 */
function hourFactor(hour) {
  if (hour < 8) return -18;          // 開館直後より前。いちばん静か
  if (hour < 9.5) return -14;        // 開いてすぐ
  if (hour < 11) return -4;
  if (hour < 15) return 12;          // 昼どき前後が山
  if (hour < 16.5) return -2;
  return -12;                        // 閉館前
}

/**
 * ある場所・ある時刻の混みやすさ。
 *
 * @param {object} spot
 * @param {Date}   at
 * @returns {{score:number, label:string, reasons:string[]}}
 *   score は 0〜100 の目安。実測ではありません。
 */
export function crowdLevel(spot, at) {
  const reasons = [];
  let score = 24;

  score += FAME_WEIGHT[spot.fame_tier] ?? 12;
  if (spot.fame_tier === "major") reasons.push("よく知られた場所");
  if (spot.fame_tier === "hidden") reasons.push("知る人ぞ知る場所");

  if (CROWD_TOLERANT.has(spot.category)) score -= 12;
  else score += CROWD_PRONE[spot.category] ?? 6;

  if (at) {
    const day = at.getDay();
    if (day === 0 || day === 6) { score += 16; reasons.push(`${WEEK[day]}曜`); }
    const h = at.getHours() + at.getMinutes() / 60;
    const hf = hourFactor(h);
    score += hf;
    if (hf <= -12) reasons.push("人の少ない時間帯");
    if (hf >= 12) reasons.push("いちばん混む時間帯");

    const season = seasonOf(at);
    if (season) { score += season.add; reasons.push(season.name); }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, label: labelOf(score), reasons };
}

export function labelOf(score) {
  if (score >= 78) return "非常に混雑";
  if (score >= 58) return "混雑";
  if (score >= 36) return "ふつう";
  return "ゆったり";
}

/**
 * その場所が空いている時間帯。
 * 「朝いち」か「夕方」かは、営業時間の長さで決めます。
 *
 * @returns {{from:number, to:number, text:string}}
 */
export function quietWindow(prof) {
  const open = prof?.open ?? 9;
  const close = prof?.close ?? 17;
  if (close - open >= 6) {
    return { from: open, to: Math.min(open + 1.5, close),
             text: `${fmtHour(open)}〜${fmtHour(Math.min(open + 1.5, close))}` };
  }
  return { from: open, to: close, text: `${fmtHour(open)}〜${fmtHour(close)}` };
}

/**
 * 押された順を勝たせます。
 *
 * 並びは道順と混雑から決めています。それでも「先に海へ行きたい」は
 * 好みの問題なので、指定された順があれば、そちらを使います。
 *
 * 指定に無いスポットは動かしません。**動かした場所の位置だけを
 * 入れ替えます。** ここで全体を作り直すと、指定されていない場所まで
 * 並びが変わり、押した人には何が起きたのか分からなくなります。
 *
 * 時刻はここでは決めません。組み直しは verify.js が行い、その順で
 * 入らなければ、これまでどおり入らないぶんが落ちます。
 *
 * @param {Array} list その日の並び（道順と混雑で決めたもの）
 * @param {string[]} [orderedIds] 押された順
 */
export function applyChosenOrder(list, orderedIds) {
  const wanted = (orderedIds ?? []).filter(Boolean);
  if (wanted.length < 2) return list;

  const rank = new Map(wanted.map((id, i) => [id, i]));
  // 指定に入っているものが、いまどの位置にいるか
  const slots = [];
  const moving = [];
  list.forEach((s, i) => {
    if (!rank.has(s.id)) return;
    slots.push(i);
    moving.push(s);
  });
  if (moving.length < 2) return list;

  moving.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const out = [...list];
  slots.forEach((at, i) => { out[at] = moving[i]; });
  return out;
}

/**
 * 混雑を避ける並べ替え。
 *
 * 混みやすい場所を朝いちに、そうでない場所を昼に回します。
 * 順番を入れ替えるだけで、待ち時間も現地の負荷も下がります。
 * 移動が増えすぎないよう、エリア（滞在）の区切りは崩しません。
 *
 * @param {Array} spots  訪問順の候補
 * @param {object} opts
 * @param {Map<string,number>} [opts.dayFloorById] 何日目に回るか
 * @returns {Array} 並べ替えた訪問順
 */
export function spreadCrowds(spots, opts = {}) {
  const { dayFloorById, start, travelFn, baseByDay } = opts;
  const groups = new Map();
  for (const s of spots) {
    const day = dayFloorById?.get(s.id) ?? 0;
    const list = groups.get(day);
    if (list) list.push(s); else groups.set(day, [s]);
  }
  const out = [];
  let from = start ?? null;
  for (const day of [...groups.keys()].sort((a, b) => a - b)) {
    // その日の起点は、**その日の拠点**です。
    //
    // ここは前の日の最後の立ち寄りから続けていました。同じ街に居続ける
    // なら、それで合っています。けれど拠点を移した日は、300km離れた
    // 昨日の場所から近い順に並べることになります。新しい街に着いて
    // いちばん遠い場所から回りはじめる旅程は、こうして出ていました。
    const base = baseByDay?.[day] ?? null;
    const ordered = applyChosenOrder(
      orderByRoute(groups.get(day), base ?? from, travelFn, opts),
      opts.orderedIds);
    out.push(...ordered);
    from = ordered.at(-1) ?? from;
  }
  return out;
}

/**
 * その日の並び順。**まず道順、そのあとで混雑**。
 *
 * 以前は混雑度だけで並べていました。「順番を変えるだけなので移動距離は
 * 増えません」とコメントに書いてありましたが、**これは誤りでした**。
 * 順番を変えれば移動距離は変わります。実際、上高地の河童橋のあとに
 * 市街の松本城を挟み、また上高地の大正池へ戻る、という旅程が出ていました。
 * 松本城がいちばん混むので、朝いちに引き上げられたためです。
 *
 * 直しかたは2段です。
 *   1. 近いところから順につなぐ（最近傍）→ 2-opt で交差をほどく
 *   2. 隣どうしの入れ替えが、**移動をほとんど増やさずに**混雑を
 *      減らせるときだけ、入れ替える
 *
 * 2 が「ほとんど増やさず」なのは、混雑を避けるために来た道を戻るのは
 * 本末転倒だからです。上限（EXTRA_KM）を超える入れ替えはしません。
 */
const EXTRA_KM = 6;

/**
 * その場所を「先に回すべき度合い」。
 *
 * 道順が同じくらいなら、この順に回します。
 *
 *   必ず行く   … 入らなければ旅程の意味がありません
 *   早く閉まる … 17時に閉まる場所を最後に置くと、着いても入れません
 *   混みやすい … 朝いちのほうが空いています
 *
 * 閉館を入れるまでは、混雑だけで見ていました。そのせいで、
 * 「必ず行く」に指定した高徳院（17:30 閉門）が5番目に回され、
 * 着いたときには閉まっている、という旅程が出ていました。
 * 指定したのに入らない旅程は、指定しなかったのと同じです。
 */
function urgency(spot, pinned, useCrowd) {
  let u = useCrowd ? crowdLevel(spot, null).score : 0;
  if (pinned.has(spot.id)) u += 60;
  const close = Number(spot.close ?? spot.hours?.close);
  if (Number.isFinite(close) && close < 18) u += (18 - close) * 8;
  return u;
}

export function orderByRoute(spots, start = null, travelFn = null, opts = {}) {
  const pinned = new Set(opts.pinnedIds ?? []);
  const useCrowd = opts.useCrowd !== false;
  const list = [...(spots ?? [])];
  if (list.length <= 2) return list;

  const cost = (a, b) => {
    if (!a || !b) return 0;
    if (travelFn) {
      const m = travelFn(a, b);
      if (Number.isFinite(m)) return m;
    }
    return km(a, b);
  };

  // 1-a. 最近傍でつなぐ
  const rest = [...list];
  const path = [];
  let cur = start;
  while (rest.length) {
    let best = 0;
    if (cur) {
      let bestC = Infinity;
      for (let i = 0; i < rest.length; i++) {
        const c = cost(cur, rest[i]);
        if (c < bestC) { bestC = c; best = i; }
      }
    }
    cur = rest.splice(best, 1)[0];
    path.push(cur);
  }

  // 1-b. 2-opt。交差している経路をほどきます。
  //      件数は多くて十数なので、素直に回して構いません。
  const total = (p) => {
    let t = start ? cost(start, p[0]) : 0;
    for (let i = 0; i + 1 < p.length; i++) t += cost(p[i], p[i + 1]);
    return t;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 40) {
    improved = false;
    for (let i = 0; i < path.length - 1; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const next = [...path.slice(0, i), ...path.slice(i, j + 1).reverse(),
                      ...path.slice(j + 1)];
        if (total(next) < total(path) - 0.001) {
          path.splice(0, path.length, ...next);
          improved = true;
        }
      }
    }
  }

  // 2. 混雑の入れ替え。道順をほとんど崩さない範囲だけ。
  //
  //    隣どうしを1回見るだけでは、いちばん混む場所が1つ前に出るだけで
  //    先頭まで来ません。動かなくなるまで繰り返します（バブルソート）。
  //    ただし、1回ごとに「移動がどれだけ増えるか」を見るので、
  //    遠い場所が混雑だけを理由に先頭へ来ることはありません。
  const crowd = (s) => urgency(s, pinned, useCrowd);
  // travelFn は分、無ければ km。どちらでも「少しだけ」の幅で見ます。
  const allow = travelFn ? EXTRA_KM * 2 : EXTRA_KM;
  // **1回ごとの上限だけでは足りませんでした。**
  //
  // 「1回につき6kmまで」を何度も通せば、いくらでも遠回りできます。実際に
  // 出ていたのが、拠点のすぐ隣に4か所あるのに、7.3km先の寺から始めて
  // また6.6km戻ってくる1日です。1回ぶんはどれも上限の中でした。
  // 道順そのものからどれだけ離れたかも、まとめて見ます。
  const routeCost = total(path);
  let moved = true;
  let pass = 0;
  while (moved && pass++ < path.length) {
    moved = false;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (crowd(b) <= crowd(a) + 8) continue;    // 入れ替える理由が薄い
      const swapped = [...path];
      swapped[i] = b; swapped[i + 1] = a;
      const after = total(swapped);
      if (after - total(path) <= allow && after - routeCost <= allow) {
        path.splice(0, path.length, ...swapped);
        moved = true;
      }
    }
  }
  return path;
}

/** 2点の距離（km）。crowd.js の中だけで使う簡易版です。 */
function km(a, b) {
  const R = 6371;
  const p1 = (a.lat ?? 0) * Math.PI / 180;
  const p2 = (b.lat ?? 0) * Math.PI / 180;
  const dp = p2 - p1;
  const dl = ((b.lng ?? 0) - (a.lng ?? 0)) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 組み上がった旅程の混雑ぐあいと、住む人への負荷。
 *
 * @param {object} itin
 * @returns {{score:number, label:string, notes:string[], perSpot:Array}}
 */
export function itineraryCrowd(itin) {
  const perSpot = [];
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind !== "spot" || !item.place) continue;
      const c = crowdLevel(item.place, item.start);
      const p = item.place;
      const hasHours = !(p.open === 0 && p.close === 24)
        && p.open !== undefined && p.close !== undefined;
      perSpot.push({ id: item.id, name: item.title, at: item.start,
                     hasHours, ...c });
    }
  }
  if (!perSpot.length) {
    return { score: 0, label: "—", notes: [], perSpot };
  }
  const score = Math.round(
    perSpot.reduce((a, x) => a + x.score, 0) / perSpot.length);

  const notes = [];
  const early = perSpot.filter((x) => x.at.getHours() < 10
    && x.score >= 50).length;
  if (early) {
    notes.push(`混みやすい${early}か所を、人の少ない朝の時間帯に置きました。`);
  }
  const hidden = perSpot.filter((x) =>
    x.reasons.includes("知る人ぞ知る場所")).length;
  if (hidden) {
    notes.push(`${hidden}か所は知る人ぞ知る場所です。`
      + "行き先が一点に集まらないほうが、現地の負担も軽くなります。");
  }
  const heavy = perSpot.filter((x) => x.score >= 78);
  if (heavy.length) {
    // 終日出入りできる場所に「開館直後」と言っても意味がありません
    const timed = heavy.filter((x) => x.hasHours);
    const open = heavy.filter((x) => !x.hasHours);
    if (timed.length) {
      notes.push(`${timed.map((x) => x.name).join("・")}は特に混み合う見込みです。`
        + "開館直後か閉館前が狙い目です。");
    }
    if (open.length) {
      notes.push(`${open.map((x) => x.name).join("・")}は特に混み合う見込みです。`
        + "早朝か夕方なら落ち着いて過ごせます。");
    }
  }
  return { score, label: labelOf(score), notes, perSpot };
}

function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm ? `${hh}:${String(mm).padStart(2, "0")}` : `${hh}時`;
}
