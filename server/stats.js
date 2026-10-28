// 管理画面のための、件数・変更待ちの置き場（Durable Object）。
//
// Analytics Engine はアカウントで有効にしないと使えず、KV や D1 は
// 先に入れ物を作ってその番号を wrangler.jsonc に書く必要があります。
// Durable Object はレート制限（RateLimiter）ですでに使っていて、
// **ダッシュボードで何もしなくても動きます。** ここに置きます。
//
// 残すもの
// --------
//   c:<日付>:<種類>:<鍵>  … 日ごとの件数（入口・国・出来事・条件・誤り）
//   e:<時刻>:<乱数>        … 誤りの記録（直近 MAX_ERRORS 件）
//   x:<時刻>:<乱数>        … スポットの変更待ち（管理画面から足したもの）
//   cleaned                … 最後に古いものを片付けた日
//   salt:<日付>            … 利用者を区別するための、その日だけの塩
//
// 残さないもの
// ------------
//   IP・入力した文・地名・旅程・位置。利用者ごとの件数は
//   「その日の塩 + IP」のハッシュの頭8文字で数えます。塩は日ごとに
//   作り直して古いものは消すので、日をまたいで同じ人だとは分かりません
//   し、ハッシュから IP にも戻せません。国は Cloudflare が付ける国コード
//   （JP など）だけで、それより細かい場所は扱いません。

export const KEEP_DAYS = 90;
export const MAX_ERRORS = 300;
export const MAX_EDITS = 500;

/** 数えるときの入口の名前。これ以外は「other」にまとめます。 */
export const ENDPOINTS = ["/gemini/generate", "/gemini/embed", "/gemini/models",
  "/routes", "/cf/generate", "/yahoo/transit", "/transit", "/web/search", "/metrics"];

// 書き込みは、まとめてから行います。
// Durable Object（SQLite）の無料枠は、書き込む行の数が1日10万行までです。
// 以前は呼び出し1回ごとに4〜10行（入口・国・利用者・出来事…）を書いていて、
// 2026-10-27 にこの上限に当たりました。上限に当たると、レート制限まで
// 一緒に失敗し、アプリ全体が止まります。
//
// いまは、件数をこの Durable Object のメモリに貯めておき、FLUSH_MS ごとに
// 1回だけ書きます。同じ鍵（例: その日の /routes の件数）は何回来ても1行です。
// メモリに貯めているあいだに Durable Object が落ちると、その分（最大
// FLUSH_MS ぶん）の件数は数えそこねます。件数は目安なので、それで構いません。
export const FLUSH_MS = 30_000;
/** 1回の書き出しで残す誤りの数。誤りが続いても、行が増えすぎないように。 */
export const MAX_ERRORS_PER_FLUSH = 20;

export function dayOf(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** スポットの変更を、決まった形に絞ります。読めないものは null。 */
export function cleanEdit(input) {
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const id = str(input?.id, 80);
  const op = input?.op;
  // どのファイルに入っているかは、エリア（regionId）から決まります。
  const regionId = str(input?.regionId, 40);
  const base = { op, id, regionId, name: str(input?.name, 120) };
  if (op !== "add" && (!id || !regionId)) return null;
  if (op === "delete") return { ...base, dropName: input.dropName === true };
  if (op === "category") {
    const category = str(input.category, 40);
    return category ? { ...base, category, from: str(input.from, 40) } : null;
  }
  if (op === "description") {
    return { ...base, description: str(input.description, 400) };
  }
  if (op === "add") {
    const s = input?.spot ?? {};
    const lat = Number(s.lat); const lng = Number(s.lng);
    const name = str(s.name, 120); const regionId = str(s.regionId, 40);
    const category = str(s.category, 40);
    if (!name || !regionId || !category) return null;
    if (!(lat > 20 && lat < 46.5 && lng > 122 && lng < 154.5)) return null;
    const tier = ["major", "known", "hidden"].includes(s.fame_tier) ? s.fame_tier : "hidden";
    const spot = { id: str(s.id, 80), regionId, name, category,
                   lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5,
                   fame_tier: tier, src: "admin" };
    const description = str(s.description, 400);
    if (description) spot.description = description;
    if (!spot.id) return null;
    return { op, id: spot.id, regionId, name, spot };
  }
  return null;
}

/**
 * Durable Object の本体。1つだけ作り（idFromName("global")）、
 * すべての件数をここで数えます。1本ずつ処理されるので、数え漏れません。
 */
export class Stats {
  constructor(state, env) {
    this.state = state; this.env = env;
    /** まだ書いていない件数（鍵 → 足す数）と誤り。 */
    this.pending = new Map();
    this.pendingErrors = [];
    /** 書き出しの予約をしてあるか。 */
    this.flushAt = 0;
    /** その日の塩（毎回読みに行かないように覚えておく）。 */
    this.salt = null;
  }

  get storage() { return this.state.storage; }

  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "POST /record": return json(await this.record(await request.json()));
        case "GET /summary": return json(await this.summary(Number(url.searchParams.get("days") ?? 30)));
        case "GET /edits": return json({ edits: await this.edits() });
        case "POST /edits": return json(await this.addEdit(await request.json()));
        case "DELETE /edits": return json(await this.dropEdits(url.searchParams.getAll("key")));
        default: return json({ ok: false, error: "no such route" }, 404);
      }
    } catch (e) {
      console.error("stats fetch failed", e?.stack ?? e);
      return json({ ok: false, error: "bad request" }, 400);
    }
  }

  /**
   * 1回ぶんを数えます。すぐには書かず、メモリに貯めます（FLUSH_MS ごとに書く）。
   * body: { ip?, items: [[種類, 鍵, 足す数]...], error?: {code, detail, path} }
   */
  async record(body) {
    const day = dayOf();
    const items = Array.isArray(body?.items) ? body.items.slice(0, 40) : [];
    if (body?.ip) items.push(["user", await this.userKey(String(body.ip), day), 1]);
    for (const [kind, key, inc = 1] of items) {
      if (!/^[a-z_]{1,16}$/.test(String(kind))) continue;
      const k = `c:${day}:${kind}:${String(key).slice(0, 80)}`;
      const n = Number(inc);
      if (!Number.isFinite(n) || n < 0 || n > 1e6) continue;
      this.pending.set(k, (this.pending.get(k) ?? 0) + n);
    }
    if (body?.error && this.pendingErrors.length < MAX_ERRORS_PER_FLUSH) {
      const e = body.error;
      this.pendingErrors.push({
        at: Date.now(),
        code: String(e.code ?? "").slice(0, 40),
        detail: String(e.detail ?? "").slice(0, 160),
        path: String(e.path ?? "").slice(0, 40),
      });
    }
    await this.scheduleFlush();
    return { ok: true };
  }

  /** 貯めた件数を書き出す予約をします（予約済みなら何もしません）。 */
  async scheduleFlush() {
    if (this.flushAt) return;
    this.flushAt = Date.now() + FLUSH_MS;
    await this.storage.setAlarm?.(this.flushAt);
  }

  /** 貯めた件数を、まとめて書きます。同じ鍵は1行です。 */
  async flush() {
    const adds = this.pending; const errors = this.pendingErrors;
    this.pending = new Map(); this.pendingErrors = [];
    if (adds.size) {
      const now = await this.storage.get([...adds.keys()]);
      const next = {};
      for (const [k, n] of adds) next[k] = (now.get(k) ?? 0) + n;
      await this.storage.put(next);
    }
    if (errors.length) {
      const rows = {};
      for (const e of errors) rows[`e:${String(e.at).padStart(14, "0")}:${rand()}`] = e;
      await this.storage.put(rows);
    }
  }

  /** その日の塩で、IP を元に戻せない短い鍵にします。 */
  async userKey(ip, day) {
    if (this.salt?.day !== day) {
      const saltKey = `salt:${day}`;
      let value = await this.storage.get(saltKey);
      if (!value) {
        value = rand() + rand() + rand();
        await this.storage.put(saltKey, value);
      }
      this.salt = { day, value };
    }
    const salt = this.salt.value;
    const digest = await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(`${salt}|${ip}`));
    return [...new Uint8Array(digest).slice(0, 4)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** 直近 days 日の件数と、直近の誤り。 */
  async summary(days) {
    // 貯めているぶんも見えるように、先に書き出します。
    await this.flush();
    const n = Math.max(1, Math.min(KEEP_DAYS, Math.floor(days) || 30));
    const since = dayOf(Date.now() - (n - 1) * 86400000);
    const counts = {};
    const rows = await this.storage.list({ prefix: "c:", start: `c:${since}` });
    for (const [k, v] of rows) {
      const [, day, kind, ...rest] = k.split(":");
      const key = rest.join(":");
      ((counts[day] ??= {})[kind] ??= {})[key] = v;
    }
    const errs = await this.storage.list({ prefix: "e:", reverse: true, limit: 100 });
    return { ok: true, days: n, since, counts, errors: [...errs.values()] };
  }

  async edits() {
    const rows = await this.storage.list({ prefix: "x:" });
    return [...rows].map(([key, v]) => ({ key, ...v }));
  }

  async addEdit(input) {
    const edit = cleanEdit(input);
    if (!edit) return { ok: false, error: "読めない変更です" };
    const rows = await this.storage.list({ prefix: "x:" });
    if (rows.size >= MAX_EDITS) return { ok: false, error: "変更待ちが多すぎます。先に反映してください" };
    // 同じスポットへの同じ種類の変更は、新しいほうだけ残します。
    for (const [key, v] of rows) {
      if (v.id === edit.id && v.op === edit.op) await this.storage.delete(key);
    }
    const key = `x:${String(Date.now()).padStart(14, "0")}:${rand()}`;
    await this.storage.put(key, { ...edit, at: Date.now() });
    return { ok: true, key };
  }

  async dropEdits(keys) {
    const list = keys.length ? keys.filter((k) => k.startsWith("x:"))
      : [...(await this.storage.list({ prefix: "x:" })).keys()];
    if (list.length) await this.storage.delete(list);
    return { ok: true, removed: list.length };
  }

  /**
   * 予約した時刻に呼ばれます。貯めた件数を書き、1日に1回は古い件数・塩・
   * 誤りを消します。そのあと、翌日の片付けを予約しておきます。
   */
  async alarm() {
    this.flushAt = 0;
    await this.flush();
    const today = dayOf();
    if ((await this.storage.get("cleaned")) !== today) {
      await this.cleanup();
      await this.storage.put("cleaned", today);
    }
    // 次に件数が来れば、そちらの予約（FLUSH_MS 後）で上書きされます。
    if (!this.flushAt) await this.storage.setAlarm(Date.now() + 86400000);
  }

  async cleanup() {
    const cutoff = dayOf(Date.now() - KEEP_DAYS * 86400000);
    const old = await this.storage.list({ prefix: "c:", end: `c:${cutoff}`, limit: 1000 });
    if (old.size) await this.storage.delete([...old.keys()]);
    const salts = await this.storage.list({ prefix: "salt:", end: `salt:${dayOf()}` });
    if (salts.size) await this.storage.delete([...salts.keys()]);
    const errs = await this.storage.list({ prefix: "e:", reverse: true });
    const extra = [...errs.keys()].slice(MAX_ERRORS);
    if (extra.length) await this.storage.delete(extra.slice(0, 1000));
    // 管理画面の「設定」（入口の止め・回数の上限）はやめました。残っていれば消します。
    if ((await this.storage.get("settings")) !== undefined) await this.storage.delete("settings");
  }
}

function rand() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

// --- Worker 側から呼ぶための小さな道具 -----------------------------------

function stub(env) {
  if (!env?.STATS) return null;
  return env.STATS.get(env.STATS.idFromName("global"));
}

/** 件数を足します。失敗しても、使う人には関係ないので黙ります。 */
export async function record(env, body) {
  const s = stub(env);
  if (!s) return;
  try {
    await s.fetch("https://stats/record", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
  }
}

/** 管理画面から Stats へそのまま渡します（server/admin.js の /private/api/）。 */
export async function forward(env, method, path, body) {
  const s = stub(env);
  if (!s) return json({ ok: false, error: "STATS のバインディングがありません" }, 503);
  return s.fetch(`https://stats${path}`, {
    method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json" },
  });
}
