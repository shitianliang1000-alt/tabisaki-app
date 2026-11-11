#!/usr/bin/env node
// 学習したモデルを出してよいかの合否（Issue #434）。
//
//   node training/eval_gate.mjs --after=runs/x/eval.json [--before=runs/base-eval.json] [--baseline=training/baseline.json]
//
// --after / --before は tools/model_eval.mjs --out の JSON（summary を見ます）。
// 次のどれかに当たれば不合格（終了コード 1）:
//   - 採点できた数が minRows より少ない、または失敗（errors）の割合が maxErrorRate を超える
//   - どれかの点が floor を下回る
//   - --before があれば、どれかの点が「学習前 − tolerance」を下回る（学習で悪くなった）
// 点が null（その種類の問題が無かった）のものは、比べずに飛ばします。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const METRICS = ["fact.prefecture", "fact.grounded", "unknown.refused", "list.known"];

/** 合否と、その理由の表。 */
export function gate(after, { baseline, before = null } = {}) {
  const rows = [];
  const fails = [];
  const n = Number(after?.n ?? 0);
  const errRate = n ? Number(after.errors ?? 0) / n : 1;
  if (n < (baseline.minRows ?? 0)) fails.push(`採点できた数が ${n}（${baseline.minRows} 以上が要る）`);
  if (errRate > (baseline.maxErrorRate ?? 1)) fails.push(`失敗の割合が ${(errRate * 100).toFixed(1)}%`);
  for (const k of METRICS) {
    const v = after?.[k];
    const floor = baseline.floor?.[k];
    const prev = before?.[k];
    const row = { metric: k, after: v ?? null, before: prev ?? null, floor: floor ?? null, ok: true };
    if (typeof v === "number") {
      if (typeof floor === "number" && v < floor) { row.ok = false; fails.push(`${k} が ${v.toFixed(3)}（下限 ${floor}）`); }
      if (typeof prev === "number" && v < prev - (baseline.tolerance ?? 0)) {
        row.ok = false;
        fails.push(`${k} が学習前の ${prev.toFixed(3)} から ${v.toFixed(3)} に下がった`);
      }
    }
    rows.push(row);
  }
  return { pass: fails.length === 0, fails, rows, n, errorRate: errRate };
}

/** Markdown の表（Colab の結果・PR に貼る用）。 */
export function report(result) {
  const f = (x) => (typeof x === "number" ? x.toFixed(3) : "-");
  const lines = ["| 点 | 学習前 | 学習後 | 下限 | |", "| --- | ---: | ---: | ---: | --- |"];
  for (const r of result.rows) lines.push(`| ${r.metric} | ${f(r.before)} | ${f(r.after)} | ${f(r.floor)} | ${r.ok ? "○" : "×"} |`);
  lines.push("", result.pass ? `合格（${result.n}問）` : `不合格: ${result.fails.join("／")}`);
  return lines.join("\n");
}

const summaryOf = (file) => {
  const doc = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  return doc.summary ?? doc;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  if (!opt("after")) {
    console.error("--after=<model_eval.mjs --out の JSON> が要ります");
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(path.resolve(opt("baseline") ?? path.join(HERE, "baseline.json")), "utf8"));
  const result = gate(summaryOf(opt("after")), { baseline, before: opt("before") ? summaryOf(opt("before")) : null });
  console.log(report(result));
  process.exit(result.pass ? 0 : 1);
}
