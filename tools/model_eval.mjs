#!/usr/bin/env node
// 自前のモデル（またはチューニング前の Gemma）を、書き出した評価用データで採点します。
//
//   node tools/model_eval.mjs --url=http://localhost:11434 --model=gemma4:e2b
//   node tools/model_eval.mjs --url=https://xxxx.endpoints.huggingface.cloud --model=tabisaki-gemma
//   node tools/model_eval.mjs ... --data=.tabisaki/training/eval.jsonl --limit=200 --out=eval-result.json
//
// 鍵が要る入口なら、環境変数 OWN_MODEL_KEY に入れてください（引数には書きません）。
// 入口は OpenAI 互換の POST /v1/chat/completions（Ollama・llama.cpp・vLLM・TGI・HF Inference Endpoints）。
//
// 採点（どれも 0〜1。高いほど良い）
//   fact.prefecture   スポットの事実: 都道府県を正しく書いたか
//   fact.grounded     スポットの事実: 収録に無い固有名（◯◯寺・◯◯駅…）を書かなかったか（grounding.js と同じ判定）
//   unknown.refused   収録に無い場所: 「見つからない」と言えたか（作り話をしなかったか）
//   list.known        エリア・旅程: 挙げた場所の名前が収録にあるか
//
// 学習の前（元の Gemma）と後で同じデータを採点し、下がっていないかを見ます。
// 有料の API に向けると、そのぶん料金がかかります。--limit で件数を絞ってください。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PREFECTURES } from "../packages/core/src/areas.js";
import { unknownNames } from "../packages/core/src/grounding.js";
import { chatUrl } from "../server/own-model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 収録の名前の集まり（grounding.js の unknownNames に渡す形）。 */
export function knownFromKb(spots, regions = []) {
  const names = new Set();
  const add = (n) => { const s = String(n ?? "").trim(); if (s.length >= 2) names.add(s); };
  for (const s of spots) add(s.name);
  for (const r of regions) { add(r.name); add(r.station); add(String(r.station ?? "").replace(/駅$/, "")); }
  for (const p of PREFECTURES) { add(p); add(p.replace(/[都道府県]$/, "")); }
  const list = [...names];
  return { names: list, hay: `\n${list.join("\n")}\n`, set: names };
}

const REFUSE = /見つかりません|見つかりませんでした|収録(には|に)?(ありません|無い|ない)|分かりません|わかりません|確かめられ(ない|ません)|存在しない|存在しません/;

/** 1行を採点します。 */
export function scoreRow(row, answer, known, spotById = new Map()) {
  const task = row?.meta?.task;
  const a = String(answer ?? "");
  if (task === "spot_fact") {
    const spot = spotById.get(row.meta.spotIds?.[0]);
    const pref = spot?.prefecture ?? (row.messages?.[1]?.content.match(/は、(.+?[都道府県])/)?.[1]);
    const bad = unknownNames(a, known);
    return { task, prefecture: pref ? (a.includes(pref) ? 1 : 0) : null, grounded: bad.length ? 0 : 1, unknown: bad.slice(0, 5) };
  }
  if (task === "unknown_place") return { task, refused: REFUSE.test(a) ? 1 : 0 };
  if (task === "area_list" || task === "itinerary") {
    const listed = [...a.matchAll(/^[・\-*]\s*(?:\d{1,2}:\d{2}\s*)?(.+?)(?:（.*）)?\s*$/gm)].map((m) => m[1].trim()).filter(Boolean);
    if (!listed.length) return { task, known: 0, listed: 0 };
    const ok = listed.filter((n) => known.set.has(n)).length;
    return { task, known: ok / listed.length, listed: listed.length, unknown: listed.filter((n) => !known.set.has(n)).slice(0, 5) };
  }
  return { task };
}

const mean = (xs) => { const v = xs.filter((x) => typeof x === "number"); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 1000) / 1000 : null; };

export function summarizeScores(scores) {
  const of = (t) => scores.filter((s) => s.task === t);
  return {
    n: scores.length,
    errors: scores.filter((s) => s.error).length,
    "fact.prefecture": mean(of("spot_fact").map((s) => s.prefecture)),
    "fact.grounded": mean(of("spot_fact").map((s) => s.grounded)),
    "unknown.refused": mean(of("unknown_place").map((s) => s.refused)),
    "list.known": mean([...of("area_list"), ...of("itinerary")].map((s) => s.known)),
  };
}

/** OpenAI 互換の入口に、1問ずつ聞きます。 */
export async function ask(url, model, user, { key = "", fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetchImpl(chatUrl(url), {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: [{ role: "user", content: user }], temperature: 0, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const out = await res.json();
  return String(out?.choices?.[0]?.message?.content ?? "");
}

export async function evaluate(rows, { url, model, key, known, spotById, fetchImpl, onProgress } = {}) {
  const scores = [];
  for (const [i, row] of rows.entries()) {
    const user = row.messages.find((m) => m.role === "user")?.content ?? "";
    try {
      const answer = await ask(url, model, user, { key, fetchImpl });
      scores.push({ ...scoreRow(row, answer, known, spotById), i });
    } catch (e) {
      scores.push({ task: row?.meta?.task, error: String(e?.message ?? e), i });
    }
    onProgress?.(i + 1, rows.length);
  }
  return { summary: summarizeScores(scores), scores };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const url = opt("url");
  const model = opt("model") ?? "tabisaki-gemma";
  if (!url) {
    console.error("--url=<OpenAI 互換の入口> が要ります（例: --url=http://localhost:11434）");
    process.exit(2);
  }
  const data = path.resolve(opt("data") ?? path.join(ROOT, ".tabisaki", "training", "eval.jsonl"));
  let rows = readFileSync(data, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const limit = Number(opt("limit") ?? 0);
  if (limit > 0) rows = rows.slice(0, limit);
  const { loadKb } = await import(pathToFileURL(path.join(ROOT, "tools", "export_training_data.mjs")).href);
  const kb = loadKb();
  const known = knownFromKb(kb.spots, [...kb.regions.values()]);
  const spotById = new Map(kb.spots.map((s) => [s.id, s]));
  const result = await evaluate(rows, {
    url, model, key: process.env.OWN_MODEL_KEY ?? "", known, spotById,
    onProgress: (i, n) => { if (i % 20 === 0 || i === n) process.stderr.write(`${i}/${n}\n`); },
  });
  const out = { model, url: url.replace(/\/\/[^@/]*@/, "//"), data, at: new Date().toISOString(), ...result };
  if (opt("out")) writeFileSync(path.resolve(opt("out")), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out.summary, null, 1));
}
