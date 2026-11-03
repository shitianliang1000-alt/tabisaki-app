#!/usr/bin/env node
// 道具の呼び出し（Tool Calling）が、形のしばり（Guided Decoding）の有無でどれだけ崩れるかを比べます（Issue #435）。
//
//   node tools/tool_call_eval.mjs --url=http://localhost:8000 --model=google/gemma-3-4b-it
//   node tools/tool_call_eval.mjs --url=http://localhost:11434 --model=gemma4:e2b --modes=free,schema
//   node tools/tool_call_eval.mjs ... --repeat=3 --temperature=0.7 --out=tool-call-result.json
//   node tools/tool_call_eval.mjs ... --style=guided_json     # 0.10 より前の vLLM
//
// 鍵が要る入口なら、環境変数 OWN_MODEL_KEY に入れてください（引数には書きません）。
// 入口は OpenAI 互換の POST /v1/chat/completions（vLLM・Ollama・llama.cpp・LM Studio）。
//
// 頼みかた（--modes。既定は3つとも）
//   free    本文で「この形の JSON で」と頼むだけ（しばりなし。比べる基準）
//   schema  「次の一手」の JSON Schema で出力をしばる（response_format: json_schema）
//   tools   OpenAI の tools + tool_choice:"required"（vLLM はこれも制約付きで出す）
//
// 数えるもの（packages/core/src/guided.js の summarizeToolCalls）
//   syntaxErrorRate   構文の崩れ（空・JSON でない・形が違う・前置きや ``` 付き）の割合
//   validCallRate     道具の名前と引数の型まで正しく呼べた割合
//   expectedToolRate  期待した道具を選んだ割合
//
// 完了条件（#435）: schema / tools で syntaxErrorRate が実質 0。

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createDefaultTools } from "../packages/core/src/tools.js";
import { TOOL_CALL_MODES, nextToolCall, summarizeToolCalls } from "../packages/core/src/guided.js";

/**
 * 問いの組。expect は選んでほしい道具（どれでもよければ並べる）。
 * 収録・検索の中身は使いません（呼ぶ道具と引数の形だけを見ます）。
 */
export const CASES = Object.freeze([
  { wish: "箱根で温泉に入りたい。どこがいい？", expect: "search_spots" },
  { wish: "金沢の兼六園の近くで見るところを探して", expect: "search_spots" },
  { wish: "京都の紅葉の名所を教えて", expect: "search_spots" },
  { wish: "長野県のお城を見て回りたい", expect: "search_spots" },
  { wish: "沖縄で海のきれいなところ", expect: "search_spots" },
  { wish: "最長片道切符の旅をしてみたい", expect: "search_special_journey" },
  { wish: "日本一周の旅のしかたを知りたい", expect: "search_special_journey" },
  { wish: "東海道五十三次の宿場町をたどりたい", expect: ["search_historical_route", "search_special_journey"] },
  { wish: "中山道を歩く旅の宿場を知りたい", expect: ["search_historical_route", "search_special_journey"] },
  { wish: "国道1号線に沿って旅したい", expect: ["search_historical_route", "search_special_journey"] },
  { wish: "博多駅から太宰府天満宮まで電車で何分かかる？", expect: "search_transit" },
  { wish: "東京駅から鎌倉駅までの行きかたを調べて", expect: "search_transit" },
  { wish: "新大阪から姫路城まで公共交通でどう行く？", expect: "search_transit" },
  { wish: "2026-11-20 の札幌の天気は？", expect: "search_weather" },
  { wish: "2026-12-01 に日光へ行くけど雨は降りそう？", expect: "search_weather" },
  { wish: "spot-1 と spot-2 と spot-3 を回る順番を決めて", expect: "calculate_route" },
  { wish: "このスポット（spot-10, spot-11）を効率よく回りたい", expect: "calculate_route" },
  { wish: "夏目友人帳の舞台をめぐりたい", expect: ["web_search", "search_spots"] },
  { wish: "今年の秋に開かれる瀬戸内の芸術祭はどこでやる？", expect: "web_search" },
  { wish: "最近話題の新しい水族館に行きたい", expect: "web_search" },
  { wish: "どこか行きたい", expect: "ask_user" },
  { wish: "旅行したいけど、何も決めていない", expect: "ask_user" },
  { wish: "来週、家族で", expect: "ask_user" },
  { wish: "熊本で阿蘇山と温泉を楽しみたい", expect: "search_spots" },
]);

/** 道具の形だけを使う登録所（kb と検索は置き物）。 */
export function evalRegistry() {
  return createDefaultTools({
    kb: { spots: [{ id: "spot-1", name: "見本", lat: 35, lng: 135 }] },
    search: async () => [],
  });
}

/**
 * 比べます。
 * @param {{url: string, model?: string, key?: string, modes?: string[], style?: string,
 *          repeat?: number, cases?: object[], fetchImpl?: Function, onRow?: Function}} p
 */
export async function runToolCallEval({ url, model = "", key = "", modes = [...TOOL_CALL_MODES], style = "json_schema",
  repeat = 1, cases = CASES, fetchImpl = globalThis.fetch, onRow = null, timeoutMs = 120_000, temperature = 0 }) {
  const registry = evalRegistry();
  const out = {};
  for (const mode of modes) {
    if (!TOOL_CALL_MODES.includes(mode)) throw new Error(`--modes は ${TOOL_CALL_MODES.join(",")} から選んでください: ${mode}`);
    const rows = [];
    for (let r = 0; r < repeat; r++) {
      for (const c of cases) {
        const result = await nextToolCall({ url, model, key, wish: c.wish, registry, mode, style, fetchImpl, timeoutMs, temperature });
        const row = { mode, wish: c.wish, expect: c.expect ?? null, result };
        rows.push(row);
        onRow?.(row);
      }
    }
    out[mode] = { summary: summarizeToolCalls(rows), rows };
  }
  return out;
}

/** 結果を表にします（Markdown）。 */
export function toTable(result) {
  const lines = [
    "| 頼みかた | 問い | 構文の崩れ | 正しく呼べた | 期待どおりの道具 | 前置き付き | 名前違い | 引数違い | しばりを断られた | 平均 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const pct = (x) => (x == null ? "—" : `${x}%`);
  for (const [mode, { summary: s }] of Object.entries(result)) {
    lines.push(`| ${mode} | ${s.answered}${s.transportErrors ? `（通信の失敗 ${s.transportErrors}）` : ""} | ${pct(s.syntaxErrorRate)} | ${pct(s.validCallRate)} | ${pct(s.expectedToolRate)} | ${s.lenient} | ${s.errors.unknown_tool} | ${s.errors.invalid_args} | ${s.degraded} | ${s.msAvg} |`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) o[m[1]] = m[2] ?? true;
  }
  return o;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.url) {
    console.log("使いかた: node tools/tool_call_eval.mjs --url=http://localhost:8000 --model=名前 [--modes=free,schema,tools] [--style=json_schema|guided_json] [--repeat=1] [--temperature=0] [--limit=24] [--out=結果.json]");
    process.exit(a.help ? 0 : 2);
  }
  const modes = String(a.modes ?? TOOL_CALL_MODES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const cases = CASES.slice(0, Number(a.limit) || CASES.length);
  const result = await runToolCallEval({
    url: a.url, model: a.model ?? "", key: process.env.OWN_MODEL_KEY ?? "", modes,
    style: a.style ?? "json_schema", repeat: Math.max(1, Number(a.repeat) || 1), cases,
    temperature: Number.isFinite(Number(a.temperature)) ? Number(a.temperature) : 0,
    onRow: (row) => process.stderr.write(row.result.ok ? (row.result.lenient ? "~" : ".") : "x"),
  });
  process.stderr.write("\n");
  console.log(toTable(result));
  if (a.out) {
    writeFileSync(a.out, JSON.stringify({ url: a.url, model: a.model ?? "", at: new Date().toISOString(), result }, null, 2));
    console.log(`\n詳しい結果: ${a.out}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
