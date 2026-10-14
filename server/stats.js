// 管理画面のための、件数・設定・変更待ちの置き場（Durable Object）。
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
//   settings               … 入口の止め・回数の上限
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

/** 管理画面から変えられる設定の、既定と形。 */
export const DEFAULT_SETTINGS = Object.freeze({
  // 止めている入口（"/routes" のように）。止めると 503 を返します。
  disabled: [],
  // 回数の上限（1IPあたり）。空なら Worker の既定・環境変数のまま。
  limits: null,
});

/** 止められる入口。これ以外は受け付けません。 */
export const SWITCHABLE = ["/gemini/generate", "/gemini/embed", "/gemini/models",
  "/routes", "/cf/generate", "/yahoo/transit", "/web/search", "/metrics"];

export function dayOf(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 管理画面から来た設定を、決まった形に絞ります。 */
export function cleanSettings(input) {
  const disabled = Array.isArray(input?.disabled)
    ? [...new Set(input.disabled.filter((p) => SWITCHABLE.includes(p)))] : [];
  let limits = null;
  const L = input?.limits;
  if (L && typeof L === "object") {
    const n = (v) => {
      const x = Math.floor(Number(v));
      return Number.isFinite(x) && x > 0 && x <= 1_000_000 ? x : null;
    };
    const pool = (p) => (n(p?.minute) && n(p?.hour)
      ? { minute: n(p.minute), hour: n(p.hour) } : null);
    const free = pool(L.free); const paid = pool(L.paid);
    if (free || paid) limits = { ...(free ? { free } : {}), ...(paid ? { paid } : {}) };
  }
  return { disabled, limits };
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
  constructor(state, env) { this.state = state; this.env = env; }

  get storage() { return this.state.storage; }

  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "POST /record": return json(await this.record(await request.json()));
        case "GET /summary": return json(await this.summary(Number(url.searchParams.get("days") ?? 30)));
        case "GET /settings": return json(await this.settings());
        case "PUT /settings": return json(await this.saveSettings(await request.json()));
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
   * 1回ぶんを数えます。
   * body: { ip?, items: [[種類, 鍵, 足す数]...], error?: {code, detail, path} }
   */
  async record(body) {
    const day = dayOf();
    const items = Array.isArray(body?.items) ? body.items.slice(0, 40) : [];
    if (body?.ip) items.push(["user", await this.userKey(String(body.ip), day), 1]);
    const adds = new Map();
    for (const [kind, key, inc = 1] of items) {
      if (!/^[a-z_]{1,16}$/.test(String(kind))) continue;
      const k = `c:${day}:${kind}:${String(key).slice(0, 80)}`;
      const n = Number(inc);
      if (!Number.isFinite(n) || n < 0 || n > 1e6) continue;
      adds.set(k, (adds.get(k) ?? 0) + n);
    }
    if (adds.size) {
      const now = await this.storage.get([...adds.keys()]);
      const next = {};
      for (const [k, n] of adds) next[k] = (now.get(k) ?? 0) + n;
      await this.storage.put(next);
    }
    if (body?.error) {
      const e = body.error;
      await this.storage.put(`e:${String(Date.now()).padStart(14, "0")}:${rand()}`, {
        at: Date.now(),
        code: String(e.code ?? "").slice(0, 40),
        detail: String(e.detail ?? "").slice(0, 160),
        path: String(e.path ?? "").slice(0, 40),
      });
    }
    await this.ensureAlarm();
    return { ok: true };
  }

  /** その日の塩で、IP を元に戻せない短い鍵にします。 */
  async userKey(ip, day) {
    const saltKey = `salt:${day}`;
    let salt = await this.storage.get(saltKey);
    if (!salt) {
      salt = rand() + rand() + rand();
      await this.storage.put(saltKey, salt);
    }
    const digest = await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(`${salt}|${ip}`));
    return [...new Uint8Array(digest).slice(0, 4)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** 直近 days 日の件数と、直近の誤り。 */
  async summary(days) {
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

  async settings() {
    const s = (await this.storage.get("settings")) ?? DEFAULT_SETTINGS;
    return { ok: true, settings: cleanSettings(s) };
  }

  async saveSettings(input) {
    const settings = cleanSettings(input);
    await this.storage.put("settings", settings);
    return { ok: true, settings };
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

  async ensureAlarm() {
    if (!(await this.storage.getAlarm?.())) {
      await this.storage.setAlarm?.(Date.now() + 86400000);
    }
  }

  /** 1日に1回、古い件数・塩・誤りを消します。 */
  async alarm() {
    const cutoff = dayOf(Date.now() - KEEP_DAYS * 86400000);
    const old = await this.storage.list({ prefix: "c:", end: `c:${cutoff}`, limit: 1000 });
    if (old.size) await this.storage.delete([...old.keys()]);
    const salts = await this.storage.list({ prefix: "salt:", end: `salt:${dayOf()}` });
    if (salts.size) await this.storage.delete([...salts.keys()]);
    const errs = await this.storage.list({ prefix: "e:", reverse: true });
    const extra = [...errs.keys()].slice(MAX_ERRORS);
    if (extra.length) await this.storage.delete(extra.slice(0, 1000));
    await this.storage.setAlarm(Date.now() + 86400000);
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

// 設定は、入口に来るたびに聞くと遅くなるので、少しのあいだ覚えておきます。
// 変えてから効くまで、最大 SETTINGS_TTL_MS かかります。
const SETTINGS_TTL_MS = 30_000;
let cached = { at: 0, settings: DEFAULT_SETTINGS };

export async function currentSettings(env, now = Date.now()) {
  const s = stub(env);
  if (!s) return DEFAULT_SETTINGS;
  if (now - cached.at < SETTINGS_TTL_MS) return cached.settings;
  try {
    const res = await s.fetch("https://stats/settings");
    const body = await res.json();
    cached = { at: now, settings: cleanSettings(body?.settings) };
  } catch (e) {
    console.error(e);
    cached = { at: now, settings: cached.settings };
  }
  return cached.settings;
}

/** 試験用。覚えている設定を捨てます。 */
export function forgetSettings() { cached = { at: 0, settings: DEFAULT_SETTINGS }; }
