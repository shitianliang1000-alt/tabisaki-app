// 旅の目的（デート・アクティブ・のんびり・子どもと・学び）。
//
// 同じ「箱根」でも、デートで行くのと、体を動かしに行くのとでは、
// 回りたい場所がまるで違います。デートなら芦ノ湖の遊覧船と美術館と
// 夕方の眺め、アクティブなら金時山とハイキングです。
//
// これまでの旅程は、興味（温泉・自然・歴史…）しか聞いていませんでした。
// 興味は「何が見たいか」で、目的は「どう過ごしたいか」です。
// 「デートで」と書いても、どこにも効いていませんでした（「デート」を
// 名前や説明に含む場所を探しに行き、ほとんど何にも当たりません）。
//
// ここで決めるのは、**選ぶときの重み**だけです（js/kb.js）。
// 外しはしません。デートで寺に行く人も、子連れで山に登る人もいます。
// 同じくらいの点なら目的に合うほうを先に、というだけです
// （js/access.js の同行者と同じ考えかたです）。
//
// 分類（category）と、名前・説明の語から見ます。収録に「デート向き」
// という印はないので、言えるのは「そういう場所が多い」までです。

/**
 * 目的ごとの決まり。
 *
 *   re      … 希望文にこう書いてあれば、この目的として読みます
 *   genres  … エリアを選ぶときに、合う性格（rankRegions の wantedGenres）
 *   good    … 前に出す分類
 *   goodText… 名前・説明にあれば前に出す語
 *   bad     … 後ろへ回す分類
 *   badText … 名前・説明にあれば後ろへ回す語
 *   pace    … ペースを選んでいないときの組みかた
 *   note    … 旅程に添える一言（何をしたかを、読む人に見せる）
 */
export const PURPOSES = [
  {
    id: "date", label: "デート",
    re: /デート|カップル|恋人|彼女と|彼氏と|記念日|ロマンチック|ロマンティック|ふたりの思い出/,
    genres: ["view", "art", "sea"],
    good: ["展望台", "庭園", "美術館", "水族館", "灯台", "岬", "海岸", "湖", "教会",
           "町並み", "建築", "ロープウェイ", "遊園地", "テーマパーク", "名勝"],
    goodText: /夜景|イルミネーション|夕日|夕陽|サンセット|カフェ|縁結び|恋人の聖地|遊覧|ライトアップ|眺め|絶景/,
    bad: ["ダム", "登山", "スキー場", "道の駅", "漁港", "市場"],
    badText: /横穴|古墳|墓|トンネル|処理場|資料館|準用河川/,
    pace: "relaxed",
    note: "デート向けに、眺めのいい場所・庭園・美術館・水辺を前に出し、"
      + "移動を詰めすぎないようにしています",
  },
  {
    id: "active", label: "アクティブ",
    re: /アクティブ|体を動か|身体を動か|からだを動か|アウトドア|アクティビティ|ハイキング|トレッキング|登山|山登り|カヤック|カヌー|ラフティング|SUP|サップ|アスレチック|スポーツ|思いっきり遊|思い切り遊|汗を?かき/i,
    genres: ["nature"],
    good: ["山", "登山", "渓谷", "滝", "高原", "島", "スキー場", "海水浴場", "海岸",
           "遊園地", "テーマパーク", "ロープウェイ", "牧場", "自然", "国立公園",
           "国定公園", "峠", "湿原"],
    goodText: /ハイキング|トレッキング|遊歩道|登山道|カヌー|カヤック|ラフティング|アスレチック|ジップ|サイクリング|体験|散策路|自然歩道/,
    bad: ["博物館", "美術館", "酒蔵", "商店街", "建築"],
    badText: /資料館|記念館|文学館/,
    pace: "packed",
    note: "体を動かしたい旅として、山・渓谷・滝・高原・体験のできる場所を"
      + "前に出し、1日に回る場所を多めにしています",
  },
  {
    id: "relax", label: "のんびり",
    re: /のんびり|まったり|癒し|癒され|リラックス|ほっと|疲れを取|休みたい|静かに過ご|何もしない/,
    genres: ["onsen"],
    good: ["温泉", "庭園", "湖", "海岸", "高原", "公園", "名勝"],
    goodText: /足湯|露天|日帰り入浴|静か|カフェ|散策|ほとり|湖畔/,
    bad: ["テーマパーク", "遊園地", "登山", "スキー場", "商店街", "峠"],
    badText: /登山道|急な|岩場/,
    pace: "relaxed",
    note: "のんびり過ごす旅として、温泉・庭園・水辺を前に出し、"
      + "1日に回る場所を少なめにしています",
  },
  {
    id: "kids", label: "子どもと",
    re: /子ども|子供|こども|子連れ|キッズ|ファミリー|家族旅行|家族で|息子|娘と|孫/,
    genres: ["sea", "nature"],
    good: ["動物園", "水族館", "遊園地", "テーマパーク", "牧場", "公園", "乗り物",
           "ロープウェイ", "海水浴場"],
    goodText: /科学館|体験|子ども|こども|アスレチック|遊具|ふれあい|動物/,
    bad: ["酒蔵", "登山", "史跡", "ダム", "峠"],
    badText: /横穴|古墳|墓|資料館|文学館/,
    pace: null,
    note: "子ども連れの旅として、動物園・水族館・公園・体験のできる場所を"
      + "前に出しています",
  },
  {
    id: "learn", label: "学び",
    re: /学び|学べる|勉強|社会科見学|知的|教養|自由研究|大人の遠足|歴史を(?:知|学)|文化に触れ/,
    genres: ["history", "art"],
    good: ["博物館", "美術館", "史跡", "城", "寺院", "神社", "建築", "町並み",
           "文化施設", "天然記念物"],
    goodText: /世界遺産|国宝|重要文化財|記念館|資料館|科学館|見学/,
    bad: ["遊園地", "テーマパーク", "スキー場", "海水浴場"],
    badText: null,
    pace: null,
    note: "学びの旅として、博物館・史跡・城・寺社を前に出しています",
  },
];

const BY_ID = new Map(PURPOSES.map((p) => [p.id, p]));

/** 正しい id だけを、重なりなく返します。 */
export function normalizePurposes(ids) {
  return (Array.isArray(ids) ? ids : [])
    .filter((id, i, a) => BY_ID.has(id) && a.indexOf(id) === i);
}

/** 希望文から読める目的。 */
export function readPurposes(text) {
  const s = String(text ?? "").normalize("NFKC");
  if (!s.trim()) return [];
  return PURPOSES.filter((p) => p.re.test(s)).map((p) => p.id);
}

/** 目的の名前（読み取った札・注意書きに使います）。 */
export function purposeLabel(id) {
  return BY_ID.get(id)?.label ?? "";
}

/**
 * その場所が、目的に合うか（0〜1。0.5 がどちらでもない）。
 *
 * 目的が複数なら平均です（デートでアクティブに、は両方を見ます）。
 * **0 にはしません。** 0 にすると、山のエリアでデートの候補が全部
 * 消えます。
 */
export function purposeAppeal(spot, purposes) {
  const list = normalizePurposes(purposes).map((id) => BY_ID.get(id));
  if (!list.length) return 0.5;
  const text = `${spot?.name ?? ""} ${spot?.description ?? ""}`;
  const cat = spot?.category ?? "";
  let sum = 0;
  for (const p of list) {
    let v = 0.5;
    if (p.good.includes(cat)) v += 0.3;
    if (p.goodText?.test(text)) v += 0.2;
    if (p.bad.includes(cat)) v -= 0.3;
    if (p.badText?.test(text)) v -= 0.3;
    sum += Math.min(1, Math.max(0.05, v));
  }
  return sum / list.length;
}

/** エリアを選ぶときに合う性格（温泉・自然…）。 */
export function purposeGenres(purposes) {
  return [...new Set(normalizePurposes(purposes)
    .flatMap((id) => BY_ID.get(id).genres))];
}

/**
 * ペースを選んでいないときの組みかた。
 * のんびりとアクティブが両方あれば、どちらにも寄せません。
 */
export function purposePace(purposes) {
  const paces = new Set(normalizePurposes(purposes)
    .map((id) => BY_ID.get(id).pace).filter(Boolean));
  return paces.size === 1 ? [...paces][0] : null;
}

/** 旅程に添える一言。 */
export function purposeNotes(purposes) {
  return normalizePurposes(purposes).map((id) => `${BY_ID.get(id).note}。`);
}

/**
 * AIに渡す一言。旅程を選ぶモデルにも、目的を伝えます。
 * （希望文に「デート」とだけ書かれても、モデルは知っていますが、
 * こだわりの欄で選んだ目的は文に入っていません。）
 */
export function purposeHint(purposes) {
  const ids = normalizePurposes(purposes);
  if (!ids.length) return "";
  return `旅の目的: ${ids.map(purposeLabel).join("・")}`
    + "（この目的で過ごしやすい場所を優先してください）";
}

/**
 * 目的を言うだけの語。スポットを探す語には使いません
 * （「デート」を名前に含む場所はほとんどありません）。
 */
export function isPurposeWord(word) {
  const w = String(word ?? "").trim();
  if (!w) return false;
  return /^(デート|カップル|恋人|記念日|ロマンチック|ロマンティック|アクティブ|アウトドア|アクティビティ|スポーツ|のんびり|まったり|リラックス|癒し|子ども|子供|こども|子連れ|キッズ|ファミリー|家族|家族旅行|学び|勉強|教養|社会科見学|自由研究)$/.test(w);
}

/**
 * 目的の言い回しを文から消します（「デート向けにして」→「にして」）。
 * チャットで目的だけを言い直した返信を、条件の言い直しとして
 * 扱うためです（js/chatread.js の hasSubstance）。
 */
export function stripPurposeWords(text) {
  let s = String(text ?? "");
  for (const p of PURPOSES) {
    const flags = p.re.flags.includes("i") ? "gi" : "g";
    s = s.replace(new RegExp(`(?:${p.re.source})(?:向け|むけ|用|で|の旅行?|旅行?)?`, flags), " ");
  }
  return s;
}
