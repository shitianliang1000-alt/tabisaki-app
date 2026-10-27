// 「もっとゆっくりしたい」で旅程を直す。
//
// ここでのいちばん大事な決めごとは、**AIに旅程を作り直させない**ことです。
//
//   AIがやること   … 言われたことを「条件の書き換え」に翻訳する
//   プログラムがやること … その条件でもう一度組み直す
//
// AIに新しい旅程を自由に作らせると、営業時間も移動時間も無視した、
// もっともらしいだけの旅程が返ってきます。せっかく verify.js で
// 実時刻を突き合わせているのに、その外側で崩されては意味がありません。
//
// だからここが返すのは、旅程ではなく**パッチ**です。
// 中身は「ペースを変える」「1泊増やす」「この場所を外す」といった、
// 既存の条件（trip）に対する差分だけです。
//
// AIキーが無くても動きます。日本語の言い回しから読み取れるぶんは、
// こちらで読み取ります（`parseEditLocally`）。

import { extractJson } from "../packages/core/src/ai.js";

/** パッチの初期値。ここに無いキーは、あとで捨てます。 */
function emptyPatch() {
  return {
    pace: null,            // "relaxed" | "balanced" | "packed"
    hiddenBias: null,      // 0〜1。大きいほど穴場寄り
    addNights: 0,          // 泊数を増やす
    extendMinutes: 0,      // 到着期限を後ろへ
    startEarlierMinutes: 0,
    remove: [],            // 外すスポットID
    // そのうち「件数ごと減らす」ぶん。差し替えなら空のままです。
    removeCount: [],
    spotCap: null,         // 立ち寄りの数の上限（null なら変えない）
    keep: [],              // 必ず行くスポットID
    addInterests: [],
    dropInterests: [],
    moreRest: false,
    note: "",              // 次の検索に足す言葉
    unresolved: [],        // 名前は出たが、旅程に無かったもの
    fromModel: false,
    empty: true,
  };
}

const PACES = new Set(["relaxed", "balanced", "packed"]);

/** 旅程に入っているスポットの一覧（id と名前）。 */
function spotsOf(itin) {
  return (itin?.days ?? [])
    .flatMap((d) => d?.items ?? [])
    .filter((i) => i.kind === "spot" && (i.spotId ?? i.place?.id))
    .map((i) => ({
      id: i.spotId ?? i.place.id,
      name: i.place?.name ?? i.title ?? "",
      genres: i.place?.genres ?? [],
      category: i.place?.category ?? "",
    }));
}

// --- 言い回しから読み取る ---------------------------------------------------
//
// 完璧に読み取ることは目指していません。読み取れなかったら「読み取れません
// でした」と言うほうが、勝手に解釈して旅程を変えるより安全です。

const PACE_WORDS = [
  [/(ゆっくり|のんびり|まったり|ゆったり|急がな|余裕)/, "relaxed"],
  [/(詰め|たくさん回|もっと回|いっぱい回|効率|びっしり|多め に?回)/, "packed"],
];

const GENRE_WORDS = {
  onsen: /(温泉|湯|銭湯)/,
  nature: /(自然|森|山|滝|渓谷|高原|公園)/,
  history: /(歴史|寺|神社|城|史跡|古い)/,
  food: /(食|グルメ|市場|商店街|酒)/,
  art: /(美術|アート|博物|建築)/,
  sea: /(海|浜|島|水族)/,
  city: /(街|まち|ショッピング|買い物)/,
  view: /(絶景|景色|眺め|展望|夜景)/,
};

/** 「増やして」なのか「減らして」なのかを、語の近くから判断します。 */
const MORE = /(増や|多く|もっと|たくさん|入れて|足して|追加)/;
const LESS = /(減ら|少なく|外し|抜い|いらな|要らな|なくし|やめ)/;

export function parseEditLocally(text, itin) {
  const s = String(text ?? "");
  const p = emptyPatch();
  if (!s.trim()) return p;

  // ペース
  for (const [re, pace] of PACE_WORDS) {
    if (re.test(s)) { p.pace = pace; break; }
  }

  // 泊数。「もう1泊」「2泊増やして」。
  // 「3泊4日のまま」のような言い直しは、増やす指示ではありません。
  const nights = /(?:もう|あと|さらに)?\s*([0-9０-９一二三四五六七八九十]+)\s*泊/
    .exec(s);
  if (nights && MORE.test(s) && !/のまま|でいい|で十分/.test(s)) {
    p.addNights = Math.min(14, toNumber(nights[1]));
  }

  // 時間を延ばす
  const mins = /([0-9０-９]+)\s*(分|時間)\s*(?:ほど|くらい|ぐらい)?\s*(延ば|遅く|長く)/
    .exec(s);
  if (mins) {
    const n = toNumber(mins[1]);
    p.extendMinutes = Math.min(600, mins[2] === "時間" ? n * 60 : n);
  }

  // 穴場と定番
  if (/(穴場|知る人ぞ知る|人が少な|静か|マイナー)/.test(s)) p.hiddenBias = 0.8;
  if (/(定番|有名|王道|ベタ|外せない)/.test(s) && !/穴場/.test(s)) {
    p.hiddenBias = 0.2;
  }

  // 休憩
  if (/(休憩|休み|カフェ|ひと息|座|疲れ)/.test(s) && !LESS.test(s)) {
    p.moreRest = true;
  }

  // ここから先は、文を句で切ってから見ます。
  //
  // 「松山城は外して、温泉をもっと増やして」を一続きの文として扱うと、
  // 「温泉」の近くに「外して」があるせいで、温泉まで減らす指示に
  // 読めてしまいます。人は句で区切って書くので、こちらも句で切ります。
  const clauses = s.split(/[、。，,．.\n]+/).filter((x) => x.trim());
  const spots = spotsOf(itin);

  for (const clause of clauses) {
    // その句に出てくる場所の名前。見つけた名前は、ジャンル判定から
    // 隠します。「道後温泉本館は外して」は、その1か所を外す指示で
    // あって「温泉を減らして」ではありません。
    let rest = clause;
    for (const spot of spots) {
      if (!spot.name || !clause.includes(spot.name)) continue;
      rest = rest.split(spot.name).join("　");
      const at = clause.indexOf(spot.name) + spot.name.length;
      const after = clause.slice(at, at + 24);
      if (LESS.test(after)) push(p.remove, spot.id);
      else if (/(行きたい|外さな|残し|必ず|絶対|はずさ)/.test(after)) {
        push(p.keep, spot.id);
      }
    }

    // 旅程に無い固有名詞らしきもの。勝手に消したり足したりせず、
    // 「読み取れませんでした」として返します。
    for (const m of rest.matchAll(
        /[一-龥ァ-ヶー]{2,12}(?=は?\s*(?:外|抜|やめ|いらな))/g)) {
      const word = m[0];
      if (spots.some((x) => x.name.includes(word) || word.includes(x.name))) continue;
      push(p.unresolved, word);
    }

    // 興味の増減。句のなかで、増やすのか減らすのかを決めます。
    for (const [genre, re] of Object.entries(GENRE_WORDS)) {
      if (!re.test(rest)) continue;
      if (LESS.test(rest)) push(p.dropInterests, genre);
      else if (MORE.test(rest)) push(p.addInterests, genre);
    }
  }

  p.empty = isEmpty(p);
  return p;
}

/** 同じものを二度入れない。 */
function push(list, value) {
  if (!list.includes(value)) list.push(value);
}

function isEmpty(p) {
  return !p.pace && p.hiddenBias === null && !p.addNights && !p.extendMinutes
    && !p.startEarlierMinutes && !p.remove.length && !p.keep.length
    && !p.addInterests.length && !p.dropInterests.length && !p.moreRest
    && !p.note;
}

const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7,
                    八: 8, 九: 9, 十: 10 };

function toNumber(raw) {
  const s = String(raw).replace(/[０-９]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const n = parseInt(s, 10);
  if (Number.isFinite(n)) return n;
  return KANJI_NUM[s] ?? 0;
}

// --- AIに翻訳させる ---------------------------------------------------------

const SHAPE = `{
  "pace": "relaxed | balanced | packed のいずれか、変えないなら null",
  "hiddenBias": 0.0〜1.0（大きいほど穴場寄り）、変えないなら null,
  "addNights": 0,
  "extendMinutes": 0,
  "remove": ["外すスポットのid"],
  "keep": ["必ず行くスポットのid"],
  "addInterests": ["onsen","nature","history","food","art","sea","city","view"],
  "dropInterests": [],
  "moreRest": false,
  "note": "旅程づくりに足したい希望があれば一文で"
}`;

function buildPrompt(text, itin) {
  const list = spotsOf(itin)
    .map((s) => `  id=${s.id} 「${s.name}」(${s.category})`).join("\n");
  return [
    "いまの旅程に対して、利用者から次の要望が来ました。",
    `「${text}」`,
    "",
    "これを、旅程づくりの条件の**書き換え**に翻訳してください。",
    "旅程そのものを作ってはいけません。条件だけを返してください。",
    "",
    "いまの旅程に入っている場所:",
    list || "  （なし）",
    "",
    "決まりごと:",
    "・remove / keep には、上の一覧にある id だけを書くこと。",
    "・要望に書かれていないことは変えないこと（null や 0 のままにする）。",
    "・addNights は増やす泊数。減らす場合は負の数。",
    "・確信が持てないものは、無理に埋めないこと。",
    "",
    "次の形の JSON だけを返してください。",
    SHAPE,
  ].join("\n");
}

/**
 * 要望をパッチにします。
 *
 * AIが使えればAIに、使えなければ言い回しの読み取りに落ちます。
 * どちらの場合も、返ってきたものは必ず検証してから使います。
 *
 * @param {string} text 利用者の要望
 * @param {object} itin いまの旅程
 * @param {{call?:Function, signal?:AbortSignal}} [opts]
 * @returns {Promise<object>} パッチ
 */
export async function parseEdit(text, itin, opts = {}) {
  const local = parseEditLocally(text, itin);
  if (!opts.call) return local;

  try {
    const raw = await opts.call(buildPrompt(text, itin),
                                { temperature: 0.1, signal: opts.signal });
    const doc = extractJson(raw);
    const patch = validatePatch(doc, itin);
    patch.fromModel = true;
    // AIが何も読み取れなかったときは、言い回しの読み取りを使います。
    // 両方空なら、空のまま返します（勝手に動かさないため）。
    if (patch.empty && !local.empty) return local;
    patch.unresolved = local.unresolved;
    return patch;
  } catch {
    // 壊れたJSON、通信の失敗、キー未設定。どれも「読めなかった」だけです。
    return local;
  }
}

/**
 * AIが返したものを、使える形に絞り込みます。
 *
 * ここを緩くすると、存在しないスポットIDが「必ず行く場所」に入り、
 * 旅程が組めなくなります。知らないものは黙って落とします。
 */
export function validatePatch(doc, itin) {
  const p = emptyPatch();
  const known = new Set(spotsOf(itin).map((s) => s.id));
  const genres = new Set(Object.keys(GENRE_WORDS));

  if (PACES.has(doc?.pace)) p.pace = doc.pace;
  if (Number.isFinite(doc?.hiddenBias)) {
    p.hiddenBias = Math.max(0, Math.min(1, doc.hiddenBias));
  }
  if (Number.isFinite(doc?.addNights)) {
    p.addNights = Math.max(-14, Math.min(14, Math.round(doc.addNights)));
  }
  if (Number.isFinite(doc?.extendMinutes)) {
    p.extendMinutes = Math.max(-600, Math.min(600, Math.round(doc.extendMinutes)));
  }
  if (Number.isFinite(doc?.startEarlierMinutes)) {
    p.startEarlierMinutes =
      Math.max(0, Math.min(600, Math.round(doc.startEarlierMinutes)));
  }
  p.remove = asArray(doc?.remove).filter((id) => known.has(id));
  p.keep = asArray(doc?.keep).filter((id) => known.has(id));
  p.addInterests = asArray(doc?.addInterests).filter((g) => genres.has(g));
  p.dropInterests = asArray(doc?.dropInterests).filter((g) => genres.has(g));
  p.moreRest = doc?.moreRest === true;
  p.note = String(doc?.note ?? "").slice(0, 120);
  p.empty = isEmpty(p);
  return p;
}

function asArray(v) {
  return (Array.isArray(v) ? v : []).map((x) => String(x)).slice(0, 20);
}

// --- パッチを条件に当てる ---------------------------------------------------

/**
 * パッチを当てた、新しい条件を返します。元の条件は書き換えません。
 *
 * 組み立てはこのあと pipeline.js が行います。ここは条件をいじるだけです。
 *
 * @param {object} patch
 * @param {object} trip makeTrip の結果
 * @returns {object} 新しい trip
 */
export function applyEdit(patch, trip) {
  const p = { ...emptyPatch(), ...(patch ?? {}) };
  const next = {
    ...trip,
    must: {
      ...trip.must,
      spotIds: [...(trip.must?.spotIds ?? [])],
      avoidSpotIds: [...(trip.must?.avoidSpotIds ?? [])],
      removedSpotIds: [...(trip.must?.removedSpotIds ?? [])],
      spotCap: trip.must?.spotCap ?? null,
    },
    interests: [...(trip.interests ?? [])],
  };

  if (p.pace) { next.pace = p.pace; next.paceChosen = true; }
  if (p.moreRest) { next.pace = "relaxed"; next.paceChosen = true; }
  if (p.hiddenBias !== null) next.hiddenBias = p.hiddenBias;

  if (p.addNights) {
    next.arriveBy = new Date(trip.arriveBy.getTime() + p.addNights * 86400000);
  }
  if (p.extendMinutes) {
    next.arriveBy = new Date(next.arriveBy.getTime() + p.extendMinutes * 60000);
  }
  if (p.startEarlierMinutes) {
    next.departAt = new Date(trip.departAt.getTime()
      - p.startEarlierMinutes * 60000);
  }

  // 「外す」と「必ず行く」が同じ場所に来たら、行くほうを優先します。
  // 消すほうを優先すると、行きたいと言った場所が二度と出てきません。
  const keep = new Set(p.keep);
  for (const id of keep) {
    if (!next.must.spotIds.includes(id)) next.must.spotIds.push(id);
  }
  next.must.avoidSpotIds = [
    ...new Set([...next.must.avoidSpotIds, ...p.remove]),
  ].filter((id) => !keep.has(id));
  next.must.spotIds = next.must.spotIds.filter(
    (id) => !next.must.avoidSpotIds.includes(id));
  // 外したままの記録だけを残します。「必ず行く」に拾い直された場所を
  // 残すと、戻したはずの場所が「外した場所」の一覧に居座ります。
  next.must.removedSpotIds = [
    ...new Set([...next.must.removedSpotIds, ...p.removeCount]),
  ].filter((id) => next.must.avoidSpotIds.includes(id));
  if (Number.isFinite(p.spotCap)) {
    next.must.spotCap = Math.max(1, Math.round(p.spotCap));
  }
  // 外したものがひとつも残っていないなら、上限も外します。
  // 上限だけ残ると、戻したのに件数が戻りません。
  if (!next.must.removedSpotIds.length) next.must.spotCap = null;

  next.interests = [
    ...new Set([...next.interests, ...p.addInterests]),
  ].filter((g) => !p.dropInterests.includes(g));

  if (p.note) next.note = `${trip.note}\n${p.note}`.trim();
  return next;
}

// --- 何をしたかを言葉にする -------------------------------------------------

const PACE_TEXT = { relaxed: "ゆっくり回る", balanced: "ふつうの速さで回る",
                    packed: "多めに回る" };

/**
 * どう解釈したかを日本語で返します。
 * 黙って条件を書き換えると、思ったのと違う旅程が出たときに
 * 何が起きたのか分かりません。
 */
export function describeEdit(patch, itin) {
  const p = { ...emptyPatch(), ...(patch ?? {}) };
  const nameOf = new Map(spotsOf(itin).map((s) => [s.id, s.name]));
  const parts = [];

  if (p.pace) parts.push(PACE_TEXT[p.pace]);
  if (p.moreRest && !p.pace) parts.push("休憩を増やす");
  if (p.hiddenBias !== null) {
    parts.push(p.hiddenBias > 0.5 ? "穴場を多めにする" : "定番を中心にする");
  }
  if (p.addNights > 0) parts.push(`${p.addNights}泊増やす`);
  if (p.addNights < 0) parts.push(`${-p.addNights}泊減らす`);
  if (p.extendMinutes > 0) parts.push(`到着を${p.extendMinutes}分遅くする`);
  if (p.remove.length) {
    parts.push(`${p.remove.map((id) => nameOf.get(id) ?? id).join("・")}を外す`);
  }
  if (p.keep.length) {
    parts.push(`${p.keep.map((id) => nameOf.get(id) ?? id).join("・")}は必ず入れる`);
  }
  if (p.addInterests.length) {
    parts.push(`${p.addInterests.map(genreLabel).join("・")}を増やす`);
  }
  if (p.dropInterests.length) {
    parts.push(`${p.dropInterests.map(genreLabel).join("・")}を減らす`);
  }

  if (!parts.length) {
    const extra = p.unresolved.length
      ? `（「${p.unresolved.join("」「")}」は、いまの旅程に見つかりませんでした）`
      : "";
    return `ご要望を読み取れませんでした${extra}。`
      + "「もっとゆっくり」「もう1泊増やして」「◯◯は外して」のように"
      + "書いていただけると、条件を書き換えて組み直します。";
  }

  const tail = p.unresolved.length
    ? `　なお「${p.unresolved.join("」「")}」は、いまの旅程に見つかりませんでした。`
    : "";
  return `${parts.join("、")}——として組み直します。${tail}`;
}

const GENRE_LABEL = {
  onsen: "温泉", nature: "自然", history: "歴史・寺社", food: "グルメ",
  art: "アート", sea: "海・湖", city: "街歩き", view: "絶景",
};

function genreLabel(g) { return GENRE_LABEL[g] ?? g; }
