// 旅程の質を、プログラム側で採点する。
//
// AIに「この旅程は何点ですか」と聞いてはいけません。同じ旅程でも
// 聞くたびに違う点が返り、案どうしを比べられなくなります。
// 採点に使う量は、どれも数えれば決まります。
//
//   移動時間の割合／歩き続ける長さ／1日の行動時間／日ごとのばらつき／
//   希望したジャンルが揃っているか／定番と穴場が混ざっているか
//
// ここで返すのは点そのものより **順序** です。移動ばかりの旅程が
// 見どころの多い旅程より高く出たら、それは採点が壊れています。
//
// 点は「良い旅かどうか」ではありません。旅の良し悪しは人が決めます。
// ここが測るのは「無理がないか」「偏っていないか」だけです。

const HOUR = 60;

/** 内訳の重み。合計1。 */
// 合計で1になるようにします。「空き時間」は、予定の抜けた時間が
// どれだけ少ないかです（8時間半あく日が実際に出ていました）。
const WEIGHTS = { move: 0.2, fatigue: 0.25, rhythm: 0.15, joy: 0.2,
                  empty: 0.2 };

/** x を [lo,hi] から 0〜100 に落とします（lo で100、hi で0）。 */
function falloff(x, lo, hi) {
  if (!Number.isFinite(x)) return 100;
  if (x <= lo) return 100;
  if (x >= hi) return 0;
  return Math.round(100 * (1 - (x - lo) / (hi - lo)));
}

const minutesOf = (item) =>
  Math.max(0, Math.round((item.end - item.start) / 60000));

/**
 * 旅程を採点します。
 *
 * @param {object} itin buildItinerary の結果（days[].items[]）
 * @param {{interests?:string[]}} [opts]
 * @returns {{total:number, parts:Array, weakest:object, summary:string}}
 */
export function scoreItinerary(itin, opts = {}) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  const all = days.flatMap((d) => (Array.isArray(d?.items) ? d.items : []));
  const spots = all.filter((i) => i.kind === "spot");
  const moves = all.filter((i) => i.kind === "transit");

  const spotMin = spots.reduce((a, i) => a + minutesOf(i), 0);
  const moveMin = moves.reduce((a, i) => a + minutesOf(i), 0);

  const parts = [
    movePart(spotMin, moveMin, opts.enjoyTravel === true),
    fatiguePart(days, all),
    rhythmPart(days),
    joyPart(spots, opts.interests ?? []),
    emptyPart(days),
  ];

  const total = Math.round(
    parts.reduce((a, p) => a + p.score * p.weight, 0));
  const weakest = parts.slice().sort((a, b) => a.score - b.score)[0];

  // 疲労は「疲れにくさ」の裏返しです。0〜100 の目盛りで、
  // 大きいほど疲れます。段階の言葉を必ず添えます（数字だけでは
  // 60 がきついのかどうか分かりません）。
  const fatigue = 100 - parts.find((p) => p.key === "fatigue").score;
  const fatigueLabel = fatigue >= 80 ? "過密"
    : fatigue >= 60 ? "やや疲れる"
    : fatigue >= 30 ? "普通" : "ゆったり";

  return { total, parts, weakest, fatigue, fatigueLabel,
           tooHard: fatigue >= 80,
           summary: summarize(total, parts, weakest) };
}

// --- 空いている時間 ---------------------------------------------------------

/** その日のいちばん長い空白（分）。予定と予定のあいだです。 */
export function longestGapMin(day) {
  const items = [...(day?.items ?? [])]
    .filter((i) => i.start && i.end)
    .sort((a, b) => a.start - b.start);
  let worst = 0;
  for (let i = 0; i + 1 < items.length; i++) {
    // 宿は「その日の終わり」なので、そこから先は空白ではありません。
    if (items[i + 1].kind === "lodging") break;
    const gap = Math.round((items[i + 1].start - items[i].end) / 60000);
    if (gap > worst) worst = gap;
  }
  return worst;
}

/** 旅程全体で、いちばん長い空白（分）。 */
export function longestGap(itin) {
  return Math.max(0, ...(itin?.days ?? []).map(longestGapMin));
}

/**
 * 空白の少なさ。
 *
 * 「9:04に見学が終わって、次は17:30の夕食」という日が出ていました。
 * 予定表としては成立していますが、8時間半をどう過ごすのかは書いて
 * ありません。**書いていない時間は、旅程ではありません。**
 * 2時間までは休憩や街歩きの範囲、5時間を超えるとその日は空です。
 */
function emptyPart(days) {
  const worst = Math.max(0, ...days.map(longestGapMin));
  const score = falloff(worst, 120, 300);
  const h = Math.floor(worst / 60);
  const m = worst % 60;
  return { key: "empty", label: "空き時間", score, weight: WEIGHTS.empty,
           note: worst >= 120
             ? `予定の空いている時間が最大${h ? `${h}時間` : ""}${m}分あります`
             : "予定の抜けた時間はありません" };
}

// --- 移動の割合 -------------------------------------------------------------

function movePart(spotMin, moveMin, enjoyTravel = false) {
  const sum = spotMin + moveMin;
  const ratio = sum > 0 ? moveMin / sum : 0;
  // 2割までは気になりません。6割を超えると「移動しに行った旅」です。
  //
  // 移動を楽しみたい人には、「移動しに行った旅」こそが頼まれたものです。
  // 減点するのは、着いた先で何もできないほど偏ったとき（8割5分超）だけにします。
  const score = enjoyTravel ? falloff(ratio, 0.6, 0.85)
    : falloff(ratio, 0.2, 0.6);
  const pct = Math.round(ratio * 100);
  return {
    key: "move", label: enjoyTravel ? "移動と見学のつり合い" : "移動の少なさ",
    weight: WEIGHTS.move, score,
    note: sum === 0 ? "移動と見学の時間がまだありません"
      : `動いている時間が全体の ${pct}%`
        + (pct >= 50 ? "（半分以上が移動です）" : ""),
  };
}

// --- 疲れにくさ -------------------------------------------------------------

/**
 * 疲れにくさ。五つのことを見ます。
 *
 *   1. いちばん長い1日     … 13時間を超えると翌日に残ります
 *   2. 続けて歩く時間       … 座らずに90分歩くのは登山です
 *   3. その日に歩く合計     … 1回が短くても、積もれば効きます
 *   4. 休まず続ける見学     … 9時 寺 / 10時 神社 / 11時 城 … を避ける
 *   5. 朝の早さ            … 6時台の出発は、それだけで一日ぶん削ります
 *
 * どれも数えれば決まる量です。AIに「疲れそうですか」とは聞きません。
 */
function fatiguePart(days, all) {
  // 1. いちばん長い1日
  const dayLengths = days.map((d) => {
    const items = (d?.items ?? []).filter((i) => i.start && i.end);
    if (!items.length) return 0;
    const from = Math.min(...items.map((i) => +i.start));
    const to = Math.max(...items.map((i) => +i.end));
    return Math.round((to - from) / 60000);
  });
  const longest = dayLengths.length ? Math.max(...dayLengths) : 0;
  // 8時間までは普通の観光。12時間を超えると、翌日に確実に残ります。
  // 「宿を出てから宿に戻るまで」で数えているので、移動も入っています。
  const dayScore = falloff(longest, 8 * HOUR, 12 * HOUR);

  // 2. 続けて歩く時間（座れば切れます）
  let run = 0, longestWalk = 0, totalWalk = 0;
  for (const i of all) {
    if (i.kind === "transit" && i.walk) {
      const m = minutesOf(i);
      run += m;
      totalWalk += m;
      longestWalk = Math.max(longestWalk, run);
    } else if (i.kind === "spot" || i.kind === "meal") {
      run = 0;   // 座れば休めます
    }
  }
  // 25分までは移動のうち。90分続けて歩くのは登山です。
  const walkScore = falloff(longestWalk, 25, 90);

  // 3. その日に歩く合計。1回が短くても、積もれば効きます。
  const walkPerDay = days.length ? totalWalk / days.length : totalWalk;
  const totalWalkScore = falloff(walkPerDay, 60, 240);

  // 4. 休まず続ける見学
  const noBreak = longestSightRun(days);
  const breakScore = falloff(noBreak, 3, 7);

  // 5. 朝の早さ
  const starts = days.map((d) => (d?.items ?? [])[0]?.start)
    .filter(Boolean).map((x) => x.getHours() + x.getMinutes() / 60);
  const earliest = starts.length ? Math.min(...starts) : 9;
  // 8時までは普通。6時より前は、それだけで一日ぶん削ります。
  const earlyScore = falloff(8 - earliest, 0, 2);

  const score = Math.round(dayScore * 0.3 + walkScore * 0.2
    + totalWalkScore * 0.2 + breakScore * 0.2 + earlyScore * 0.1);

  const notes = [];
  if (longest) notes.push(`いちばん長い1日は ${fmtMin(longest)}`);
  if (longestWalk >= 25) notes.push(`続けて歩くのは最長 ${longestWalk}分`);
  if (walkPerDay >= 90) notes.push(`1日あたり徒歩 ${Math.round(walkPerDay)}分`);
  if (noBreak >= 4) notes.push(`休憩をはさまず ${noBreak}か所続きます`);
  if (earliest < 7) {
    notes.push(`${Math.floor(earliest)}時台の出発があります`);
  }
  return {
    key: "fatigue", label: "疲れにくさ", weight: WEIGHTS.fatigue, score,
    note: notes.join("・") || "無理のない長さです",
  };
}

/** 食事や自由時間をはさまずに、見学が何か所続くか。 */
function longestSightRun(days) {
  let best = 0;
  for (const day of days) {
    let len = 0;
    for (const item of day?.items ?? []) {
      if (item.kind === "spot") { len++; best = Math.max(best, len); }
      else if (item.kind === "meal" || item.kind === "free"
               || item.kind === "lodging") len = 0;
    }
  }
  return best;
}

// --- 日ごとのばらつき -------------------------------------------------------

/**
 * 旅のリズム。二つのことを見ます。
 *
 *   1. 日ごとの偏り  … 1日目に全部、最終日は何も無い、を避ける
 *   2. 同じ種類の連続 … 寺 → 寺 → 寺 → 寺 を避ける
 *
 * 2番目が大事です。時間的には成立していても、同じものが4件続く旅程は
 * 人にとってつらい。寺 → 商店街 → 昼食 → 海 → 展望台 のほうが、
 * 同じ5か所でも旅として持ちます。
 */
function rhythmPart(days) {
  const counts = days.map((d) =>
    (d?.items ?? []).filter((i) => i.kind === "spot").length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) {
    return { key: "rhythm", label: "旅のリズム", weight: WEIGHTS.rhythm,
             score: 0, note: "立ち寄り先がありません" };
  }

  // 1. 日ごとの偏り
  let spreadScore = 100;
  let spreadNote = "日帰りのため、日ごとの偏りはありません";
  if (days.length > 1) {
    const mean = total / counts.length;
    const sd = Math.sqrt(
      counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length);
    // ばらつきが平均の 15% までは気になりません。80% を超えると
    // 「1日目に全部、最終日は何も無い」旅程です。
    spreadScore = falloff(sd / mean, 0.15, 0.8);
    const empty = counts.filter((c) => c === 0).length;
    spreadNote = empty
      ? `${empty}日ぶん、立ち寄り先がありません（${counts.join("・")}か所）`
      : `日ごとの立ち寄りは ${counts.join("・")}か所`;
  }

  // 2. 同じ種類の連続。食事をはさめば切れます（そこで休めるので）。
  const run = longestGenreRun(days);
  // 2件続きは普通。4件続くと「また寺か」になります。
  const varietyScore = falloff(run.length, 2, 5);

  const score = Math.round(spreadScore * 0.45 + varietyScore * 0.55);
  const notes = [spreadNote];
  if (run.length >= 3) {
    notes.push(`${run.label}が${run.length}件続きます`);
  }
  return {
    key: "rhythm", label: "旅のリズム", weight: WEIGHTS.rhythm, score,
    note: notes.join("・"),
  };
}

const GENRE_LABEL = {
  onsen: "温泉", nature: "自然", history: "歴史・寺社", food: "食",
  art: "アート", sea: "海・湖", city: "街", view: "眺め",
};

/**
 * 同じ種類が何件続くか、いちばん長いところ。
 * 食事は区切りとして数えます（座って休めるためです）。
 */
function longestGenreRun(days) {
  let best = { length: 0, genre: null };
  for (const day of days) {
    let cur = null, len = 0;
    for (const item of day?.items ?? []) {
      if (item.kind === "meal" || item.kind === "lodging") { cur = null; len = 0; continue; }
      if (item.kind !== "spot") continue;
      const g = (item.place?.genres ?? [])[0] ?? item.place?.category ?? "?";
      if (g === cur) len++;
      else { cur = g; len = 1; }
      if (len > best.length) best = { length: len, genre: g };
    }
  }
  return { ...best, label: GENRE_LABEL[best.genre] ?? best.genre ?? "同じ種類" };
}

// --- 満足度 -----------------------------------------------------------------

function joyPart(spots, interests) {
  if (!spots.length) {
    return { key: "joy", label: "希望との合い方", weight: WEIGHTS.joy,
             score: 0, note: "立ち寄り先がありません" };
  }

  // 1. 希望したジャンルのうち、いくつが旅程に入っているか
  let coverScore = 100;
  let covered = [];
  if (interests.length) {
    const have = new Set(spots.flatMap((s) => s.place?.genres ?? []));
    covered = interests.filter((g) => have.has(g));
    coverScore = Math.round((covered.length / interests.length) * 100);
  }

  // 2. 定番と穴場が混ざっているか。
  //    定番だけの旅程は退屈で、穴場だけの旅程は「何しに来たのか」になります。
  const tiers = new Set(spots.map((s) => s.place?.fame_tier).filter(Boolean));
  const mixScore = tiers.size >= 3 ? 100 : tiers.size === 2 ? 75 : 45;

  const score = Math.round(coverScore * 0.65 + mixScore * 0.35);
  const notes = [];
  if (interests.length) {
    notes.push(`希望した ${interests.length}件のうち ${covered.length}件に対応`);
  }
  notes.push(tiers.size >= 2
    ? `定番と穴場が ${tiers.size}層まざっています`
    : "似た知名度の場所ばかりです");
  return { key: "joy", label: "希望との合い方", weight: WEIGHTS.joy, score,
           note: notes.join("・") };
}

// --- 言葉にする -------------------------------------------------------------

function fmtMin(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h ? `${h}時間${mm ? `${mm}分` : ""}` : `${mm}分`;
}

const GRADES = [
  [85, "無理がなく、よく均せています"],
  [70, "おおむね無理のない旅程です"],
  [55, "回れますが、少し詰まっています"],
  [40, "やや無理があります"],
  [0, "このままでは負担が大きい旅程です"],
];

function summarize(total, parts, weakest) {
  const grade = GRADES.find(([n]) => total >= n)[1];
  const best = parts.slice().sort((a, b) => b.score - a.score)[0];
  return `${grade}（${total}点）。`
    + `いちばん良いのは「${best.label}」、`
    + `気になるのは「${weakest.label}」です — ${weakest.note}。`;
}

/**
 * 案がいくつかあるとき、どれを採るかを決めます。
 *
 * これまでは「立ち寄りの多いほう」で選んでいました。その基準だと、
 * 30分の見学と90分の移動を繰り返す詰め込み案が、ゆったり2か所を回る案に
 * 勝ちます。回れる数ではなく、無理のなさで選びます。
 *
 * 同点なら立ち寄りの多いほうを採ります（せっかく行くので）。
 * それも同じなら、渡された順を保ちます（並べ替えで結果が揺れないように）。
 *
 * @param {Array<{key:string, itin:object}>} options
 * @param {object} [opts] scoreItinerary に渡します
 * @returns {{key:string, itin:object, score:number, ranked:Array}|null}
 */
export function pickBest(options, opts = {}) {
  if (!Array.isArray(options) || !options.length) return null;
  const ranked = options.map((o, i) => {
    const detail = scoreItinerary(o.itin, opts);
    const spots = (o.itin?.days ?? [])
      .flatMap((d) => d?.items ?? [])
      .filter((x) => x.kind === "spot").length;
    return { ...o, score: detail.total, detail, spots, order: i };
  }).sort((a, b) =>
    b.score - a.score || b.spots - a.spots || a.order - b.order);
  return { ...ranked[0], ranked };
}

// --- 帰りの余裕 -------------------------------------------------------------
//
// 「旅程が成立している」と「安心して行ける」は別です。
// 12分しか余裕がない旅程は、成立してはいますが、電車が1本遅れたら
// 帰れません。成立の可否だけでなく、どれくらい耐えられるかを出します。

const SLACK_LEVELS = [
  [90, "safe", "安心",
   "少し道に迷っても、写真を撮りすぎても対応できます。"],
  [30, "tight", "やや注意",
   "電車が遅れると、どこかを削る必要が出るかもしれません。"],
  [0, "risky", "危険",
   "1本遅れると帰着の期限を超える可能性があります。"],
];

/**
 * 帰りの余裕（分）を、3段階の言葉にします。
 * 分からないときは段階を作りません（それらしい安心を出さないため）。
 */
export function slackLevel(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { level: "unknown", label: "—", minutes: null,
             text: "帰りの余裕は計算できていません。" };
  }
  const [, level, label, text] = SLACK_LEVELS.find(([n]) => minutes >= n);
  return { level, label, minutes: Math.round(minutes), text };
}

// --- 旅のペース -------------------------------------------------------------

/**
 * 何にどれだけ時間を使うのか。
 *
 * 「この旅、結局忙しいの？」に一目で答えるための内訳です。
 * 点をひとつ出すより、移動2時間35分・観光5時間10分と並べたほうが、
 * 自分にとって忙しいかどうかを判断できます。
 */
export function paceBreakdown(itin) {
  const all = (itin?.days ?? []).flatMap((d) => d?.items ?? []);
  const sum = (pred) => all.filter(pred)
    .reduce((a, i) => a + minutesOf(i), 0);

  const sightMin = sum((i) => i.kind === "spot");
  const moveMin = sum((i) => i.kind === "transit");
  const mealMin = sum((i) => i.kind === "meal");
  const freeMin = sum((i) => i.kind === "free");
  const walkKm = all
    .filter((i) => i.kind === "transit" && i.walk)
    .reduce((a, i) => a + (Number.isFinite(i.km) ? i.km : 0), 0);

  const rows = [
    { key: "sight", label: "観光", minutes: sightMin },
    { key: "move", label: "移動", minutes: moveMin },
    { key: "meal", label: "食事", minutes: mealMin },
    { key: "free", label: "自由時間", minutes: freeMin },
  ].filter((r) => r.minutes > 0);

  const total = rows.reduce((a, r) => a + r.minutes, 0) || 1;
  for (const r of rows) r.share = Math.round((r.minutes / total) * 100);

  return { sightMin, moveMin, mealMin, freeMin,
           walkKm: Math.round(walkKm * 10) / 10, rows, totalMin: total };
}
