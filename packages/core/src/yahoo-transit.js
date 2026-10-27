import { endpointFor, readProxyError, requestSignal } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";

/**
 * Yahoo!路線情報の検索をバックエンド経由で実行します。
 *
 * 旅程で使うのは「この日、この時刻に出発地を出たら、次に乗れる
 * 公共交通で何時に到着するか」です。日時はそのまま渡します。
 */
/**
 * 断られたら、しばらく置いてから。
 *
 * 続けて何度も聞くと、Yahoo!からも中継の回数制限からも断られます（429）。
 * そこで**急がず**、失敗したら待ってもう一度、それでも駄目なら
 * しばらく聞かない、という形にします。旅程1つで区間の数だけ聞くので、
 * 断られた直後に残りを投げても、全部断られるだけです。
 */
const RETRY_WAIT_MS = [1500, 5000, 12000];
const COOLDOWN_MS = 60000;

/**
 * 断られる前に、こちらで間隔を空けます。
 *
 * 断られてから1分待つのは、待ち時間としては最悪の形です。断られた回は
 * やり直しになるうえ、その間の残りの区間も道連れになります。先に自分で
 * 数えておけば、やり直しそのものが起きません。
 *
 * 中継の枠は2つに分かれていて、電車・バス（Yahoo!）はお金のかからない
 * 側です。旅程1本ぶんを止めずに通せる速さにしてあります。
 */
// 中継のYahoo!の枠は1分600点（1回=1点）です。ここはその内側に収まって
// いれば足ります。旅程1本の30区間ほどを止めずに通せる速さにしつつ、
// 取り違えて無限に呼んでしまったときの歯止めは残します。
const PACE_PER_MINUTE = 120;
const PACE_WINDOW_MS = 60000;
const sentAt = [];

/** 次の1回を投げてよい時刻まで待ちます。 */
async function pace() {
  for (;;) {
    const now = Date.now();
    while (sentAt.length && now - sentAt[0] >= PACE_WINDOW_MS) sentAt.shift();
    if (sentAt.length < PACE_PER_MINUTE) { sentAt.push(now); return; }
    await sleep(PACE_WINDOW_MS - (now - sentAt[0]) + 50);
  }
}

/** テストと、旅程を組み直すときのために、数えた回数を捨てます。 */
export function resetYahooPace() { sentAt.length = 0; }
const cooldown = { until: 0, reason: "", retryable: false };

/**
 * いま聞ける状態か。旅程を組む側が、無駄な呼び出しを避けるために見ます。
 *
 * retryable は「待てば通るか」です。**ここを区別しないと直せません。**
 *
 *   429（回数が多い）・5xx  … 相手には届いています。待てば通ります。
 *   403・400（設定の不備）  … 何分待っても同じ答えです。
 *
 * 以前はどちらも同じ「待ち」として扱っていました。呼ぶ側は
 * 「一度も答えが返っていないなら待たない」という取り決めで身を守って
 * いましたが、そのせいで**前回の旅程で回数制限に当たったまま次を組むと、
 * 1区間目から待てず、全区間が目安**になっていました。
 */
export function yahooCooldown(now = Date.now()) {
  const left = Math.max(0, cooldown.until - now);
  return { waiting: left > 0, seconds: Math.ceil(left / 1000),
           reason: cooldown.reason, retryable: cooldown.retryable };
}

export function resetYahooCooldown() {
  cooldown.until = 0;
  cooldown.reason = "";
  cooldown.retryable = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchYahooTransit(from, to, opts = {}) {
  const cfg = effectiveConfig();
  const fromName = String(from?.name ?? from ?? "").trim();
  const toName = String(to?.name ?? to ?? "").trim();
  if (!fromName || !toName) return null;

  // 断られた直後は、間を置きます。ここで投げても、また断られます。
  const wait = yahooCooldown();
  if (wait.waiting && !opts.force) {
    const e = new Error(`あと約${wait.seconds}秒お待ちください（${wait.reason}）`);
    e.status = 429;
    e.retryAfter = wait.seconds;
    throw e;
  }

  // **頼まれた日時で調べます。**
  //
  // 以前は、過ぎた日なら「いま」、先すぎる日なら「同じ曜日の来週」に
  // 寄せていました。返ってくるのは別の日の便なので、旅程の時刻と
  // 食い違います（9月6日4:00発の旅程に「14:50発→18:40着」）。
  // Yahoo!は過ぎた日でもその日のダイヤで答えるので、寄せる必要は
  // ありませんでした。答えられない日はYahoo!がそう言います。
  const requested = opts.departAt ? new Date(opts.departAt) : neutralDepartureTime();
  const departAt = Number.isNaN(requested.getTime())
    ? neutralDepartureTime() : requested;

  // **どの乗り物を使ってよいかを、いっしょに渡します。**
  //
  // これまでは渡していなかったので、中継の側で「全部使う」を
  // 決め打ちしていました。すると
  //
  //   ・「電車で」と書いた人に、飛行機の経路が返る
  //   ・「フェリーで」と書いた人に、速い陸の経路が返る（船は候補に
  //     入っていても、到着が遅いので採られません）
  //   ・「普通列車で」（青春18きっぷ）と書いた人に、新幹線が返る
  //
  // のどれも起きます。旗（modes）と、優先して採る種類（prefer）を
  // 渡して、指定に合うものを選んでもらいます。
  //
  // 渡さなければ、中継はこれまでどおり「全部使う・速い順」で答えます
  // （古い画面がつながっても壊れません）。
  // 何を調べるか。既定は「その時刻に出たら次に乗れるのは何時か」。
  // "last" を渡すと、その日の**終電**を聞きます（中継が type=2 を
  // 立てます）。渡さなければ、これまでどおりです。
  const search = opts.search === "last" ? "last" : undefined;

  // 位置も渡します（中継が Yahoo!に flatlon / tlatlon として渡します）。
  // 名前だけだと、同じ名前の別の駅や、駅前の店に読み替えられます
  // （「県庁前」が神戸の駅に、「京都駅前」が飲食店に）。位置があれば、
  // Yahoo!がその近くの駅・バス停を選び、そこまでの徒歩も数えます。
  // opts.byName を立てると、これまでどおり名前だけで聞きます。
  const at = (p) => (!opts.byName && Number.isFinite(p?.lat) && Number.isFinite(p?.lng)
    ? { lat: p.lat, lng: p.lng } : undefined);
  const body = JSON.stringify({
    from: fromName,
    to: toName,
    fromAt: at(from),
    toAt: at(to),
    departAt: departAt.toISOString(),
    modes: opts.modes ?? undefined,
    prefer: opts.prefer?.length ? opts.prefer : undefined,
    search,
  });
  const url = endpointFor("yahoo:transit", {}, cfg);

  // 待ち時間は差し替えられます（テストで18秒待たないため）。
  const waits = Array.isArray(opts.retryWaits) ? opts.retryWaits : RETRY_WAIT_MS;
  let lastError = null;
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    if (attempt > 0) {
      // 待つ時間は、回を追うごとに伸ばします。同じ間隔で叩き続けても、
      // 相手の側の事情は変わりません。
      await sleep(waits[attempt - 1]);
    }
    // 断られる前に、こちらで間隔を空けます。テストと診断は素通しです。
    if (opts.pace !== false) await pace();
    let res;
    try {
      // 中継が黙ったままでも、区間ごとに何分も待たないようにします。
      res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body, signal: requestSignal(opts.signal, opts.timeoutMs),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
      // 通信そのものの失敗。1度だけ待ってやり直します。
      //
      // ここで最後まで粘ると、**区間の数だけ**同じ待ちが積み上がります。
      // 旅程1つで20区間あれば、届かない相手を相手に6分待つことになり、
      // 画面は「作成中」のまま止まって見えます。届かないものは、
      // 少し置いてからにします（下の hold）。
      if (attempt >= 1) break;
      continue;
    }
    if (res.ok) {
      resetYahooCooldown();
      const doc = await res.json();
      return { ...doc, searchedAt: departAt.toISOString() };
    }

    // 番号だけを投げていました。「Yahoo Transit 429」と出ても、
    // 断ったのがYahoo!なのか、中継の回数制限なのかが分かりません。
    // 待つ先が違うので、中継が付けてくれる手がかりごと受け取ります。
    const raw = await res.text().catch(() => "");
    const info = readProxyError(raw, res.status);
    const err = new Error(info.message || `Yahoo Transit ${res.status}`);
    err.status = res.status;
    err.code = info.code;
    err.retryable = info.retryable;
    err.retryAfter = info.retryAfter
      || Number(res.headers?.get?.("Retry-After")) || null;
    lastError = err;
    // 断られた（429）か、上流が不調（5xx）のときだけ、待って試します。
    // 400番台のほかは、待っても同じ答えです。
    //
    // 同じ答えなら、**残りの区間も投げません**。403（このサイトからは
    // 呼べません）のような設定の問題は、20区間投げても20回同じことを
    // 言われるだけです。
    if (res.status !== 429 && res.status < 500) { hold(err); throw err; }
  }

  // ここまで来たら、しばらく聞きません。旅程1つで区間の数だけ聞くので、
  // 断られた直後に残りを投げても、全部断られるだけです。
  hold(lastError);
  throw lastError ?? new Error("Yahoo!路線情報に接続できませんでした");
}

/** しばらく聞かない。区間ごとに同じ壁へぶつかりに行かないためです。 */
function hold(err) {
  const status = Number(err?.status ?? 0);
  const retryable = status === 429 || status >= 500
    || err?.retryable === true;
  // 待てば通るものは、言われたぶんだけ待ちます。中継が Retry-After を
  // 付けてくれるなら、それが最短です。1分固定で待つと、5秒で明ける
  // 制限に55秒よけいに座ることになります。
  const asked = (err?.retryAfter ?? 0) * 1000;
  cooldown.until = Date.now()
    + (retryable && asked > 0 ? asked : COOLDOWN_MS);
  cooldown.reason = String(err?.message ?? "断られました").slice(0, 60);
  cooldown.retryable = retryable;
}

function neutralDepartureTime(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}
