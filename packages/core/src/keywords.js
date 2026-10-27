// 日本語の希望文から、検索に使える語を取り出す。
//
// 空白で区切る方式は日本語では機能しません。「歴史ある街を歩きたい」は
// 句読点が無いので1語として扱われ、どのスポットにも一致しませんでした。
// （実際にこれで「候補なし」になる不具合が出ました。）
//
// 形態素解析器を積むほどではないので、旅行語彙の辞書に対する部分一致で
// 拾います。決定的で、辞書を見れば挙動が説明でき、APIキー無しでも動きます。

export const GENRE_TERMS = {
  onsen: ["温泉", "おんせん", "湯", "風呂", "露天", "スパ", "サウナ", "湯治"],
  nature: ["自然", "山", "森", "滝", "緑", "ハイキング", "登山", "高原", "渓谷",
           "紅葉", "花", "公園", "湿原", "星", "川", "散策"],
  history: ["寺", "神社", "歴史", "城", "古都", "世界遺産", "史跡", "仏", "神宮",
            "遺跡", "町並み", "レトロ", "文化", "伝統", "古い"],
  food: ["グルメ", "食べ", "たべ", "美味", "おいし", "海鮮", "寿司", "そば",
         "ラーメン", "スイーツ", "ランチ", "名物", "市場", "地酒", "café",
         "カフェ", "food"],
  art: ["美術", "アート", "建築", "博物館", "ミュージアム", "展示", "工芸", "陶芸"],
  sea: ["海", "湖", "ビーチ", "水族館", "浜", "岬", "島", "港", "船"],
  city: ["街", "まち", "散歩", "買い物", "ショッピング", "商店", "夜景",
         "都会", "路地"],
  view: ["絶景", "景色", "眺め", "展望", "富士", "パノラマ", "写真", "映え"],
};

/** 雰囲気を表す語。ジャンルではないが検索文に効く。 */
const MOOD_TERMS = [
  "静か", "のんびり", "ゆっくり", "まったり", "癒", "落ち着", "穴場",
  "人が少な", "混ま", "賑やか", "有名", "定番", "珍し", "変わった",
];

/**
 * それ自体では場所を指さない語。
 *
 * 「四国の有名な観光地を巡りたい」で「観光地」が検索語になると、
 * 名前に「観光地」を含むスポットは無いので、毎回「ご希望に合う場所が
 * 見つかりませんでした」と出ます。希望には応えているのに、です。
 */
export const GENERIC_TERMS = new Set([
  "観光", "観光地", "名所", "旅行", "旅程", "予定", "場所", "スポット",
  "有名", "人気", "定番", "おすすめ", "見どころ", "巡り", "周遊", "満喫",
  "気分", "感じ", "自分", "今回", "今年", "来年", "行きたい", "したい",
]);

/**
 * 希望文から検索語とジャンルを取り出します。
 * @returns {{keywords: string[], genres: string[], moods: string[]}}
 */
export function extractKeywords(note) {
  const text = String(note ?? "");
  const keywords = new Set();
  const genres = new Set();
  const moods = [];

  if (!text.trim()) return { keywords: [], genres: [], moods: [] };

  for (const [genre, terms] of Object.entries(GENRE_TERMS)) {
    for (const t of terms) {
      if (text.includes(t)) {
        genres.add(genre);
        keywords.add(t);
      }
    }
  }
  for (const m of MOOD_TERMS) {
    if (text.includes(m)) moods.push(m);
  }

  // 辞書に当たらなかったときの保険。語のまとまりを崩さないように、
  // カタカナ列・漢字列をそのまま取り出します。以前は2文字ずつ機械的に
  // 切っていたため、「スキューバダイビング」から「ーバ」が生まれ、
  // 「ハーバーランド」に誤って一致していました。
  //
  // 漢字はつながって書かれるので、場所を指さない語がくっついたまま
  // 1語になることがあります。「日本全国有名なところ」から「日本全国有名」
  // が取り出され、「『日本全国有名』に該当する場所は見つかりませんでした」
  // と出ていました。そうした語の所で切って、残りだけを使います。
  if (keywords.size === 0) {
    for (const run of wordRuns(text)) {
      for (const part of splitGeneric(run)) keywords.add(part);
    }
  }

  return { keywords: [...keywords], genres: [...genres], moods };
}

/** 語の中の「有名」「観光地」などで切り、2文字以上の残りを返します。 */
function splitGeneric(run) {
  if (GENERIC_TERMS.has(run)) return [];
  const terms = [...GENERIC_TERMS].sort((a, b) => b.length - a.length);
  let parts = [run];
  for (const t of terms) parts = parts.flatMap((p) => p.split(t));
  return parts.filter((p) => p.length >= 2 && !GENERIC_TERMS.has(p));
}

const PARTICLES = new Set([
  "を", "に", "は", "が", "の", "で", "と", "も", "や", "へ", "から", "まで",
  "たい", "ます", "です", "する", "した", "して", "いる", "ある", "こと",
]);

/**
 * 語のまとまりを取り出します。
 *   カタカナ列（3文字以上）  … 「スキューバダイビング」「ロープウェイ」
 *   漢字列（2文字以上）      … 「登山」「渓谷」
 *   英数字列（3文字以上）
 * 途中で切らないので、意味のない断片が検索語になりません。
 */
export function wordRuns(text) {
  const out = [];
  const patterns = [
    /[ァ-ヶー]{3,}/g,          // カタカナ
    /[一-鿿]{2,}/g,            // 漢字
    /[A-Za-z0-9]{3,}/g,        // 英数字
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const w = m[0];
      if (PARTICLES.has(w)) continue;
      out.push(w);
    }
  }
  return [...new Set(out)].slice(0, 10);
}

/**
 * 検索用の説明文。モデルが使えないときに searchText の代わりにします。
 */
export function buildSearchText(note, interests = []) {
  const { keywords, moods } = extractKeywords(note);
  const parts = [...keywords, ...moods, ...interests];
  return parts.length ? parts.join(" ") : "日帰りで楽しめる観光地";
}
