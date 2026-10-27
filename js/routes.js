// Google Maps Routes API。
//
// ■ 日本では、公共交通の経路が返りません（JAPAN_TRANSIT）
//
//   これは設定の問題でも、時間帯の問題でもありません。Google の経路APIは
//   日本国内の鉄道・バスの経路を返しません。東京→横浜のような、まず
//   間違いなく電車がある区間でも ZERO_RESULTS が返ります（同じ症状は
//   北千里→大阪でも報告されています）。日本の交通事業者のデータが
//   経路APIから引ける形で提供されていないためです。
//
//   したがって travelMode:"TRANSIT" は **投げません**。投げれば必ず
//   失敗し、それでも課金対象のリクエストは1回消費されます。
//
//   代わりに、駅・バス停の位置（js/stops.js）を使って組み立てます。
//
//     出発地 →(徒歩・Routes APIで実測)→ 最寄り駅
//     最寄り駅 →(距離からの目安)→ 目的地の最寄り駅
//     最寄り駅 →(徒歩・Routes APIで実測)→ 目的地
//
//   徒歩は日本でも返るので、端の1kmずつは実測になります。真ん中の
//   駅間だけが目安です。全部を直線距離で見積もっていたときより、
//   「駅から遠い目的地」の扱いがはっきりします。
//
// ■ 費用の設計方針
//
//   ・区間ごとに個別に問い合わせない。1回の computeRoutes に中間地点
//     （intermediates）をまとめて渡し、legs[] で各区間の所要時間を受け取る。
//     6スポットの旅なら 7区間 → リクエスト1回。
//   ・中間地点は10か所まで。11か所以上は上位SKU（Pro）の扱いになります。
//   ・optimizeWaypointOrder は使わない（上位SKU）。順序はこちらで決める。
//   ・交通量を見る routingPreference は使わない（上位SKU）。
//   ・Route Matrix は使わない（要素数ぶん課金されうるため）。
//   ・キーが無い / 失敗した場合は距離からの推定に落ちる。その場合は
//     routed:false を返し、画面に「推定」と出す。

import { TUNING, USE_ROUTES_API } from "./config.js";
import { endpointFor, keyHeaders, missingSecretHelp, proxyStatus, usingProxy }
  from "./endpoints.js";
import { effectiveConfig } from "./settings.js";
import { QuotaBlockedError, meteredFetch } from "./quota.js";
import { estimateMinutes, haversineKm, isSlowTerrain, taxiMinutes }
  from "./feasibility.js";
import { findStop, nearbyStops, nearestStop } from "./stops.js";
import { ropewayMinutes, ropewayNear } from "./ropeways.js";
import { summarizeTransitLeg, summarizeYahooRoute, transitFieldMask }
  from "./transit.js";
import { KIND_NOTE, asksTimetable, classifyLine, kindsOf, preferredKinds,
  yahooFlags } from "./modes.js";
import { getProvider } from "./providers.js";

// 公共交通の経路は、いま選ばれている取り口（js/providers.js）から引きます。
// 本体は取り口の名前（Yahoo!など）を知らず、決まった形の答えだけを使います。
const routing = () => getProvider("routing");
const searchYahooTransit = (from, to, opts) => routing().search(from, to, opts);
const yahooCooldown = () => routing().cooldown();
const resetYahooCooldown = () => routing().resetCooldown();
const resetYahooPace = () => routing().resetPace();

/**
 * どこへ投げるか。
 *
 * 毎回読み直します。設定画面で入れたキー（localStorage）が、
 * config.js より優先されます。起動時に1回だけ読むと、設定画面で
 * 保存したあともページを再読み込みするまで効かず、「入れたのに
 * 推定のまま」に見えます。
 */
function net() {
  const c = effectiveConfig();
  return { proxyUrl: c.proxyUrl, mapsKey: c.mapsKey };
}

/** 経路を呼べる状態か。プロキシ経由なら、キーはサーバーが持っています。 */
export function hasMapsAccess() {
  const c = net();
  return usingProxy(c) || Boolean(c.mapsKey);
}

/** 秒文字列 "1234s" を秒数に。 */
function parseDuration(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return parseFloat(m[1]);
    const n = parseFloat(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/**
 * 公共交通に渡す出発時刻。
 *
 * 時刻表は先の日付ぶんまで公開されていません。半年先・1年先の日時で
 * 問い合わせると、経路そのものが「見つかりません」で返ります
 * （実際に 2026年9月の旅程で全区間が推定に落ちていました）。
 *
 * 所要時間に効くのは「曜日と時刻」で、何週間先かはほとんど効きません。
 * そこで、遠い日付は **同じ曜日・同じ時刻の直近の日** に置き換えます。
 * 置き換えたことは modeNote で伝えます。
 */
export const TRANSIT_HORIZON_DAYS = 45;

/**
 * 便のある時間帯に寄せます。
 *
 * 旅程の時刻は、こちらが計算した「ちょうどの時刻」です。6:54 発の
 * ローカル線はまず走っていません。その瞬間で問い合わせると
 * 「経路が見つかりません」が返り、**その区間だけでなく旅程ぜんぶが
 * 推定に落ちていました**。
 *
 * 始発前・終電後は、いちばん近い運行時間帯に寄せて聞き直します。
 * 所要時間の目安としてはそれで足ります（寄せたことは画面に出します）。
 */
/**
 * 1リクエストに入れられる地点の数（出発地＋中間地点＋終点）。
 * 中間地点が11か所以上になると上位SKU（Pro）の扱いになるため、
 * 中間地点10か所ぶんの12で切ります。
 */
export const MAX_POINTS = 12;

const SERVICE_FROM = 7;
const SERVICE_TO = 21;

export function clampToService(date) {
  const d = new Date(date);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < SERVICE_FROM) { d.setHours(SERVICE_FROM, 30, 0, 0); return d; }
  if (h > SERVICE_TO) {
    d.setDate(d.getDate() + 1);
    d.setHours(SERVICE_FROM + 1, 0, 0, 0);
    return d;
  }
  return d;
}

/**
 * 出発時刻を指定しない問い合わせに使う、当たりさわりのない日時。
 *
 * 出発時刻を送らないと、Google 側は「いまこの瞬間」で調べます。すると
 * 深夜に押しただけで東京→横浜すら「経路が見つかりません」になり、
 * キーの問題と見分けがつかなくなります（設定の「確認」が実際そうでした）。
 * しかも departureTime が無いと departedAt も null になるため、
 * 「便のある時間帯へ寄せて聞き直す」再試行も動きません。
 *
 * 押した時刻に結果が左右されないよう、次の平日の10時に固定します。
 */
export function neutralDepartureTime(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  // 土日は本数が減る路線があるので、平日まで送ります。
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}

export function transitDepartureTime(date, now = new Date()) {
  const ahead = (date - now) / 86400000;
  if (ahead < 0) return new Date(now.getTime() + 60000);
  if (ahead <= TRANSIT_HORIZON_DAYS) return new Date(date);

  // 同じ曜日・同じ時刻で、いまから7〜13日後にあたる日
  const target = new Date(now);
  target.setDate(target.getDate() + 7);
  const diff = (date.getDay() - target.getDay() + 7) % 7;
  target.setDate(target.getDate() + diff);
  target.setHours(date.getHours(), date.getMinutes(), 0, 0);
  return target;
}

/**
 * 最後に降りたあとの徒歩（分）。
 *
 * 「駅に着く時刻」と「目的地に着く時刻」は違います。降りたあとの
 * 徒歩を足さないと、駅前に着いた時刻を到着として扱うことになります。
 */
function tailWalkMinutes(segments) {
  let n = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === "ride") break;
    if (segments[i].kind === "walk") n += segments[i].minutes;
  }
  return n;
}

/** 時刻を「8:30」の形に。画面に出す注記で使います。 */
function fmtHm(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function waypoint(p) {
  return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
}

/** 経路全体の移動手段を、点の散らばりから決めます。 */
export function pickMode(points, transport = "any") {
  // 指定があれば、そちらに従います。距離から推し量ると、車で来ている
  // 人にも「バスがないので行けません」と言うことになります。
  if (transport === "car") return "DRIVE";
  if (transport === "walk") return "WALK";
  // 電車＋現地の車。区間ごとに分けて聞きます（pipeline.js の
  // modeGroups）。ここに1つだけ返すときは、遠出のほうを答えます。
  if (transport === "transit+car") return "TRANSIT";
  // 空路・船・普通列車のみ。どれも「時刻表に聞く」移動なので、
  // Googleに渡す手段としては TRANSIT です。**どの乗り物を使うかは
  // Yahoo!に渡す旗（js/modes.js）で決まります。** ここで DRIVE に
  // 落とすと、飛行機の区間を車の道のりとして計算してしまいます。
  if (transport === "air" || transport === "ferry"
      || transport === "local" || transport === "air+car") return "TRANSIT";
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      max = Math.max(max, haversineKm(points[i], points[j]));
    }
  }
  if (transport === "transit") return "TRANSIT";
  return max > TUNING.transitThresholdKm ? "TRANSIT" : "WALK";
}

/** 連続した区間のうち、いちばん長いもの（km）。 */
function longestLegKm(points) {
  let max = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    max = Math.max(max, haversineKm(points[i], points[i + 1]));
  }
  return max;
}

/**
 * 失敗が続いたら呼ぶのをやめる。
 *
 * 設定の不備（APIが有効でない・制限に引っかかっている等）は、
 * 何度投げても同じ結果です。それでも呼び続けると、旅程1回につき
 * 数リクエストずつ課金対象の失敗が積み上がります。
 * 2回続けて 4xx が返ったら、そのページを開いている間は呼びません。
 */
const breaker = { fails: 0, open: false, reason: "" };

/**
 * 公共交通の区間ごとの問い合わせに使える回数。旅程1回ぶんの通しです。
 * 経路ごとに数えると、エリアが増えるだけ合計が膨らみます。
 */
const transitBudget = { spent: 0 };
// Yahoo!路線情報に聞いた回数（Googleの回数とは別勘定）。
// hits は、そのうち時刻が取れた区間の数です。legs は調べた区間の数。
const yahooBudgetSpent = { spent: 0, hits: 0, legs: 0 };

// 断られたときに待ち直す回数の上限。1回およそ1分です。
// 待てば入る時刻を、待たずに「目安」にするほうが損です。
const MAX_COOLDOWN_WAITS = 8;

/**
 * 1区間あたり、停留所の名前を何通りまで試すか。
 *
 * 最寄りの1件で引けないことは珍しくありません（同名の停留所が全国に
 * ある、両端の最寄りが同じ、バス停の名前をYahoo!が知らない）。
 * 2〜3通り試せばたいてい通りますが、それ以上は当たらないまま
 * 回数だけ使うので、ここで止めます。
 */
const YAHOO_NAME_TRIES = 3;
/** 片側につき、候補として拾う停留所の数。 */
const YAHOO_STOP_CANDIDATES = 3;
/** これより近ければ、停留所まで「歩いた」とは数えません（駅前の数十m）。 */
const NEAR_STOP_KM = 0.15;
/**
 * 停留所を探す半径。近い順に2段階。
 *
 * 5kmしか見ていませんでした。「岩尾内ダム」（北海道士別市）の5km以内に
 * 停留所は1つもありません。すると問い合わせる名前が作れず、**一度も
 * 聞かないまま「目安」**になります。画面には37.6kmが「約112分・目安」と
 * だけ出て、調べられなかったのか調べていないのかが分かりません。
 *
 * 地方では、駅まで10km というのは珍しくありません。そこまで見ます。
 * 駅までの徒歩は所要時間に足すので（歩けば2時間半です）、数字が
 * 甘くなることはありません。
 */
const STOP_REACH_KM = 5;
const STOP_REACH_FAR_KM = 15;
/** ここを超えたら、速くても歩きません。 */
const MAX_WALK_KM = 3;

/**
 * その距離を歩いたら何分か。時速4.2km、信号や坂のぶんを少し足します。
 *
 * estimateMinutes は 1km を超えると乗り物の速さに切り替わるので、
 * 「歩いたらどうか」を知りたいときには使えません。
 */
function walkMinutes(km) {
  return Math.max(5, Math.round((km / 4.2) * 60) + 4);
}

// 待っているあいだに「やめる」が押されたら、すぐ起きて止まります。
// 回数制限の待ちは1回で最長65秒です。押してから1分以上なにも
// 起きないのでは、やめるボタンの意味がありません。
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
  const timer = setTimeout(done, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});

/** 呼び出しの記録。画面で「何回呼んで、何が返ったか」を見せるため。 */
const usage = { calls: 0, failures: 0, lastError: "", skipped: 0 };

export function routesUsage() {
  return { ...usage, breakerOpen: breaker.open, breakerReason: breaker.reason,
           transitSpent: transitBudget.spent,
           // 電車・バスはGoogleではなくYahoo!に聞きます。ここを数えて
           // いなかったので、30区間を調べた旅程でも画面には何も出ず、
           // 「一度しか問い合わせていないのでは」と見えていました。
           yahooAsks: yahooBudgetSpent.spent,
           yahooLegs: yahooBudgetSpent.legs,
           yahooHits: yahooBudgetSpent.hits };
}

/**
 * 数えた回数を捨てます。テストと、設定を入れ直したときのためです。
 * 旅程を組み直すだけのときには呼びません（中継側の1分は続いています）。
 */
export function resetTransitPacing() {
  resetYahooPace();
  resetYahooCooldown();
}

export function routesBreakerState() {
  return { ...breaker };
}

export function resetRoutesBreaker() {
  transitBudget.spent = 0;
  yahooBudgetSpent.spent = 0;
  yahooBudgetSpent.hits = 0;
  yahooBudgetSpent.legs = 0;
  // 回数制限の待ちは、**消しません**。
  //
  // ここは旅程を組むたびに呼ばれます。前回の終わりに回数制限へ当たって
  // いると、その待ちを消して1区間目から投げ直すことになり、また同じ壁に
  // ぶつかります。そして最初の1区間が通らないので、以降も待たずに進み、
  // 全区間が「目安」になります。作り直すほど直らない、の正体でした。
  // 消してよいのは、設定の不備で止まっているときだけです（キーを入れ
  // 直した直後など、待っても意味がなく、条件が変わっているため）。
  if (!yahooCooldown().retryable) resetYahooCooldown();
  breaker.fails = 0;
  breaker.open = false;
  breaker.reason = "";
  usage.calls = 0;
  usage.failures = 0;
  usage.lastError = "";
  usage.skipped = 0;
}

/**
 * 設定の問題（キーが無効・APIが未有効・参照元の制限）か。
 * これは何度投げても同じ結果なので、1回で止めて構いません。
 */
function isConfigError(status, detail) {
  if (status === 401 || status === 403) return true;
  return status === 400
    && /API[ _]?KEY|api key|PERMISSION_DENIED|not (been )?enabled|referer/i
      .test(detail);
}

function noteFailure(status, detail) {
  usage.failures++;
  usage.lastError = detail;
  if (status < 400 || status >= 500) return;
  // 429（回数制限）は時間が経てば直ります。止めっぱなしにはしません。
  if (status === 429) return;
  if (isConfigError(status, detail)) {
    breaker.open = true;
    breaker.reason = detail;
    return;
  }
  // それ以外の 4xx は、その区間だけの都合（出発時刻が過去だった等）
  // かもしれません。1回で全部を止めると、旅程ぜんぶが推定に落ちます。
  // 3回続いたら、リクエストの形そのものが通っていないと見て止めます。
  breaker.fails++;
  if (breaker.fails >= 3) {
    breaker.open = true;
    breaker.reason = detail;
  }
}

/** Google のエラー本文から、人が読める1行を取り出します。 */
function readableError(text) {
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (e?.message) {
      return [e.status, e.message].filter(Boolean).join(" ");
    }
  } catch { /* JSON でなければそのまま */ }
  return text;
}

/**
 * 1区間ぶんの「なんとなくの目安」。
 *
 * 両端の近くに停留所（駅・バス停、js/stops.js）が見つかれば、
 * 「起点→最寄り停留所は徒歩」「停留所どうしは目安の速さ」
 * 「最寄り停留所→終点は徒歩」の3つに分けて見積もります。
 * 見つからなければ、これまでどおり直線距離1本の目安にします。
 *
 * 富士山五合目のような区間（速い公共交通はバス停まで、そこから先は
 * 登山道）を、ぜんぶ同じ速さで計算すると大きく外れるための工夫です。
 * 山まわりのカテゴリ（isSlowTerrain）に触れる徒歩区間だけ、
 * 街なかより遅い速さで見ます。停留所どうしの区間は、バスや鉄道が
 * 走っている前提なのでこれまでの推定式のままです。
 */
async function estimateLegRough(a, b) {
  const directKm = haversineKm(a, b);
  // 山道の見積もり（時速2.2km）は、**歩く距離のときだけ**です。
  //
  // ここを距離に関わらず使っていたので、5.1km先のダムへ「149分」と
  // 出ていました。歩けば確かにそれくらいですが、5kmを歩く人はいません。
  // 歩ける距離を超えたら、乗り物で行くものとして見ます。
  const walkable = directKm <= (TUNING.walkableKm ?? 1.5);
  const direct = estimateMinutes(a, b, {
    slow: walkable && (isSlowTerrain(a) || isSlowTerrain(b)),
  });
  // 短い区間では、停留所を挟む意味がありません（探す手間のほうが大きい）。
  if (directKm <= 1.5) return direct;

  const [stopA, stopB] = await Promise.all([
    nearestStop(a, Math.min(5, directKm / 2)),
    nearestStop(b, Math.min(5, directKm / 2)),
  ]);
  if (!stopA || !stopB) return direct;
  if (stopA.lat === stopB.lat && stopA.lng === stopB.lng) return direct;

  const walkA = estimateMinutes(a, stopA, { slow: isSlowTerrain(a) });
  const walkB = estimateMinutes(stopB, b, { slow: isSlowTerrain(b) });
  const between = estimateMinutes(stopA, stopB);
  const viaStops = walkA + between + walkB;

  // 停留所ぶん大きく遠まわりになるなら、その停留所は的外れだったと見て
  // 直線の目安に戻します。
  return viaStops <= direct * 2.2 ? viaStops : direct;
}

/** 推定にフォールバックしたときの結果。 */
async function estimatedLegs(points) {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    legs.push({
      minutes: await estimateLegRough(points[i], points[i + 1]),
      meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
      line: null,
      routed: false,
    });
  }
  return { legs, routed: false };
}

/**
 * リクエストの中身を組み立てます。
 *
 * 送る前の形をテストできるように、送信とは分けてあります。
 * 「TRANSIT に経由地を付けて 400 が返る」類の不具合は、
 * 実際に叩かなくてもここで捕まえられます。
 *
 * @returns {{body:object, fieldMask:string, mode:string, modeNote:string|null}}
 */
export function buildRouteRequest(points, opts = {}) {
  const mode = opts.mode ?? pickMode(points);
  // Routes API の制約: 公共交通（TRANSIT）は経由地を受け付けません。
  // 経由地つきで投げられるのは DRIVE / WALK / BICYCLE だけです。
  //
  // ここで TRANSIT を DRIVE に読み替えるのは誤りでした。鉄道とバスで動く
  // 旅程を、車の所要時間で組むことになります。とくに地方では、
  // 1時間に1本のバス区間を車の10分として計算してしまい、
  // 「時間内に収まる」と判定した旅程が現地で破綻します。
  // このアプリが防ぐはずの失敗そのものです。
  //
  // 経由地つきの公共交通は computeRoute が区間ごとに分けて取りにいくので、
  // ここに来ることはありません。来たなら呼び出し側の誤りなので止めます。
  if (mode === "TRANSIT" && points.length > 2) {
    throw new Error("公共交通に経由地は指定できません（区間ごとに分けてください）");
  }
  const effective = mode;
  let modeNote = null;
  if (mode === "TRANSIT" && opts.departAt
      && (opts.departAt - Date.now()) / 86400000 > TRANSIT_HORIZON_DAYS) {
    modeNote = "出発が先すぎて時刻表が公開されていないため、"
      + "同じ曜日・時刻の直近の日で所要時間を調べています";
  }

  const body = {
    origin: waypoint(points[0]),
    destination: waypoint(points[points.length - 1]),
    travelMode: effective,
    languageCode: "ja",
    units: "METRIC",
  };
  if (points.length > 2) {
    body.intermediates = points.slice(1, -1).map(waypoint);
    // 順序の最適化フラグは、車と二輪のときだけ受け付けられます。
    // 徒歩に付けて投げると 400 が返ります（4xx が半分近く出ていた原因の一つ）。
    // 既定は false なので、送らないこと自体が「順序を触らせない」ことです。
    if (effective === "DRIVE" || effective === "TWO_WHEELER") {
      body.optimizeWaypointOrder = false;
    }
  }
  let departedAt = null;
  if (effective === "TRANSIT") {
    if (opts.departAt) {
      departedAt = transitDepartureTime(opts.departAt);
      body.departureTime = departedAt.toISOString();
    }
  } else if (effective === "DRIVE") {
    // 交通量を見ない設定にして、基本SKUの範囲に収めます。
    // この設定では departureTime を送りません（併用は受け付けられません）。
    body.routingPreference = "TRAFFIC_UNAWARE";
  }

  const fieldMask = [
    "routes.duration",
    "routes.distanceMeters",
    "routes.legs.duration",
    "routes.legs.distanceMeters",
    // 乗換の中身は公共交通のときだけ返ります。他のモードで要求すると
    // フィールドマスク不正になる場合があるので、モードで出し分けます。
    ...(effective === "TRANSIT" ? transitFieldMask() : []),
  ].join(",");

  return { body, fieldMask, mode: effective, modeNote, departedAt };
}

/**
 * 経路全体を1回で取得します。
 *
 * @param {Array<{lat,lng}>} points 出発地 → 経由地… → 終点（2点以上）
 * @param {object} [opts]
 * @param {Date}   [opts.departAt]  TRANSIT のときの出発時刻（時刻表に効く）
 * @param {string} [opts.mode]      省略時は散らばりから自動判定
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{legs: Array<{minutes,meters,line,routed}>, routed: boolean,
 *                    mode: string, error?: string}>}
 */
/**
 * 同じ問い合わせを繰り返さないための控え。
 *
 * 案を作り直すと verifyProposal がもう一度走り、同じ経路を取り直して
 * いました。1回の旅程作成で 3リクエストのはずが 6 になっていた原因です。
 */
const routeCache = new Map();

const cacheKey = (points, mode, departAt) =>
  `${mode}|${departAt ? Math.floor(departAt.getTime() / 600000) : "-"}|`
  + points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");

export function clearRouteCache() { routeCache.clear(); legCache.clear(); }

/**
 * 公共交通の区間を、駅の位置から組み立てます。
 *
 * Googleの経路APIは日本の公共交通を返さないので（JAPAN_TRANSIT）、
 * 1区間を3つに分けて考えます。
 *
 *   出発地 →(徒歩)→ 最寄り駅 →(乗車)→ 目的地の最寄り駅 →(徒歩)→ 目的地
 *
 * 徒歩の部分は日本でも経路APIが返すので、**実測できます**。
 * 乗車の部分だけが距離からの目安です。全部を直線距離で見積もっていた
 * ときと比べて、「駅から遠い目的地」が正しく重くなります。
 *
 * 徒歩の実測は、旅程1回あたりの上限（TUNING.maxTransitRequests）まで。
 * 歩きが長い区間から順に使います。目安との差がいちばん大きいのは
 * そこだからです（駅前の300mを実測しても、答えはほとんど変わりません）。
 */
async function computeViaStations(points, opts) {
  const n = points.length - 1;
  // 長い区間でも、まずYahoo!に聞きます。
  //
  // 以前は700kmを超えると聞かずに、距離からの目安にしていました。これは
  // Googleの経路APIを想定した線引きで、Yahoo!には当てはまりません。
  // Yahoo!は新幹線も飛行機も含めて答えます（東京→鹿児島は約966km。
  // 目安では「約303分」でしたが、実際の便はもっとかかります）。
  // 引けなかったときだけ、これまでどおり目安に落ちます。
  // まずYahoo!路線情報に聞きます。**区間ごとに**聞くので、経由地のある
  // 旅程でも公共交通の実際の便が入ります（以前は2地点のときだけでした）。
  // 出発時刻は区間ごとにずらします。1区間目を10時に出るなら、
  // 2区間目に乗るのは10時ではありません。
  const plans = new Array(n);
  const yahooLegs = new Array(n).fill(null);
  // 聞かずに組んだ区間（山から山への登山道、ロープウェイと徒歩だけの区間）。
  const localLegs = new Array(n).fill(null);
  // 区間ごとの出発時刻。呼ぶ側が「この区間を通るのは何日目の何時か」を
  // 知っているなら、そちらを使います（pipeline.js が渡します）。
  // 所要時間だけを足していく下の時計は、滞在も宿泊もまたげません。
  // 3日目の区間を初日の昼として調べていたのが、これです。
  const given = Array.isArray(opts.departTimes) ? opts.departTimes : null;
  let clock = opts.departAt ? new Date(opts.departAt) : null;
  // Yahoo!の回数は、Googleの徒歩実測とは別に数えます。混ぜていたので、
  // 徒歩を測ると、そのぶん実際の時刻が取れなくなっていました。
  // Yahoo!は課金されず、中継側で控えるので、多めに取ります。
  let yahooBudget = Math.max(0,
    (TUNING.maxYahooRequests ?? 40) - yahooBudgetSpent.spent);
  // 断られたあと、どれだけ待ってやり直したか。
  let waited = 0;
  // 引けなかった区間を、あとでもう一度聞くための出発時刻。
  // 歩く区間には入れません（聞いていないので、聞き直すものもありません）。
  const askedAt = new Array(n).fill(null);
  // 聞き直すときに、何通りまで試すか（null なら残りの回数まで）。
  const retryTries = new Array(n).fill(null);
  // 歩く区間の数。「◯区間中◯区間で時刻表」の分母から外します。
  let walkLegs = 0;
  // 近くに駅・バス停が1つも無い区間の数。車が要る区間です。
  let noTransitLegs = 0;
  // どの区間がそれだったか。数だけだと、**画面でその行に印を出せません**。
  // 「目安」とだけ書かれた行を見て、読む人は「調べそこねたのか、
  // そもそも便が無いのか」を判断できず、作り直しても直らないものを
  // 何度も作り直すことになります。
  const noTransitAt = new Array(n).fill(false);
  // 拾い直した区間の数（画面の注記に出します）。
  let retried = 0;
  for (let i = 0; i < n; i++) {
    const at = given?.[i] instanceof Date ? given[i] : clock;
    // 断られている間は、**待ちます**。
    //
    // 電車・バスは中継の無料側の枠で数えるので、旅程1本ぶんでは
    // ふつう断られません。それでも当たったときは、諦めずに待ちます。
    // 以前は1つの枠を全部で分け合っていて必ず途中で断られ、3日目から
    // 先はまるごと「推定」になっていました。旅程づくりに1〜2分よけいに
    // かかっても、実際の時刻が入るほうが役に立ちます。
    //
    // 待つかどうかは、**断られた理由**で決めます。
    //
    //   429・5xx … 相手には届いています。待てば通ります。
    //   403・400 … 設定の不備なので、何分待っても同じ答えです。
    //
    // 以前は「その旅程で一度は答えが返っているとき」だけ待っていました。
    // 通信の無い場所で止まらないための取り決めでしたが、**前の旅程で
    // 回数制限に当たったまま次を組むと、1区間目から待てません**。
    // すると最後まで一度も答えが返らないので、以降も待たず、
    // 全区間が「目安」になります。作り直すほど直らない、の正体でした。
    const cool = yahooCooldown();
    const worthWaiting = cool.retryable || yahooLegs.some(Boolean);
    if (worthWaiting && yahooBudget > 0 && cool.waiting
        && waited < MAX_COOLDOWN_WAITS) {
      await sleep(Math.min(cool.seconds + 1, 65) * 1000, opts.signal);
      waited++;
    }
    // 歩く距離は、聞きません。
    //
    // 「高乗寺へ移動 07:46発→09:07着（1時間21分）・乗換2回・608円・
    // 約0.6km」。600mを1時間21分かけて、2回乗り換えて行く人はいません。
    // 歩けば8分です。全区間を聞くようにしたときに、**歩く区間まで
    // 聞いてしまう**ようになったのが原因でした。時刻表に聞けば時刻表は
    // 答えます。近すぎて直通がないので、遠回りの乗り継ぎが返ります。
    //
    // どこまで歩くかは、すでに決めてあります（TUNING.walkableKm、1.5km）。
    // その内側は歩きとして扱い、聞きに行きません。速いうえに、
    // 中継の回数もそのぶん残ります。
    const legKm = haversineKm(points[i], points[i + 1]);
    const onFoot = legKm <= (TUNING.walkableKm ?? 1.5);
    if (onFoot) walkLegs++;
    // やめると言われたら、残りの区間は聞きません。外れた区間を
    // 目安で埋めて続けると、要らない問い合わせが最後まで走ります。
    opts.signal?.throwIfAborted();
    const hit = (!onFoot && yahooBudget > 0 && routing().available !== false
        && !yahooCooldown().waiting)
      ? await yahooLeg(points[i], points[i + 1],
                       { ...opts, departAt: at, tries: yahooBudget })
      : null;
    // 使った回数は、当たっても外れても引きます。1区間で名前を3通り
    // 試したなら3回ぶんです。
    if (hit?.spent) {
      yahooBudget -= hit.spent;
      yahooBudgetSpent.spent += hit.spent;
    }
    if (hit?.noTransit) { noTransitLegs++; noTransitAt[i] = true; }
    if (hit?.local) {
      // 時刻表に載る乗り物が無い区間です。歩く区間と同じく、
      // 「◯区間中◯区間で時刻表」の分母には入れません。
      localLegs[i] = hit;
      walkLegs++;
      plans[i] = { minutes: hit.minutes, walkKm: 0, walk: true,
                   fromStop: null, toStop: null, walkMeasured: false };
    } else if (hit && !hit.miss) {
      yahooLegs[i] = hit;
      plans[i] = { minutes: hit.minutes, walkKm: 0,
                   fromStop: null, toStop: null, walkMeasured: false };
    } else if (onFoot) {
      plans[i] = { minutes: estimateMinutes(points[i], points[i + 1],
                                            { slow: isSlowTerrain(points[i])
                                                 || isSlowTerrain(points[i + 1]) }),
                   walkKm: 0, walk: true,
                   fromStop: null, toStop: null, walkMeasured: false };
    } else if (hit?.noTransit) {
      // 近くに駅もバス停もありません。歩くには遠い区間なので、
      // **タクシーで行くものとして**時間と運賃を見積もります。
      // 電車・バスの目安（待ち時間や乗り換えを含む数字）を当てると、
      // 乗り物が来ない場所ほど長く出るという逆のことが起きます。
      //
      // 聞き直しても停留所が生えるわけではないので、あとの拾い直しの
      // 列（askedAt）には入れません。
      plans[i] = { minutes: taxiMinutes(legKm), walkKm: 0, taxi: true,
                   fromStop: null, toStop: null, walkMeasured: false };
    } else {
      askedAt[i] = at;
      // Yahoo!が「経路なし」と答えた区間は、聞き直しを短くします。
      //
      // 山の区間では1区間に6回使っていました（位置で1回・停留所の
      // 名前で2回、それをもう一周）。断られた・つながらなかった区間は
      // 同じだけ聞き直し、答えが返っていた区間は2通りだけにします。
      retryTries[i] = hit?.definitive ? 2 : null;
      plans[i] = await planStationLeg(points[i], points[i + 1]);
    }
    if (clock) clock = new Date(clock.getTime() + plans[i].minutes * 60000);
  }

  // 引けなかった区間を、もう一度だけ拾い直します。
  //
  // 1回目に外す理由は、その区間が引けないからとは限りません。通信が
  // 一瞬切れた、中継が混んでいた、回数制限の一歩手前だった——どれも
  // 時間をおけば通ります。とくに**1区間目**は、まだ間隔の調整も待ちも
  // 効いていない状態で投げるので、いちばん外しやすい場所です。
  // 「東京駅 → 潮見駅」だけが目安で、あとは全部時刻が入っている、と
  // いう出かたは、これでした。
  //
  // 拾い直すのは、ほかの区間が引けているときだけです。ぜんぶ外して
  // いるなら、原因は区間ではなく設定か通信なので、もう一度投げても
  // 同じ答えが返るだけです。
  if (yahooLegs.some(Boolean)) {
    for (let i = 0; i < n; i++) {
      if (yahooLegs[i] || !askedAt[i] || yahooBudget <= 0) continue;
      const cool2 = yahooCooldown();
      if (cool2.waiting) {
        if (!cool2.retryable || waited >= MAX_COOLDOWN_WAITS) continue;
        await sleep(Math.min(cool2.seconds + 1, 65) * 1000, opts.signal);
        waited++;
      }
      const again = await yahooLeg(points[i], points[i + 1],
        { ...opts, departAt: askedAt[i],
          tries: Math.min(yahooBudget, retryTries[i] ?? yahooBudget) });
      if (again?.spent) {
        yahooBudget -= again.spent;
        yahooBudgetSpent.spent += again.spent;
        retried++;
      }
      if (again && !again.miss && !again.local) {
        yahooLegs[i] = again;
        plans[i] = { minutes: again.minutes, walkKm: 0,
                     fromStop: null, toStop: null, walkMeasured: false };
      }
    }
  }

  // 歩きの長い区間から実測します。
  const budget = Math.max(0,
    (TUNING.maxTransitRequests ?? 8) - transitBudget.spent);
  const order = plans
    .map((p, i) => ({ i, km: p.walkKm }))
    .filter((x) => x.km > 0.4)      // 駅前の数百mは測る意味がありません
    .sort((a, b) => b.km - a.km)
    .slice(0, budget);

  let measured = 0;
  for (const { i } of order) {
    const p = plans[i];
    if (!p.fromStop && !p.toStop) continue;
    const walked = await measureWalks(p, opts);
    if (walked) { plans[i] = walked; measured++; transitBudget.spent++; }
  }

  const legs = plans.map((p, i) => yahooLegs[i] ?? localLegs[i] ?? ({
    minutes: p.minutes,
    meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
    line: null,
    walk: p.walk === true,
    // 近くに駅・バス停が無かった区間。もう一度聞いても同じ答えなので、
    // タクシーで行くものとして組んであります。
    noTransit: noTransitAt[i] === true,
    taxi: p.taxi === true,
    // 真ん中（乗車）が目安なので、区間としては実測扱いにしません。
    routed: false,
    stations: p.fromStop && p.toStop
      ? { from: p.fromStop.name, to: p.toStop.name, walkMeasured: p.walkMeasured }
      : null,
  }));

  const searched = yahooLegs.filter(Boolean).length;
  // 数えるのは、聞くべき区間だけです。歩く区間を分母に入れると
  // 「7区間中4区間」と出て、3区間を引きそこねたように読めます。
  const rideLegs = n - walkLegs;
  yahooBudgetSpent.legs += rideLegs;
  yahooBudgetSpent.hits += searched;
  const viaStations = plans.filter((p) => p.fromStop && p.toStop).length;
  const parts = [];
  if (searched) {
    parts.push(`${rideLegs}区間のうち${searched}区間はYahoo!路線情報で検索`
      + (retried ? `（${retried}区間は聞き直し）` : ""));
  }
  if (walkLegs) parts.push(`${walkLegs}区間は徒歩`);
  if (noTransitLegs) {
    parts.push(`${noTransitLegs}区間は近くに駅・バス停が見当たりません`
      + "（車での移動になります）");
  }
  if (viaStations) {
    parts.push(`${viaStations}区間は最寄りの駅・バス停どうしの移動として`
      + "見ています"
      + (measured ? `（うち${measured}区間は駅までの徒歩を実測）` : ""));
  }
  return { legs, routed: searched === rideLegs, mode: "TRANSIT",
           modeNote: parts.length ? parts.join("、") : null,
           requests: measured + searched };
}

/**
 * 区間ごとの控え。
 *
 * 控えは旅程まるごと（全地点＋全区間の出発時刻）の鍵でしたが、5泊の
 * ように長いと、調べ直しの2周目で1区間でも出発時刻が動くだけで鍵が
 * 変わり、**43区間をすべて聞き直していました**。回数は旅程全体で
 * 数えているので、1周目で使い切って、2周目の区間は全部「目安」に
 * 落ちます。区間ごとに控えれば、動いていない区間は回数を使いません。
 */
const legCache = new Map();
const LEG_CACHE_MAX = 600;

export function clearYahooLegCache() { legCache.clear(); }

const legKey = (a, b, opts) =>
  [a, b].map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(">")
  + `|${opts.departAt instanceof Date
      ? Math.floor(opts.departAt.getTime() / 600000) : "-"}`
  + `|${opts.transport ?? "any"}`;

async function yahooLeg(a, b, opts) {
  const key = legKey(a, b, opts);
  const cached = legCache.get(key);
  if (cached) return { ...cached, spent: 0 };
  const res = await yahooLegUncached(a, b, opts);
  // 引けたもの（時刻・歩き・停留所なし）だけ控えます。外したものは
  // 控えません。通信の失敗や断りは次に聞けば通るかもしれず、「経路なし」
  // も、あとの拾い直しで別の名前を試すためです。
  if (res && !res.miss) {
    if (legCache.size >= LEG_CACHE_MAX) legCache.delete(legCache.keys().next().value);
    legCache.set(key, res);
  }
  return res;
}

/**
 * 1区間を、Yahoo!路線情報で調べます。引けなければ null。
 *
 * 出発地・目的地そのものは駅名ではないことが多いので、収録の停留所から
 * 最寄りを引いて名前にします（「箱根湯本駅」「大涌谷」）。
 */
async function yahooLegUncached(a, b, opts) {
  // 使った回数は、途中で失敗しても数えます。投げたものは投げたものです。
  let spent = 0;
  try {
    const [fromNames, toNames, accA, accB] = await Promise.all(
      [stopNamesFor(a), stopNamesFor(b), accessFor(a), accessFor(b)]);
    // 片側にも停留所が無いなら、公共交通では行けません。「調べたけれど
    // 引けなかった」とは別ものなので、分けて返します。画面で
    // 「目安」とだけ出すと、調べそこねたのか、そもそも便が無いのかが
    // 読む人に分かりません。
    if (!fromNames.length || !toNames.length || !accA || !accB) {
      return { spent: 0, miss: true, noTransit: true, definitive: true };
    }

    // **山から山へは、聞きません。**
    //
    // 黒岳 → 北鎮岳（3.3km）、小泉岳 → 白雲岳（1.4km）。どちらも
    // 登山道を歩く区間で、時刻表に載る乗り物はありません。それでも
    // 1区間ごとに位置で1回、近くの停留所の名前で2回聞き、外れると
    // あとでもう一度同じだけ聞いていました。山の多い旅程では、これで
    // 問い合わせの回数を使い切り、**後ろの区間は町なかでも時刻が
    // 引けなくなっていました**（43区間のうち10区間しか引けない）。
    const straightKm = haversineKm(a, b);
    const sideA = accessSide(accA, a, true);
    const sideB = accessSide(accB, b, false);
    if (accA.mountain && accB.mountain && !accA.direct && !accB.direct
        && straightKm <= MOUNTAIN_TRAIL_KM) {
      return trailLeg(a, b);
    }
    // 両端の乗り場が歩ける近さなら、乗り物の出番はありません。
    // 層雲峡（バスの終点）→ 黒岳 は、ロープウェイの山麓駅まで歩いて、
    // ロープウェイで上がって、山頂駅から歩きます。
    const gapKm = haversineKm(accA.at, accB.at);
    if (!(accA.direct && accB.direct) && gapKm <= ACCESS_WALK_KM) {
      return localLeg(a, b, sideA, gapKm, sideB);
    }

    // 名前の組を、見込みの高い順に作ります。
    //
    // 以前はここで**1組だけ**試し、両端が同じ名前になったら諦めて
    // いました。近い2地点（同じ駅が最寄りのスポットどうし）は必ずそこに
    // 落ちるので、街なかの短い移動はほとんど「目安」のままでした。
    // 2番目の停留所まで見れば、その多くは実際の時刻が引けます。
    //
    // 山頂のように乗り場から離れた端は、**その乗り場の近く**の名前で
    // 聞きます。山頂から5km以内の停留所を拾うと、尾根の向こう側の
    // バス停や、同じ名前の別の山（「旭岳」→ 1,100km先）に当たります。
    //
    // ロープウェイの山麓駅は、その名前では聞きません（Yahoo!は
    // 「◯◯ロープウェイ 山麓駅」を知りません）。山麓駅の近くの停留所です。
    const candsFor = (acc, names) => (acc.direct ? names
      : acc.stop ? [acc.stop]
        : nearbyStops(acc.at, STOP_REACH_KM, YAHOO_STOP_CANDIDATES));
    const [fromCands, toCands] = await Promise.all([
      candsFor(accA, fromNames), candsFor(accB, toNames),
    ]);
    const pairs = [];
    for (let i = 0; i < fromCands.length; i++) {
      for (let j = 0; j < toCands.length; j++) {
        const from = fromCands[i];
        const to = toCands[j];
        if (!from?.name || !to?.name) continue;
        if (sameStopName(from.name, to.name)) continue;
        pairs.push({ from, to, rank: i + j });
      }
    }
    pairs.sort((x, y) => x.rank - y.rank);
    // 残りの回数を超えて試しません。1区間に使い切ると、後ろの区間が
    // まるごと「目安」になります。
    const tries = Math.max(1,
      Math.min(YAHOO_NAME_TRIES, opts.tries ?? YAHOO_NAME_TRIES));
    let from = null;
    let to = null;
    let yahoo = null;
    let byLocation = false;
    // **指定された乗り物を、問い合わせにそのまま乗せます。**
    //
    // ここを渡していなかったので、画面で何を選んでも Yahoo!への
    // 問い合わせは同じ（全部の乗り物・速い順）でした。「電車で」を
    // 選んでも空路が返り、「フェリーで」を選んでも陸の経路が返ります。
    const ask = { ...opts,
      modes: yahooFlags(opts.transport ?? "any"),
      prefer: preferredKinds(opts.transport ?? "any") };

    // **まず、位置で聞きます。**
    //
    // 名前で聞くと、Yahoo!が同じ名前の別の場所に読み替えます。
    //
    //   「県庁前駅」（那覇）→ 県庁前(兵庫県)。沖縄の旅の行き帰りが
    //     東京⇔神戸の新幹線になり、飛行機が一度も出ませんでした。
    //   「京都駅前」（市バスの乗り場）→ 駅前の飲食店。
    //
    // 位置で聞けば、Yahoo!がその近くの駅・バス停を探し、停留所までの
    // 徒歩・バス・電車・飛行機をつないで答えます。近くのバス停から
    // 乗る区間も、ここで初めて引けるようになります。
    //
    // 聞くのは**乗り場の位置**です。山頂の位置で聞いても、Yahoo!は
    // 近くに駅を見つけられず、答えは返りません。ロープウェイが
    // 架かっていれば山麓駅、無ければいちばん近い停留所で聞きます。
    const label = (p, fallback) => ({ ...p, name: String(p?.name ?? "").trim() || fallback });
    const askFrom = accA.direct ? label(a, "出発地") : accA.at;
    const askTo = accB.direct ? label(b, "目的地") : accB.at;
    spent++;
    const near = await searchYahooTransit(askFrom, askTo, ask);
    // 位置を受け付けない古い中継だと、名前だけで聞いた答えが返ります
    // （スポット名で聞いたもの）。それは使わず、下の停留所名で聞きます。
    if (near?.routed && near.minutes > 0 && near.byLocation === true
        && plausibleRoute(near, askFrom, askTo)) {
      yahoo = near;
      from = askFrom;
      to = askTo;
      byLocation = true;
    }

    // 位置で引けなければ、これまでどおり近くの停留所の名前で聞きます。
    for (const cand of byLocation ? [] : pairs.slice(0, tries - 1)) {
      spent++;
      const r = await searchYahooTransit(cand.from, cand.to, { ...ask, byName: true });
      if (r?.routed && r.minutes > 0 && plausibleRoute(r, a, b)) {
        from = cand.from;
        to = cand.to;
        yahoo = r;
        break;
      }
    }
    // ここまで来て引けなければ、Yahoo!が「経路なし」と答えています。
    // 通信の不調ではないので、あとで聞き直しても同じです。
    if (!yahoo) return { spent, miss: true, definitive: true };

    // **停留所までの徒歩を足します。**
    //
    // ここが抜けていました。Yahoo!に聞いているのは「停留所から停留所」で
    // あって、「いまいる場所から次の場所」ではありません。足さないと
    //
    //   多摩森林科学園 → 浄泉寺（1.9km）を「1分」
    //
    // と出ます。Googleで同じ区間を引くと30分、うち27分が徒歩です。
    // 停留所どうしがたまたま隣で、乗っているのが1分だったというだけで、
    // 歩く27分をどちらの端にも数えていませんでした。
    //
    // 出発地そのものが駅なら（東京駅発など）、その端の徒歩は0です。
    // 位置で聞いたときは、Yahoo!の答えに停留所までの徒歩が入っています。
    //
    // 山頂の側は、乗り場から先（ロープウェイと山道）を足します。
    const endWalk = (acc, spot, stop, side) => {
      if (!acc.direct) {
        // 乗り場の近くの別の停留所で聞いたなら、そこから乗り場まで歩きます。
        const extra = byLocation || haversineKm(stop, acc.at) < NEAR_STOP_KM
          ? 0 : walkMinutes(haversineKm(stop, acc.at));
        return side.minutes + extra;
      }
      return byLocation || haversineKm(spot, stop) < NEAR_STOP_KM
        ? 0 : estimateMinutes(spot, stop, { slow: isSlowTerrain(spot) });
    };
    const walkA = endWalk(accA, a, from, sideA);
    const walkB = endWalk(accB, b, to, sideB);
    const total = walkA + yahoo.minutes + walkB;

    // 歩いたほうが早いなら、歩きます。
    //
    // 前後の徒歩を足すと、乗るより歩くほうが早い区間が出てきます
    // （上の例は、乗って30分・歩いて35分でほぼ互角です）。乗り換えて
    // 1分だけ乗るために20分歩く旅程は、読んだ人が従いません。
    //
    // 比べる相手は**本当に歩いた時間**です。estimateLegRough は 1.5km を
    // 超えると時速22kmの乗り物として見るので、それと比べると、実際に
    // 調べた時刻を作り話の目安に負けさせることになります。
    // 山へ上がる区間は、山道の速さで比べます（3kmの登りは47分では
    // 歩けません）。
    const onFoot = accA.mountain || accB.mountain
      ? hikeMinutes(straightKm, true) : walkMinutes(straightKm);
    if (straightKm <= MAX_WALK_KM && onFoot <= total) {
      return { spent, minutes: onFoot, walk: true, routed: false,
               meters: Math.round(straightKm * 1000) };
    }

    // 手順は、Yahoo!の区間の前後に、山頂の側（ロープウェイ・山道）を
    // つなぎます。乗り場までの徒歩は、山頂の側に入っています。
    const steps = withAccessSteps(
      summarizeYahooRoute(yahoo.meta, {
        walkA: accA.direct ? walkA : walkA - sideA.minutes,
        walkB: accB.direct ? walkB : walkB - sideB.minutes,
      }),
      sideA, sideB);
    const ropeway = ropewayInfo(sideA, sideB);
    return {
      spent,
      minutes: total,
      rideMinutes: yahoo.rideMinutes ?? yahoo.minutes,
      waitMinutes: yahoo.waitMinutes ?? 0,
      walkA, walkB,
      meters: Math.round(straightKm * 1000),
      // 画面に出す一行は、こちらで組み立てます。
      //
      // Yahoo!の要約をそのまま出すと、こうなります。
      //
      //   04:49 発→ 05:19 着 30分 （乗車 17分 ） / 乗換： 1 回 /
      //   IC優先： 375 円 / 8.2km（4:00出発で、次に乗れる便です）
      //
      // 旅程の1行としては長すぎます。読む人が知りたいのは、何時に出て
      // 何時に着くか、乗り換えが何回か、いくらか、の3つです。
      line: [transitLine(yahoo, walkA + walkB, total) ?? yahoo.summary
        ?? "Yahoo!路線情報", ...accessNotes(sideA, sideB)].join("・"),
      routed: true,
      searchedAt: yahoo.searchedAt ?? null,
      stations: byLocation
        ? { from: steps?.boardAt ?? from.name ?? null,
            to: steps?.alightAt ?? to.name ?? null, walkMeasured: true }
        : { from: from.name, to: to.name, walkMeasured: false },
      yahoo: yahoo.meta ?? null,
      // 乗る路線と乗り場の手順（どのバスに、どこから乗るのか）。
      // 旅程の行の「乗換の手順」で開けます。
      transit: steps ?? undefined,
      ropeway,
      alternatives: yahoo.meta?.alternatives ?? [],
      // **何に乗る区間なのか。**
      //
      // これが無いと、飛行機の区間も船の区間も「電車」として旅程に
      // 並びます。呼び名が違うだけなら我慢できますが、空港には
      // 搭乗手続きの時間が要り、船は欠航します。旅程がそのまま
      // 使えるかどうかが変わるので、種類として持ちます。
      //
      // 中継が数えたもの（yahoo.kinds）を先に使い、無ければ区間の
      // 路線名から見分けます（古い中継につながったときのため）。
      kinds: yahoo.kinds?.length ? yahoo.kinds
        : kindsOf(yahoo.meta?.legs ?? [{ line: yahoo.summary }]),
      // 指定した乗り物で組めたか。false なら、そう書きます。
      preferMet: yahoo.preferMet !== false,
    };
  } catch (e) {
    usage.lastError = `Yahoo Transit: ${String(e?.message ?? e).slice(0, 200)}`;
    // 断られた・つながらなかった。こちらは時間をおけば通ります。
    return { spent, miss: true };
  }
}

/** これより近くに駅・バス停があれば、その場所の位置のまま Yahoo!に聞きます。 */
const ACCESS_WALK_KM = 1;
/**
 * 山から山へ、これより近ければ登山道を歩く区間として扱い、聞きません。
 * 尾根づたいの縦走（黒岳 → 北鎮岳 → 白雲岳）はこの内側です。
 */
const MOUNTAIN_TRAIL_KM = 8;

/** 山頂・山のスポットか。カテゴリが無くても、名前で見ます（「◯◯岳」）。 */
function mountainish(p) {
  return isSlowTerrain(p)
    || /(山|岳|嶽|峰|ヶ峰)$/.test(String(p?.name ?? "").trim());
}

/** 山道を歩く時間（分）。山は時速2.2km、街は時速4.2kmで見ます。 */
function hikeMinutes(km, mountain) {
  if (!(km > 0)) return 0;
  return mountain ? Math.max(5, Math.round((km / 2.2) * 60)) : walkMinutes(km);
}

/** ロープウェイの乗り場の呼び名。「山麓駅」だけだと、どこの駅か分かりません。 */
function ropewayStation(rw, end) {
  const n = rw?.[end]?.name ?? "";
  return /^(山麓駅|山頂駅)$/.test(n) ? `${rw.name} ${n}` : n;
}

/**
 * Yahoo!に聞く端を決めます。
 *
 *   ・歩ける距離に駅・バス停がある … その場所の位置のまま聞きます
 *   ・ロープウェイの山頂駅が近い     … 山麓駅で聞きます
 *   ・どちらも無い                   … いちばん近い停留所で聞きます
 *
 * 片側にも停留所が無ければ null（公共交通では行けません）。
 */
async function accessFor(p) {
  const mountain = mountainish(p);
  // 山でなければ、その場所の位置で聞きます。Yahoo!は収録の停留所より
  // 多くのバス停を知っていて（「滝見台」）、位置からそれを選べます。
  if (!mountain || await nearestStop(p, ACCESS_WALK_KM)) {
    return { at: p, direct: true, hikeKm: 0, mountain };
  }
  const rw = await ropewayNear(p);
  if (rw) {
    return { at: { name: ropewayStation(rw, "base"), lat: rw.base.lat, lng: rw.base.lng },
             direct: false, ropeway: rw, hikeKm: rw.hikeKm, mountain };
  }
  const stop = (await nearbyStops(p, STOP_REACH_KM, 1))[0]
    ?? (await nearbyStops(p, STOP_REACH_FAR_KM, 1))[0];
  if (!stop) return null;
  return { at: stop, direct: false, stop, hikeKm: haversineKm(p, stop), mountain };
}

/**
 * 乗り場から先（または乗り場まで）の手順と時間。
 *
 * @param {boolean} leaving その場所を出る側か（山頂から下りる）
 */
function accessSide(acc, p, leaving) {
  if (!acc || acc.direct) return { minutes: 0, segments: [] };
  const hike = {
    kind: "walk", minutes: hikeMinutes(acc.hikeKm, acc.mountain),
    meters: Math.round(acc.hikeKm * 1000),
    ...(acc.mountain ? { trail: true } : {}),
  };
  if (acc.ropeway) {
    const rw = acc.ropeway;
    const t = ropewayMinutes(rw);
    const base = ropewayStation(rw, "base");
    const top = ropewayStation(rw, "top");
    const ride = {
      kind: "ride", line: rw.name, short: null, agency: null,
      vehicle: "ロープウェイ", vehicleKind: "ropeway", headsign: null,
      // 乗る行には路線名が付くので、駅は短い名前のままにします
      // （「山麓駅 → 山頂駅　大雪山層雲峡黒岳ロープウェイ（5分）」）。
      from: leaving ? rw.top.name : rw.base.name,
      to: leaving ? rw.base.name : rw.top.name, stops: null,
      departAt: null, arriveAt: null, minutes: t.ride,
      meters: Math.round((Number(rw.km) || 0) * 1000),
    };
    const wait = { kind: "wait", minutes: t.wait, at: leaving ? top : base };
    return {
      minutes: hike.minutes + t.total, hikeMinutes: hike.minutes,
      ropewayMinutes: t.total, rideMinutes: t.ride, waitMinutes: t.wait,
      segments: leaving ? [hike, wait, ride] : [wait, ride, hike],
      ropeway: rw, leaving, hikeKm: acc.hikeKm, spot: p,
    };
  }
  return {
    minutes: hike.minutes, hikeMinutes: hike.minutes,
    segments: [hike], stop: acc.stop, leaving, hikeKm: acc.hikeKm,
    noRopeway: acc.mountain, spot: p,
  };
}

/** 旅程の行に添える一言。ロープウェイがあるか、無いか。 */
function accessNotes(sideA, sideB) {
  const out = [];
  for (const side of [sideA, sideB]) {
    if (!side?.segments?.length) continue;
    const km = (side.hikeKm ?? 0).toFixed(1);
    const spot = side.spot?.name ?? (side.leaving ? "出発地" : "目的地");
    if (side.ropeway) {
      const rw = side.ropeway;
      // 「大雪山層雲峡黒岳ロープウェイ（山麓駅→山頂駅）で上がり、
      //  黒岳まで歩いて約2.2km」。どの駅で乗るのかを、先に書きます。
      const route = side.leaving
        ? `${rw.top.name}→${rw.base.name}` : `${rw.base.name}→${rw.top.name}`;
      out.push(side.leaving
        ? `${spot}から歩いて約${km}km、${rw.name}（${route}）で下ります`
        : `${rw.name}（${route}）で上がり、${spot}まで歩いて約${km}km`);
    } else if (side.noRopeway) {
      out.push(`${spot}へ上がるロープウェイはありません。`
        + `${side.stop?.name ?? "最寄りの停留所"}から登山道を約${km}km歩きます`);
    }
  }
  return out;
}

/** 区間に乗るロープウェイ（画面の印と、試験のため）。 */
function ropewayInfo(sideA, sideB) {
  const list = [sideA, sideB].filter((s) => s?.ropeway).map((s) => ({
    name: s.ropeway.name,
    base: ropewayStation(s.ropeway, "base"),
    top: ropewayStation(s.ropeway, "top"),
    direction: s.leaving ? "down" : "up",
    minutes: s.ropewayMinutes,
  }));
  const none = [sideA, sideB].filter((s) => s?.noRopeway)
    .map((s) => s.spot?.name).filter(Boolean);
  if (!list.length && !none.length) return undefined;
  return { rides: list, none };
}

/** Yahoo!の手順の前後に、山頂の側の手順をつなぎます。 */
function withAccessSteps(steps, sideA, sideB) {
  if (!steps) return steps;
  const pre = sideA?.segments ?? [];
  const post = sideB?.segments ?? [];
  if (!pre.length && !post.length) return steps;
  const segments = [...pre, ...steps.segments, ...post];
  const sum = (kind) => segments.filter((s) => s.kind === kind)
    .reduce((t, s) => t + (s.minutes ?? 0), 0);
  const rides = segments.filter((s) => s.kind === "ride");
  return {
    ...steps,
    segments,
    transfers: Math.max(0, rides.length - 1),
    walkMinutes: sum("walk"),
    rideMinutes: sum("ride"),
    waitMinutes: sum("wait"),
    headline: [sideA?.ropeway?.name, steps.headline, sideB?.ropeway?.name]
      .filter(Boolean).join(" → "),
  };
}

/** 山から山へ、登山道を歩く区間。聞きません。 */
function trailLeg(a, b) {
  const km = haversineKm(a, b);
  const minutes = hikeMinutes(km, true);
  const meters = Math.round(km * 1000);
  return {
    spent: 0, local: true, trail: true, walk: true, routed: false,
    minutes, meters,
    line: `登山道を歩きます（約${km.toFixed(1)}km）`,
    transit: {
      segments: [{ kind: "walk", minutes, meters, trail: true }],
      // 行にはもう「登山道を歩きます」と書いてあるので、重ねません。
      transfers: 0, walkMinutes: minutes, rideMinutes: 0, waitMinutes: 0,
      headline: "",
    },
  };
}

/** 乗り場どうしが歩ける近さの区間。ロープウェイと徒歩だけで組みます。 */
function localLeg(a, b, sideA, gapKm, sideB) {
  const gap = gapKm > NEAR_STOP_KM
    ? [{ kind: "walk", minutes: walkMinutes(gapKm), meters: Math.round(gapKm * 1000) }]
    : [];
  const segments = [...(sideA.segments ?? []), ...gap, ...(sideB.segments ?? [])];
  const minutes = segments.reduce((t, s) => t + (s.minutes ?? 0), 0);
  const sum = (kind) => segments.filter((s) => s.kind === kind)
    .reduce((t, s) => t + (s.minutes ?? 0), 0);
  const notes = accessNotes(sideA, sideB);
  return {
    spent: 0, local: true, walk: true, routed: false,
    minutes, meters: Math.round(haversineKm(a, b) * 1000),
    line: notes.length ? notes.join("・") : `徒歩約${minutes}分`,
    transit: {
      segments, transfers: Math.max(0, segments.filter((s) => s.kind === "ride").length - 1),
      walkMinutes: sum("walk"), rideMinutes: sum("ride"), waitMinutes: sum("wait"),
      // ロープウェイの名前は行に書いてあるので、重ねません。
      headline: "",
    },
    ropeway: ropewayInfo(sideA, sideB),
  };
}

/**
 * 名前で聞いた答えが、頼んだ2地点のあいだの経路として筋が通っているか。
 *
 * 名前は別の場所に読み替えられることがあります（「県庁前」→ 神戸）。
 * 那覇の2駅のあいだを聞いて、1,000km先を回る答えが返ったら、それは
 * 聞いた場所の経路ではありません。距離が分からなければ通します。
 */
export function plausibleRoute(r, a, b) {
  const km = Number(r?.meta?.distanceKm);
  if (!(km > 0)) return true;
  const straight = haversineKm(a, b);
  return km <= straight * 3 + 30;
}

/**
 * 旅程に出す、電車・バスの一行。
 *
 * 「4:49発→5:19着（30分）・乗換1回・375円」
 *
 * 元の要約にある距離（8.2km）と乗車時間（17分）は落とします。距離は
 * 地図で見れば分かり、乗車時間は「30分のうち何分座っているか」で、
 * 予定を立てるのには使いません。
 */
function transitLine(yahoo, walkMin = 0, totalMin = 0) {
  const m = yahoo?.meta ?? {};
  if (!m.departure || !m.arrival) return null;
  const parts = [`${m.departure}発→${m.arrival}着`];
  // 出す所要時間は、**その便に乗っている時間**です。
  //
  // yahoo.minutes は「頼んだ時刻から着くまで」で、便を待つ時間を含みます。
  // それをここに出すと「06:28発→08:49着（4時間49分）」になり、同じ行の
  // 中で計算が合いません（引き算すると2時間21分です）。
  const ride = yahoo.rideMinutes ?? yahoo.minutes;
  if (ride > 0) parts[0] += `（${fmtMinutes(ride)}）`;
  if (Number.isFinite(m.transfers)) {
    parts.push(m.transfers > 0 ? `乗換${m.transfers}回` : "乗換なし");
  }
  if (m.fareYen > 0) parts.push(`${m.fareYen.toLocaleString("ja-JP")}円`);
  // 停留所までの徒歩も書きます。
  //
  // 「10:07発→10:08着（1分）」とだけ書いてあると、1.9km先へ1分で
  // 行けるように読めます。実際は前後に歩きがあって、そちらのほうが
  // 長いことさえあります（この区間はGoogleで30分、うち徒歩27分）。
  if (walkMin > 0) {
    parts.push(`前後の徒歩${fmtMinutes(walkMin)}を含めて${fmtMinutes(totalMin)}`);
  }
  return parts.join("・");
}

/** 「90分」ではなく「1時間30分」。旅程は時計で読むものです。 */
function fmtMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}分`;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

/**
 * Yahoo!に渡す駅・バス停の名前を決めます。
 *
 * ここは、いつでも「その地点にいちばん近い停留所」を引いていました。
 * けれど出発地が **すでに駅** のときは、それが答えです。東京駅の
 * 半径5kmには何十もの停留所があるので、たまたま近い「呉服橋」や
 * 「丸の内南口」が選ばれます。すると
 *
 *   ・旅程には「東京駅 →」と書いてあるのに、調べたのは別の場所
 *   ・Yahoo!が名前を解決できず、時刻が取れないことがある
 *
 * の両方が起きます。**自分の名前で通るなら、そのまま使います。**
 */
async function stopNamesFor(point) {
  const out = [];
  const push = (s) => {
    if (!s?.name) return;
    if (out.some((x) => sameStopName(x.name, s.name))) return;
    out.push(s);
  };
  const name = String(point?.name ?? "").trim();
  if (name) {
    if (/(駅|港|空港|バス停|停留所)$/.test(name)) push(point);
    else {
      // 収録の停留所に同じ名前があるなら、それも「駅として通る名前」です。
      const exact = await findStop(name);
      if (exact) push(exact);
    }
  }
  for (const s of await nearbyStops(point, STOP_REACH_KM, YAHOO_STOP_CANDIDATES)) {
    push(s);
  }
  // 近くに1つも無ければ、広げて探します。無いまま返すと、その区間は
  // 一度も聞かれません。
  if (!out.length) {
    for (const s of await nearbyStops(point, STOP_REACH_FAR_KM,
                                      YAHOO_STOP_CANDIDATES)) push(s);
  }
  return out;
}

/** 「高尾山口」と「高尾山口駅」は同じ停留所です。 */
function sameStopName(a, b) {
  const norm = (s) => String(s ?? "").trim().replace(/[\s　]+/g, "")
    .replace(/駅$/, "");
  return norm(a) === norm(b);
}

/** 1区間ぶんの組み立て（まだ経路APIは呼びません）。 */
async function planStationLeg(a, b) {
  const directKm = haversineKm(a, b);
  // 歩ける距離の駅を探します。10km先の駅まで歩く旅程は組めません。
  const reach = Math.max(1.5, Math.min(5, directKm / 3));
  const [fromStop, toStop] = await Promise.all([
    nearestStop(a, reach), nearestStop(b, reach),
  ]);
  const usable = fromStop && toStop
    && !(fromStop.lat === toStop.lat && fromStop.lng === toStop.lng);
  if (!usable) {
    return { minutes: await estimateLegRough(a, b), walkKm: 0,
             fromStop: null, toStop: null, walkMeasured: false };
  }
  const walkA = estimateMinutes(a, fromStop, { slow: isSlowTerrain(a) });
  const walkB = estimateMinutes(toStop, b, { slow: isSlowTerrain(b) });
  // 乗るまでの待ちを乗せます。
  //
  // 距離だけで見ると、名古屋港水族館からレゴランドは5.5kmで「25分」に
  // なります。ところが実際は、あおなみ線まで歩き、列車を待ち、乗り換え、
  // また歩いて40分ほどです。**直線で近い＝鉄道で近い、ではありません。**
  // 何分待つかは時刻表しか知りませんが、「0分」でないことは確かです。
  const ride = estimateMinutes(fromStop, toStop) + (TUNING.transitWaitMin ?? 8);
  const viaStations = walkA + ride + walkB;
  const direct = await estimateLegRough(a, b);
  // 駅を経由するほうが大きく遠回りなら、その駅は的外れです。
  if (viaStations > direct * 2.2) {
    return { minutes: direct, walkKm: 0, fromStop: null, toStop: null,
             walkMeasured: false };
  }
  return { minutes: viaStations, walkKm: fromStop.km + toStop.km,
           a, b, fromStop, toStop, walkA, walkB, ride, walkMeasured: false };
}

/** 駅までの徒歩を、経路APIで実測して置き換えます。 */
async function measureWalks(plan, opts) {
  const { a, b, fromStop, toStop, ride } = plan;
  const [ra, rb] = await Promise.all([
    computeRouteUncached([a, fromStop], { ...opts, mode: "WALK" }),
    computeRouteUncached([toStop, b], { ...opts, mode: "WALK" }),
  ]);
  const walkA = ra.legs[0]?.routed ? ra.legs[0].minutes : plan.walkA;
  const walkB = rb.legs[0]?.routed ? rb.legs[0].minutes : plan.walkB;
  if (!ra.legs[0]?.routed && !rb.legs[0]?.routed) return null;
  return { ...plan, walkA, walkB, minutes: walkA + ride + walkB,
           walkMeasured: true };
}

export async function computeRoute(points, opts = {}) {
  const mode = opts.mode ?? pickMode(points);
  // 公共交通は、Googleの経路APIには投げません（JAPAN_TRANSIT）。
  // 日本国内では必ず「経路が見つかりません」が返り、それでも課金対象の
  // リクエストは消費されます。駅の位置から組み立てます。
  if (mode === "TRANSIT") {
    // 控えの鍵に、**選ばれた乗り物**を入れます。
    //
    // 入れないと、「電車で」で組んだあと「フェリーで」に変えても、
    // 同じ鍵に当たって前の答えが返ります。画面では選び直したのに
    // 旅程が変わらない、という出かたになります。
    const key = cacheKey(points, `TRANSIT-yahoo-${opts.transport ?? "any"}`,
                         opts.departAt)
      + (Array.isArray(opts.departTimes)
        ? "|" + opts.departTimes
          .map((d) => (d instanceof Date ? Math.floor(d.getTime() / 600000) : "-"))
          .join(",")
        : "");
    const hit = routeCache.get(key);
    if (hit) return hit;

    // 区間ごとにYahoo!路線情報へ聞き、引けない区間だけ駅の位置から見積もります。
    const result = await computeViaStations(points, opts);
    // 途中でやめた結果は控えません。目安で埋まった半端な答えが残ると、
    // 次に同じ条件で組んだときに、それが返ってきます。
    opts.signal?.throwIfAborted();
    routeCache.set(key, result);
    return result;
  }
  const key = cacheKey(points, mode, opts.departAt);
  const hit = routeCache.get(key);
  if (hit) return hit;
  const result = await computeRouteUncached(points, { ...opts, mode });
  opts.signal?.throwIfAborted();
  routeCache.set(key, result);
  return result;
}

async function computeRouteUncached(points, opts = {}) {
  const mode = opts.mode;
  if (points.length < 2) return { legs: [], routed: false, mode };
  // 中間地点は10か所まで。
  //
  // Routes API 自体は25か所ほど受け付けますが、**11か所以上は上位SKU（Pro）
  // の扱いになります**。基本料金（Essentials）に収めたいので、ここで切ります。
  // 超える経路は分割せず推定にします（分割すると結局リクエストが増えて、
  // 費用を抑える目的から外れるため）。
  if (points.length > MAX_POINTS) {
    return { ...(await estimatedLegs(points)), mode, error: "地点数が多すぎます" };
  }
  // 空路になる距離は、そもそも経路が引けません（海をまたぐ区間も同じ）。
  // 投げれば ZERO_RESULTS か 4xx が返るだけなので、呼ばずに推定にします。
  // キーの有無より先に見ます。キーがあっても呼ぶべきでない呼び出しだからです。
  const longest = longestLegKm(points);
  if (longest > 700) {
    return { ...(await estimatedLegs(points)), mode,
             error: `区間が長すぎます（最長 ${Math.round(longest)}km）。`
               + "空路のため経路検索は行いません" };
  }
  if (!hasMapsAccess()) {
    return { ...(await estimatedLegs(points)), mode,
             error: "経路APIのキーが未設定です（設定 →「開発者向け」から入力できます）" };
  }
  if (!USE_ROUTES_API) {
    usage.skipped++;
    return { ...(await estimatedLegs(points)), mode,
             error: "config.js の USE_ROUTES_API が false です" };
  }
  // 続けて失敗している間は呼びません。原因が直るまで課金だけが増えるためです。
  if (breaker.open) {
    return { ...(await estimatedLegs(points)), mode,
             error: `Routes API の呼び出しを停止しています（${breaker.reason}）` };
  }

  const { body, fieldMask, mode: effective, modeNote, departedAt } =
    buildRouteRequest(points, { ...opts, mode });

  usage.calls++;
  try {
    // 使用量の確認をここに置きます。数えるだけの場所に置くと、
    // 「やめる」を選んだあとも呼び続けてしまいます。
    const cfg = net();
    const res = await meteredFetch("routes", endpointFor("routes", {}, cfg), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...keyHeaders("maps", cfg),
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = `Routes API ${res.status}: ${readableError(text).slice(0, 200)}`;
      noteFailure(res.status, detail);
      return { ...(await estimatedLegs(points)), mode, modeNote, error: detail };
    }
    breaker.fails = 0;   // 1回でも通れば数え直し
    let data = await res.json();
    let route = data?.routes?.[0];

    if (!route?.legs?.length) {
      // 何が起きたのかを、そのまま残します。
      // 「経路が見つかりません」だけでは、設定の問題なのか、その区間に
      // 経路が無いだけなのかが切り分けられません。
      const why = effective === "TRANSIT"
        ? "その区間に公共交通が見つかりませんでした"
          + "（便のある時間帯でも試しています。バスしか無い区間や、"
          + "時刻表が未公開の先の日付で起きます）"
        : "その区間に道路経路が見つかりませんでした（海をまたぐ区間など）";
      usage.lastError = `ZERO_RESULTS: ${why}`;
      return { ...(await estimatedLegs(points)), mode, modeNote,
               error: `経路が見つかりません — ${why}` };
    }

    const legs = route.legs.map((leg) => {
      const out = {
        minutes: Math.max(1, Math.round(parseDuration(leg.duration) / 60)),
        meters: leg.distanceMeters ?? 0,
        line: null,
        routed: true,
      };
      if (effective !== "TRANSIT") return out;
      // 乗換・待ち時間・乗車時刻まで読み解きます。所要時間だけを出しても、
      // 現地で「いま予定どおりか」を確かめられないためです。
      const t = summarizeTransitLeg(leg, { startAt: departedAt });
      out.line = t.line;
      if (t.segments.length) out.transit = t;

      // **最初の電車を待つ時間を足します。**
      //
      // Routes API の leg.duration は、乗ってから降りるまでを返します。
      // 9:00 に駅へ着いて、次の電車が 9:35 なら、その35分は入りません。
      // その値をそのまま旅程に置くと、実際より早く着く前提で組むことに
      // なり、次の予定が押します。「経路APIを使っているのに、
      // ちゃんとした時間が出ない」のはこれでした。
      //
      // 出発時刻と、最初の乗車時刻の両方が分かるときだけ足します。
      // 分からないものを推測で埋めることはしません。
      if (departedAt && t.lastArriveAt) {
        const doorToDoor = Math.round((t.lastArriveAt - departedAt) / 60000);
        // 降りたあとの徒歩は duration に含まれるので、足し戻します。
        const afterWalk = tailWalkMinutes(t.segments);
        const real = doorToDoor + afterWalk;
        if (real > out.minutes) {
          out.waitedMinutes = real - out.minutes;
          out.minutes = real;
        }
      }
      return out;
    });

    // 区間数が合わない場合は足りないぶんを推定で補う（結果が壊れないように）
    while (legs.length < points.length - 1) {
      const i = legs.length;
      legs.push({
        minutes: estimateMinutes(points[i], points[i + 1]),
        meters: Math.round(haversineKm(points[i], points[i + 1]) * 1000),
        line: null, routed: false,
      });
    }
    return { legs, routed: legs.some((l) => l.routed), mode: effective, modeNote };
  } catch (e) {
    if (e instanceof QuotaBlockedError) {
      // 呼んでいないので、呼び出し回数には数えません。
      usage.calls--;
      usage.skipped++;
      return { ...(await estimatedLegs(points)), mode, modeNote, error: e.message };
    }
    return { ...(await estimatedLegs(points)), mode, modeNote,
             error: String(e?.message ?? e) };
  }
}

/**
 * 2点間だけを知りたいとき（出発地→最初のスポット など）。
 * 内部的には computeRoute を使うので、呼び出し回数の考え方は同じです。
 */
export async function computeLeg(from, to, opts = {}) {
  const r = await computeRoute([from, to], opts);
  return r.legs[0] ?? {
    minutes: estimateMinutes(from, to),
    meters: Math.round(haversineKm(from, to) * 1000),
    line: null, routed: false,
  };
}

/**
 * 経路の所要時間から、区間ごとの移動時間を引ける関数を作ります。
 * スケジューラはこれを travelFn として使うので、Routes API の有無に
 * かかわらず同じコードで動きます。
 */
export function legLookup(points, legs) {
  return legLookupAll([[points, legs]]);
}

const pairKey = (a, b) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}`
  + `->${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;

/**
 * 複数の経路をまとめて1つの travelFn にします。
 * 拠点を移す旅では「エリア内の経路」と「エリア間の経路」を別に取るので、
 * どちらから引いても同じ関数で答えられるようにしておきます。
 *
 * @param {Array<[Array<{lat,lng}>, Array<{minutes:number}>]>} entries
 */
export function legLookupAll(entries) {
  const map = new Map();
  for (const [points, legs] of entries) {
    for (let i = 0; i + 1 < points.length; i++) {
      map.set(pairKey(points[i], points[i + 1]), legs?.[i]?.minutes
        ?? estimateMinutes(points[i], points[i + 1]));
    }
  }
  return (a, b) => map.get(pairKey(a, b)) ?? estimateMinutes(a, b);
}

/**
 * 区間の中身（路線・乗換・待ち時間）を、2点の組から引きます。
 *
 * 所要時間だけを返す legLookupAll とは別に用意しています。時間の計算は
 * verify.js の仕事で、こちらは画面に出すための情報だからです。
 * 混ぜると、表示のために取った情報がスケジュール判定に紛れ込みます。
 *
 * 知らない組には null を返します。推定で埋めるかどうかは呼ぶ側が決めます。
 */
export function legDetailLookup(entries) {
  const map = new Map();
  for (const [points, legs] of entries) {
    if (!legs) continue;
    for (let i = 0; i + 1 < points.length; i++) {
      if (legs[i]) map.set(pairKey(points[i], points[i + 1]), legs[i]);
    }
  }
  return (a, b) => map.get(pairKey(a, b)) ?? null;
}

/**
 * Routes API のキーが実際に使えるかを、1リクエストだけで確かめます。
 *
 * 「キーを入れたのに反映されない」ときの原因は、たいてい次のどれかです。
 * 画面から呼べる形にして、どれなのかをその場で言えるようにしました。
 */
export async function diagnoseMapsKey(signal) {
  // 中継を使っているなら、まず**鍵が置かれているか**を確かめます。
  // 置かれていないまま上流へ投げると、Googleは「API key not valid」と
  // 返します。読んだ人は自分の入力を疑いますが、直す場所は中継です。
  const cfg = effectiveConfig();
  if (usingProxy(cfg)) {
    try {
      const st = await proxyStatus(cfg, signal);
      if (st && st.secrets && st.secrets.MAPS_API_KEY === false) {
        return { ok: false, code: "no-key",
          message: missingSecretHelp("MAPS_API_KEY", "経路APIのキー")
            + "\n※ 電車・バス（Yahoo!路線情報）はキー不要なので、"
            + "そちらは設定しなくても動きます。" };
      }
    } catch { /* 状態を取れなくても、下の実地の確認は行います */ }
  }
  if (!hasMapsAccess()) {
    return { ok: false, code: "no-key",
      message: "経路APIのキーが空です。上の欄に Google Maps Platform のキーを"
        + "貼るか、PROXY_URL に自分のバックエンドを設定してください。" };
  }
  // 「確認」は、いまの設定で **必ず1回投げます**。
  // 控え（cache）と停止スイッチ（breaker）を通すと、キーを直したあとも
  // 前の失敗がそのまま返り、「直したのに直らない」に見えます。
  breaker.open = false;
  breaker.fails = 0;
  breaker.reason = "";
  // **徒歩で確かめます。公共交通では確かめられません。**
  //
  // 以前は東京→横浜を TRANSIT で試していました。ところが Google の
  // 経路APIは、日本国内の公共交通の経路を返しません（JAPAN_TRANSIT の
  // コメント参照）。つまり、キーが正しくても必ず「経路が見つかりません」に
  // なります。キーの確認としては、何を確かめているのか分からない試験でした。
  //
  // 徒歩なら日本でも返ります。東京駅→日本橋の1kmで、キーと通信と
  // 課金設定がそろっているかだけを見ます。
  const tokyoStation = { lat: 35.681236, lng: 139.767125 };
  const nihonbashi = { lat: 35.683889, lng: 139.774444 };
  routeCache.delete(cacheKey([tokyoStation, nihonbashi], "WALK", undefined));
  const r = await computeRoute([tokyoStation, nihonbashi],
    { mode: "WALK", signal });
  if (r.routed) {
    return { ok: true, code: "ok",
      message: `Routes API に接続できました（東京駅→日本橋 徒歩約${r.legs[0].minutes}分）。`
        + "\n※ 日本国内では、Googleの経路APIは電車・バスの経路を返しません。"
        + "乗換の時間は、駅の位置からの目安で組み立てます。" };
  }
  const err = r.error ?? "";

  const m = /Routes API (\d+)/.exec(err);
  const status = m ? Number(m[1]) : 0;
  const here = globalThis.location?.origin
    ? `${globalThis.location.origin}/*` : "http://localhost:8000/*";
  const hint = status === 403
    ? "キーは届いていますが拒否されました。Google Cloud で ①Routes API を"
      + "有効化 ②請求先アカウントを紐付け ③キーのAPI制限に Routes API を含める "
      + `④HTTPリファラー制限に今のURL（${here}）を追加、`
      + "の4点をご確認ください。"
    : status === 400
      ? "リクエストが拒否されました。キーの文字列に余分な空白や改行が"
        + "入っていないか、キーの種類（Maps Platform のキー）をご確認ください。"
      : status === 429
        ? "回数制限に達しています。しばらく待つか割り当てをご確認ください。"
        : "ネットワークかブラウザの拡張機能に遮断されている可能性があります。";
  return { ok: false, code: status || "error", message: `${hint}\n詳細: ${err}` };
}

/**
 * 公共交通（Yahoo!路線情報）の疎通確認。
 *
 * 電車・バスの時間はGoogleではなくYahoo!路線情報から取ります。
 * 「確認」でGoogleだけを試すと、実際に旅程で使う側が通っているのか
 * 分かりません。新宿→箱根湯本で、中継とYahoo!の応答を見ます。
 */
export async function diagnoseYahooTransit(signal) {
  const shinjuku = { lat: 35.690921, lng: 139.700258, name: "新宿駅" };
  const hakone = { lat: 35.2325, lng: 139.1063, name: "箱根湯本駅" };
  // どこへ投げたのかを必ず出します。
  //
  // 中継の入口は2か所から決まります。設定画面に入れた値と、js/config.js。
  // **設定画面のほうが勝ちます。**以前どこかで入れた古い入口が残っていると、
  // config.js を直しても効かず、画面には「接続できませんでした」としか
  // 出ませんでした。どちらを使ったかが分かれば、その場で気づけます。
  const cfg = effectiveConfig();
  const where = (() => {
    try {
      const url = endpointFor("yahoo:transit", {}, cfg);
      const from = cfg.from?.proxyUrl === "settings" ? "設定画面"
        : cfg.from?.proxyUrl === "config" ? "js/config.js" : "未設定";
      return `\n投げ先: ${url}（${from}）`;
    } catch (e) {
      return `\n投げ先を決められません: ${String(e?.message ?? e)}`;
    }
  })();
  try {
    const r = await searchYahooTransit(shinjuku, hakone,
      { departAt: neutralDepartureTime(), signal });
    if (r?.routed && r.minutes > 0) {
      return { ok: true, code: "ok",
        message: `Yahoo!路線情報に接続できました（新宿駅→箱根湯本駅 約${r.minutes}分`
          + `${r.summary ? "・" + r.summary : ""}）。` + where };
    }
    return { ok: false, code: "no-route",
      message: "Yahoo!路線情報は応答しましたが、経路を取り出せませんでした。"
        + where + (r?.reason ? `\n詳細: ${r.reason}` : "") };
  } catch (e) {
    // 返事が返ってきているなら、出どころ（ALLOW_ORIGIN）の話ではありません。
    // 429 は「回数が多い」なので、設定を疑わせても直りません。
    if (e?.status) {
      return { ok: false, code: e.status,
        message: (e.status === 429
          ? "呼び出しが多すぎて、いま断られています。"
            + (e.retryAfter ? `${e.retryAfter}秒ほど` : "少し")
            + "待ってからもう一度お試しください。"
            + "\n※ 旅程は組めます。この間の電車・バスの時間は、"
            + "駅の位置からの目安になります。"
          : "Yahoo!路線情報に接続できませんでした。")
          + where + `\n詳細: ${String(e?.message ?? e)}` };
    }
    // 「Load failed」は、ブラウザが返事の中身を捨てたときの言い方です。
    // たいていは、このページの出どころが中継側で許されていない場合です
    // （中継は断り文句を返していますが、CORSの見出しが合わないと
    // ブラウザはそれを読ませません）。何を直せばいいのかを書きます。
    const here = globalThis.location?.origin ?? "";
    return { ok: false, code: "error",
      message: "Yahoo!路線情報に接続できませんでした。" + where
        // 返事が1文字も返っていない状態です。中継まで届いていれば、
        // 断られたとしても番号と本文が返ります。まず、このページと外の
        // あいだで止められていないかを疑います（拡張機能・社内網・圏外）。
        + "\n通信そのものが届いていません。広告ブロックなどの拡張機能を"
        + "切るか、プライベートウインドウでお試しください。"
        + (here ? `\n（このページの出どころは ${here} です。中継の`
          + "ALLOW_ORIGIN に入っていない場合も、同じ出かたになります）" : "")
        + `\n詳細: ${String(e?.message ?? e)}` };
  }
}
