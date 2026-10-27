// 旅さきの「旅程を組む部分」を、Node.js から使うための入口（packages/core）。
//
// 旅程を組む本体は js/ にあります（ブラウザでもそのまま動くように、画面と
// 切り離して書いてあります。js/pipeline.js の冒頭）。ここはそれを Node.js
// から呼ぶための薄い層で、次のことだけを受け持ちます。
//
//   ・知識ベース（kb/）をファイルから読む（ブラウザでは fetch で取るところ）
//   ・外への通信を切る（AI・経路・天気は使わず、距離からの目安で組みます）
//   ・入力を確かめ、決まった形のエラー（CoreError）で返す
//
// js/ のファイルを packages/core/ へ移すのは、この入口の形が固まってから
// 少しずつ行います（docs/roadmap.md）。Web 版はこれまでどおり js/ を直接読みます。
//
//     import { createCore } from "./packages/core/index.mjs";
//     const core = await createCore();
//     const result = await core.plan({ wish: "温泉と海をゆっくり", from: "東京駅", days: 2 });

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 本体（js/）は「端末の時計＝日本時間」の前提で、getHours() で時刻を割り付けます。
// サーバーや CI（多くは UTC）で走らせても同じ旅程になるよう、日本時間にそろえます。
process.env.TZ = "Asia/Tokyo";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const js = (f) => import(pathToFileURL(path.join(ROOT, "js", f)).href);

/** 決まった形のエラー。code で見分けます。 */
export class CoreError extends Error {
  /**
   * @param {"invalid_input"|"unknown_place"|"plan_failed"} code
   * @param {string} message 利用者に見せる日本語
   */
  constructor(code, message) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

/**
 * 外へは出ず、リポジトリの中のファイルだけを返す fetch。
 * kb/・data/ のような相対の場所は、リポジトリの根から引きます。
 */
export function offlineFetch(root = ROOT) {
  return async (url) => {
    const u = String(url?.url ?? url);
    let file;
    if (u.startsWith("file:")) file = fileURLToPath(u);
    else if (/^https?:\/\//.test(u)) {
      // 公開サイトの kb/ を指していても、手元の kb/ を読みます。
      const m = /\/(kb\/.+)$/.exec(new URL(u).pathname);
      if (!m) throw new Error(`通信を切っています: ${u}`);
      file = path.join(root, m[1]);
    } else file = path.join(root, u.replace(/^\.?\//, "").replace(/[?#].*$/, ""));
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`リポジトリの外は読みません: ${u}`);
    let body;
    try {
      body = await readFile(file, "utf8");
    } catch {
      return { ok: false, status: 404, json: async () => null, text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
}

/** "2026-11-01" と "08:00" から、日本時間の Date を作ります。 */
export function jstDate(day, hm = "09:00") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new CoreError("invalid_input", `日付は YYYY-MM-DD で書いてください: ${day}`);
  if (!/^\d{1,2}:\d{2}$/.test(String(hm))) throw new CoreError("invalid_input", `時刻は HH:MM で書いてください: ${hm}`);
  const [h, m] = hm.split(":").map(Number);
  if (h > 23 || m > 59) throw new CoreError("invalid_input", `時刻がおかしいです: ${hm}`);
  const d = new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`);
  if (Number.isNaN(d.getTime())) throw new CoreError("invalid_input", `日付がおかしいです: ${day}`);
  return d;
}

/** 日本時間の今日の次の日（"YYYY-MM-DD"）。 */
export function tomorrowJst(now = new Date()) {
  const t = new Date(now.getTime() + 9 * 3600000 + 86400000);
  return t.toISOString().slice(0, 10);
}

const TRANSPORTS = ["any", "transit", "car", "walk", "local"];

/**
 * 入力を確かめて、旅程を組むときの条件にします。
 * @typedef {object} PlanRequest
 * @property {string} wish  希望の文（「温泉と海をゆっくり」）
 * @property {string} [from="東京駅"] 出発地（収録の駅・空港の名前）
 * @property {number} [days=1] 日数（1〜14）
 * @property {string} [date] 出発日 YYYY-MM-DD（無ければ明日）
 * @property {string} [start="08:00"] 出発時刻
 * @property {string} [back="20:00"] 最終日に帰り着く時刻
 * @property {string} [transport="any"] any / transit / car / walk / local
 */
export async function normalizeRequest(req = {}) {
  const { findPlace } = await js("places.js");
  const wish = String(req.wish ?? "").trim();
  if (!wish) throw new CoreError("invalid_input", "希望の文を書いてください（例: 温泉と海をゆっくり楽しみたい）");
  if (wish.length > 500) throw new CoreError("invalid_input", "希望の文は500字までにしてください");
  const days = req.days === undefined ? 1 : Number(req.days);
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new CoreError("invalid_input", "日数は1〜14の整数にしてください");
  const fromName = String(req.from ?? "東京駅").trim();
  const origin = findPlace(fromName);
  if (!origin) throw new CoreError("unknown_place", `出発地「${fromName}」が収録にありません（駅の名前で書いてください。例: 東京駅・新大阪駅）`);
  const transport = req.transport ?? "any";
  if (!TRANSPORTS.includes(transport)) throw new CoreError("invalid_input", `移動の手段は ${TRANSPORTS.join(" / ")} のどれかにしてください`);
  const date = req.date ?? tomorrowJst();
  const departAt = jstDate(date, req.start ?? "08:00");
  const last = new Date(jstDate(date, "00:00").getTime() + (days - 1) * 86400000);
  const lastDay = new Date(last.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const arriveBy = jstDate(lastDay, req.back ?? "20:00");
  if (arriveBy - departAt < 150 * 60000) throw new CoreError("invalid_input", "出発から帰りまで、2時間半以上空けてください");
  return { wish, origin, days, departAt, arriveBy, transport };
}

/**
 * 旅程を組む道具を用意します（知識ベースを読み込むので、1回だけ呼んで使い回します）。
 *
 * userKb を渡すと、公式の kb/ にユーザーKBの差分を重ねてから組みます（docs/user-kb.md）。
 * 名前（~/.tabisaki/kbs/<名前>/）か、読み込み済みの overlay を渡します。kb/ は書き換えません。
 *
 * @param {{root?: string, userKb?: string|object, home?: string}} [opts]
 */
export async function createCore({ root = ROOT, userKb, home } = {}) {
  // 本体（js/）は fetch で kb/ を取りに行きます。この process では外へ出しません。
  globalThis.fetch = offlineFetch(root);
  const { loadKnowledgeBase } = await js("kb.js");
  const { planTrip } = await js("pipeline.js");
  const { makeTrip } = await js("trip.js");
  let kb = await loadKnowledgeBase();
  let overlayReport = null;
  if (userKb) {
    const { openStore, applyOverlay } = await import("./userkb.mjs");
    const { sameThing } = await js("dedupe.js");
    const doc = typeof userKb === "string" ? await openStore(home ? { home } : {}).load(userKb) : userKb;
    ({ kb, report: overlayReport } = applyOverlay(kb, doc, { sameThing }));
  }

  return {
    kb,
    /** ユーザーKBを重ねたときの報告（足した・直した・消した数、見失った差分、公式との食い違い）。 */
    overlayReport,
    /**
     * 旅程を組みます。
     * @param {PlanRequest} request
     * @returns {Promise<{request: object, itinerary: object}>}
     */
    async plan(request) {
      const r = await normalizeRequest(request);
      const trip = makeTrip({
        origin: r.origin, departAt: r.departAt, arriveBy: r.arriveBy,
        note: r.wish, interests: [], transport: r.transport,
      });
      let itinerary;
      try {
        itinerary = await planTrip({ trip, kb });
      } catch (e) {
        throw new CoreError("plan_failed", e?.message ?? String(e));
      }
      return { request: r, itinerary };
    },
  };
}

export { toMarkdown, toPlainText, toJson } from "./format.mjs";
export { LANGS, SOURCE_LANG, pickLang, createI18n, localizeSpot, sourceHash } from "./i18n.mjs";
export { resolveLang } from "./locales.mjs";
export * as userkb from "./userkb.mjs";
