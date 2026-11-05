// 控え（キャッシュ）の層（#438）。Redis を使わずに、同じ問い合わせを聞き直さない。
//
// 外の API（ネット検索など）は、回数で枠やお金がかかり、1回が遅いことも
// あります。同じ語を何度も聞くことが多いので、答えを期限つきで覚えておき、
// 期限のあいだは覚えた答えを返します。
//
// 置き場（store）は get / set / delete を持つものなら何でも使えます。
// 決まりのものは次の3つです。どれも外のサーバーは要りません。
//
//   memoryStore()          … その場のメモリ（古いものから捨てる。数の上限つき）
//   webStorageStore(ls)    … ブラウザの localStorage（端末の中だけ。数の上限つき）
//   cacheApiStore(caches)  … Cloudflare Workers の Cache API（データセンターごと）
//
// layers に並べると、前から順に見て、後ろで見つかったものは前へも入れます
// （メモリ → Cache API のように、速いものを前に）。
//
// 当たり・外れの数、かかった時間（当たり・外れ別の中央値・95%）、
// 聞かずに済んだ回数と、そのぶんの費用を stats() で返します。
//
// 置き場が壊れていても（容量切れ・読めない値）、外れとして聞き直すだけで、
// 例外は出しません。聞いた先の失敗は覚えません（次はまた聞きます）。

const DAY_MS = 24 * 3600 * 1000;

/** 問い合わせの語を鍵にします（前後と続きの空白・大文字小文字の違いをならす）。 */
export function cacheKey(q) {
  return String(q ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * メモリの置き場。maxEntries を超えたら、いちばん長く使われていないものを捨てます。
 * @param {{maxEntries?: number}} [opts]
 */
export function memoryStore({ maxEntries = 500 } = {}) {
  const map = new Map();
  return {
    kind: "memory",
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key); map.set(key, v); // 使った順に並べ直す
      return v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    delete(key) { map.delete(key); },
    get size() { return map.size; },
  };
}

/**
 * localStorage（か sessionStorage）の置き場。端末の外へは出ません。
 * 鍵の一覧を1つの項目に持ち、maxEntries を超えたら古いものから消します。
 * @param {Storage} storage
 * @param {{prefix?: string, maxEntries?: number}} [opts]
 */
export function webStorageStore(storage, { prefix = "tabisaki:cache:", maxEntries = 100 } = {}) {
  const indexKey = `${prefix}#index`;
  const readIndex = () => {
    try {
      const v = JSON.parse(storage.getItem(indexKey) ?? "[]");
      return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
    } catch { return []; }
  };
  const writeIndex = (keys) => { storage.setItem(indexKey, JSON.stringify(keys)); };
  return {
    kind: "webStorage",
    get(key) {
      const raw = storage.getItem(prefix + key);
      if (raw == null) return undefined;
      try { return JSON.parse(raw); } catch { return undefined; }
    },
    set(key, value) {
      const keys = readIndex().filter((k) => k !== key);
      keys.push(key);
      while (keys.length > maxEntries) storage.removeItem(prefix + keys.shift());
      try {
        storage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        // 容量切れ。いちばん古い半分を捨てて、もう1回だけ試します。
        for (const k of keys.splice(0, Math.ceil(keys.length / 2))) storage.removeItem(prefix + k);
        if (!keys.includes(key)) keys.push(key);
        storage.setItem(prefix + key, JSON.stringify(value));
      }
      writeIndex(keys);
    },
    delete(key) {
      storage.removeItem(prefix + key);
      writeIndex(readIndex().filter((k) => k !== key));
    },
  };
}

/**
 * Cloudflare Workers の Cache API（caches.default）の置き場。
 * 鍵は base の下の URL にします。期限は Cache-Control にも書きます。
 * @param {Cache} cache
 * @param {{base?: string, ttlMs?: number}} [opts]
 */
export function cacheApiStore(cache, { base = "https://cache.tabisaki/", ttlMs = DAY_MS } = {}) {
  const req = (key) => new Request(`${base}${encodeURIComponent(key)}`, { method: "GET" });
  return {
    kind: "cacheApi",
    async get(key) {
      const hit = await cache.match(req(key));
      return hit ? hit.json() : undefined;
    },
    async set(key, value) {
      await cache.put(req(key), new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json",
                   "Cache-Control": `max-age=${Math.max(1, Math.round(ttlMs / 1000))}` },
      }));
    },
    async delete(key) { await cache.delete(req(key)); },
  };
}

/** 並んだ数の p 分位（0〜1）。空なら 0。 */
function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const r = (x) => Math.round(x * 10) / 10;
  return { n: s.length, avgMs: r(s.length ? sum / s.length : 0), p50Ms: r(quantile(s, 0.5)), p95Ms: r(quantile(s, 0.95)) };
}

const clock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/**
 * 控えの層を作ります。
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] 覚えておく長さ（既定 24 時間）
 * @param {object[]} [opts.layers] 置き場（前から順に見る）。既定はメモリだけ
 * @param {object} [opts.store] 置き場が1つのときの書きかた（layers と同じ）
 * @param {number} [opts.costPerCall] 1回聞くと何円（何ドル）かかるか。費用の見積もりに使う
 * @param {number} [opts.maxSamples] 時間を覚えておく数（新しいものから）
 * @param {() => number} [opts.now] 期限を見る時計（試験用）
 * @param {() => number} [opts.timer] かかった時間を測る時計（試験用）
 */
export function createCache({
  ttlMs = DAY_MS, layers, store, costPerCall = 0, maxSamples = 500,
  now = () => Date.now(), timer = clock,
} = {}) {
  const tiers = layers ?? [store ?? memoryStore()];
  const inflight = new Map();
  const counts = { hits: 0, misses: 0, shared: 0, errors: 0, storeErrors: 0 };
  const lat = { hit: [], miss: [] };
  const sample = (kind, ms) => {
    const a = lat[kind];
    a.push(ms);
    if (a.length > maxSamples) a.shift();
  };

  const fresh = (e) => e && typeof e === "object" && Number.isFinite(e.at) && now() - e.at < ttlMs;

  /** 覚えている値（期限内のもの）。無ければ undefined。 */
  async function get(key) {
    for (let i = 0; i < tiers.length; i++) {
      let e;
      try { e = await tiers[i].get(key); } catch { counts.storeErrors++; continue; }
      if (!fresh(e)) continue;
      // 後ろの置き場で見つかったものは、前の置き場へも入れておきます。
      for (let j = 0; j < i; j++) {
        try { await tiers[j].set(key, e); } catch { counts.storeErrors++; }
      }
      return e.value;
    }
    return undefined;
  }

  async function set(key, value) {
    const e = { at: now(), value };
    for (const t of tiers) {
      try { await t.set(key, e); } catch { counts.storeErrors++; }
    }
  }

  async function del(key) {
    for (const t of tiers) {
      try { await t.delete?.(key); } catch { counts.storeErrors++; }
    }
  }

  /**
   * 覚えていればそれを、無ければ load() で取って覚えてから返します。
   * 同じ鍵を同時に頼まれたら、load() は1回だけにします。
   * @param {string} key
   * @param {() => Promise<any>} load
   * @param {{keep?: (value: any) => boolean}} [opts] keep が false を返した値は覚えない
   * @returns {Promise<{value: any, hit: boolean, ms: number}>}
   */
  async function fetchWith(key, load, { keep = () => true } = {}) {
    const t0 = timer();
    const cached = await get(key);
    if (cached !== undefined) {
      counts.hits++;
      const ms = timer() - t0;
      sample("hit", ms);
      return { value: cached, hit: true, ms };
    }
    if (inflight.has(key)) {
      counts.shared++;
      const value = await inflight.get(key);
      return { value, hit: true, ms: timer() - t0 };
    }
    counts.misses++;
    const job = (async () => {
      try {
        const value = await load();
        if (value !== undefined && keep(value)) await set(key, value);
        return value;
      } catch (e) {
        counts.errors++;
        throw e;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    const value = await job;
    const ms = timer() - t0;
    sample("miss", ms);
    return { value, hit: false, ms };
  }

  /** いままでの数。hitRate は 0〜1、saved は聞かずに済んだ回数。 */
  function stats() {
    const asked = counts.hits + counts.misses + counts.shared;
    const saved = counts.hits + counts.shared;
    return {
      ...counts,
      requests: asked,
      calls: counts.misses,
      saved,
      hitRate: asked ? Math.round((saved / asked) * 1000) / 1000 : 0,
      costSaved: Math.round(saved * costPerCall * 1e6) / 1e6,
      costSpent: Math.round(counts.misses * costPerCall * 1e6) / 1e6,
      latency: { hit: summarize(lat.hit), miss: summarize(lat.miss) },
    };
  }

  function resetStats() {
    for (const k of Object.keys(counts)) counts[k] = 0;
    lat.hit.length = 0; lat.miss.length = 0;
  }

  return { get, set, delete: del, fetch: fetchWith, stats, resetStats, ttlMs };
}
