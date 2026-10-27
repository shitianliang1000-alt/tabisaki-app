// 費用の内訳。
//
// これまで「予算」を外していたのは、入場料しか数えておらず、
// 交通費も宿泊費も持っていなかったからです。合計が実態と何桁も違うのに
// 「予算内です」と出すのは、判断材料ではなく誤解の元でした。
//
// 交通費を距離から見積もれるようにしたので、内訳として出せる状態に
// なりました。実額ではないので「概算」とはっきり書きます。
// Routes API から運賃が取れた区間は、そちらを優先します。

import { TUNING } from "./config.js";

/**
 * 距離から公共交通の運賃を見積もります。
 *
 * 日本の鉄道は「初乗り + 距離逓減」なので、そのかたちに寄せています。
 * 長距離ほど1kmあたりが安くなる代わりに、新幹線の特急料金が乗ります。
 */
export function fareFor(km, { mode = "TRANSIT" } = {}) {
  if (!Number.isFinite(km) || km <= 0) return 0;
  // タクシー。初乗りと、そのあとの加算でできています。
  // 地域で幅がありますが（東京は初乗り¥500/1.096km・¥100/255m）、
  // 「だいたいいくらか」を知るには足ります。乗る前提の区間にしか
  // 使わないので、歩ける距離で呼び出されることはありません。
  if (mode === "TAXI") {
    if (km <= 1.1) return 500;
    return Math.round((500 + (km - 1.1) * 392) / 10) * 10;
  }
  if (mode === "WALK" || km < 1.2) return 0;
  if (km <= 3) return 150;
  if (km <= 10) return Math.round(150 + (km - 3) * 30);
  if (km <= 50) return Math.round(360 + (km - 10) * 22);
  if (km <= 150) return Math.round(1240 + (km - 50) * 18);   // 在来線＋特急
  // 新幹線帯。運賃＋特急料金をならした概算
  const rail = Math.round(3040 + (km - 150) * 20);
  if (km <= 700) return rail;
  // 700km を超えると空路が現実的になります。鉄道の式をそのまま伸ばすと
  // 東京〜パリが片道14万円を超え、実勢とかけ離れます。
  const air = Math.round(10000 + km * 8);
  return Math.min(rail, air);
}

const yen = (n) => Math.max(0, Math.round(n));

/** 借りる旅か（レンタカー代が要る旅か）。 */
const RENTS = new Set(["transit+car", "air+car"]);

/**
 * その区間を運転するか。
 *
 * 区間の側が答えを持っているなら、そちらが先です（電車＋現地の車では、
 * 同じ旅程の中に新幹線の区間と運転の区間が並びます。pipeline.js の
 * modeGroups が区間に書いています）。
 */
function isDriving(item, transport) {
  if (item.walk || item.taxi) return false;
  if (item.drive === true) return true;
  if (item.drive === false) return false;
  return transport === "car";
}

/**
 * 旅程の費用を項目ごとに積み上げます。
 *
 * @param {object} itin
 * @param {object} [opts]
 * @param {number} [opts.people] 人数（宿泊と入場に効きます）
 * @returns {{total:number, perPerson:number, rows:Array, estimated:boolean}}
 */
export function costBreakdown(itin, { people = 1, transport = "any" } = {}) {
  let transit = 0;
  let meals = 0;
  let admission = 0;
  let lodging = 0;
  let anyFare = false;
  // 運転する区間の距離。車の費用は、ここから出します。
  let driveKm = 0;
  let tollKm = 0;
  let tollLegs = 0;

  for (const day of itin.days) {
    for (const item of day.items) {
      switch (item.kind) {
        case "transit": {
          // 運転する区間は、**鉄道の運賃の式で数えません**。
          //
          // これまで車の旅でも fareFor(km, "TRANSIT") を通していました。
          // 700kmを運転すると「¥14,040」と出ます。鉄道の運賃です。
          // ガソリンも高速もレンタカーも、1円も数えていませんでした。
          // 「予算内です」と言われても、車旅では使えません。
          if (isDriving(item, transport)) {
            const km = item.km ?? kmOf(item);
            driveKm += km;
            if (km >= TUNING.tollFromKm) { tollKm += km; tollLegs += 1; }
            break;
          }
          if (typeof item.fareYen === "number") { transit += item.fareYen; anyFare = true; }
          else transit += fareFor(item.km ?? kmOf(item),
            { mode: item.taxi ? "TAXI" : item.walk ? "WALK" : "TRANSIT" });
          break;
        }
        case "meal": meals += item.costYen ?? TUNING.mealYen; break;
        case "spot": admission += item.costYen ?? 0; break;
        case "lodging": lodging += item.costYen ?? TUNING.lodgingYen; break;
        default: break;
      }
    }
  }

  // 車の費用は、**人数ではなく台数**で増えます。
  //
  // 4人で乗っても、ガソリン代は1台ぶんです。ここを人数倍すると、
  // 家族旅行の概算が4倍になります。
  const cars = Math.max(1, Math.ceil(people / TUNING.seatsPerCar));
  const fuel = driveKm > 0
    ? (driveKm / TUNING.kmPerL) * TUNING.fuelYenPerL * cars : 0;
  const toll = tollKm > 0
    ? (tollKm * TUNING.tollYenPerKm + tollLegs * TUNING.tollBaseYen) * cars : 0;
  // レンタカーは、借りる旅のときだけです。自分の車で行く旅（"car"）に
  // レンタカー代を足すと、行きもしない出費が乗ります。
  const rentDays = RENTS.has(transport) ? Math.max(1, itin.days?.length ?? 1) : 0;
  const rental = rentDays * TUNING.rentalYenPerDay * cars;

  const rows = [
    { key: "transit", label: "交通", yen: yen(transit * people),
      note: anyFare ? "一部は実際の運賃" : "距離からの概算" },
    // 前提をそのまま書きます。幅のある数字なので、読む人が自分の車に
    // 置き換えられるようにするためです。
    { key: "fuel", label: "ガソリン", yen: yen(fuel),
      note: `約${Math.round(driveKm)}km を ${TUNING.kmPerL}km/L・`
        + `${TUNING.fuelYenPerL}円/L で計算`
        + (cars > 1 ? `（${cars}台ぶん）` : "") },
    { key: "toll", label: "高速道路", yen: yen(toll),
      note: `${TUNING.tollFromKm}km を超える${tollLegs}区間を、`
        + "普通車の対距離料金で計算（下道なら不要です）" },
    { key: "rental", label: "レンタカー", yen: yen(rental),
      note: `${rentDays}日 × ${TUNING.rentalYenPerDay.toLocaleString()}円`
        + `（免責補償込みの目安${cars > 1 ? `・${cars}台` : ""}）` },
    { key: "meals", label: "食事", yen: yen(meals * people),
      note: `1食 ¥${TUNING.mealYen.toLocaleString()}で計算` },
    { key: "admission", label: "入場・拝観", yen: yen(admission * people),
      note: "収録の料金" },
    { key: "lodging", label: "宿泊", yen: yen(lodging * people),
      note: `1泊 ¥${TUNING.lodgingYen.toLocaleString()}で計算` },
  ].filter((r) => r.yen > 0);

  const total = rows.reduce((a, r) => a + r.yen, 0);
  // 数えていないものを、**数えたふりをしません**。
  //
  // 駐車場は、場所ごとに無料と有料が入り混じり、料金も持っていません。
  // 作った数字を足すより、「入っていません」と言うほうが役に立ちます。
  const missing = driveKm > 0 ? ["駐車場"] : [];
  return { total, perPerson: Math.round(total / Math.max(1, people)),
           rows, estimated: true, cars, missing };
}

/** 距離が入っていない移動の、座標からの補完。 */
function kmOf(item) {
  const a = item.from;
  const b = item.to;
  if (!a || !b) return 0;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
