// スポットのタグ（1つの場所が持ついくつもの性格）。
//
// 分類（category）は1つしか持てません。清水寺は「寺院」ですが、紅葉の名所で、
// 世界遺産でもあります。タグはそれを並べて持つための印です。
//
// ルールで付けます（名前・分類・説明の語）。言えるのは「そう名乗っている・そう書いてある」
// までで、見頃の時期や営業の有無までは分かりません。
// tools/add_tags.mjs がこれで kb/ の tags を作り直し、tools/kb_check.mjs が
// TAGS に無いタグを誤りとして止めます。

/** タグの一覧（id → 日本語の名前）。足すときは RULES にも足します。 */
export const TAGS = {
  temple: "寺",
  shrine: "神社",
  museum: "博物館",
  art_museum: "美術館",
  onsen: "温泉",
  ski_resort: "スキー場",
  world_heritage: "世界遺産",
  autumn_foliage: "紅葉",
  cherry_blossom: "桜",
  flowers: "花の名所",
  night_view: "夜景",
  illumination: "ライトアップ",
  sunrise_sunset: "朝日・夕日",
  historical_street: "町並み",
  observatory: "展望台",
  dam: "ダム",
  island: "島",
  cave: "鍾乳洞",
  waterfall: "滝",
  botanical_garden: "植物園",
  zoo: "動物園",
  aquarium: "水族館",
  planetarium: "プラネタリウム",
  factory_tour: "工場見学",
  fruit_picking: "果物狩り",
  rafting: "川下り・ラフティング",
  cycling: "サイクリング",
  stargazing: "星空",
  power_spot: "パワースポット",
  hiking: "ハイキング",
  castle: "城",
  garden: "庭園",
  beach: "海水浴",
  footbath: "足湯",
};

// [タグ, 分類の一覧, 名前の語, 説明の語]。どれか1つに当たれば付けます。
const RULES = [
  ["temple", ["寺院"], null, null],
  ["shrine", ["神社"], null, null],
  ["museum", ["博物館"], /博物館|資料館|科学館|記念館/, null],
  ["art_museum", ["美術館"], /美術館/, null],
  ["onsen", ["温泉", "温泉地"], /温泉/, null],
  ["ski_resort", ["スキー場"], /スキー場|スノーパーク/, null],
  ["world_heritage", ["世界遺産"], null, /世界遺産/],
  ["autumn_foliage", null, /紅葉|もみじ谷/, /紅葉/],
  ["cherry_blossom", null, /桜|さくら/, /桜の名所|桜並木|千本桜|しだれ桜|花見|桜が咲/],
  ["flowers", null, /花畑|フラワー|ラベンダー|あじさい|ひまわり|コスモス|ばら園|バラ園|菜の花|つつじ|ツツジ/, /花畑|ラベンダー|あじさい|ひまわり畑|ネモフィラ|芝桜/],
  ["night_view", null, /夜景/, /夜景/],
  ["illumination", null, /イルミネーション/, /イルミネーション|ライトアップ/],
  ["sunrise_sunset", null, /夕日|夕陽|朝日|日の出|サンセット/, /夕日|夕陽|日の出|日の入り|朝日が/],
  ["historical_street", ["町並み"], /町並み|街並み|宿場|古い町/, /重要伝統的建造物群|町並み|宿場町/],
  ["observatory", ["展望台"], /展望台|展望所|展望広場/, null],
  ["dam", ["ダム"], /ダム$/, null],
  ["island", ["島"], /島$/, null],
  ["cave", null, /鍾乳洞|洞窟|風穴/, /鍾乳洞/],
  ["waterfall", ["滝"], /滝$|の滝/, null],
  ["botanical_garden", null, /植物園|樹木園|薬草園/, null],
  ["zoo", ["動物園"], /動物園|サファリ/, null],
  ["aquarium", ["水族館"], /水族館|アクアリウム/, null],
  ["planetarium", null, /プラネタリウム/, /プラネタリウム/],
  ["factory_tour", null, /工場見学|見学工場|ファクトリー/, /工場見学/],
  ["fruit_picking", null, /いちご狩り|ぶどう狩り|りんご狩り|果樹園|観光農園|フルーツパーク/, /いちご狩り|ぶどう狩り|りんご狩り|さくらんぼ狩り|果物狩り|味覚狩り/],
  ["rafting", null, /ラフティング|川下り|ライン下り|舟下り/, /ラフティング|川下り|舟下り/],
  ["cycling", null, /サイクリング/, /サイクリング/],
  ["stargazing", null, /天文台|星空|スターパーク/, /星空|天体観測/],
  ["power_spot", null, /パワースポット/, /パワースポット|縁結び/],
  ["hiking", ["登山"], /自然歩道|遊歩道|ハイキング|トレイル/, /ハイキング|トレッキング/],
  ["castle", ["城"], /城$|城跡$|城址$/, null],
  ["garden", ["庭園"], /庭園$/, null],
  ["beach", ["海水浴場"], /海水浴場/, null],
  ["footbath", null, /足湯/, /足湯/],
];

/**
 * スポットのタグを、決まった順に並べて返します（無ければ空の配列）。
 * @param {{name?: string, category?: string, description?: string}} s
 * @returns {string[]}
 */
export function spotTags(s) {
  const name = String(s?.name ?? "");
  const cat = s?.category;
  const desc = String(s?.description ?? "");
  const out = [];
  for (const [tag, cats, nameRe, descRe] of RULES) {
    if ((cats && cats.includes(cat)) || (nameRe && nameRe.test(name)) || (descRe && descRe.test(desc))) {
      out.push(tag);
    }
  }
  // 人が確かめて足したタグ（kb/curated.json → tools/apply_curated.mjs）
  for (const t of Array.isArray(s?.tags) ? s.tags : []) if (t in TAGS && !out.includes(t)) out.push(t);
  return out;
}

// 時間帯（いつ行くと良いか）。タグから決めます。
const TIME_OF = {
  night_view: "night", illumination: "night", stargazing: "night",
  sunrise_sunset: "sunset",
  temple: "morning", shrine: "morning", garden: "morning",
};

/**
 * 旅程を組むときの目安（時間帯・向いている同行者・体の負担）。
 * 収録に印が無いので、分類とタグからの見立てです。
 * @returns {{bestTime: string[], suitableFor: string[], effort: "easy"|"moderate"|"hard"}}
 */
export function spotProfile(s) {
  const tags = spotTags(s);
  const given = Array.isArray(s?.best_time) ? s.best_time : [];
  const bestTime = [...new Set([...given, ...tags.map((t) => TIME_OF[t]).filter(Boolean)])];
  const cat = s?.category;
  const suitableFor = [];
  if (["zoo", "aquarium", "planetarium", "fruit_picking", "factory_tour"].some((t) => tags.includes(t))
    || ["動物園", "水族館", "遊園地", "テーマパーク", "牧場", "公園"].includes(cat)) suitableFor.push("kids");
  if (["night_view", "illumination", "sunrise_sunset", "art_museum", "garden"].some((t) => tags.includes(t))
    || ["展望台", "庭園", "美術館", "灯台", "岬"].includes(cat)) suitableFor.push("couple");
  if (["onsen", "garden", "historical_street", "footbath"].some((t) => tags.includes(t))
    || ["温泉", "庭園", "町並み", "博物館", "美術館"].includes(cat)) suitableFor.push("elderly");
  if (["hiking", "cycling", "stargazing"].some((t) => tags.includes(t))
    || ["山", "登山", "渓谷", "峠"].includes(cat)) suitableFor.push("solo");
  let effort = "easy";
  if (["山", "登山", "渓谷"].includes(cat) || tags.includes("hiking") || tags.includes("rafting")) effort = "hard";
  else if (["滝", "城", "高原", "峠", "島", "スキー場"].includes(cat) || tags.includes("cave")) effort = "moderate";
  return { bestTime, suitableFor, effort };
}
