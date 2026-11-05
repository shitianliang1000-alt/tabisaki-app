#!/usr/bin/env node
// 質問の選択肢を AI が作る（#441）の、質の見本を出します。
//
//   GEMINI_API_KEY=... node tools/choice_samples.mjs            # 見本の頼み全部
//   GEMINI_API_KEY=... node tools/choice_samples.mjs "紅葉を見たい"  # 1つだけ
//
// Gemma（packages/core/src/config.js の MODEL）に直接頼みます。Gemini は
// 使いません。出したもの（採用）と、捨てたもの（地名入り・読めない日程など）
// を並べるので、決まり（packages/core/src/choices.js）が効いているかを
// 目で確かめられます。キーはこの手元の process の中だけで使います。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL } from "../packages/core/src/config.js";
import { questionKey, startDialog } from "../packages/core/src/slots.js";
import { buildChoicePrompt, placeChecker, sanitizeChoices } from "../packages/core/src/choices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = [
  "紅葉を見に行きたい",
  "温泉でゆっくり",
  "子どもと動物を見たい",
  "おいしい海鮮が食べたい",
  "写真映えするところ",
  "雨でも楽しめるところ",
  "歴史が好き",
  "星空を見たい",
];

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY を指定してください（Gemma を呼びます）。");
  process.exit(2);
}

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "kb", f), "utf8"));
const regions = readJson("regions.json");
const kb = { regions: regions.regions ?? regions, names: readJson("names.json").names };
const isPlace = placeChecker(kb);

async function gemma(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7 } }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
}

function parse(raw) {
  const t = String(raw).replace(/```(?:json)?/g, "");
  return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
}

const list = process.argv.slice(2).length ? process.argv.slice(2) : SAMPLES;
for (const text of list) {
  const d = startDialog(text);
  console.log(`\n## ${text}`);
  if (d.phase !== "asking") { console.log("（聞くことはありません）"); continue; }
  let reply;
  try {
    reply = parse(await gemma(buildChoicePrompt(d.base, d.slots, d.questions)));
  } catch (e) {
    console.log(`  AI に聞けませんでした: ${e.message}`);
    continue;
  }
  const byId = new Map((reply.questions ?? []).map((x) => [x.id, x.choices ?? []]));
  for (const q of d.questions) {
    const raw = byId.get(questionKey(q)) ?? [];
    const kept = sanitizeChoices(raw, q, { isPlace });
    const keptLabels = new Set(kept.map((c) => c.label));
    const dropped = raw.filter((c) => !keptLabels.has(String(c?.label ?? "").trim()));
    console.log(`- ${q.question}`);
    console.log(`    採用: ${kept.map((c) => c.label).join(" / ") || "（なし → 決め打ち）"}`);
    if (dropped.length) console.log(`    捨てた: ${dropped.map((c) => c?.label).join(" / ")}`);
  }
}
