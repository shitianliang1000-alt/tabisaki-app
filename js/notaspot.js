// 行き先ではないものを、行き先として並べない。
//
// 収録は、出どころの違う一覧を継ぎ足して作っています。そのぶん
// 「観光の一覧に載っていた」だけで、行っても観光にならないものが
// 混ざります。旅程と、エリアの「定番・穴場」に出ていたのは、たとえば
//
//   東横イン京都琵琶湖大津（湖）       宿です。見に行く所ではありません
//   長浜ビジネスホテル（観光名所）     同上
//   琵琶湖（海水浴場）                 湖まるごとを1つの浜として、湖の
//                                      まん中の1点に置いていました
//   瀬戸内海（海水浴場）               同上
//   伊達市 (北海道)（海水浴場）         町の記事。浜の一覧から張られて
//                                      いただけです
//   環境省・帝国書院・山陽新聞（海水浴場） 出典として張られていた記事
//
// 琵琶湖の岸には、近江舞子・真野浜・宮ケ浜…と浜がいくつもあり、
// それぞれ別の場所として収録にあります。「琵琶湖 60分」という1件は、
// それらを**1つにまとめられないのに1つにまとめた**ものでした。
//
// 宿は、旅程の「宿泊」の段で別に扱います（js/stays.js）。見どころの
// 並びに混ぜると、行き先が1つ減って、代わりにホテルのロビーへ案内する
// ことになります。
//
// ■ 外さないもの
//
//   ・「旧」で始まる建物（旧○○旅館のように、保存された建物）
//   ・温泉の名前が先に来て、宿の名前が括弧の中にあるだけのもの
//       白山温泉(永井旅館) … 行き先は温泉です
//   ・「宿泊なし」と書いてあるもの
//   ・キャンプ場（宿ではなく、そこで過ごす場所です）
//   ・宿場（妻籠宿・奈良井宿）。「宿」の字だけでは見ません
//
// 道具（tools/drop_not_spots.mjs）も、読み込み（js/kb.js）も、この
// 判定を使います。片方だけ直すと、取り込み直したときに戻ります。

/**
 * 宿だと言い切れる語。どこにあっても宿です。
 *
 * 「ホテル」「旅館」は、名前のどこにあっても宿の名前です
 * （「和の宿ホテル祖谷温泉」は温泉の名前で終わりますが、宿です）。
 */
const LODGING_STRONG = /ホテル|hotel|旅館|ryokan|民宿|ペンション|ゲストハウス|ホステル|hostel|オーベルジュ|auberge|東横イン|ルートイン|ドーミーイン|かんぽの宿|国民宿舎|宿坊|宿泊(施設|研修|情報)|ビジネスイン/i;

/**
 * 宿のことが多いけれど、温泉や野営地の名前にも入る語。
 *
 *   湯宿温泉   … 群馬の温泉の名前です（宿ではありません）
 *   休暇村近江八幡キャンプ場 … キャンプ場です
 *
 * 名前が温泉・キャンプ場で終わるなら外しません。
 */
const LODGING_WEAK = /コテージ|ロッジ|ヴィラ(?!ージュ|デスト|・デ)|\bvilla\b|休暇村|エクシブ|湯宿|の宿(?!場)|宿泊/i;

const KEEP_LODGING_TAIL = /(温泉|温泉郷|温泉街|キャンプ場|キャンプ村|野営場|スキー場|文学館|記念館|資料館|博物館|美術館)$/;

/**
 * 宿を併せ持つ寺社。行き先は寺社のほうです。
 *
 *   おおま宿坊 普賢院 ／ ユースホステル天香寺
 */
const SHRINE_OR_TEMPLE = /(寺|院|神社|大社|宮)$/;

const PAREN = /[（(][^）)]*[）)]/g;

/** 括弧の外だけ。「白山温泉(永井旅館)」→「白山温泉」。 */
function outside(name) {
  return String(name ?? "").replace(PAREN, "").trim();
}

/**
 * 宿か。
 *
 * @param {{name?:string}} spot
 */
export function isLodging(spot) {
  const name = String(spot?.name ?? "");
  if (!name) return false;
  if (/宿泊なし/.test(name)) return false;
  if (/^旧/.test(name)) return false;
  if (/道の駅/.test(name)) return false;
  // 一軒宿の温泉（青荷温泉旅館・長寿温泉旅館）。国土数値情報は温泉を
  // 宿の名前で載せています。行けば湯に入れるので、温泉として残します。
  if (spot?.category === "温泉" && /温泉旅館$/.test(outside(name))) return false;
  if ((spot?.category === "寺院" || spot?.category === "神社")
      && SHRINE_OR_TEMPLE.test(outside(name))) {
    return false;
  }
  const base = outside(name);
  // 宿の名前が括弧の中にあるだけなら、行き先は括弧の外（温泉など）です。
  if (base && base !== name && !LODGING_STRONG.test(base)
      && !LODGING_WEAK.test(base)) {
    return false;
  }
  if (LODGING_STRONG.test(base || name)) return true;
  if (LODGING_WEAK.test(base || name)) {
    return !KEEP_LODGING_TAIL.test(base || name);
  }
  return false;
}

/**
 * 一覧記事から拾われた、場所ではない記事。
 *
 * 浜の一覧は、浜のついでに町・役所・新聞社の記事へも張ります。
 * 座標も分類も付いてしまうので、名前と記事の書き出しで見分けます。
 *
 *   伊達市 (北海道)   ／ 本町 (室蘭市) ／ 西区 (新潟市)
 *     … 「名前 (県名や市名)」の形は、ウィキペディアで同名の町を
 *        分けるための書き方です。名前が市町村区で終わります。
 *   環境省 ／ 帝国書院 ／ 山陽新聞社 ／ 北海道電力 ／ 日本トランスオーシャン航空
 *     … 役所と会社です
 *
 * 書き出しで見るのは、ウィキペディアから来たもの（wikipedia 欄が
 * 名前と同じもの）だけです。国土数値情報の説明は住所です。
 */
// 「伊達市 (北海道)」「西区 (新潟市)」。ウィキペディアが同名を分ける
// 書き方で、括弧の前に空白が入ります（国土数値情報の「桜市(宮代町)」は
// 空白が無く、催しの会場を書いたものなので、ここでは見ません）。
//
// 「今井町 (橿原市)」「荻町 (白川村)」「三町 (高山市)」は、町並みが
// そのまま見どころの地区です。**市の中の町は外しません。** 外すのは、
// 括弧が県（＝それ自体が市町村）のものと、市の区です。
const ADMIN_AREA_NAME = /^[^\s()（）]{1,8}[市町村郡] [（(]([^）)]+[都道府県]|代表的なトピック)[)）]$|^[^\s()（）]{1,6}区 [（(][^）)]+[市都][)）]$/;
// 「庁」「書院」は入れません。東京都庁は展望室が見どころで、
// 藤樹書院・今西家書院は建物そのものが文化財です。
const ORG_NAME = /(省|新聞|新聞社|出版|電力|航空|放送|銀行|信用金庫|証券|保険)$/;
const ADMIN_LEAD = /^[^。]{0,60}(に位置する|にある|の)(市|町|村|行政区|特別区)(である|。|（)|を構成する(\d+区の)?行政区|の町丁|の地区名/;
const ORG_LEAD = /^(株式会社|[^。]{0,40}株式会社は)|^[^。]{0,60}(行政機関|中央省庁|発行する新聞|出版社|航空会社|電力会社)/;

// 会社の記事でも、行けば見るものがあるもの。観光列車の鉄道会社、
// 酒蔵、工場見学、日帰りの湯、記念館、遺跡（「大宰府政庁跡」の書き出しは
// 役所の説明から始まります）。
const KEEP_ORG = /鉄道|鐵道|スパ|spa|湯|館|工場|酒造|蔵|醸造|跡|ミュージアム/i;

export function isNotAPlace(spot) {
  const name = String(spot?.name ?? "").trim();
  if (!name) return false;
  if (ADMIN_AREA_NAME.test(name)) return true;
  const base = outside(name);
  if (ORG_NAME.test(base) && !KEEP_ORG.test(base)) return true;
  const lead = String(spot?.description ?? "");
  const fromWiki = spot?.src === "wikipedia" || spot?.src === "wikipedia-tourlist";
  if (fromWiki && lead) {
    if (ADMIN_LEAD.test(lead) && /[市町村区]$/.test(base)) return true;
    if (ORG_LEAD.test(lead) && !KEEP_ORG.test(base)) return true;
  }
  return false;
}

/**
 * 観光案内所。
 *
 * 地図やパンフレットをもらう所で、見に行く所ではありません。それが
 * 旅程の1か所目に、45分・300円の立ち寄りとして入っていました。
 *
 *   9:00 広島駅総合案内所（45分）
 *
 * 外すのは、名前が「案内所」「インフォメーション（センター）」で
 * 終わるものだけです。
 *
 *   ・ビジターセンターは残します。国立公園のものは展示が見どころです
 *   ・「観光センター」は残します。物産館や展望台を兼ねたものが多いためです
 *   ・「倉吉白壁土蔵群・赤瓦観光案内所」のように、見どころの名前と
 *     「・」でつないだものは残します（建物そのものが見どころです）
 */
const INFO_DESK = /(案内所|インフォメーション\s*(センター)?)$/i;

export function isInfoDesk(spot) {
  const base = outside(spot?.name);
  if (!base || /ビジターセンター|・/.test(base)) return false;
  return INFO_DESK.test(base);
}

/**
 * 1つにまとめられないものを、1つの浜として入れたもの。
 *
 * 「琵琶湖（海水浴場）」「瀬戸内海（海水浴場）」「多摩川（海水浴場）」。
 * 湖・海・川そのものの名前に、浜の分類が付いています。湖岸の浜は
 * それぞれ別に収録にあるので、まとめた1件は外します（湖そのものは
 * 湖として別に入っています）。
 */
const BEACH_CATEGORY = new Set(["海水浴場", "ビーチ"]);
const WATER_BODY = /(湖|沼|海|内海|灘|川|湾|潟)$/;
const BEACH_WORD = /浜|ビーチ|海水浴|水泳場|水浴場|海岸|渚|なぎさ|松原|浦|beach/i;

export function isUmbrella(spot) {
  if (!BEACH_CATEGORY.has(spot?.category)) return false;
  const base = outside(spot?.name);
  if (!base || BEACH_WORD.test(base)) return false;
  return WATER_BODY.test(base);
}

/**
 * 行き先にならない理由。行き先なら null。
 *
 * @param {object} spot
 * @returns {null|"宿"|"場所ではない記事"|"まとめすぎ"|"案内所"}
 */
export function whyNotASpot(spot) {
  // 利用者が足したもの・調べて足したもの（source: "ai"）は、名指しで
  // 頼まれた場所なので判定しません。
  if (spot?.source === "ai" || spot?.source === "user") return null;
  if (isLodging(spot)) return "宿";
  if (isUmbrella(spot)) return "まとめすぎ";
  if (isInfoDesk(spot)) return "案内所";
  if (isNotAPlace(spot)) return "場所ではない記事";
  return null;
}

/** 行き先になるものだけを返します。 */
export function onlySpots(spots) {
  return (spots ?? []).filter((s) => !whyNotASpot(s));
}
