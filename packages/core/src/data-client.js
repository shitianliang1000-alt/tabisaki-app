// データ配信 API（GET /v1/data/…）を呼ぶ小さな道具。CUI とアプリの両方で使えます
// （通信は fetch だけ。Node 22・ブラウザ・Capacitor で同じに動きます）。
//
//   const c = createDataClient({ key: process.env.TABISAKI_DATA_KEY });
//   const { items, license_summary } = await c.spots({ near: "35.68,139.76", radius: 2 });
//
// 返事の license_summary.attribution は、画面や出力に必ず添えてください
// （docs/data-api.md）。

import { PROXY_URL } from "./config.js";

export class DataApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

export function createDataClient({ base = PROXY_URL, key = null, fetch: f = globalThis.fetch } = {}) {
  const root = `${String(base ?? PROXY_URL).replace(/\/+$/, "")}/v1/data`;
  const etags = new Map(); // 道 → { etag, body }（版が同じなら 304 で済ませる）

  async function get(path, query) {
    const qs = query ? new URLSearchParams(Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString() : "";
    const url = `${root}${path}${qs ? `?${qs}` : ""}`;
    const headers = { Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const known = etags.get(url);
    if (known) headers["If-None-Match"] = known.etag;
    const res = await f(url, { headers });
    if (res.status === 304 && known) return known.body;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new DataApiError(res.status, body?.error?.code ?? "http_error",
        body?.error?.message ?? `HTTP ${res.status}`, Number(res.headers.get("Retry-After")) || undefined);
    }
    const etag = res.headers.get("ETag");
    if (etag) {
      if (etags.size > 200) etags.delete(etags.keys().next().value);
      etags.set(url, { etag, body });
    }
    return body;
  }

  return {
    manifest: () => get(""),
    attribution: () => get("/attribution"),
    spots: (q) => get("/spots", q),
    spot: (id) => get(`/spots/${encodeURIComponent(id)}`),
    stations: (q) => get("/stations", q),
    stops: (q) => get("/stops", q),
    /** next を辿って全部集めます（上限 max 件）。 */
    async all(dataset, q, max = 2000) {
      const out = []; const srcs = new Map(); const attr = new Set(); let offset = 0; let page;
      do {
        page = await get(`/${dataset}`, { ...q, offset, limit: 500 });
        out.push(...page.items);
        for (const s of page.license_summary?.sources ?? []) srcs.set(s.id, s);
        for (const a of page.license_summary?.attribution ?? []) attr.add(a);
        offset += page.count;
      } while (page.next && out.length < max);
      return { ...page, items: out.slice(0, max), count: Math.min(out.length, max), offset: 0, next: null,
               license_summary: { sources: [...srcs.values()], attribution: [...attr] } };
    },
  };
}
