// 中継（server/worker.js・server/node-proxy.mjs）の「開いた中継」対策。
//
// 中継は Origin を見て、知らないサイトからの呼び出しを断ります。ただし
// Origin は名乗りにすぎず、curl やスクリプトは好きな値を書けます。だから
// 本当の歯止めは回数制限です。その回数制限に、穴が2つありました。
//
//   1. IPv6 は、1つの契約で /64（2^64 個）のアドレスを持つのが普通です。
//      アドレスごとに数えると、末尾を変えるだけで枠が無限に増えます。
//      → IPv6 は /64 ごとにまとめて数えます（rateKey）。
//
//   2. 数えるのは IP ごとだけで、全体の上限がありませんでした。IP を
//      たくさん持つ相手なら、1つずつは上限の内側のまま、Gemini の
//      1日の無料枠や、従量課金の Routes API を使い切れます。
//      → お金・無料枠を使う側（paid）は、全員の合計にも1日の上限を
//        置きます（dailyLimit・jstDay）。超えたらその日は断ります。
//
// 1日の上限に当たると、正しい利用者もその日は使えなくなります。それでも、
// 請求が青天井になるよりは、止まるほうを選びます。上限は Worker の変数
// RATE_PAID_PER_DAY で変えられます（off で外せます）。

/** 1日の合計の既定値（点）。Gemini の生成1回 = 5点なので、約8,000回分。 */
export const DEFAULT_PAID_PER_DAY = 40_000;

/**
 * 回数を数える単位。IPv4 はそのまま、IPv6 は先頭 64 ビット（/64）。
 * IPv4 を埋め込んだ IPv6（::ffff:1.2.3.4）は IPv4 として扱います。
 * 読めない値は、そのまま返します（数えないよりはましです）。
 */
export function rateKey(ip) {
  const raw = String(ip ?? "").trim().toLowerCase();
  if (!raw.includes(":")) return raw || "unknown";
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const bare = raw.replace(/^\[|\]$/g, "").split("%")[0];
  const halves = bare.split("::");
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // 末尾が IPv4 の書きかた（::1.2.3.4 など）でも、先頭 64 ビットには
  // 関わらないので、2つ分の区切りとして数えるだけにします。
  const width = (parts) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const missing = 8 - width(head) - width(tail);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return raw;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  const first4 = groups.slice(0, 4);
  if (first4.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${first4.map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** 日本時間の日付（YYYY-MM-DD）。1日の合計は、日本の0時で数え直します。 */
export function jstDay(now = Date.now()) {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 1日の合計の上限。0 か off なら上限なし（null）。 */
export function dailyLimit(env) {
  const raw = String(env?.RATE_PAID_PER_DAY ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_PAID_PER_DAY;
}

/** 次の日本時間0時までの秒数（Retry-After に入れます）。 */
export function secondsToJstMidnight(now = Date.now()) {
  const jst = now + 9 * 3_600_000;
  const next = (Math.floor(jst / 86_400_000) + 1) * 86_400_000;
  return Math.max(1, Math.ceil((next - jst) / 1000));
}
