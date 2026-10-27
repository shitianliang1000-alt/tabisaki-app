// AIに投げるリクエストの形。
//
// キーが無くても、送る前の形は確かめられます。モデルによって受け付ける
// 項目が違うので、ここを取り違えると 400 が返り、候補を1つずつ落として
// 最後は「AIに聞けませんでした」になります。

import assert from "node:assert/strict";
import test from "node:test";

// --- Gemma に投げる形 -------------------------------------------------------
//
// Gemma には構造化出力（responseSchema）がありません。付けて投げると
// 400 が返り、モデルの候補を1つ落として次へ行ってしまいます。
// 本文で「JSONだけ」と頼み、返事から拾います。

test("Gemma には responseSchema を付けない", async () => {
  const { buildModelRequest } = await import("../packages/core/src/ai.js");
  const schema = { type: "OBJECT", properties: {} };
  const r = buildModelRequest("旅程を作って", { schema, model: "gemma-4-e2b-it" });
  assert.ok(!("responseSchema" in r.generationConfig),
    "Gemma に構造化出力を送っています");
  assert.ok(!("responseMimeType" in r.generationConfig));
  assert.match(r.contents[0].parts[0].text, /JSON だけ/);
});

test("Gemma には systemInstruction を付けない（本文の先頭に置く）", async () => {
  // Gemma は systemInstruction を受け取りません。付けて投げると 400 が
  // 返り、候補を順に落として最後は「AIに聞けませんでした」になります。
  // Gemma に切り替えたのに使われていなかったのは、これです。
  const { buildModelRequest } = await import("../packages/core/src/ai.js");
  const r = buildModelRequest("旅程を作って", { model: "gemma-3-27b-it" });
  assert.ok(!("systemInstruction" in r), "Gemma に systemInstruction を"
    + "送っています");
  // 役割の指示そのものは、消さずに本文へ移します。
  assert.match(r.contents[0].parts[0].text, /旅程を作って/);
  assert.ok(r.contents[0].parts[0].text.length > "旅程を作って".length + 50,
    "役割の指示が本文に入っていません");
});

test("Gemma には検索の道具を付けない", async () => {
  const { buildModelRequest, canGround } = await import("../packages/core/src/ai.js");
  const r = buildModelRequest("調べて", { search: true, model: "gemma-3-27b-it" });
  assert.ok(!("tools" in r), "Gemma に google_search を送っています");
  // 裏取りができないことは、呼ぶ前に分かるようにしておきます。
  assert.equal(canGround(), false);
});

test("Gemini には、これまでどおり構造化出力を送る", async () => {
  const { buildModelRequest } = await import("../packages/core/src/ai.js");
  const schema = { type: "OBJECT", properties: {} };
  const r = buildModelRequest("旅程を作って", { schema, model: "gemini-3.7-flash" });
  assert.equal(r.generationConfig.responseSchema, schema);
  assert.equal(r.generationConfig.responseMimeType, "application/json");
  assert.ok(!/JSON だけ/.test(r.contents[0].parts[0].text));
  assert.ok(r.systemInstruction, "Gemini には systemInstruction を送ります");
});

test("中継は、使うモデルを通す", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../server/worker.js", import.meta.url),
                                "utf8");
  const { MODEL, FALLBACK_MODELS, CF_MODEL, CF_FALLBACK_MODELS }
    = await import("../packages/core/src/config.js");
  for (const m of [MODEL, ...FALLBACK_MODELS, CF_MODEL, ...CF_FALLBACK_MODELS]) {
    assert.ok(worker.includes(`"${m}"`),
      `中継の ALLOWED_MODELS に ${m} がありません（400 で弾かれます）`);
  }
});

test("Workers AI の返事は、入れ物が違っても取り出す", async () => {
  const { cfText } = await import("../server/worker.js");
  // 入れ物はモデルによって違います。1つだけを見ていたので、Gemma 4 が
  // 空で返ってきていました（中継は動いているのに、答えが出ない）。
  assert.equal(cfText({ response: "答え" }), "答え");
  assert.equal(cfText({ result: { response: "答え" } }), "答え");
  assert.equal(cfText({ choices: [{ message: { content: "答え" } }] }), "答え");
  assert.equal(cfText({ output: [{ content: [{ text: "答" }, { text: "え" }] }] }),
               "答え");
  assert.equal(cfText("答え"), "答え");
  // どれにも当たらなければ空。呼び出し側が「形」を返して次の手を決めます。
  assert.equal(cfText({ usage: { tokens: 1 } }), "");
});

test("Cloudflare で動かすときは、Gemini の埋め込みを呼ばない", async () => {
  const { embedQuery, usingCloudflare } = await import("../packages/core/src/ai.js");
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error("呼ばれました"); };
  try {
    const v = await embedQuery("温泉でゆっくり");
    if (usingCloudflare()) {
      // AI本体は Workers AI なのに、検索用のベクトルだけ Gemini を
      // 呼んでいました。中継に鍵が無ければ503で、握りつぶして語句検索に
      // 落ちます——旅程を作るたびに、無駄な往復と待ち時間が出ます。
      assert.equal(called, 0, "Gemini の埋め込みを呼んでいます");
      assert.equal(v, null);
    }
  } finally {
    globalThis.fetch = real;
  }
});

// --- 中継にキーが無いときの案内 ---------------------------------------------
//
// 「npx wrangler secret put …」とだけ書いていました。npx が使えない人には
// 手の打ちようがありません。しかもダッシュボードには**同じ名前の欄が2か所**
// あり、Builds のほうに入れても動いている Worker からは見えません
// （実際、そちらに入れて「設定されていません」と出ていました）。

test("キーの入れ場所は、Bindings と Builds を取り違えないように書く", async () => {
  const { missingSecretHelp } = await import("../packages/core/src/endpoints.js");
  const help = missingSecretHelp("GEMINI_API_KEY", "AIのキー");
  assert.match(help, /GEMINI_API_KEY/);
  assert.match(help, /Bindings/);
  assert.match(help, /Builds.*ではありません/s);
  // npx が使えない人のために、ダッシュボードの道順を先に書きます。
  assert.ok(help.indexOf("Bindings") < help.indexOf("npx"), help);
});

// --- 中継へは、本文にモデル名を入れる ---------------------------------------
//
// Googleへ直に投げるときは、モデル名はURLに入ります
// （/models/gemma-4-26b-a4b-it:generateContent）。中継の入口は
// /gemini/generate の1本きりなので、URLでは伝わりません。中継は本文の
// model を見て投げ先を決めます。
//
// ここを入れ忘れていたので、中継は model="" を受け取り、どのモデルを
// 指定しても「そのモデルは使えません」（400）で断っていました。
// **モデル名の問題ではなく、名前が届いていませんでした。**

test("中継を通すときは、本文に model を入れる", async () => {
  const { PROXY_URL } = await import("../packages/core/src/config.js");
  assert.ok(PROXY_URL, "この確認は中継を使う設定が前提です");

  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200,
             json: async () => ({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }) };
  };
  try {
    const { callModel } = await import("../packages/core/src/ai.js");
    await callModel("OK", { temperature: 0 });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length > 0, true, "呼ばれていません");
  const { url, body } = sent[0];
  assert.match(url, /\/gemini\/generate$/, url);
  assert.ok(body.model, "本文に model がありません（中継が投げ先を決められません）");
});
