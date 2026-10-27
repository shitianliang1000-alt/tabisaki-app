// 希望文に出てくる地名を拾う。
//
// 「四国の有名な観光地を巡りたい」と書いたのに銚子が出てくる——
// 語句検索では「四国」がどのスポット名にも含まれないので、一致ゼロになり、
// 何でもいいから返す経路に落ちていました。地名は他の検索語とは性質が
// 違います。ジャンルは「近いもの」で代用できますが、地名は代用できません。
//
// そこで地名だけを先に取り出し、
//   ・収録があれば、その範囲に絞ってから選ぶ
//   ・収録が無ければ、提案の前に「収録が無い」とはっきり言う
// の2つに分けます。黙って別の場所を出すのがいちばん困ります。

import { wordRuns } from "./keywords.js";
import { withJapanesePlaces } from "./romaji.js";
import { WIDE_REACH_KM, shapeOf } from "./shapes.js";

/** 地方名 → 都道府県。 */
export const MACRO_AREAS = {
  北海道: ["北海道"],
  東北: ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"],
  関東: ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"],
  首都圏: ["東京都", "神奈川県", "埼玉県", "千葉県"],
  中部: ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
         "岐阜県", "静岡県", "愛知県"],
  北陸: ["新潟県", "富山県", "石川県", "福井県"],
  甲信越: ["山梨県", "長野県", "新潟県"],
  東海: ["岐阜県", "静岡県", "愛知県", "三重県"],
  近畿: ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"],
  関西: ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"],
  中国地方: ["鳥取県", "島根県", "岡山県", "広島県", "山口県"],
  山陰: ["鳥取県", "島根県"],
  山陽: ["岡山県", "広島県", "山口県"],
  四国: ["徳島県", "香川県", "愛媛県", "高知県"],
  九州: ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県"],
  沖縄: ["沖縄県"],
  瀬戸内: ["香川県", "愛媛県", "岡山県", "広島県", "兵庫県"],
};

/**
 * 決まった言い回し。
 *
 * 「3大都市の美術館をめぐりたい」と書いても、「3大都市」という語は
 * どのスポット名にも入っていません。一致ゼロのまま点の高い順に選ぶので、
 * 鹿児島市・京都市・箱根のような並びが出ていました。**日本語として
 * 分かっている言葉は、分かっているものとして扱います。**
 *
 * ここに入れるのは、指す先が決まっているものだけです。「絶景」や
 * 「映え」のような、人によって指す先が変わる言葉は入れません。
 */
export const NAMED_SETS = {
  三大都市: ["東京", "大阪", "名古屋"],
  "3大都市": ["東京", "大阪", "名古屋"],
  三大都市圏: ["東京", "大阪", "名古屋"],
  五大都市: ["東京", "大阪", "名古屋", "横浜", "京都"],
  大都市: ["東京", "大阪", "名古屋", "横浜", "札幌", "福岡"],
  日本三景: ["松島", "天橋立", "宮島"],
  三名園: ["金沢", "岡山", "水戸"],
  日本三名園: ["金沢", "岡山", "水戸"],
  三名泉: ["草津", "下呂", "有馬"],
  日本三名泉: ["草津", "下呂", "有馬"],
  三古湯: ["道後", "有馬", "白浜"],
  三大祭: ["京都", "大阪", "東京"],
  // 言い回しが人によって違うもの（読みかたに複数ある）。最も多い読みで
  // 組み、旅程に「この読みで組んだ」と言います（NAMED_READINGS）。
  三都心: ["東京", "大阪", "名古屋"],
  三都: ["東京", "京都", "大阪"],
  三都物語: ["神戸", "大阪", "京都"],
  京阪神: ["京都", "大阪", "神戸"],
};

/**
 * 「三都心」は、文脈で指す先が変わる呼び名です。
 *
 * 地名が添えられていれば（「東京の三都心」）、その街の3つの中心を指します。
 * 地名が無くても、出発地が東京なら東京の話だと読みます（東京の人が
 * 「三都心」と書くとき、東京・大阪・名古屋のことはまずありません）。
 * どちらでもなければ、いちばん多い読みの三大都市にします。
 *
 * 収録のエリア名で当てるので、池袋は豊島区です。
 */
const CITY_CENTERS = {
  東京: { regions: ["新宿", "渋谷", "豊島"], label: "東京の新宿・渋谷・池袋",
          cue: /東京|都内|首都圏/ },
};

/** 出発地から、その人の街を決めます（収録に3つの中心がある街だけ）。 */
export function originCity(origin) {
  const lat = Number(origin?.lat);
  const lng = Number(origin?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // 東京駅から約40km。
  const km = Math.hypot((lat - 35.681) * 111, (lng - 139.767) * 91);
  return km <= 40 ? "東京" : null;
}

/** 読みが複数ありうる言い回しの、組んだ読みの説明。 */
export const NAMED_READINGS = {
  三都心: "「三都心」は、東京・大阪・名古屋の三大都市として読みました"
    + "（東京の副都心など、別の意味なら言い直してください）。",
  三都: "「三都」は、江戸（東京）・京・大坂（大阪）の三都として読みました。",
  三都物語: "「三都物語」は、神戸・大阪・京都を結ぶ関西の呼び名として読みました。",
};

/**
 * 「さん都心」「3都心」「三大都市」のように、数の書きかたが違っても
 * 同じ言い回しとして当てるために、数を漢数字にそろえます。
 * 「3大都市」は辞書にそのまま持っているので、先にそちらが当たります。
 */
function canonNumbers(s) {
  return String(s)
    .replace(/[3３](?=大|都)/g, "三")
    .replace(/さん(?=都|大都)/g, "三")
    .replace(/サン(?=都|大都)/g, "三");
}

/**
 * 日本全体を指す言い方。
 *
 * 「日本全国の名所をめぐりたい」と書いても、これまでは地名の指定が
 * 無いことになり、点の高い順に選ばれていました。点の高いエリアは
 * たいてい近くに固まっているので、7日の旅が瀬戸内だけで終わります
 * （実際に「高知・広島・宮島・松山・道後・直島」になっていました）。
 * 全国と書いた人がほしいのは、1つの地方を深く、ではありません。
 *
 * 「全国的に有名な」「全国チェーン」は範囲の指定ではないので外します。
 */
const NATIONWIDE_RE =
  /日本全国|全国各地|日本各地|日本中|日本一周|日本縦断|全都道府県|47都道府県|全国(?!的|区|チェーン|展開|大会|紙|放送|ネット|区分)/;

/**
 * 地方の分けかた（散らすときの単位）。県 → 地方。
 * 近畿と中部の両方に入る三重は、近畿に寄せます（MACRO_AREAS の東海と
 * 近畿の両方に入っています）。
 */
const REGION_BLOCKS = ["北海道", "東北", "関東", "中部", "近畿", "中国地方",
                       "四国", "九州", "沖縄"];
export const BLOCK_OF_PREF = (() => {
  const out = {};
  for (const block of [...REGION_BLOCKS].reverse()) {
    for (const p of MACRO_AREAS[block]) out[p] = block;
  }
  return out;
})();

/** そのエリアが属する地方。分からなければ県名（外国なら国名）。 */
export function blockOf(region) {
  return BLOCK_OF_PREF[region?.prefecture]
    ?? region?.prefecture ?? region?.country ?? "";
}

/**
 * 収録エリアを地方ごとに分ける表（regionId → 地方）。
 * 「全国」や「移動を楽しみたい」のときに、1つの地方へ固まらないよう
 * 使います（ai.js の coherentRegions が、まだ行っていない地方を先に選びます）。
 */
export function blockGroups(kb, regionIds = null) {
  const out = new Map();
  const only = regionIds ? new Set(regionIds) : null;
  for (const r of kb?.regions ?? []) {
    if (only && !only.has(r.id)) continue;
    out.set(r.id, blockOf(r));
  }
  return out;
}

export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/** 「京都」のように県名を省いた書き方。長い順に見るので誤爆しません。 */
const SHORT_PREF = PREFECTURES
  .filter((p) => p !== "北海道")
  .map((p) => [p.replace(/[都道府県]$/, ""), p]);

/**
 * 文中の地名を拾います。
 * @returns {Array<{term:string, kind:"macro"|"prefecture"|"region",
 *                  prefectures:string[], regionIds:string[]}>}
 */
/**
 * その収録エリア名を、書かれうる形に開きます。
 *
 * 収録は「横浜市」ですが、人は「横浜」と書きます。完全な名前しか
 * 探していなかったので、
 *
 *     横浜の人が少ない静かな場所で自然を感じたい
 *       → 江東区（東京都）
 *
 * となっていました。収録には 横浜みなとみらい・横浜市・横浜町 の3つが
 * あるのに、**1つも見つかっていません**。
 *
 * 落とすのは「市」と「区」だけです。
 *
 *   横浜市 → 横浜、渋谷区 → 渋谷   … こう書く人のほうが多い
 *   横浜町 → （落とさない）        … 青森県の町です。「横浜」と書いた人が
 *                                    指しているのは、まず横浜市のほうです
 *
 * 2文字未満になるものは返しません（「港区」→「港」は、空港にも港町にも
 * 当たってしまいます）。
 */
export function variantsOf(name) {
  const full = String(name ?? "");
  const out = [full, ...full.split(/[・]/)];
  for (const part of [...out]) {
    const short = part.replace(/[市区]$/, "");
    if (short.length >= 2 && short !== part && !out.includes(short)) {
      out.push(short);
    }
  }
  return out;
}

export function detectAreas(text, kb, ctx = {}) {
  // ローマ字で書かれた地名を、収録の表記に足してから探します。
  //
  // 「I want to visit around Sendai」と書かれて、**旭川市・函館市**が
  // 出ていました。仙台から700km離れています。ここは収録の名前
  // （「仙台市」）をそのまま探すので、"Sendai" はどこにも一致せず、
  // 地名の指定が無かったことになって、点の高い順に返っていました。
  const s = withJapanesePlaces(text);
  if (!s.trim()) return [];
  const found = [];
  const seen = new Map();

  // 同じ地名に当たるエリアは、**まとめます**。
  //
  // ここは2つ目以降を捨てていました。「横浜」には 横浜市 と
  // 横浜みなとみらい の両方が当たるのに、先に見つかったほうだけが
  // 残ります。収録が細かくなるほど、取りこぼしが増えます
  // （大阪は「大阪・ミナミ」と「大阪市」に分かれています）。
  const push = (term, kind, prefectures, regionIds, groups = null) => {
    const had = seen.get(term);
    if (had) {
      for (const p of prefectures) {
        if (!had.prefectures.includes(p)) had.prefectures.push(p);
      }
      for (const id of regionIds ?? []) {
        if (!had.regionIds.includes(id)) had.regionIds.push(id);
      }
      return;
    }
    const entry = { term, kind, prefectures: [...prefectures],
                    regionIds: [...(regionIds ?? [])], groups };
    seen.set(term, entry);
    found.push(entry);
  };

  // 収録エリア名（「箱根」「道後」など）がいちばん具体的なので先に見る
  for (const r of kb?.regions ?? []) {
    for (const name of variantsOf(r.name)) {
      if (name.length >= 2 && s.includes(name)) {
        push(name, "region", [r.prefecture], [r.id]);
        break;
      }
    }
  }
  // 同じ地名で始まるエリアも、同じ県内なら一緒に見ます。
  //
  // 「横浜」には 横浜市 が当たりますが、収録にはもう1つ
  // 「横浜みなとみらい」（77スポット）があります。名前の頭は同じでも
  // 完全一致ではないので、これまでは外れていました。**収録を細かく
  // するほど、書いた地名から遠ざかる**という妙なことになります。
  //
  // 県をそろえるのは、青森県の「横浜町」を巻き込まないためです。
  // 「横浜」と書いた人が指しているのは、まず神奈川のほうです。
  for (const hit of found.filter((f) => f.kind === "region")) {
    for (const r of kb?.regions ?? []) {
      if (hit.regionIds.includes(r.id)) continue;
      if (!String(r.name).startsWith(hit.term)) continue;
      if (!hit.prefectures.includes(r.prefecture)) continue;
      hit.regionIds.push(r.id);
    }
  }

  // 決まった言い回し（「3大都市」「日本三景」）は、指す先が決まっています。
  // 広い地方名より先に見ます。「三大都市」を「都市」の一般語として
  // 扱うと、結局は点の高い順に戻ってしまいます。
  // 長い言い回しから順に見ます。「3大都市」を拾ったあとで「大都市」も
  // 拾うと、6エリアの指定が13エリアに広がって、指定した意味が消えます。
  const namedHits = [];
  let dropCityTerm = null;
  const canon = canonNumbers(s);
  for (const [term, setNames] of Object.entries(NAMED_SETS)
    .sort((a, b) => b[0].length - a[0].length)) {
    let names = setNames;
    if (!canon.includes(term) && !s.includes(term)) continue;
    if (namedHits.some((t) => t.includes(term))) continue;
    // 「3大都市」と「三大都市」は同じ言い回しです。2つ目は数えません。
    if (namedHits.some((t) => canonNumbers(t) === canonNumbers(term))) continue;
    namedHits.push(term);
    let reading = NAMED_READINGS[term];
    if (term === "三都心") {
      // 文脈に合わせて、どの街の3つの中心かを決めます。
      const city = Object.entries(CITY_CENTERS).find(([name, c]) =>
        c.cue.test(s) || (!/大阪|名古屋|京都/.test(s) && ctx.originCity === name));
      if (city) {
        // 「東京の三都心」の「東京」は街の名前で、東京全体の指定ではありません。
        if (city[1].cue.test(s)) dropCityTerm = city[0];
        names = city[1].regions;
        reading = `「三都心」は、${city[1].label}として読みました`
          + "（別の街のことなら、街の名前を足して書いてください）。";
      }
    }
    const ids = [];
    const prefs = new Set();
    // どのエリアが、どの地名（東京・大阪・名古屋）に属するか。
    // 「3大都市」は3つとも回るのが自然なので、あとで1つずつ選びます。
    const groups = new Map();
    for (const name of names) {
      for (const r of kb?.regions ?? []) {
        if (r.name.includes(name) || name.includes(r.name)) {
          ids.push(r.id);
          groups.set(r.id, name);
          if (r.prefecture) prefs.add(r.prefecture);
        }
      }
    }
    if (ids.length) {
      push(term, "region", [...prefs], ids, groups);
      if (reading) seen.get(term).reading = reading;
    }
  }
  for (const [term, prefs] of Object.entries(MACRO_AREAS)) {
    if (!s.includes(term)) continue;
    // 県をまたぐ地方（九州・関東など）は、県ごとに散らせるよう内訳を持たせます。
    const ids = regionsIn(kb, prefs);
    const groups = prefs.length > 1 ? new Map(ids.map((id) =>
      [id, kb.regionsById?.get(id)?.prefecture
        ?? kb.regions.find((r) => r.id === id)?.prefecture])) : null;
    push(term, "macro", prefs, ids, groups);
  }
  for (const p of PREFECTURES) {
    if (s.includes(p)) push(p, "prefecture", [p], regionsIn(kb, [p]));
  }
  for (const [short, full] of SHORT_PREF) {
    if (short.length >= 2 && s.includes(short)) {
      push(full, "prefecture", [full], regionsIn(kb, [full]));
    }
  }
  // 日本全体の指定は、ほかに地名が無いときだけ範囲として扱います。
  // 「全国の中でも京都」なら、指しているのは京都です。
  const nation = s.match(NATIONWIDE_RE);
  if (nation && !found.length) {
    const ids = (kb?.regions ?? [])
      .filter((r) => !r.country || r.country === "日本").map((r) => r.id);
    push(nation[0], "nation", [...PREFECTURES], ids, blockGroups(kb, ids));
  }
  if (dropCityTerm) {
    return found.filter((a) => a.term === "三都心"
      || !(a.term.startsWith(dropCityTerm) || a.term === `${dropCityTerm}都`));
  }
  return found;
}

/**
 * AIが読み取った言い回し（「関西の三つの大きな街」など）を、
 * detectAreas と同じ形のエリアにします。
 *
 * 辞書（NAMED_SETS）に無い言い方でも、AIが「東京・大阪・名古屋」のように
 * 具体的な地名に直してくれれば、辞書にあるものと同じに扱えます。
 * 地名は収録のエリア名に当てるだけで、AIが挙げた名前を信じすぎません
 * （収録に無い名前は、無いこととして捨てます）。
 *
 * @param {Array<{phrase:string, meaning?:string, names:string[], ambiguous?:boolean}>} phrases
 */
export function phraseAreas(phrases, kb) {
  const out = [];
  for (const ph of phrases ?? []) {
    const term = String(ph?.phrase ?? "").trim();
    const names = (Array.isArray(ph?.names) ? ph.names : [])
      .map((n) => String(n ?? "").trim()).filter((n) => n.length >= 2)
      .filter((n, i, a) => a.indexOf(n) === i).slice(0, 8);
    if (!term || names.length < 2) continue;
    const ids = [];
    const prefs = new Set();
    const groups = new Map();
    for (const name of names) {
      for (const r of kb?.regions ?? []) {
        if (r.name.includes(name) || name.includes(r.name)) {
          ids.push(r.id);
          groups.set(r.id, name);
          if (r.prefecture) prefs.add(r.prefecture);
        }
      }
    }
    if (!ids.length) continue;
    const meaning = String(ph.meaning ?? "").trim().slice(0, 60);
    out.push({
      term, kind: "region", prefectures: [...prefs], regionIds: ids, groups,
      reading: `「${term}」は、${names.join("・")}として読みました`
        + (meaning ? `（${meaning}）` : "")
        + "。AIの読み取りです。違っていたら、希望文で言い直してください。",
      fromAi: true,
    });
  }
  return out;
}

/**
 * 収録にある場所の名前から、エリアを決めます（地名が当たらなかったとき）。
 *
 * 「琵琶湖に行きたい」は、どのエリア名にも県名にも当たりません。
 * 地名の指定が無いことになり、湖の多い裏磐梯（福島）が出ていました。
 * 琵琶湖は収録にあるのに、です。
 *
 * そのうえ琵琶湖は、**1つのエリアにまとめられません。** 岸には大津・
 * 高島・長浜・彦根・近江八幡…とエリアが並び、浜もそれぞれの町にあります。
 * 収録では近江八幡市に1点として入っていますが、そこだけに絞ると、
 * 近江舞子や真野浜のような岸の浜が候補から消えます。
 *
 * そこで、
 *   ・点の場所（お寺・美術館）なら、そのエリア
 *   ・広い場所（湖・島・高原・山…。packages/core/src/shapes.js）なら、代表の点から
 *     WIDE_REACH_KM（packages/core/src/shapes.js）以内にあるエリアをまとめて
 * を候補にします。湖のまわりの浜は、それぞれのエリアの中から選ばれます。
 *
 * 当てるのは、定番か知られた場所（fame_tier）で、3文字以上の名前だけ
 * です。短い名前や無名の場所は、たまたま文に含まれます（「公園」）。
 *
 * @returns {Array} detectAreas と同じ形（kind: "spot"）
 */
export function namedSpotAreas(text, kb) {
  const s = withJapanesePlaces(text);
  if (!s.trim()) return [];
  const hits = new Map();
  for (const spot of kb?.spots ?? []) {
    if (spot?.fame_tier !== "major" && spot?.fame_tier !== "known") continue;
    const name = String(spot.name ?? "");
    if (name.length < 3 || !s.includes(name)) continue;
    if (!Number.isFinite(spot.lat) || !Number.isFinite(spot.lng)) continue;
    const had = hits.get(name);
    // 同じ名前が2件あれば、知られているほう（定番）を代表にします。
    if (!had || (had.fame_tier !== "major" && spot.fame_tier === "major")) {
      hits.set(name, spot);
    }
  }
  // 「琵琶湖大橋」と書いた人に、「琵琶湖」まで当てません。
  const names = [...hits.keys()];
  const out = [];
  for (const [name, spot] of hits) {
    if (names.some((n) => n !== name && n.includes(name))) continue;
    const ids = new Set(spot.regionId ? [spot.regionId] : []);
    if (shapeOf(spot) === "wide") {
      // 定番の広い場所ほど大きい（琵琶湖・富士山）。知られた程度の
      // 広い場所は、すぐ隣のエリアまでにします。
      const reach = spot.fame_tier === "major" ? WIDE_REACH_KM : 6;
      for (const r of kb?.regions ?? []) {
        if (!Number.isFinite(r?.lat)) continue;
        if (kmBetween(spot, r) <= reach) ids.add(r.id);
      }
    }
    if (!ids.size) continue;
    const prefs = new Set();
    for (const id of ids) {
      const p = kb?.regionsById?.get(id)?.prefecture
        ?? kb?.regions?.find((r) => r.id === id)?.prefecture;
      if (p) prefs.add(p);
    }
    out.push({ term: name, kind: "spot", prefectures: [...prefs],
               regionIds: [...ids], groups: null });
  }
  return out;
}

function kmBetween(a, b) {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function regionsIn(kb, prefectures) {
  const set = new Set(prefectures);
  return (kb?.regions ?? []).filter((r) => set.has(r.prefecture)).map((r) => r.id);
}

/**
 * 拾った地名から、絞り込みに使う地域IDと、収録が無かった地名を分けます。
 *
 * @returns {{regionIds:Set<string>|null, matched:Array, missing:Array}}
 *   regionIds が null なら「地名の指定なし」＝絞り込みません。
 */
export function areaScope(areas) {
  if (!areas.length) return { regionIds: null, matched: [], missing: [] };
  const matched = areas.filter((a) => a.regionIds.length);
  const missing = areas.filter((a) => !a.regionIds.length);
  if (!matched.length) return { regionIds: null, matched, missing };
  const ids = new Set();
  // 「3大都市」のように、複数の地名を並べた言い方のときは、その内訳も
  // 返します。1つの街に固まらず、名指しされた街を1つずつ回るためです。
  //
  // 「日本全国」「九州」のような広い指定も同じです。地方（全国なら
  // 北海道・東北…、九州なら県）を内訳にして、1か所に固まらないようにします。
  // ただし広い指定に具体的な地名が混じっているとき（「九州の別府」）は、
  // 具体的なほうが言いたいことなので、散らしません。
  const isWide = (a) => a.kind === "nation"
    || (a.kind === "macro" && a.prefectures.length > 1);
  const spread = matched.every(isWide);
  const groupById = new Map();
  for (const a of matched) {
    for (const id of a.regionIds) ids.add(id);
    if (!a.groups) continue;
    if (isWide(a) && !spread) continue;
    for (const [id, name] of a.groups) if (name) groupById.set(id, name);
  }
  return { regionIds: ids, matched, missing, spread,
           groupById: groupById.size ? groupById : null };
}

/**
 * 地名についての説明文。応えられた場合も、応えられなかった場合も言います。
 */
export function areaNote(scope, { chosenRegionName, unknownTerms = [] } = {}) {
  const notes = [];
  const missing = [...scope.missing.map((a) => a.term), ...unknownTerms];
  if (missing.length) {
    const names = [...new Set(missing)].join("・");
    notes.push(`「${names}」は現在このアプリに収録がありません。`
      + "収録済みのエリアから、ご希望に近いものを提案しています。");
  }
  for (const a of scope.matched) if (a.reading) notes.push(a.reading);
  if (scope.matched.length && chosenRegionName) {
    const names = mostSpecific(scope.matched).map((a) => a.term).join("・");
    notes.push(`「${names}」の収録エリアの中から${chosenRegionName}を選びました。`);
  }
  return notes;
}

// 「屋久島に行きたい」——地名だけれど収録が無い、を言えるようにする。
//
// 地名の辞書を持って照合する方法は、抜けたぶんだけ黙って別の場所に
// すり替わるので採りません。代わりに「地名の形をしていて、収録データの
// どこにも現れない語」を探します。出てこない理由を言えることが大事で、
// 何を知らないかを網羅することは目的ではありません。
const PLACE_SUFFIX = /(島|山|岳|丘|砂丘|川|湖|沼|岬|崎|温泉|寺|神社|宮|城|園|峠|渓|滝|浜|浦|坂|橋|塔|宿|村|町|市|郡|県|府|地方|高原|海岸|渓谷|半島|平野|盆地|遺跡|城跡)$/;

/**
 * 地名として使われそうにないカタカナ語。
 * これを除かないと「カフェ」「ホテル」まで地名候補になります。
 */
const NOT_PLACE = new Set([
  "カフェ", "ホテル", "スパ", "サウナ", "アート", "グルメ", "ランチ",
  "ディナー", "ショッピング", "レストラン", "バス", "タクシー", "ツアー",
  "ロープウェイ", "スイーツ", "ビーチ", "パノラマ", "ミュージアム",
  "テーマパーク", "ハイキング", "リゾート", "ドライブ", "サイクリング",
  "キャンプ", "グランピング", "ダイビング", "シュノーケリング", "スキー",
  "スノーボード", "ゆっくり", "のんびり",
]);

/**
 * 「地名らしい語」だけを先に拾います。
 *
 * 収録と照らす前の段階です。段を遅れて読むようにしたので、
 * **照らす相手（名前の索引）を取りにいく必要があるかどうか**を、
 * 通信の前に知りたい、という用途です（packages/core/src/kb.js の ensureNames）。
 * 拾うものが無ければ、索引は要りません。
 */
export function placeCandidates(text) {
  const s = String(withJapanesePlaces(text) ?? "");
  if (!s.trim()) return [];
  const out = [];
  for (const term of new Set(wordRuns(s))) {
    if (!PLACE_SUFFIX.test(term)) continue;
    if (MACRO_AREAS[term]) continue;
    out.push(term);
  }
  for (const m of s.matchAll(/[ァ-ヶー]{2,}/g)) {
    const term = m[0];
    if (term.length < 2 || NOT_PLACE.has(term)) continue;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

export function unknownPlaceTerms(text, kb) {
  // ここも同じです。読み替えれば分かる地名を「知らない場所」として
  // 報告すると、断り文句だけが出て旅程が組めません。
  text = withJapanesePlaces(text);
  const s = String(text ?? "");
  // 名前の索引（kb.names）があれば、スポットが読み込まれていなくても
  // 照らせます。索引が無く、スポットも1件も無いときは、**照らす相手が
  // いないので何も言いません**（全部を「知らない場所」と言うより、
  // 黙っているほうが正しい）。
  if (!s.trim() || !(kb?.spots?.length || kb?.names)) return [];
  const haystack = kb.__searchHaystack ?? (kb.__searchHaystack = [
    // 名前の索引。段を遅れて読んでも、判定は変わりません（packages/core/src/kb.js）。
    kb.names ?? "",
    ...kb.spots.map((x) => `${x.name} ${x.region} ${x.prefecture} ${x.category} ${x.description ?? ""}`),
    ...kb.regions.map((r) => `${r.name} ${r.prefecture} ${r.station ?? ""} ${r.description ?? ""}`),
  ].join("\n"));

  const out = [];
  for (const term of new Set(wordRuns(s))) {
    if (term.length < 3 && !PLACE_SUFFIX.test(term)) continue;
    if (!PLACE_SUFFIX.test(term)) continue;
    if (haystack.includes(term)) continue;
    if (MACRO_AREAS[term]) continue;
    out.push(term);
  }

  // カタカナの地名（「パリ」「ハワイ」「ウユニ」）。
  //
  // wordRuns はカタカナを3文字以上でしか拾いません（「ーバ」のような
  // 断片で誤検索した過去があるため）。地名の判定はそれとは別の用途なので、
  // 2文字から拾い、収録に無く、地名らしくない語でもないものを候補にします。
  // これが無いと、キーが無いときに「パリ」が黙って別の土地に化けます。
  for (const m of s.matchAll(/[ァ-ヶー]{2,}/g)) {
    const term = m[0];
    if (term.length < 2 || NOT_PLACE.has(term)) continue;
    if (haystack.includes(term)) continue;
    if (out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

/**
 * 「京都・京都府」のように、同じ場所を指す語が並ぶのを避けます。
 * 広いほう（他方を丸ごと含むほう）を落として、具体的なほうを残します。
 */
export function mostSpecific(areas) {
  return areas.filter((a) => !areas.some((b) => {
    if (a === b || b.regionIds.length >= a.regionIds.length) return false;
    return b.regionIds.every((id) => a.regionIds.includes(id));
  }));
}

/**
 * 都道府県のおおよその中心と、そこからの許容半径（km）。
 *
 * AI に観光地を調べさせるとき、「愛媛県」と言いながら関東の座標を返す、
 * といった取り違えが起きます。名前と座標が食い違っていないかを機械的に
 * 確かめるための、粗い物差しです。厳密な境界は要りません。
 * 離島を抱える都県は半径を広く取っています（東京都の小笠原など）。
 */
export const PREF_CENTER = {
  北海道: [43.064, 141.347, 500], 青森県: [40.824, 140.740, 130],
  岩手県: [39.704, 141.153, 140], 宮城県: [38.269, 140.872, 120],
  秋田県: [39.719, 140.102, 140], 山形県: [38.240, 140.363, 130],
  福島県: [37.750, 140.468, 150], 茨城県: [36.342, 140.447, 120],
  栃木県: [36.566, 139.884, 110], 群馬県: [36.391, 139.060, 110],
  埼玉県: [35.857, 139.649, 110], 千葉県: [35.605, 140.123, 120],
  東京都: [35.690, 139.692, 1100], 神奈川県: [35.448, 139.643, 100],
  新潟県: [37.902, 139.023, 220], 富山県: [36.695, 137.211, 100],
  石川県: [36.595, 136.626, 140], 福井県: [36.065, 136.222, 120],
  山梨県: [35.664, 138.568, 100], 長野県: [36.651, 138.181, 160],
  岐阜県: [35.391, 136.722, 140], 静岡県: [34.977, 138.383, 150],
  愛知県: [35.180, 136.907, 110], 三重県: [34.730, 136.509, 140],
  滋賀県: [35.005, 135.869, 90], 京都府: [35.021, 135.756, 130],
  大阪府: [34.686, 135.520, 90], 兵庫県: [34.691, 135.183, 160],
  奈良県: [34.685, 135.833, 110], 和歌山県: [34.226, 135.167, 120],
  鳥取県: [35.504, 134.238, 120], 島根県: [35.472, 133.051, 220],
  岡山県: [34.662, 133.935, 110], 広島県: [34.396, 132.460, 130],
  山口県: [34.186, 131.471, 130], 徳島県: [34.066, 134.559, 110],
  香川県: [34.340, 134.043, 90], 愛媛県: [33.842, 132.766, 130],
  高知県: [33.560, 133.531, 150], 福岡県: [33.607, 130.418, 120],
  佐賀県: [33.249, 130.300, 90], 長崎県: [32.745, 129.874, 230],
  熊本県: [32.790, 130.742, 150], 大分県: [33.238, 131.613, 120],
  宮崎県: [31.911, 131.424, 140], 鹿児島県: [31.560, 130.558, 320],
  沖縄県: [26.212, 127.681, 500],
};

/** 日本の範囲。ここを外れた座標は、名前が何であれ採用しません。 */
export const JAPAN_BOUNDS = { minLat: 20.2, maxLat: 45.8, minLng: 122.8, maxLng: 154.1 };
