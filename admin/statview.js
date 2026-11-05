// 件数（/private/api/stats）を、画面に出せる形に集める関数。画面には依存しません。
//
// 入力は server/stats.js の summary の counts: { 日付: { 種類: { 鍵: 数 } } }。
// 協力してくれた人（オプトイン）はまだ少ないので、**少ないとき**を
// ふつうのこととして扱います（lowData）。

/** 種類ごとに、期間の合計を鍵別に。 */
export function totals(counts, kind) {
  const out = new Map();
  for (const day of Object.values(counts ?? {})) {
    for (const [k, n] of Object.entries(day[kind] ?? {})) out.set(k, (out.get(k) ?? 0) + n);
  }
  return out;
}

/** 日ごとの合計（グラフ用）。[日付, 数] の昇順。 */
export function perDay(counts, kind, pick = () => true) {
  return Object.keys(counts ?? {}).sort().map((d) => {
    let n = 0;
    for (const [k, v] of Object.entries(counts[d]?.[kind] ?? {})) if (pick(k)) n += v;
    return [d, n];
  });
}

const desc = (m) => [...m].sort((a, b) => b[1] - a[1]);

/** 入口ごとの呼び出し回数（接続回数）。 */
export function requestsByEndpoint(counts) { return desc(totals(counts, "req")); }

/**
 * 控え（キャッシュ）の当たり・外れ（#438）。入口ごとに
 * { path, hits, misses, hitRate, hitMs, missMs }。時間は平均（ミリ秒）。
 */
export function cacheSummary(counts) {
  const n = totals(counts, "cache");
  const ms = totals(counts, "cache_ms");
  const paths = new Set([...n.keys()].map((k) => k.replace(/ (hit|miss)$/, "")));
  return [...paths].sort().map((path) => {
    const hits = n.get(`${path} hit`) ?? 0;
    const misses = n.get(`${path} miss`) ?? 0;
    const avg = (kind, c) => (c ? (ms.get(`${path} ${kind}`) ?? 0) / c : null);
    return { path, hits, misses, hitRate: hits + misses ? hits / (hits + misses) : null,
             hitMs: avg("hit", hits), missMs: avg("miss", misses) };
  });
}

/** 国ごとの回数。国コードだけです（それより細かい場所は持ちません）。 */
export function byCountry(counts) { return desc(totals(counts, "country")); }

/**
 * 利用者ごとの回数。鍵は「その日の塩 + IP」のハッシュ頭8文字なので、
 * 日をまたいで同じ人かは分かりません。日ごとに見ます。
 */
export function usersByDay(counts) {
  return Object.keys(counts ?? {}).sort().map((d) => {
    const users = Object.entries(counts[d]?.user ?? {}).sort((a, b) => b[1] - a[1]);
    return { day: d, users: users.length, requests: users.reduce((a, [, n]) => a + n, 0), top: users.slice(0, 5) };
  });
}

/** 旅程づくりの結果。 */
export function planOutcome(counts) {
  const ev = totals(counts, "event");
  let ok = 0; let err = 0;
  const byTransport = new Map(); const reasons = new Map();
  for (const [k, n] of ev) {
    const [event, detail] = k.split("|");
    if (event === "plan_ok") { ok += n; byTransport.set(detail || "?", (byTransport.get(detail || "?") ?? 0) + n); }
    if (event === "plan_error") { err += n; reasons.set(detail || "理由不明", (reasons.get(detail || "理由不明") ?? 0) + n); }
  }
  const total = ok + err;
  return { ok, err, total, rate: total ? ok / total : null, reasons: desc(reasons), byTransport: desc(byTransport),
           lowData: total < 20 };
}

/** かかった時間（平均と幅）。 */
export function timing(counts) {
  const sum = totals(counts, "sum");
  const buckets = totals(counts, "secs");
  const order = ["0-10", "10-30", "30-60", "60-120", "120+"];
  const dist = order.map((b) => [b, (buckets.get(`plan_ok:${b}`) ?? 0)]);
  const n = sum.get("n:plan_ok") ?? 0;
  return { avgSecs: n ? (sum.get("secs:plan_ok") ?? 0) / n : null, n, dist };
}

/** AIに聞いた回数（ラウンド）。 */
export function rounds(counts) {
  const sum = totals(counts, "sum");
  const n = sum.get("rounds_n") ?? 0;
  const dist = [...totals(counts, "rounds")].sort((a, b) => Number(a[0]) - Number(b[0]));
  return { avg: n ? (sum.get("rounds") ?? 0) / n : null, n, dist };
}

/** 入力条件の分布。{ 項目: [[値, 数]...] }。成功・失敗のどちらも含みます。 */
export function conditions(counts) {
  const out = {};
  for (const [k, n] of totals(counts, "cond")) {
    const m = /^plan_(?:ok|error):([a-z]+)=(.+)$/.exec(k);
    if (!m) continue;
    const bucket = (out[m[1]] ??= new Map());
    bucket.set(m[2], (bucket.get(m[2]) ?? 0) + n);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, desc(v)]));
}

export const CONDITION_LABEL = {
  t: "移動手段", days: "日数", p: "人数", b: "予算を決めた", h: "穴場の混ぜかた",
  n: "希望の文を書いた", k: "混雑を避ける", pin: "必ず行くを選んだ", g: "好み",
};
