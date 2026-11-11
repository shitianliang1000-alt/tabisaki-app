// 天気での組み直し（tabisaki replan --weather-check）。
//
// 旅程ファイルを組み、日ごとの予報を取り、雨の時間に屋外へ行く予定があれば
// 屋内の代わりに入れ替えた旅程を作って、違いを出します。
//
// 守ること（docs/journey-as-code.md「天気での組み直し」）:
//   - 通信は --weather-check を付けたときだけ。行き先は api.open-meteo.com だけ
//     （送るのは、立ち寄る場所の緯度・経度を小数4桁に丸めたものと日付。キーも名前も送らない）
//   - 天気が取れなければ、旅程は変えない（取れなかったと言うだけ）
//   - must_visit に書いた場所は、雨でも入れ替えない（知らせるだけ）
//   - 組み直した旅程が constraints を守れなければ、元のままにする
//   - 元のファイルは書き換えない（--apply は別のファイルに書く）

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildJourney, checkJourney, diffJourneys, findSpot } from "./index.mjs";
import { stringifyYaml } from "./yaml.mjs";
import { hm } from "./simulate.mjs";

// createCore() は globalThis.fetch を「外へ出ない fetch」に替えます。その前の本物を持っておきます。
const nativeFetch = globalThis.fetch;

export const WEATHER_HOST = "api.open-meteo.com";
export const WEATHER_PROVIDERS = ["open-meteo", "mock", "off"];
export const HORIZON_DAYS = 16;
/** 組み直しを繰り返す上限（組み直しで入った別の屋外の場所を外すため）。 */
export const MAX_ROUNDS = 3;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 天気の行き先だけに出られる fetch。つながらない・混んでいる（429・5xx）ときは、間をあけて取り直します。
 * @param {{realFetch?: Function, retries?: number, waits?: number[], sleep?: (ms: number) => Promise<void>, host?: string}} [o]
 */
export function guardedFetch({ realFetch = nativeFetch, retries = 2, waits = [500, 1500], sleep = sleepMs, host = WEATHER_HOST } = {}) {
  return async (url, init) => {
    let u;
    try { u = new URL(String(url?.url ?? url)); } catch { throw new Error("天気の行き先を読めません"); }
    if (u.protocol !== "https:" || u.hostname !== host) throw new Error(`天気の行き先は ${host} だけです: ${u.hostname}`);
    let lastError = null;
    for (let i = 0; i <= retries; i++) {
      if (i) await sleep(waits[Math.min(i - 1, waits.length - 1)]);
      try {
        const res = await realFetch(u.href, { ...init, redirect: "error" });
        if (res.ok || !(res.status === 429 || res.status >= 500)) return res;
        lastError = res;
      } catch (e) {
        if (init?.signal?.aborted) throw e;
        lastError = e;
      }
    }
    if (lastError instanceof Error) throw lastError;
    return lastError;
  };
}

const homeDir = (env = process.env) => path.resolve(env.TABISAKI_HOME || path.join(os.homedir(), ".tabisaki"));

/** 予報の控え（3時間。packages/core/src/weather.js が寿命を見ます）を、ファイルに置く入れもの。 */
export function fileStorage(file) {
  let doc = null;
  const load = () => {
    if (doc) return doc;
    try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { doc = {}; }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
    return doc;
  };
  const save = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
      renameSync(tmp, file);
    } catch { /* 控えは任意です。書けなくても動きます */ }
  };
  return {
    getItem: (k) => (Object.hasOwn(load(), k) ? load()[k] : null),
    setItem: (k, v) => { load()[k] = String(v); save(); },
    removeItem: (k) => { delete load()[k]; save(); },
  };
}

/**
 * 天気の取り口を選びます（createCore() の後で呼ぶ。core は既定で天気を取りません）。
 * @param {{provider?: string, rain?: number, env?: object, fetchImpl?: Function}} [o]
 */
export async function useWeather({ provider = "open-meteo", rain = 80, env = process.env, fetchImpl = null } = {}) {
  const providers = await import("../core/src/providers.js");
  if (provider === "off") { providers.useProvider("weather", "off"); return "off"; }
  if (provider === "mock") {
    providers.registerProvider(providers.createMockWeather({ rain, name: "mock-cli" }));
    providers.useProvider("weather", "mock-cli");
    return "mock";
  }
  const { forecastFor } = await import("../core/src/weather.js");
  const send = fetchImpl ?? guardedFetch();
  const storage = fileStorage(path.join(homeDir(env), "cache", "weather.json"));
  providers.registerProvider({
    kind: "weather", name: "open-meteo-cli", label: "Open-Meteo（端末から）", available: true,
    forecast: (at, date, opts) => forecastFor(at, date, { ...opts, fetchImpl: send, storage }),
  });
  providers.useProvider("weather", "open-meteo-cli");
  return "open-meteo";
}

/**
 * 天気を見て、組み直しの案を作ります。
 *
 * @returns {Promise<{status: "ok"|"proposal"|"warning"|"unavailable"|"not_yet"|"past",
 *   weather: string[], reasons: string[], concerns: object[], swaps: object[], kept: object[],
 *   before: object, after: object|null, diff: string[], rejected: string|null, fingerprint: string}>}
 *   status  ok = 雨の心配なし / proposal = 入れ替えの案あり / warning = 雨の心配はあるが入れ替えない
 *           unavailable = 天気が取れなかった / not_yet = 予報がまだ出ない先の日付 / past = 過ぎた日付
 */
export async function weatherReplan(core, journey, { format, provider = "open-meteo", now = new Date() } = {}) {
  const before = await buildJourney(core, journey);
  const itin = before.result.itinerary;
  const rp = itin.replan ?? { suggestions: [], notes: [] };
  const weather = rp.days ?? [];
  const reasons = (rp.notes ?? []).filter((n) => /天気|予報/.test(n));
  const base = { weather, reasons, concerns: [], swaps: [], kept: [], alsoAvoided: [], remaining: [], before, after: null, diff: [], rejected: null, fingerprint: "" };

  if (!weather.length) {
    const days = itin.days ?? [];
    const first = days[0]?.date ? new Date(days[0].date) : null;
    const last = days.at(-1)?.date ? new Date(days.at(-1).date) : null;
    let status = "unavailable";
    if (provider === "open-meteo" && first && (first - now) / 86400000 > HORIZON_DAYS) status = "not_yet";
    else if (provider === "open-meteo" && last && (last - now) / 86400000 < -1) status = "past";
    return { ...base, status };
  }

  const mustIds = new Set(before.spots.must.map((m) => m.spot.id));
  const rain = (rp.suggestions ?? []).filter((s) => s.kind === "rain");
  const itemOf = (s) => (itin.days?.[s.day]?.items ?? []).find((i) => i.id === s.itemId);
  for (const s of rain) {
    const item = itemOf(s);
    const c = { day: s.day + 1, at: item?.start ?? null, spotId: s.spotId, title: item?.title ?? item?.place?.name ?? String(s.spotId),
      spot: item?.place ?? null, alternative: s.alternative ?? null, text: s.text, action: "keep", why: "" };
    if (mustIds.has(s.spotId)) c.why = "must_visit に書いてあるので入れ替えません";
    else if (!s.alternative) c.why = "近くに屋内の代わりが見つかりませんでした";
    else c.action = "swap";
    base.concerns.push(c);
  }
  base.swaps = base.concerns.filter((c) => c.action === "swap");
  base.kept = base.concerns.filter((c) => c.action === "keep");
  base.fingerprint = base.concerns.length
    ? createHash("sha256").update(JSON.stringify(base.concerns.map((c) => [c.day, c.spotId, c.alternative?.id ?? null, c.action]))).digest("hex").slice(0, 16)
    : "";
  if (!base.concerns.length) return { ...base, status: "ok" };
  if (!base.swaps.length) return { ...base, status: "warning" };

  // 入れ替えて組み直します。守れなければ、元のままにします。
  // 組み直しで別の屋外の場所が入ってくることがあるので、それも外して組み直します（MAX_ROUNDS 回まで）。
  const wasOk = new Set(checkJourney(before).filter((c) => c.ok).map((c) => c.name));
  const must = base.swaps.map((c) => ({ name: c.alternative.name, spot: c.alternative }));
  const avoid = base.swaps.map((c) => ({ name: c.title, spot: c.spot ?? { id: c.spotId } }));
  const pinned = new Set([...mustIds, ...must.map((m) => m.spot.id)]);
  const alsoAvoided = [];
  let after = null;
  let remaining = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let next;
    try {
      next = await buildJourney(core, journey, { must, avoid });
    } catch (e) {
      if (!after) return { ...base, status: "warning", rejected: `組み直せませんでした（${e?.message ?? e}）` };
      break;
    }
    const broken = checkJourney(next).filter((c) => !c.ok && wasOk.has(c.name));
    if (broken.length) {
      if (!after) return { ...base, status: "warning", rejected: `組み直すと条件を守れません（${broken.map((c) => `${c.name}: ${c.detail}`).join(" / ")}）` };
      break;
    }
    after = next;
    const days = next.result.itinerary.days ?? [];
    remaining = (next.result.itinerary.replan?.suggestions ?? []).filter((s) => s.kind === "rain").map((s) => {
      const item = (days[s.day]?.items ?? []).find((i) => i.id === s.itemId);
      return { day: s.day + 1, spotId: s.spotId, title: item?.title ?? String(s.spotId), spot: item?.place ?? { id: s.spotId } };
    });
    const more = remaining.filter((r) => !pinned.has(r.spotId) && !avoid.some((m) => m.spot.id === r.spotId));
    if (!more.length || round === MAX_ROUNDS) break;
    for (const r of more) { avoid.push({ name: r.title, spot: r.spot }); alsoAvoided.push(r); }
  }
  // 最後に採った旅程に残らなかったものは、「外した」に数えません
  const finalAvoid = new Set(after.spots.avoid.map((m) => m.spot.id));
  const a = JSON.parse(format.toJson(before.result));
  const b = JSON.parse(format.toJson(after.result));
  const { same, lines } = diffJourneys(a, b, { labelA: "いまの旅程", labelB: "組み直した旅程" });
  if (same) return { ...base, status: "warning", rejected: "組み直しても旅程が変わりませんでした" };
  return { ...base, status: "proposal", after, diff: lines,
    alsoAvoided: alsoAvoided.filter((r) => finalAvoid.has(r.spotId)), remaining };
}

/** 入れ替えを書き足した旅程ファイル（YAML）を作ります。元の注釈は残りません。 */
export function replannedYaml(journey, swaps, kb = null, alsoAvoided = []) {
  const doc = structuredClone(journey.doc);
  doc.constraints = { ...(doc.constraints ?? {}) };
  const must = [...(doc.constraints.must_visit ?? [])];
  const avoid = [...(doc.constraints.avoid ?? [])];
  const notes = [];
  for (const c of swaps) {
    if (!must.includes(c.alternative.name)) must.push(c.alternative.name);
    if (!avoid.includes(c.title)) avoid.push(c.title);
    if (kb) {
      for (const [name, id] of [[c.alternative.name, c.alternative.id], [c.title, c.spotId]]) {
        const hit = findSpot(kb, name).spot;
        if (hit && hit.id !== id) notes.push(`「${name}」は同じ名前の別の場所として読まれます。書き出したファイルを確かめてください`);
      }
    }
  }
  for (const r of alsoAvoided) if (!avoid.includes(r.title)) avoid.push(r.title);
  doc.constraints.must_visit = must;
  doc.constraints.avoid = avoid;
  const head = [
    "# tabisaki replan --weather-check が書き出した旅程ファイルです。",
    ...swaps.map((c) => `#   ${c.day}日目「${c.title}」→「${c.alternative.name}」（雨の予報のため）`),
    ...(alsoAvoided.length ? [`#   組み直しで入った屋外の場所も外しました: ${alsoAvoided.map((r) => r.title).join("・")}`] : []),
  ];
  return { text: head.join("\n") + "\n" + stringifyYaml(doc), notes };
}

/** 書き出す先。--out が無ければ trip.yaml → trip.replanned.yaml。元のファイルには書きません。 */
export function outPathFor(file, out = null) {
  const src = path.resolve(file);
  const ext = path.extname(src) || ".yaml";
  const dest = path.resolve(out ?? path.join(path.dirname(src), `${path.basename(src, path.extname(src))}.replanned${ext}`));
  if (dest === src) throw Object.assign(new Error("--out に元のファイルは書けません（元の旅程は書き換えません）"), { exitCode: 2 });
  return dest;
}

// ---- 決まった時刻に動かすときの控え（--state） ----

export const STATE_VERSION = 1;

export async function loadState(file) {
  try {
    const s = JSON.parse(await readFile(file, "utf8"));
    if (s?.version === STATE_VERSION) return { fingerprint: "", failures: 0, ...s };
  } catch { /* 無ければ新しく作ります。壊れていても作り直します */ }
  return { version: STATE_VERSION, fingerprint: "", failures: 0, lastRunAt: null, lastOkAt: null, notifiedAt: null };
}

export async function saveState(file, state) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * 結果と前回の控えから、知らせるか・終了コードを決めます。
 *
 * 終了コード: 0 = 知らせることなし、1 = 見直しの案・雨の心配あり、3 = 天気が取れない
 * （--strict のとき、または続けて maxFailures 回取れなかったとき）
 *
 * @returns {{code: number, notify: boolean, headline: string, state: object}}
 */
export function decide(result, prev, { strict = false, maxFailures = 3, now = new Date(), useState = false } = {}) {
  const state = { ...prev, version: STATE_VERSION, lastRunAt: now.toISOString() };
  if (result.status === "unavailable") {
    state.failures = (prev.failures ?? 0) + 1;
    const streak = useState && state.failures >= maxFailures && state.failures % maxFailures === 0;
    return { code: strict || streak ? 3 : 0, notify: strict || streak || !useState, state,
      headline: streak ? `天気を ${state.failures}回つづけて取れていません。旅程は変えていません` : "天気を取れませんでした。旅程は変えていません" };
  }
  state.failures = 0;
  state.lastOkAt = now.toISOString();
  if (result.status === "not_yet" || result.status === "past") {
    return { code: 0, notify: !useState, state,
      headline: result.status === "not_yet" ? `予報はまだ出ていません（${HORIZON_DAYS}日先まで）。旅程は変えていません` : "過ぎた日付の旅程です。天気は見ていません" };
  }
  if (result.status === "ok") {
    const cleared = !!prev.fingerprint;
    state.fingerprint = "";
    return { code: 0, notify: cleared || !useState, state, headline: cleared ? "前に知らせた雨の心配は、なくなりました" : "雨の心配はありません。旅程はそのままで大丈夫です" };
  }
  const same = useState && prev.fingerprint === result.fingerprint;
  state.fingerprint = result.fingerprint;
  if (!same) state.notifiedAt = now.toISOString();
  return { code: same ? 0 : 1, notify: !same, state,
    headline: same ? "前回と同じ内容です（もう知らせてあります）"
      : result.status === "proposal" ? `雨の予報があります。${result.swaps.length}か所を屋内に入れ替える案があります` : "雨の予報がありますが、入れ替えはしません" };
}

/** 人が読む形。 */
export function replanText({ file, title, result, headline }) {
  const out = [`${file}: ${title}（天気での見直し）`];
  for (const w of result.weather) out.push(`  天気 ${w}`);
  for (const r of result.reasons) out.push(`  ${r}`);
  if (result.concerns.length) {
    out.push("", "雨の時間に屋外へ行く予定:");
    for (const c of result.concerns) {
      out.push(`  ${c.day}日目${c.at ? ` ${hm(c.at)}` : ""}「${c.title}」`
        + (c.action === "swap" ? ` → 屋内の「${c.alternative.name}」に入れ替え` : ` → そのまま（${c.why}）`));
    }
  }
  if (result.rejected) out.push("", `${result.rejected}。旅程は元のままです`);
  if (result.alsoAvoided?.length) out.push(`  組み直しで入った屋外の場所も外しました: ${result.alsoAvoided.map((r) => `「${r.title}」`).join("・")}`);
  if (result.remaining?.length) out.push(`  組み直した後も、雨の時間の屋外が残ります: ${result.remaining.map((r) => `${r.day}日目「${r.title}」`).join("・")}`);
  if (result.diff.length) out.push("", ...result.diff);
  out.push("", headline);
  return out.join("\n") + "\n";
}

/** 機械が読む形。 */
export function replanJson({ file, title, result, headline, code }) {
  return JSON.stringify({
    version: 1, file, title, status: result.status, exitCode: code, headline,
    weather: result.weather, reasons: result.reasons,
    concerns: result.concerns.map((c) => ({ day: c.day, at: c.at ? new Date(c.at).toISOString() : null, spotId: c.spotId, title: c.title,
      action: c.action, alternative: c.alternative ? { id: c.alternative.id, name: c.alternative.name } : null, why: c.why || null })),
    alsoAvoided: (result.alsoAvoided ?? []).map((r) => ({ spotId: r.spotId, title: r.title })),
    remaining: (result.remaining ?? []).map((r) => ({ day: r.day, spotId: r.spotId, title: r.title })),
    rejected: result.rejected, diff: result.diff, fingerprint: result.fingerprint || null,
  }, null, 2) + "\n";
}
