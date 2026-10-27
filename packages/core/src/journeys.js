// 名前のある「旅のしかた」を読み取る。
//
// 「最長往復切符で旅したい」「国道1号線の旅がしたい」と書く人がいます。
// これまでは、どちらも語として検索に回るだけでした。「最長」「往復」「国道」
// を説明文に含むスポットは無いので、点の高い順に近場が選ばれ、
// 「『国道1号線』に該当する場所は見つかりませんでした」と出ていました。
//
// 書いた人が言っているのは、行き先ではなく**旅の形**です。
//
//   国道1号線の旅   … 東京から大阪まで、国道1号に沿って車で走る
//   最長片道切符    … JRの線を、同じ駅を二度通らずにできるだけ長くたどる
//
// ここでは、その形を3つに落とします。
//
//   transport   … 何で移動するか（画面の選択と同じ値）
//   along       … 沿って訪れる地名（順番つき）。行き先の絞り込みに使います
//   spread      … 沿う道が決まっていない、全国をめぐる旅か
//
// 沿う街には、同名の別の土地がある名前（草津＝滋賀と群馬）を入れません。
//
// 名前と中身は、よく知られたものだけ手元に持っています（AIが使えない
// ときもこれで読めます）。手元に無いものは、AIの読み取り（ai.js の
// understandRequest が返す journey）に任せ、ここで形を整えます。
//
// **経路そのものは引きません。** 最長片道切符の正確な経路は、運賃計算の
// 規則と路線の変化で毎年変わります。分かるのは「全国を、移動を楽しみ
// ながら回る旅」というところまでです。そう書きます。

/** 手元に持っている旅のしかた。上から順に見ます（長い言い回しを先に）。 */
export const KNOWN_JOURNEYS = [
  {
    name: "最長片道切符",
    re: /最長片道(切符|きっぷ)?/,
    meaning: "JRの線を、同じ駅を二度通らずに一筆書きでできるだけ長く"
      + "たどる片道の乗車券の旅（北海道から九州まで、全国にわたります）",
    transport: "transit", enjoyTravel: true, spread: true, along: [],
  },
  {
    name: "最長往復切符",
    re: /最長往復(切符|きっぷ)?/,
    meaning: "JRの線を、行きと帰りで同じ区間をなるべく重ねずに、"
      + "できるだけ長くたどって出発地へ戻る乗車券の旅",
    transport: "transit", enjoyTravel: true, spread: true, along: [],
  },
  {
    name: "日本一周",
    re: /日本一周/,
    meaning: "日本の各地方を、ぐるりと回る旅",
    transport: null, enjoyTravel: true, spread: true, along: [],
  },
  {
    // 片道で通す旅です。出発地が南なら、南から北へたどります
    // （向きは packages/core/src/pipeline.js が出発地から決めます）。
    name: "日本縦断",
    re: /日本(列島)?縦断|列島縦断/,
    meaning: "日本列島を、端から端まで片道で通して旅すること",
    transport: null, enjoyTravel: true, spread: false, oneWay: true,
    along: ["青森", "盛岡", "仙台", "福島", "宇都宮", "東京", "静岡", "名古屋",
            "京都", "大阪", "岡山", "広島", "下関", "博多", "熊本", "鹿児島"],
  },
  {
    name: "東海道五十三次",
    re: /東海道五十三次|旧東海道/,
    meaning: "江戸の日本橋から京都の三条大橋まで、旧東海道の宿場町を"
      + "たどる旅",
    transport: null, enjoyTravel: true, spread: false,
    along: ["東京", "品川", "川崎", "横浜", "小田原", "箱根", "三島", "静岡",
            "浜松", "豊橋", "名古屋", "桑名", "亀山", "大津", "京都"],
  },
  {
    name: "中山道",
    re: /中山道|中仙道/,
    meaning: "江戸の日本橋から京都まで、内陸の山あいを抜ける旧中山道の"
      + "宿場町をたどる旅",
    transport: null, enjoyTravel: true, spread: false,
    along: ["東京", "大宮", "高崎", "軽井沢", "諏訪", "木曽", "馬籠",
            "中津川", "関ケ原", "彦根", "大津", "京都"],
  },
];

/**
 * 主な一桁国道。番号ごとに、沿う街を順に持ちます。
 * 「国道1号線の旅」「R1を走る」のような書きかたで読みます。
 */
export const NATIONAL_ROUTES = {
  1: { from: "東京", to: "大阪",
       along: ["東京", "横浜", "小田原", "箱根", "沼津", "静岡", "浜松",
               "豊橋", "名古屋", "四日市", "亀山", "大津", "京都", "大阪"] },
  2: { from: "大阪", to: "北九州",
       along: ["大阪", "神戸", "姫路", "岡山", "倉敷", "尾道", "広島",
               "岩国", "下関", "北九州"] },
  3: { from: "北九州", to: "鹿児島",
       along: ["北九州", "福岡", "久留米", "熊本", "八代", "水俣", "鹿児島"] },
  4: { from: "東京", to: "青森",
       along: ["東京", "宇都宮", "白河", "郡山", "福島", "仙台", "一関",
               "盛岡", "八戸", "青森"] },
  7: { from: "新潟", to: "青森",
       along: ["新潟", "村上", "鶴岡", "酒田", "秋田", "能代", "弘前", "青森"] },
  8: { from: "新潟", to: "京都",
       along: ["新潟", "長岡", "上越", "糸魚川", "富山", "金沢", "福井",
               "敦賀", "彦根", "京都"] },
  9: { from: "京都", to: "下関",
       along: ["京都", "福知山", "豊岡", "鳥取", "米子", "松江", "出雲",
               "益田", "萩", "下関"] },
};

const ROUTE_RE = /(?:国道|R|Ｒ)\s*([0-9０-９]{1,3})\s*号?線?/;

const toHalf = (s) => String(s).replace(/[０-９]/g,
  (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/**
 * 希望文から、手元で分かる旅のしかたを探します。
 * @returns {object|null} normalizeJourney と同じ形
 */
export function readJourney(text) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  for (const j of KNOWN_JOURNEYS) {
    if (j.re.test(s)) return normalizeJourney({ ...j, known: true });
  }
  const m = s.match(ROUTE_RE);
  if (m) {
    const no = Number(toHalf(m[1]));
    const r = NATIONAL_ROUTES[no];
    if (r) {
      return normalizeJourney({
        name: `国道${no}号線`, known: true,
        meaning: `${r.from}から${r.to}まで、国道${no}号に沿って走る旅`,
        transport: "car", enjoyTravel: true, spread: false, along: r.along,
      });
    }
  }
  return null;
}

const TRANSPORTS = ["transit", "car", "walk", "local", "ferry", "air"];

/**
 * 読み取った旅のしかたを、同じ形にそろえます。AIの答えもここを通します。
 * 名前が無ければ null（読み取れなかった）を返します。
 */
export function normalizeJourney(raw) {
  const name = String(raw?.name ?? "").trim().slice(0, 40);
  if (!name) return null;
  const along = (Array.isArray(raw.along) ? raw.along : [])
    .map((p) => String(p ?? "").trim()).filter((p) => p && p.length <= 20)
    .filter((p, i, a) => a.indexOf(p) === i).slice(0, 16);
  return {
    name,
    meaning: String(raw.meaning ?? "").trim().slice(0, 120),
    transport: TRANSPORTS.includes(raw.transport) ? raw.transport : null,
    enjoyTravel: raw.enjoyTravel === true,
    // 沿う街が分かっているなら、その道の旅です（全国に散らしません）。
    spread: raw.spread === true && along.length === 0,
    along,
    // 片道で通す旅（出発地へ戻らない）。
    oneWay: raw.oneWay === true && along.length > 1,
    known: raw.known === true,
  };
}

/**
 * どちらを使うか。手元で分かるものを先にします（AIの説明は、知られた
 * 旅でも経路を取り違えることがあるためです）。手元に無ければAIのもの。
 */
export function pickJourney(text, fromModel) {
  return readJourney(text) ?? normalizeJourney(fromModel);
}

/**
 * 希望文から旅のしかたの名前を取り除きます。地名を探す前に使います。
 * 「東海道五十三次」の「東海」を東海地方として読むと、沿う宿場町ではなく
 * 静岡・愛知・岐阜・三重全体に絞られてしまうためです。
 */
export function stripJourney(text, j) {
  let s = String(text ?? "");
  for (const k of KNOWN_JOURNEYS) s = s.replace(new RegExp(k.re.source, "g"), " ");
  s = s.replace(new RegExp(ROUTE_RE.source, "g"), " ");
  if (j?.name) s = s.split(j.name).join(" ");
  return s;
}

/** 旅程に添える一言。何として読み、どう組んだかを言います。 */
export function journeyNote(j, { from, stops } = {}) {
  if (!j) return "";
  const what = j.meaning ? `「${j.name}」は、${j.meaning}です。` : "";
  const how = j.oneWay && stops?.length
    ? `${from ? `${from}から` : ""}${stops.at(-1)}まで片道で進み、`
      + `毎日の終着を${stops.join("→")}にしています。`
    : j.along.length
    ? `${j.along[0]}から${j.along[j.along.length - 1]}までの道沿いから`
      + "行き先を選んでいます。"
    : j.spread ? "全国を地方ごとに回る旅として組んでいます。" : "";
  const caveat = j.known ? ""
    : "（この説明はAIの読み取りです。違っていたら、希望文で言い直してください）";
  return `${what}${how}${caveat}`;
}
