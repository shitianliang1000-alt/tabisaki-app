// 手元の LLM（Issue #352）の試験。本物の Ollama のかわりに、同じ形で答える小さなサーバーを立てます。

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveBaseUrl, probeRuntime, ensureLocalModel, hasModel, pingModel, pullModel,
} from "../packages/core/local.mjs";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));

/** Ollama のふりをするサーバー。chats に、受け取った文が入ります。 */
async function fakeOllama({ models = ["gemma4:e2b"], openaiOnly = false, reply = "{}" } = {}) {
  const chats = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url === "/api/tags" && !openaiOnly) return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      if (req.url === "/v1/chat/completions") {
        const j = JSON.parse(body);
        chats.push({ model: j.model, text: j.messages.at(-1).content });
        return res.end(JSON.stringify({ choices: [{ message: { content: typeof reply === "function" ? reply(j) : reply } }] }));
      }
      if (req.url === "/api/pull") {
        res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
        res.write(JSON.stringify({ status: "downloading", total: 100, completed: 50 }) + "\n");
        return res.end(JSON.stringify({ status: "success" }) + "\n");
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, chats, close: () => new Promise((r) => server.close(r)) };
}

/** 子プロセスで CLI を動かします（偽サーバーを同じプロセスで動かすので、spawnSync は使えません）。 */
function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, TZ: "UTC", TABISAKI_LLM_URL: "", OLLAMA_HOST: "" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => { stdout += c; });
    p.stderr.on("data", (c) => { stderr += c; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("行き先は --llm-url → TABISAKI_LLM_URL → OLLAMA_HOST → 既定 の順に決まる", () => {
  assert.equal(resolveBaseUrl(undefined, {}), "http://127.0.0.1:11434");
  assert.equal(resolveBaseUrl(undefined, { OLLAMA_HOST: "0.0.0.0:11434" }), "http://127.0.0.1:11434");
  assert.equal(resolveBaseUrl(undefined, { OLLAMA_HOST: "a:1", TABISAKI_LLM_URL: "http://b:2/v1/" }), "http://b:2");
  assert.equal(resolveBaseUrl("http://c:3", { TABISAKI_LLM_URL: "http://b:2" }), "http://c:3");
  assert.throws(() => resolveBaseUrl("http://", {}), /URL/);
});

test("モデル名は :latest を省いても同じものとみなす", () => {
  assert.ok(hasModel(["gemma4:latest"], "gemma4"));
  assert.ok(hasModel(["gemma4:e2b"], "gemma4:e2b"));
  assert.ok(!hasModel(["gemma4:e4b"], "gemma4:e2b"));
});

test("動いていない・モデルが無いときは、直しかた付きで止まる", async () => {
  // 何も待ち受けていない口（閉じたサーバーの番号）
  const dead = await fakeOllama();
  await dead.close();
  await assert.rejects(probeRuntime(dead.url, { timeoutMs: 1000 }), (e) => e.code === "not_running" && /ollama serve/.test(e.message));
  const f = await fakeOllama({ models: ["llama3.2:3b"] });
  try {
    await assert.rejects(ensureLocalModel({ baseUrl: f.url, model: "gemma4:e2b" }),
      (e) => e.code === "model_missing" && /ollama pull gemma4:e2b/.test(e.message) && /llama3\.2:3b/.test(e.message));
  } finally { await f.close(); }
});

test("Ollama 以外の OpenAI 互換サーバー（/v1/models だけ）でも確かめられる", async () => {
  const f = await fakeOllama({ openaiOnly: true, models: ["local-model"], reply: "OK" });
  try {
    const info = await ensureLocalModel({ baseUrl: f.url, model: "local-model" });
    assert.equal(info.runtime, "openai");
    const { reply } = await pingModel({ baseUrl: f.url, model: "local-model" });
    assert.equal(reply, "OK");
  } finally { await f.close(); }
});

test("pullModel は進みぐあいを渡し、success で終わる", async () => {
  const f = await fakeOllama();
  try {
    const seen = [];
    await pullModel({ baseUrl: f.url, model: "gemma4:e2b", onProgress: (ev) => seen.push(ev.status) });
    assert.deepEqual(seen, ["pulling manifest", "downloading", "success"]);
  } finally { await f.close(); }
});

test("plan --local は手元の LLM に聞いて組み、使ったモデルを書く（ほかへは通信しない）", async () => {
  const f = await fakeOllama({ models: ["gemma4:e4b"] });
  try {
    const r = await run(["plan", "温泉と海をゆっくり", "--local", "--model=gemma4:e4b", `--llm-url=${f.url}`, "--date=2026-11-07", "--output=json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ai.provider, "local");
    assert.equal(j.ai.model, "gemma4:e4b");
    assert.equal(j.ai.used, true, JSON.stringify(j.ai));
    assert.ok(f.chats.length >= 2, "希望文の読み取りと選定の2回以上は聞く");
    assert.ok(f.chats.every((c) => c.model === "gemma4:e4b"));
    assert.ok(f.chats.some((c) => c.text.includes("温泉と海をゆっくり")));
  } finally { await f.close(); }
});

test("plan --local でつながらないときは終了コード 1 と直しかた", async () => {
  const dead = await fakeOllama();
  await dead.close();
  const r = await run(["plan", "温泉", "--local", `--llm-url=${dead.url}`]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^tabisaki: 手元の LLM（http:\/\/127\.0\.0\.1:\d+）につながりません/);
});

test("local setup はつながり・モデル・返事を順に確かめる。--pull で取る", async () => {
  const f = await fakeOllama({ models: [], reply: "OK" });
  try {
    const no = await run(["local", "setup", `--llm-url=${f.url}`]);
    assert.equal(no.status, 1);
    assert.match(no.stderr, /tabisaki local setup --pull/);
    const yes = await run(["local", "setup", "--pull", `--llm-url=${f.url}`]);
    // 偽サーバーは取ったあともモデル一覧が空のままですが、取ったあとは一覧を見直しません
    assert.equal(yes.status, 0, yes.stderr);
    assert.match(yes.stdout, /答えました/);
    assert.match(yes.stdout, /--local/);
  } finally { await f.close(); }
});

test("local models は勧めるモデルとライセンスを出す", async () => {
  const r = await run(["local", "models"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gemma4:e2b/);
  assert.match(r.stdout, /Apache-2\.0/);
});
