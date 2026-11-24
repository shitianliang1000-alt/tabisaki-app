// スクレイピング（非推奨・自己責任の設定のときだけ）。スポットの公式サイトなどの
// 公開ページを、**利用者の端末から**読んで、営業時間・電話などを拾います。
//
// 使ってよいのは、設定が "scrape" で、いまの版の注意書きに同意しているときだけです
// （app-settings.js の canScrape）。中継（Cloudflare Worker）からは読みません。
//
// 守ること
// --------
// ・robots.txt で断られたパスは読まない（読めない robots.txt は「断られていない」扱い。
//   ただし 401/403 のときは読まない）
// ・同じホストへは間を空ける（既定 3 秒）。1回の旅程で読むページ数にも上限を置く
// ・名乗る（User-Agent に旅さきと連絡先の URL。ブラウザのふりはしない）
// ・http(s) だけ。localhost・社内向けのアドレスは読まない
// ・大きすぎるページ（1MB 超）は途中でやめる
//
// 拾うのは、ページが自分で機械向けに書いている schema.org の JSON-LD だけです
// （openingHours・openingHoursSpecification・telephone・address）。画面の文を
// 推し量って読むことはしません。壊れやすく、まちがいやすいからです。

export const SCRAPE_USER_AGENT = "tabisaki-scraper/1 (+https://github.com/shitianliang1000-alt/tabisaki.github.io)";
export const SCRAPE_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxBytes: 1_000_000,
  hostIntervalMs: 3_000,
  maxPages: 8,
});

export class ScrapeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScrapeError";
    this.code = code;
  }
}

/** 読んではいけない宛先か（localhost・社内向けのアドレス・http(s) 以外）。 */
export function blockedUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return "URL ではありません"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "http(s) だけ読みます";
  if (u.username || u.password) return "ID・パスワード入りの URL は読みません";
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return "端末の中・社内向けの宛先は読みません";
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "社内向けのアドレスは読みません";
  }
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:")) return "社内向けのアドレスは読みません";
  }
  return null;
}

/**
 * robots.txt を読み、そのパスを読んでよいかを返します。
 * 旅さきの名前（tabisaki-scraper）の組があればそれ、無ければ * の組を見ます。
 * Allow と Disallow が両方当たるときは、長く当たったほうに従います（Google と同じ決め方）。
 */
export function robotsAllows(robotsText, pathWithQuery, agent = "tabisaki-scraper") {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(robotsText ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "allow" || key === "disallow") cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of pick) {
    for (const r of g.rules) {
      if (!r.path) continue; // 「Disallow:」（空）は全部よい、の意味
      if (!ruleMatches(r.path, pathWithQuery)) continue;
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

function ruleMatches(rule, p) {
  // * は何文字でも、末尾の $ は「ここで終わる」。
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(p);
}

/** HTML から JSON-LD の塊を取り出します（読めないものは飛ばします）。 */
export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    try {
      const doc = JSON.parse(m[1].trim());
      const flat = (d) => (Array.isArray(d) ? d.flatMap(flat) : d && typeof d === "object" ? [d, ...(Array.isArray(d["@graph"]) ? d["@graph"].flatMap(flat) : [])] : []);
      out.push(...flat(doc));
    } catch { /* 壊れた JSON-LD は無視します */ }
  }
  return out;
}

const DAY_JA = { Monday: "月", Tuesday: "火", Wednesday: "水", Thursday: "木", Friday: "金", Saturday: "土", Sunday: "日", PublicHolidays: "祝" };
const dayName = (d) => {
  const s = String(d ?? "").replace(/^https?:\/\/schema\.org\//, "");
  return DAY_JA[s] ?? s;
};

/** openingHoursSpecification を「月〜金 9:00–17:00」のような短い文の並びにします。 */
function hoursFromSpec(spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  const lines = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const days = (Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek]).filter(Boolean).map(dayName);
    const t = (v) => String(v ?? "").slice(0, 5);
    if (!s.opens && !s.closes) continue;
    lines.push(`${days.join("・") || "毎日"} ${t(s.opens)}–${t(s.closes)}`);
  }
  return lines;
}

/** JSON-LD の塊から、旅程に役立つ項目だけを拾います。 */
export function extractPlaceFacts(blocks) {
  const facts = { name: "", hours: [], phone: "", address: "" };
  for (const b of blocks) {
    if (!facts.name && typeof b.name === "string") facts.name = b.name.trim().slice(0, 120);
    if (!facts.hours.length) {
      if (b.openingHoursSpecification) facts.hours = hoursFromSpec(b.openingHoursSpecification);
      else if (b.openingHours) facts.hours = (Array.isArray(b.openingHours) ? b.openingHours : [b.openingHours]).map(String);
    }
    if (!facts.phone && typeof b.telephone === "string") facts.phone = b.telephone.trim().slice(0, 40);
    if (!facts.address && b.address) {
      const a = b.address;
      facts.address = (typeof a === "string" ? a
        : [a.postalCode, a.addressRegion, a.addressLocality, a.streetAddress].filter(Boolean).join(" ")).trim().slice(0, 160);
    }
  }
  facts.hours = facts.hours.map((h) => h.trim()).filter(Boolean).slice(0, 14);
  return facts;
}

async function readCapped(res, maxBytes) {
  if (!res.body?.getReader) {
    const text = await res.text();
    if (text.length > maxBytes) throw new ScrapeError("too_large", "ページが大きすぎます");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { try { await reader.cancel(); } catch { /* 無視 */ } throw new ScrapeError("too_large", "ページが大きすぎます"); }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * 公開ページを読む道具を作ります。ホストごとの間隔と robots.txt の控えを、作った道具の中で持ちます。
 *
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, hostIntervalMs?: number,
 *          maxPages?: number, sleep?: (ms:number)=>Promise<void>, now?: ()=>number}} [opts]
 */
export function createScraper(opts = {}) {
  const o = { ...SCRAPE_DEFAULTS, ...opts };
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const lastHit = new Map();
  const robots = new Map();
  let pages = 0;

  async function politeGet(url) {
    const host = new URL(url).host;
    const wait = (lastHit.get(host) ?? -Infinity) + o.hostIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, now());
    return fetchImpl(url, {
      headers: { "User-Agent": SCRAPE_USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  }

  async function robotsFor(u) {
    const key = u.origin;
    if (robots.has(key)) return robots.get(key);
    let text = "";
    let denyAll = false;
    try {
      const res = await politeGet(`${u.origin}/robots.txt`);
      if (res.status === 401 || res.status === 403) denyAll = true;
      else if (res.ok) text = await readCapped(res, 200_000);
    } catch { /* 読めなければ「断られていない」扱い */ }
    const entry = { text, denyAll };
    robots.set(key, entry);
    return entry;
  }

  /**
   * 1ページ読みます。失敗しても投げずに {ok:false, reason} を返します（旅程づくりを止めないため）。
   * @returns {Promise<{ok: true, url: string, fetchedAt: string, facts: object} | {ok: false, url: string, code: string, reason: string}>}
   */
  async function read(rawUrl) {
    const url = String(rawUrl ?? "").trim();
    const bad = blockedUrl(url);
    if (bad) return { ok: false, url, code: "blocked", reason: bad };
    if (pages >= o.maxPages) return { ok: false, url, code: "limit", reason: `1回に読むのは ${o.maxPages} ページまでです` };
    pages += 1;
    try {
      const u = new URL(url);
      const r = await robotsFor(u);
      if (r.denyAll || !robotsAllows(r.text, u.pathname + u.search)) {
        return { ok: false, url, code: "robots", reason: "robots.txt で断られているので読みません" };
      }
      const res = await politeGet(url);
      if (!res.ok) return { ok: false, url, code: "http", reason: `HTTP ${res.status}` };
      const finalUrl = res.url || url;
      const redirected = blockedUrl(finalUrl);
      if (redirected) return { ok: false, url, code: "blocked", reason: `転送先: ${redirected}` };
      const type = String(res.headers?.get?.("content-type") ?? "text/html");
      if (!/html|xml|text\/plain/i.test(type)) return { ok: false, url, code: "type", reason: `HTML ではありません（${type}）` };
      const html = await readCapped(res, o.maxBytes);
      const facts = extractPlaceFacts(jsonLdBlocks(html));
      return { ok: true, url: finalUrl, fetchedAt: new Date(now()).toISOString(), facts };
    } catch (e) {
      const code = e?.code ?? (e?.name === "TimeoutError" ? "timeout" : "network");
      return { ok: false, url, code, reason: e?.name === "TimeoutError" ? "時間切れ" : String(e?.message ?? e).slice(0, 120) };
    }
  }

  return { read, get pagesRead() { return pages; } };
}

/** スポットの公式サイト（収録の url、無ければ OpenStreetMap の website）。 */
export function spotPageUrl(spot) {
  const raw = String(spot?.url ?? spot?.osmInfo?.website ?? "").trim();
  return raw && !blockedUrl(raw) ? raw : "";
}

/**
 * 旅程の場所の公式サイトを読み、拾えたことを並べて返します。収録のデータは書き換えません
 * （「公式サイトから読んだ（未確認）」として別に持ちます）。
 *
 * @param {object} itinerary  旅程（days[].items[].spot）
 * @param {{settings: object, scraper?: ReturnType<typeof createScraper>, canScrape: (s:object)=>boolean}} opts
 */
export async function scrapeItinerary(itinerary, { settings, scraper, canScrape }) {
  if (!canScrape(settings)) return { enabled: false, results: [] };
  const s = scraper ?? createScraper();
  const seen = new Set();
  const results = [];
  for (const day of itinerary?.days ?? []) {
    for (const it of day.items ?? []) {
      if (it.kind !== "spot") continue;
      const url = spotPageUrl(it.spot ?? it.place ?? it);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const r = await s.read(url);
      results.push({ title: it.title ?? it.spot?.name ?? "", ...r });
      if (r.code === "limit") return { enabled: true, results };
    }
  }
  return { enabled: true, results };
}

/** 読んだ結果を、旅程の下に付ける短い文にします（CUI の Markdown・ふつうの文）。 */
export function scrapeSummaryLines(summary) {
  if (!summary?.enabled) return [];
  const lines = ["## 公式サイトから読んだこと（スクレイピング・未確認・自己責任）", ""];
  const got = summary.results.filter((r) => r.ok && (r.facts.hours.length || r.facts.phone));
  if (!got.length) lines.push("- 拾えたことはありませんでした。");
  for (const r of got) {
    const bits = [r.facts.hours.length ? `営業時間 ${r.facts.hours.join("、")}` : "", r.facts.phone ? `電話 ${r.facts.phone}` : ""].filter(Boolean);
    lines.push(`- ${r.title}: ${bits.join("・")}（${r.url}）`);
  }
  const skipped = summary.results.filter((r) => !r.ok);
  if (skipped.length) lines.push("", `読まなかった・読めなかったページ ${skipped.length}件（robots.txt で断られた・時間切れなど）。`);
  return [...lines, ""];
}
