// 旅程を CalDAV のカレンダーへ書き込む（tabisaki sync）。
//
// .ics の書き出し（js/ical.js）は「ファイルを渡して、取り込むかは人が決める」
// やりかたでした。sync はその続きで、自分のカレンダー（Nextcloud・iCloud・
// Fastmail・Radicale など CalDAV が使えるもの）へ直接入れます。
//
// 守ること（docs/calendar-and-voice.md）:
//
//   ・**書くのは旅さきが作った予定だけ。** 予定1つを1つのファイル
//     （tabisaki-<UID の要約>.ics）として PUT します。ほかの予定は読みも
//     消しもしません。
//   ・**同じ旅を2度送っても、予定は増えません。** UID は旅の条件から
//     決まるので、同じ場所に上書きします。前に送って今回は無くなった予定は、
//     手元に残した「送った一覧」から消します。
//   ・**合言葉はファイルに書きません。** 環境変数か、合言葉を出すコマンド
//     （pass・1Password CLI・macOS のキーチェーン）から受け取り、
//     送った一覧にも残しません。URL に user:pass@ を書くのは断ります。
//   ・**暗号化していない http には送りません**（手元の 127.0.0.1 は別）。

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class SyncError extends Error {
  /** @param {"invalid_input"|"auth"|"http"|"network"} code */
  constructor(code, message) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}

/** 旅の条件から、UID に混ぜる種を作ります。同じ条件なら同じ種です。 */
export function tripSeed(request) {
  const r = request ?? {};
  const key = [
    r.wish, r.origin?.name ?? r.from, r.days,
    r.departAt instanceof Date ? r.departAt.toISOString() : r.departAt,
  ].map((v) => String(v ?? "")).join("|");
  return `trip-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** 折り返した行を戻します（RFC 5545 §3.1）。 */
function unfold(text) {
  return String(text).replace(/\r?\n[ \t]/g, "");
}

/**
 * 1つの VCALENDAR を、予定1つずつの VCALENDAR に分けます。
 * CalDAV は「1つのファイルに予定1つ」（RFC 4791 §4.1）なので、そのまま
 * PUT できる形にします。
 * @returns {{uid: string, summary: string, start: string, body: string}[]}
 */
export function splitEvents(ics) {
  const text = String(ics ?? "");
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const head = [];
  const out = [];
  let cur = null;
  let inHead = true;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = [line]; inHead = false; continue; }
    if (line === "END:VEVENT" && cur) {
      cur.push(line);
      const flat = unfold(cur.join("\r\n"));
      const uid = (/^UID:(.*)$/m.exec(flat)?.[1] ?? "").trim();
      const summary = (/^SUMMARY:(.*)$/m.exec(flat)?.[1] ?? "")
        .replace(/\\([,;\\])/g, "$1").replace(/\\n/g, " ");
      const start = (/^DTSTART[^:]*:(.*)$/m.exec(flat)?.[1] ?? "").trim();
      if (uid) {
        out.push({
          uid, summary, start,
          body: [...head.filter((l) => l && !/^(METHOD|X-WR-CALNAME|X-WR-TIMEZONE):/.test(l)), ...cur, "END:VCALENDAR"]
            .join("\r\n") + "\r\n",
        });
      }
      cur = null;
      continue;
    }
    if (cur) cur.push(line);
    else if (inHead && line !== "END:VCALENDAR") head.push(line);
  }
  return out;
}

/** UID から、カレンダーの中のファイル名を作ります（記号の無い名前）。 */
export function hrefFor(uid) {
  return `tabisaki-${createHash("sha256").update(String(uid)).digest("hex").slice(0, 24)}.ics`;
}

/**
 * カレンダー（コレクション）の URL を確かめます。
 * @returns {URL} 末尾が / の URL
 */
export function checkCalendarUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    throw new SyncError("invalid_input", "--caldav-url には https:// で始まるカレンダーの URL を書いてください");
  }
  if (u.username || u.password) {
    throw new SyncError("invalid_input",
      "URL に名前や合言葉を入れないでください（履歴に残ります）。TABISAKI_CALDAV_USER と TABISAKI_CALDAV_PASSWORD で渡してください");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new SyncError("invalid_input", "暗号化していない http には送りません。https:// の URL にしてください");
  }
  if (u.search || u.hash) throw new SyncError("invalid_input", "--caldav-url に ? や # は付けないでください");
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u;
}

/**
 * 名前と合言葉を受け取ります。
 *   TABISAKI_CALDAV_USER
 *   TABISAKI_CALDAV_PASSWORD      … そのまま
 *   TABISAKI_CALDAV_PASSWORD_CMD  … 合言葉を stdout に出すコマンド（例: pass show caldav）
 * @param {NodeJS.ProcessEnv} env
 * @param {(cmd: string) => Promise<string>} [runCmd]
 */
export async function credentialsFrom(env, runCmd) {
  const user = env.TABISAKI_CALDAV_USER;
  let password = env.TABISAKI_CALDAV_PASSWORD;
  if (!password && env.TABISAKI_CALDAV_PASSWORD_CMD && runCmd) {
    password = (await runCmd(env.TABISAKI_CALDAV_PASSWORD_CMD)).replace(/\r?\n$/, "");
  }
  if (!user || !password) {
    throw new SyncError("auth",
      "TABISAKI_CALDAV_USER と、TABISAKI_CALDAV_PASSWORD（または TABISAKI_CALDAV_PASSWORD_CMD）を入れてください。iCloud・Fastmail などはアプリ用パスワードを使います");
  }
  return { user, password };
}

/** 送った一覧の置き場所。合言葉は入れません。 */
export function statePath(env = process.env) {
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "tabisaki", "caldav-sync.json");
}

export async function loadState(file) {
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    return j && j.version === 1 && typeof j.calendars === "object" ? j : { version: 1, calendars: {} };
  } catch {
    return { version: 1, calendars: {} };
  }
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

function authHeader({ user, password }) {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

async function request(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new SyncError("network", `カレンダーにつながりません: ${e?.cause?.code ?? e?.message ?? e}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SyncError("auth", `カレンダーに断られました（${res.status}）。名前とアプリ用パスワードを確かめてください`);
  }
  return res;
}

/**
 * 予定を書き込みます。
 *
 * @param {object} o
 * @param {URL} o.calendar   checkCalendarUrl の結果
 * @param {{user:string,password:string}} [o.credentials] dryRun のときは要りません
 * @param {ReturnType<typeof splitEvents>} o.events
 * @param {string} o.seed    tripSeed の結果（送った一覧の見出し）
 * @param {object} o.state   loadState の結果（書き換えます）
 * @param {boolean} [o.dryRun]
 * @param {typeof fetch} [o.fetch]
 * @returns {Promise<{put: string[], removed: string[], kept: string[]}>}
 */
export async function syncEvents({ calendar, credentials, events, seed, state, dryRun = false, fetch: fetchImpl = globalThis.fetch }) {
  const key = calendar.href;
  const cal = (state.calendars[key] ??= {});
  const before = new Set(cal[seed]?.hrefs ?? []);
  const now = events.map((e) => hrefFor(e.uid));
  const stale = [...before].filter((h) => !now.includes(h));
  if (dryRun) return { put: now, removed: stale, kept: [] };

  const auth = authHeader(credentials);
  const put = [];
  for (const [i, ev] of events.entries()) {
    const href = now[i];
    const res = await request(fetchImpl, new URL(href, calendar), {
      method: "PUT",
      headers: { authorization: auth, "content-type": "text/calendar; charset=utf-8" },
      body: ev.body,
    });
    if (!res.ok) {
      // 途中まで書けた分は、一覧に残します（次の sync・--remove で片付けられるように）。
      cal[seed] = { hrefs: [...new Set([...before, ...put])], at: new Date().toISOString() };
      throw new SyncError("http", `「${ev.summary}」を書き込めませんでした（${res.status}）`);
    }
    put.push(href);
  }
  const removed = [];
  const kept = [];
  for (const href of stale) {
    const res = await request(fetchImpl, new URL(href, calendar), { method: "DELETE", headers: { authorization: auth } });
    if (res.ok || res.status === 404) removed.push(href);
    else kept.push(href);
  }
  cal[seed] = { hrefs: [...put, ...kept], at: new Date().toISOString() };
  return { put, removed, kept };
}

/**
 * 旅さきが書いた予定を消します（tabisaki sync --remove）。
 * 送った一覧にあるものだけを消します。seed を渡さなければ、その
 * カレンダーに送った旅をすべて消します。
 */
export async function removeEvents({ calendar, credentials, seed, state, dryRun = false, fetch: fetchImpl = globalThis.fetch }) {
  const cal = state.calendars[calendar.href] ?? {};
  const seeds = seed ? [seed].filter((s) => cal[s]) : Object.keys(cal);
  const hrefs = seeds.flatMap((s) => cal[s].hrefs ?? []);
  if (dryRun) return { removed: hrefs, kept: [] };
  const auth = authHeader(credentials);
  const removed = [];
  const kept = [];
  for (const s of seeds) {
    const left = [];
    for (const href of cal[s].hrefs ?? []) {
      const res = await request(fetchImpl, new URL(href, calendar), { method: "DELETE", headers: { authorization: auth } });
      if (res.ok || res.status === 404) removed.push(href);
      else { kept.push(href); left.push(href); }
    }
    if (left.length) cal[s].hrefs = left;
    else delete cal[s];
  }
  if (!Object.keys(cal).length) delete state.calendars[calendar.href];
  return { removed, kept };
}
