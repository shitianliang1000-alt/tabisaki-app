// 公共交通の区間を、乗り換えと待ち時間まで含めて読み解く。
//
// 「1時間20分」とだけ出す旅程は、現地では使えません。
//
//   どの駅から乗るのか。何線か。どこで乗り換えるのか。何分待つのか。
//
// これが無いと、旅程どおりに動けているかを本人が確かめられません。
// 遅れが出たときに、どこを削れば取り返せるのかも分かりません。
//
// Routes API は steps[] にこの情報を返します。ここではそれを読み解いて、
// 画面に出せる形に直すだけです。時刻の計算はしません（API が返した
// 絶対時刻をそのまま使います）。推測で埋めるくらいなら、空にします。

import { classifyLine } from "./modes.js";

/** 秒文字列 "780s" を分に。 */
function minutesOf(v) {
  if (typeof v === "number") return Math.round(v / 60);
  const m = /^(\d+(?:\.\d+)?)s?$/.exec(String(v ?? "").trim());
  return m ? Math.round(parseFloat(m[1]) / 60) : 0;
}

function timeOf(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 乗り物の呼び名。API の種別しか無いときの受け皿です。 */
const VEHICLE_LABEL = {
  BUS: "バス", HEAVY_RAIL: "電車", SUBWAY: "地下鉄", METRO_RAIL: "地下鉄",
  COMMUTER_TRAIN: "電車", HIGH_SPEED_TRAIN: "新幹線",
  LONG_DISTANCE_TRAIN: "特急", TRAM: "路面電車", MONORAIL: "モノレール",
  FERRY: "フェリー", CABLE_CAR: "ケーブルカー", GONDOLA_LIFT: "ロープウェイ",
  FUNICULAR: "ケーブルカー", RAIL: "鉄道", TROLLEYBUS: "トロリーバス",
  SHARE_TAXI: "乗合タクシー", INTERCITY_BUS: "高速バス", OTHER: "公共交通",
};

/**
 * 1区間ぶんの公共交通の中身を読み解きます。
 *
 * @param {object} leg  Routes API の routes.legs[i]
 * @param {{startAt?: Date}} [opts]
 *   出発時刻。分かっているときだけ、最初の待ち時間を出します。
 *   分からないのに 0分 と書くと、間に合う前提の旅程になってしまいます。
 * @returns {{segments:Array, transfers:number, walkMinutes:number,
 *            rideMinutes:number, waitMinutes:number,
 *            boardAt:string|null, alightAt:string|null,
 *            firstDepartAt:Date|null, lastArriveAt:Date|null,
 *            line:string|null, headline:string}}
 */
export function summarizeTransitLeg(leg, opts = {}) {
  const steps = Array.isArray(leg?.steps) ? leg.steps : [];
  const segments = [];
  let walkMinutes = 0, rideMinutes = 0, waitMinutes = 0;

  // 直前に降りた時刻と、そこから歩いた分。次に乗るまでの待ちを出すために持ちます。
  let lastArrival = opts.startAt instanceof Date ? new Date(opts.startAt) : null;
  let walkSinceArrival = 0;

  for (const step of steps) {
    const td = step?.transitDetails;
    if (!td) {
      const min = minutesOf(step?.staticDuration ?? step?.duration);
      if (min <= 0) continue;
      walkMinutes += min;
      walkSinceArrival += min;
      segments.push({ kind: "walk", minutes: min,
                      meters: step?.distanceMeters ?? 0 });
      continue;
    }

    const sd = td.stopDetails ?? {};
    const depart = timeOf(sd.departureTime);
    const arrive = timeOf(sd.arrivalTime);
    const from = sd.departureStop?.name ?? null;
    const to = sd.arrivalStop?.name ?? null;
    const tl = td.transitLine ?? {};
    const line = tl.name || tl.nameShort || null;

    // 待ち時間。降りた時刻＋歩いた分から、次の発車までの差です。
    // どちらかが分からないときは、待ちを作りません。
    if (lastArrival && depart) {
      const readyAt = lastArrival.getTime() + walkSinceArrival * 60000;
      const wait = Math.round((depart.getTime() - readyAt) / 60000);
      if (wait > 0) {
        waitMinutes += wait;
        segments.push({ kind: "wait", minutes: wait, at: from });
      }
    }

    const rideMin = depart && arrive
      ? Math.round((arrive - depart) / 60000)
      : minutesOf(step?.staticDuration ?? step?.duration);
    rideMinutes += rideMin;
    segments.push({
      kind: "ride", line,
      short: tl.nameShort ?? null,
      agency: tl.agencies?.[0]?.name ?? null,
      vehicle: tl.vehicle?.name?.text
        ?? VEHICLE_LABEL[tl.vehicle?.type] ?? null,
      headsign: td.headsign ?? null,
      from, to,
      stops: td.stopCount ?? null,
      departAt: depart, arriveAt: arrive,
      minutes: rideMin,
      meters: step?.distanceMeters ?? 0,
    });

    lastArrival = arrive;
    walkSinceArrival = 0;
  }

  const rides = segments.filter((s) => s.kind === "ride");
  const out = {
    segments,
    transfers: Math.max(0, rides.length - 1),
    walkMinutes, rideMinutes, waitMinutes,
    boardAt: rides[0]?.from ?? null,
    alightAt: rides.at(-1)?.to ?? null,
    firstDepartAt: rides[0]?.departAt ?? null,
    lastArriveAt: rides.at(-1)?.arriveAt ?? null,
    line: rides[0]?.line ?? null,
  };
  out.headline = headlineOf(out);
  return out;
}

function headlineOf(s) {
  const parts = [];
  if (s.transfers === 0) parts.push(s.segments.some((x) => x.kind === "ride")
    ? "乗換なし" : "徒歩のみ");
  else parts.push(`乗換${s.transfers}回`);
  if (s.waitMinutes > 0) parts.push(`待ち${s.waitMinutes}分`);
  if (s.walkMinutes > 0) parts.push(`徒歩${s.walkMinutes}分`);
  return parts.join("・");
}

/** 時刻を HH:MM に。tz を渡すとその時間帯で読みます（試験用）。 */
function hhmm(d, tz) {
  if (!d) return "";
  // Yahoo!の区間は「10:15」の形で持っています。保存した旅程を開き直すと
  // 日時も文字列で戻ってくるので、Date に直してから読みます。
  if (typeof d === "string") {
    if (/^\d{1,2}:\d{2}$/.test(d)) return d.padStart(5, "0");
    d = new Date(d);
  }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ja-JP", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    ...(tz ? { timeZone: tz } : {}),
  });
}

/**
 * 画面にそのまま並べられる日本語の行にします。
 * 1行が1つの動作（歩く・待つ・乗る）に対応します。
 */
export function describeTransit(summary, opts = {}) {
  const tz = opts.tz;
  return summary.segments.map((s) => {
    if (s.kind === "walk") {
      // 山道は、街の徒歩と分けて書きます。同じ「徒歩60分」でも、
      // 靴も持ち物も違います。
      if (s.trail) {
        const km = s.meters ? `（約${(s.meters / 1000).toFixed(1)}km）` : "";
        return `登山道を歩いて${s.minutes}分${km}`;
      }
      const m = s.meters ? `（約${Math.round(s.meters)}m）` : "";
      return `徒歩${s.minutes}分${m}`;
    }
    if (s.kind === "wait") {
      return `${s.at ?? "乗り場"}で${s.minutes}分待ち`;
    }
    const name = [s.line, s.headsign ? `${s.headsign}行` : null]
      .filter(Boolean).join("・");
    const stops = s.stops ? `${s.stops}駅` : "";
    const times = s.departAt
      ? `${hhmm(s.departAt, tz)} ${s.from} → ${hhmm(s.arriveAt, tz)} ${s.to}`
      : `${s.from ?? ""} → ${s.to ?? ""}`;
    return `${times}　${name || s.vehicle || "公共交通"}`
      + `（${s.minutes}分${stops ? `・${stops}` : ""}）`;
  });
}

/**
 * Yahoo!路線情報で調べた経路を、乗り換えの手順の形にします。
 *
 * **ここが無かったので、バスの経路が画面に出ていませんでした。**
 *
 * 手順（segments）は Routes API の答えからしか作っていませんでした。
 * 日本の電車・バスは Yahoo!で引くようになったので、旅程の行には
 * 「10:10発→10:52着（37分）・乗換なし・230円」とだけ出て、
 * 何に乗るのか（京都市営バス7号、どのバス停から乗るのか）が
 * どこにも書かれていませんでした。中継は区間ごとの路線名と
 * 乗り場を返しているので（meta.legs）、それを並べます。
 *
 * @param {object} meta  中継の meta（legs: [{from,to,departure,arrival,minutes,line}]）
 * @param {{walkA?:number, walkB?:number}} [opts]
 *   停留所までの徒歩（分）。旅程の行はこれを含めて数えています。
 * @returns {object|null} summarizeTransitLeg と同じ形。区間が無ければ null。
 */
export function summarizeYahooRoute(meta, opts = {}) {
  const legs = Array.isArray(meta?.legs) ? meta.legs : [];
  if (!legs.length) return null;
  const segments = [];
  let walkMinutes = 0, rideMinutes = 0, waitMinutes = 0;
  const walk = (min) => {
    if (!(min > 0)) return;
    walkMinutes += min;
    segments.push({ kind: "walk", minutes: min, meters: 0 });
  };

  walk(Math.round(opts.walkA ?? 0));
  let readyAt = null;   // 前の区間を降りて（歩いて）次に乗れる時刻（分）
  for (const leg of legs) {
    const { kind, label } = classifyLine(leg?.line);
    const minutes = Number.isFinite(leg?.minutes) ? leg.minutes
      : clockGap(leg?.departure, leg?.arrival);
    if (kind === "walk") {
      walk(minutes ?? 0);
      const arrived = clockOf(leg?.arrival);
      if (arrived != null) readyAt = arrived;
      else if (readyAt != null) readyAt += minutes ?? 0;
      continue;
    }
    const dep = clockOf(leg?.departure);
    if (readyAt != null && dep != null) {
      const wait = (dep - readyAt + 1440) % 1440;
      if (wait > 0 && wait < 600) {
        waitMinutes += wait;
        segments.push({ kind: "wait", minutes: wait, at: stopName(leg?.from) });
      }
    }
    rideMinutes += minutes ?? 0;
    segments.push({
      kind: "ride",
      line: String(leg?.line ?? "").trim() || null,
      short: null, agency: null,
      vehicle: label, vehicleKind: kind,
      headsign: null,
      from: stopName(leg?.from), to: stopName(leg?.to),
      stops: null,
      departAt: leg?.departure ?? null, arriveAt: leg?.arrival ?? null,
      minutes: minutes ?? 0,
      meters: 0,
    });
    readyAt = clockOf(leg?.arrival);
  }
  walk(Math.round(opts.walkB ?? 0));

  const rides = segments.filter((s) => s.kind === "ride");
  if (!rides.length) return null;
  return {
    segments,
    transfers: Math.max(0, rides.length - 1),
    walkMinutes, rideMinutes, waitMinutes,
    boardAt: rides[0].from,
    alightAt: rides.at(-1).to,
    firstDepartAt: rides[0].departAt,
    lastArriveAt: rides.at(-1).arriveAt,
    line: rides[0].line,
    // 旅程の行に足す一言。乗換の回数と運賃は行にもう書いてあるので、
    // ここでは**何に乗るのか**だけを並べます（「京都市営バス・７号」）。
    headline: rides.map((r) => shortLine(r.line) || r.vehicle)
      .filter(Boolean).join(" → "),
  };
}

/** 「京都市営バス・７号・四条河原町 銀閣寺行」→「京都市営バス・７号・四条河原町」 */
function shortLine(line) {
  return String(line ?? "").replace(/\s+\S+行$/, "").trim();
}

/** 「銀閣寺道/京都市営バス」→「銀閣寺道」。会社名は路線名のほうに出ます。 */
function stopName(name) {
  const s = String(name ?? "").trim();
  if (!s) return null;
  return s.replace(/\/[^/()（）]+$/, "") || s;
}

function clockOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function clockGap(a, b) {
  const x = clockOf(a), y = clockOf(b);
  return x == null || y == null ? null : (y - x + 1440) % 1440;
}

/**
 * 公共交通のときに要求する項目。
 *
 * 必要なものだけを挙げます。経路の線（polyline）や案内文まで取ると
 * 応答が数十倍になり、通信量も課金も無駄に増えます。
 */
export function transitFieldMask() {
  return [
    "routes.legs.steps.travelMode",
    "routes.legs.steps.staticDuration",
    "routes.legs.steps.distanceMeters",
    "routes.legs.steps.transitDetails.transitLine.name",
    "routes.legs.steps.transitDetails.transitLine.nameShort",
    "routes.legs.steps.transitDetails.transitLine.agencies.name",
    "routes.legs.steps.transitDetails.transitLine.vehicle.name",
    "routes.legs.steps.transitDetails.transitLine.vehicle.type",
    "routes.legs.steps.transitDetails.headsign",
    "routes.legs.steps.transitDetails.stopCount",
    "routes.legs.steps.transitDetails.stopDetails.departureStop.name",
    "routes.legs.steps.transitDetails.stopDetails.departureTime",
    "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
    "routes.legs.steps.transitDetails.stopDetails.arrivalTime",
  ];
}
