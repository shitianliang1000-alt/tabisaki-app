// ローマ字・英語で書かれた地名を、収録の表記に読み替える。
//
// 画面にこう入力されていました。
//
//     I want to visit around Sendai
//
// 出てきたのは **旭川市・函館市（北海道）** です。仙台から700km離れて
// います。areas.js は収録の名前（「仙台市」）をそのまま探すので、
// "Sendai" はどこにも一致しません。地名が1つも見つからなければ
// 「どこでもよい」として扱われ、点の高い順に返ります。
//
// **黙って別の場所を出すのが、いちばん困ります。** 読み替えの表を持って、
// 見つかるようにします。
//
// 表に入れるのは、外から来た人がまず書く名前です。
//
//   ・47都道府県
//   ・地方名（Kanto, Kansai, Tohoku …）
//   ・よく書かれる市・観光地（Kyoto, Hakone, Nikko …）
//
// 収録エリアは1,370あり、その全部にローマ字を振ることはできません。
// 表に無い名前は、これまでどおり「収録が無い」と伝わります（黙って
// 別の場所を出すよりましです）。
//
// 書きかたのゆれも吸収します。Tokyo / Tôkyô / Toukyou / Tookyoo は
// すべて「東京」です。長音の書きかたは人によって違い、どれも正しい
// つもりで書かれています。

/** ローマ字 → 収録の表記。鍵は正規化済み（小文字・長音を落とした形）。 */
const PLACES = {
  // --- 都道府県 ---
  hokkaido: "北海道", aomori: "青森県", iwate: "岩手県", miyagi: "宮城県",
  akita: "秋田県", yamagata: "山形県", fukushima: "福島県",
  ibaraki: "茨城県", tochigi: "栃木県", gunma: "群馬県", saitama: "埼玉県",
  chiba: "千葉県", tokyo: "東京都", kanagawa: "神奈川県",
  niigata: "新潟県", toyama: "富山県", ishikawa: "石川県", fukui: "福井県",
  yamanashi: "山梨県", nagano: "長野県", gifu: "岐阜県", shizuoka: "静岡県",
  aichi: "愛知県", mie: "三重県", shiga: "滋賀県", kyoto: "京都府",
  osaka: "大阪府", hyogo: "兵庫県", nara: "奈良県", wakayama: "和歌山県",
  tottori: "鳥取県", shimane: "島根県", okayama: "岡山県", hiroshima: "広島県",
  yamaguchi: "山口県", tokushima: "徳島県", kagawa: "香川県", ehime: "愛媛県",
  kochi: "高知県", fukuoka: "福岡県", saga: "佐賀県", nagasaki: "長崎県",
  kumamoto: "熊本県", oita: "大分県", miyazaki: "宮崎県",
  kagoshima: "鹿児島県", okinawa: "沖縄県",

  // --- 地方 ---
  tohoku: "東北", kanto: "関東", chubu: "中部", hokuriku: "北陸",
  kansai: "関西", kinki: "近畿", shikoku: "四国", kyushu: "九州",
  tokai: "東海", sanin: "山陰", sanyo: "山陽", setouchi: "瀬戸内",
  koshinetsu: "甲信越",

  // --- よく書かれる市・観光地 ---
  sendai: "仙台市", sapporo: "札幌市", hakodate: "函館市",
  asahikawa: "旭川市", otaru: "小樽市", niseko: "ニセコ",
  kanazawa: "金沢市", takayama: "高山市", matsumoto: "松本市",
  nagoya: "名古屋市", yokohama: "横浜市", kamakura: "鎌倉市",
  hakone: "箱根", nikko: "日光市", kusatsu: "草津温泉",
  karuizawa: "軽井沢町", chichibu: "秩父", enoshima: "江の島",
  kobe: "神戸市", himeji: "姫路市", nagahama: "長浜市",
  kurashiki: "倉敷市", onomichi: "尾道市", miyajima: "宮島",
  matsuyama: "松山市", dogo: "道後温泉", takamatsu: "高松市",
  kochishi: "高知市", beppu: "別府市", yufuin: "由布院",
  naha: "那覇市", ishigaki: "石垣市", miyakojima: "宮古島市",
  fuji: "富士山", takao: "高尾山", atami: "熱海市", ito: "伊東市",
  shirakawago: "白川郷", kurobe: "黒部市", noboribetsu: "登別市",
  aomorishi: "青森市", morioka: "盛岡市", hirosaki: "弘前市",
  yamagatashi: "山形市", ginzan: "銀山温泉", zao: "蔵王",
  nasu: "那須町", hakuba: "白馬村", kiso: "木曽",
  ise: "伊勢市", koyasan: "高野山", yoshino: "吉野町",
  arashiyama: "嵐山", gion: "祇園", uji: "宇治市",
};

/**
 * 照合用に整えます。
 *
 * 長音の書きかたは人によって違います。Tokyo / Tôkyô / Toukyou /
 * Tookyoo は、どれも同じ「東京」のつもりです。伸ばす音を落として
 * そろえます（Osaka と Ōsaka、Kyushu と Kyūshū も同じになります）。
 */
export function normalizeRomaji(word) {
  return String(word ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // ô → o
    .replace(/[^a-z]/g, "")
    .replace(/ou/g, "o").replace(/uu/g, "u")
    .replace(/(.)\1+/g, "$1");                           // oo → o
}

/**
 * 引くための表。**鍵も同じ整えかたを通します。**
 *
 * 通していなかったので、"HOKKAIDO" が引けませんでした（整えると
 * hokkaido は hokaido になり、表の鍵と形が違います）。書くときは
 * 読みやすい綴りのまま置いて、引くときに両側をそろえます。
 */
const LOOKUP = new Map(
  Object.entries(PLACES).map(([k, v]) => [normalizeRomaji(k), v]));

/** その語が、収録の地名を指しているか。指していなければ null。 */
export function placeFromRomaji(word) {
  return LOOKUP.get(normalizeRomaji(word)) ?? null;
}

/**
 * 文の中のローマ字の地名を、収録の表記に置き換えた文を返します。
 *
 * 元の文は捨てません。「Sendai」を「仙台市」に**足します**。
 * 置き換えてしまうと、同じ文の中の日本語の手がかり（「温泉」など）と
 * 並べて読めなくなる場面があるためです。
 *
 *     I want to visit around Sendai
 *       → I want to visit around Sendai 仙台市
 */
export function withJapanesePlaces(text) {
  const s = String(text ?? "");
  const add = [];
  for (const m of s.matchAll(/[A-Za-zÀ-ɏ]{3,}/g)) {
    const hit = placeFromRomaji(m[0]);
    if (hit && !s.includes(hit) && !add.includes(hit)) add.push(hit);
  }
  return add.length ? `${s} ${add.join(" ")}` : s;
}
