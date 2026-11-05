// 使い分け（ハイブリッドモデルルーター。Issue #439）の記録と閾値を、端末に置きます。
//
//   ~/.tabisaki/router-log.jsonl … 1行に1件。どちらに回したか・なぜか・確信度・かかった時間
//   ~/.tabisaki/router.json      … { "threshold": 0.75 }（tabisaki router threshold で変えます）
//
// 置き場は TABISAKI_HOME（無ければ ~/.tabisaki）です。頼みの文そのものは書きません（長さだけです）。

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { userHome } from "./userdata.mjs";
import { DEFAULT_THRESHOLD, normalizeThreshold } from "./src/router.js";

export const logPath = (env = process.env) => path.join(userHome(env), "router-log.jsonl");
export const settingsPath = (env = process.env) => path.join(userHome(env), "router.json");

/**
 * 閾値を決めます。--threshold → TABISAKI_ROUTER_THRESHOLD → router.json → 既定 の順です。
 * @param {string|number|undefined} explicit
 * @returns {{threshold: number, from: "option" | "env" | "file" | "default"}}
 */
export function resolveThreshold(explicit, env = process.env) {
  const ok = (v) => v !== undefined && v !== null && String(v).trim() !== "" && Number.isFinite(Number(v));
  if (explicit !== undefined) {
    if (!ok(explicit) || Number(explicit) < 0 || Number(explicit) > 1) {
      throw Object.assign(new Error("--threshold は 0〜1 の数です（例: 0.75）"), { code: "invalid_input" });
    }
    return { threshold: Number(explicit), from: "option" };
  }
  if (ok(env.TABISAKI_ROUTER_THRESHOLD)) return { threshold: normalizeThreshold(env.TABISAKI_ROUTER_THRESHOLD), from: "env" };
  try {
    const doc = JSON.parse(readFileSync(settingsPath(env), "utf8"));
    if (ok(doc?.threshold)) return { threshold: normalizeThreshold(doc.threshold), from: "file" };
  } catch { /* 無ければ既定 */ }
  return { threshold: DEFAULT_THRESHOLD, from: "default" };
}

/** 閾値を router.json に書きます。 */
export async function saveThreshold(value, env = process.env) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw Object.assign(new Error("閾値は 0〜1 の数です（例: 0.75）"), { code: "invalid_input" });
  }
  const file = settingsPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  let doc = {};
  try { doc = JSON.parse(await readFile(file, "utf8")) ?? {}; } catch { /* 新しく作ります */ }
  await writeFile(file, JSON.stringify({ ...doc, threshold: n }, null, 2) + "\n");
  return file;
}

/**
 * 1件ずつ記録ファイルへ書き足す関数を返します（createCore の hybrid.onRecord に渡します）。
 * 書けなくても旅程づくりは止めません。
 */
export function fileRecorder(env = process.env) {
  const file = logPath(env);
  let ready = false;
  return (entry) => {
    try {
      if (!ready) { mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
      const { seq: _seq, ...rest } = entry;
      appendFileSync(file, JSON.stringify(rest) + "\n");
    } catch { /* 記録できなくても続けます */ }
  };
}

/** 記録を読みます。壊れた行は飛ばします。 */
export async function readRouteLog(env = process.env) {
  let text = "";
  try { text = await readFile(logPath(env), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
