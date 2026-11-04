// Colab で「すべて実行」する GPU 用のノートブック（notebooks/gpu-eval.ipynb。#435）。
// 壊れた JSON や、無くなった道具を呼んでいないかだけを見ます（GPU では回しません）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const nb = JSON.parse(readFileSync(new URL("../notebooks/gpu-eval.ipynb", import.meta.url), "utf8"));
const code = nb.cells.filter((c) => c.cell_type === "code").map((c) => c.source.join("")).join("\n");

test("ノートブックは Colab で開ける形で、GPU を求める", () => {
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.metadata.accelerator, "GPU");
  assert.ok(nb.cells.every((c) => c.cell_type !== "code" || c.outputs.length === 0), "出力は空で入れる");
});

test("ノートブックが呼ぶ道具はリポジトリにある", () => {
  const tools = [...new Set([...code.matchAll(/tools\/[\w-]+\.mjs/g)].map((m) => m[0]))];
  assert.ok(tools.includes("tools/tool_call_eval.mjs"));
  assert.ok(tools.includes("tools/model_eval.mjs"));
  for (const t of tools) assert.ok(existsSync(new URL(`../${t}`, import.meta.url)), t);
});

test("鍵をノートブックに書かない（Colab のシークレットから読む）", () => {
  assert.doesNotMatch(code, /hf_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}/);
});
