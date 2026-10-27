// 名前のある列車を、旅程に反映する。
//
// 「サンライズに乗って山陰へ」「サフィール踊り子に乗りたい」と書かれても、
// これまでは素通りしていました。旅程は朝いちの新幹線で組まれ、
// **書いた人の希望がどこにも入りません。**
//
// 名前のある列車は、2つに分かれます。
//
//   時刻まで収録しているもの（サンライズ出雲・瀬戸）
//     毎日同じ時刻で走る定期の夜行です。前の日の夜に乗って翌朝に着き、
//     その晩の宿は要りません。区間としてそのまま組み込めます。
//
//   走る区間だけを収録しているもの（サフィール踊り子、リゾートしらかみ …）
//     運転日・時刻が変わるもの、季節運転のもの、抽選のものです。
//     **時刻は書きません。** 書けば、走らない日に「乗れる」旅程が出ます。
//     代わりに「どこへ向かう列車か」を使って行き先を寄せ、
//     時刻の確かめかたを添えます。
//
// Yahoo!路線情報は「いま出たら」で答えるので、狙った列車を引くのには
// 向きません（朝10時に聞けば、新幹線が返ります）。だから表を持ちます。
//
// **席が取れるかは、ここでは分かりません。** 寝台券・指定席券は別に要り、
// 休前日は早く埋まります。旅程には「乗れたとして」の時刻を置き、
// 確かめかたを添えます。

/**
 * 時刻まで収録している列車。いまは定期の夜行だけです。
 *
 * 時刻は2024年3月改正のもの。
 *
 * stops は停車駅を順に並べたものです。lat/lng は、旅程の地点と
 * 突き合わせるために持ちます（名前だけだと、収録の「出雲市」と
 * 駅の「出雲市駅」が別ものになります）。
 *
 * depart/arrive は、その駅を出る／着く時刻（"HH:MM"）。
 * nextDay が true の駅は、乗った日の翌日に着きます。
 */
export const TIMETABLED = [
  {
    id: "sunrise-izumo",
    name: "サンライズ出雲",
    note: "寝台特急。個室のほか、指定席券だけで乗れる「のびのび座席」があります",
    stops: [
      { name: "東京", lat: 35.6812, lng: 139.7671, depart: "21:50" },
      { name: "横浜", lat: 35.4660, lng: 139.6222, depart: "22:24" },
      { name: "熱海", lat: 35.1047, lng: 139.0781, depart: "23:23" },
      { name: "静岡", lat: 34.9714, lng: 138.3887, depart: "00:20", nextDay: true },
      { name: "浜松", lat: 34.7040, lng: 137.7348, depart: "01:12", nextDay: true },
      { name: "姫路", lat: 34.8266, lng: 134.6903, arrive: "05:25", depart: "05:26", nextDay: true },
      { name: "岡山", lat: 34.6661, lng: 133.9180, arrive: "06:27", depart: "06:34", nextDay: true },
      { name: "米子", lat: 35.4281, lng: 133.3311, arrive: "09:03", depart: "09:04", nextDay: true },
      { name: "松江", lat: 35.4681, lng: 133.0486, arrive: "09:29", depart: "09:30", nextDay: true },
      { name: "出雲市", lat: 35.3661, lng: 132.7549, arrive: "09:58", nextDay: true },
    ],
  },
  {
    id: "sunrise-seto",
    name: "サンライズ瀬戸",
    note: "寝台特急。個室のほか、指定席券だけで乗れる「のびのび座席」があります",
    stops: [
      { name: "東京", lat: 35.6812, lng: 139.7671, depart: "21:50" },
      { name: "横浜", lat: 35.4660, lng: 139.6222, depart: "22:24" },
      { name: "熱海", lat: 35.1047, lng: 139.0781, depart: "23:23" },
      { name: "静岡", lat: 34.9714, lng: 138.3887, depart: "00:20", nextDay: true },
      { name: "浜松", lat: 34.7040, lng: 137.7348, depart: "01:12", nextDay: true },
      { name: "姫路", lat: 34.8266, lng: 134.6903, arrive: "05:25", depart: "05:26", nextDay: true },
      { name: "岡山", lat: 34.6661, lng: 133.9180, arrive: "06:27", depart: "06:31", nextDay: true },
      { name: "高松", lat: 34.3499, lng: 134.0466, arrive: "07:27", nextDay: true },
    ],
  },
];

/** 地球上の2点の距離（km）。feasibility.js と同じ式です。 */
function km(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** その地点から乗り降りできる駅。遠ければ null。 */
const REACH_KM = 25;

function stopNear(train, point, { boarding }) {
  let best = null;
  for (const s of train.stops) {
    if (boarding && !s.depart) continue;
    if (!boarding && !s.arrive && s !== train.stops.at(-1)) continue;
    const d = km(s, point);
    if (d <= REACH_KM && (!best || d < best.km)) best = { stop: s, km: d };
  }
  return best;
}

function hhmmToMinutes(hm) {
  const [h, m] = String(hm ?? "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * 夜行の区間を組み立てます。乗れなければ null。
 *
 * @param {{lat,lng,name?}} from   出発地
 * @param {{lat,lng,name?}} to     目的地
 * @param {Date} departDate        出発する日（時刻は見ません）
 * @param {string} [prefer]        列車の id（「サンライズ出雲」など指定があれば）
 * @returns {{minutes,line,routed,overnight,boardAt,alightAt,
 *            departure,arrival,train,note}|null}
 */
export function nightTrainLeg(from, to, departDate, prefer = null) {
  if (!from || !to || !(departDate instanceof Date)) return null;
  let best = null;
  for (const train of TIMETABLED) {
    if (prefer && train.id !== prefer && train.name !== prefer) continue;
    const on = stopNear(train, from, { boarding: true });
    const off = stopNear(train, to, { boarding: false });
    if (!on || !off) continue;
    // 乗る駅は、降りる駅より前でなければなりません。
    if (train.stops.indexOf(on.stop) >= train.stops.indexOf(off.stop)) continue;
    const total = on.km + off.km;
    if (!best || total < best.total) best = { train, on, off, total };
  }
  if (!best) return null;

  const { train, on, off } = best;
  const depMin = hhmmToMinutes(on.stop.depart);
  const arrMin = hhmmToMinutes(off.stop.arrive ?? off.stop.depart);
  if (depMin === null || arrMin === null) return null;

  const board = new Date(departDate);
  board.setHours(0, 0, 0, 0);
  board.setMinutes(depMin);
  const land = new Date(board);
  land.setHours(0, 0, 0, 0);
  // 乗る駅が翌日側（静岡・浜松など深夜発）なら、そこから数えます。
  if (on.stop.nextDay) land.setDate(land.getDate() + 1);
  if (off.stop.nextDay && !on.stop.nextDay) land.setDate(land.getDate() + 1);
  land.setMinutes(arrMin);
  if (land <= board) land.setDate(land.getDate() + 1);

  const minutes = Math.round((land - board) / 60000);
  return {
    minutes,
    // 乗る時刻と着く時刻そのもの。夜行は「出発できる時刻＋所要時間」では
    // 着きません（10時に家を出ても、21:50発の列車は21:50発です）。
    boardAt_: board,
    arriveAt: land,
    rideMinutes: minutes,
    waitMinutes: 0,
    routed: true,
    overnight: true,
    train: train.name,
    boardAt: on.stop.name,
    alightAt: off.stop.name,
    departure: on.stop.depart,
    arrival: off.stop.arrive ?? off.stop.depart,
    line: `${train.name}・${on.stop.name} ${on.stop.depart}発`
      + ` → ${off.stop.name} ${off.stop.arrive ?? off.stop.depart}着`
      + `（車中泊・${Math.floor(minutes / 60)}時間${minutes % 60}分）`,
    note: `${train.name}は${on.stop.name}を${on.stop.depart}に出て、`
      + `翌朝${off.stop.arrive ?? off.stop.depart}に${off.stop.name}へ着きます。`
      + "その晩の宿は取りません（車中泊）。"
      + "寝台券・指定席券はJRの窓口やえきねっとでお求めください"
      + "（休前日は早く埋まります）。",
  };
}

/**
 * 走る区間だけを収録している列車。**時刻は書きません。**
 *
 * 運転日が限られるもの（観光列車）、季節で変わるもの、抽選のもの
 * （クルーズトレイン）です。時刻を書けば、走らない日に「乗れる」旅程が
 * 出ます。書かなければ、少なくとも嘘は出ません。
 *
 * 代わりに使えるのは「どこへ向かう列車か」です。「サフィール踊り子に
 * 乗りたい」と書いた人は、伊豆へ行きたいはずです。行き先を寄せるのは、
 * 時刻を知らなくてもできます。
 *
 * toward は、行き先を寄せるための地名。収録エリア名と突き合わせます。
 * bookable が false のものは、乗ること自体が旅の目的になる列車です
 * （申し込みの期限が数か月前）。
 */
export const NAMED_ROUTES = [
  { id: "saphir", name: "サフィール踊り子",
    alias: /サフィール|saphir/i,
    toward: ["伊豆急下田", "下田市", "河津町", "伊東市", "熱海市"],
    from: "東京",
    note: "サフィール踊り子は東京・横浜から伊豆急下田へ向かう全車グリーン車の"
      + "特急です。運転日と時刻はJR東日本の時刻表でご確認ください"
      + "（指定席のみ・えきねっとで発売）" },
  { id: "odoriko", name: "踊り子",
    alias: /踊り子|odoriko/i,
    toward: ["伊豆急下田", "下田市", "伊東市", "熱海市", "修善寺"],
    from: "東京",
    note: "踊り子は東京から伊豆へ向かう特急です。時刻はJR東日本の"
      + "時刻表でご確認ください" },
  { id: "shirakami", name: "リゾートしらかみ",
    alias: /しらかみ|shirakami/i,
    toward: ["五所川原市", "深浦町", "弘前市", "青森市", "秋田市"],
    from: "秋田",
    note: "リゾートしらかみは五能線（秋田〜青森）を走る観光列車です。"
      + "運転日が限られ、全席指定です。JR東日本の時刻表でご確認ください" },
  { id: "yufuin", name: "ゆふいんの森",
    alias: /ゆふいんの森|由布院の森|yufuin no mori/i,
    toward: ["由布市", "湯布院", "別府市", "日田市"],
    from: "博多",
    note: "ゆふいんの森は博多から由布院へ向かう観光特急です。"
      + "全席指定で、休日は早く埋まります。JR九州の時刻表でご確認ください" },
  { id: "iyonada", name: "伊予灘ものがたり",
    alias: /伊予灘ものがたり/,
    toward: ["大洲市", "八幡浜市", "伊予市", "松山市"],
    from: "松山",
    note: "伊予灘ものがたりは松山から伊予灘沿いを走る観光列車です。"
      + "運転日が限られ、食事付きの席は予約が要ります"
      + "（JR四国のサイトでご確認ください）" },
  { id: "hanayome", name: "花嫁のれん",
    alias: /花嫁のれん/,
    toward: ["七尾市", "和倉温泉", "金沢市"],
    from: "金沢",
    note: "花嫁のれんは金沢から和倉温泉へ向かう観光列車です。"
      + "おもに金・土・日に走ります。JR西日本の時刻表でご確認ください" },
  { id: "rokumon", name: "ろくもん",
    alias: /ろくもん/,
    toward: ["軽井沢町", "小諸市", "上田市", "長野市"],
    from: "長野",
    note: "ろくもんはしなの鉄道（長野〜軽井沢）の観光列車です。"
      + "運転日が限られ、食事付きのコースは予約が要ります"
      + "（しなの鉄道のサイトでご確認ください）" },
  { id: "fujisan-view", name: "富士山ビュー特急",
    alias: /富士山ビュー特急/,
    toward: ["富士河口湖町", "富士吉田市", "都留市"],
    from: "大月",
    note: "富士山ビュー特急は富士急行線（大月〜河口湖）の特急です。"
      + "時刻は富士山麓電気鉄道のサイトでご確認ください" },
  { id: "ametsuchi", name: "あめつち",
    alias: /あめつち/,
    toward: ["出雲市", "松江市", "米子市", "鳥取市"],
    from: "鳥取",
    note: "あめつちは山陰本線（鳥取〜出雲市）の観光列車です。"
      + "おもに週末に走ります。JR西日本の時刻表でご確認ください" },
  { id: "sl-gunma", name: "SLぐんま",
    alias: /SL(ぐんま|群馬)|蒸気機関車/i,
    toward: ["みなかみ町", "水上温泉", "安中市", "高崎市"],
    from: "高崎",
    note: "SLぐんまは高崎から水上・横川へ走る蒸気機関車です。"
      + "運転日は月に数日です。JR東日本の時刻表でご確認ください" },
  // --- 乗ること自体が目的の列車（申し込みが数か月前） ---
  { id: "nanatsuboshi", name: "ななつ星in九州",
    alias: /ななつ星|七つ星/, bookable: false,
    toward: ["九州"],
    note: "ななつ星in九州は、数日かけて九州を回るクルーズトレインです。"
      + "旅程に組み込めるものではなく、数か月前の抽選申し込みが要ります"
      + "（JR九州のサイトをご確認ください）" },
  { id: "shikishima", name: "四季島",
    alias: /四季島|しきしま/, bookable: false,
    toward: ["東日本"],
    note: "TRAIN SUITE 四季島は、数日かけて東日本を回るクルーズトレインです。"
      + "抽選申し込みが要ります（JR東日本のサイトをご確認ください）" },
  { id: "mizukaze", name: "瑞風",
    alias: /瑞風|みずかぜ/, bookable: false,
    toward: ["山陰", "山陽"],
    note: "TWILIGHT EXPRESS 瑞風は、山陰・山陽を回るクルーズトレインです。"
      + "抽選申し込みが要ります（JR西日本のサイトをご確認ください）" },
];

/**
 * 文の中の、名前のある列車を拾います。
 *
 * @param {string} text
 * @returns {{timetabled: object|null, named: object[]}}
 *   timetabled … 時刻まで収録している列車（サンライズ）。無ければ null。
 *   named      … 区間だけ収録している列車。複数書かれていれば複数。
 */
export function findTrains(text) {
  const s = String(text ?? "");
  const named = NAMED_ROUTES.filter((t) => t.alias.test(s));
  let timetabled = null;
  if (/サンライズ出雲|sunrise izumo/i.test(s)) timetabled = "sunrise-izumo";
  else if (/サンライズ瀬戸|sunrise seto/i.test(s)) timetabled = "sunrise-seto";
  else if (/サンライズ|寝台特急|夜行列車|sunrise/i.test(s)) timetabled = "any";
  return { timetabled, named };
}
