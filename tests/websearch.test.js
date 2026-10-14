// Gemma にネット検索をさせるテスト。
//
// Gemma は google_search を受け取らないので、中継（server/worker.js の
// /web/search）が代わりに検索し、短い抜き書きを渡します（js/qa.js）。
// 本物の検索先には行きません（fetch を差し替えます）。

import assert from "node:assert/strict";
import test from "node:test";

import worker, { cleanSnippet, tavilyResults, wikiResults } from "../server/worker.js";
import { answerQuestion, searchContext } from "../js/qa.js";

const ORIGIN = "https://shitianliang1000-alt.github.io";

function stubFetch(reply) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input?.url ?? input), init });
    return new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function search(q, env = {}, reply = {}) {
  const stub = stubFetch(reply);
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}/web/search`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    }), { ALLOW_ORIGIN: ORIGIN, ...env });
    return { res, doc: await res.json(), calls: stub.calls };
  } finally {
    stub.restore();
  }
}

test("抜き書きはタグを落とし、200字で切る", () => {
  assert.equal(cleanSnippet('<span class="searchmatch">箱根</span>は&amp;温泉'), "箱根は&温泉");
  assert.equal(cleanSnippet("あ".repeat(300)).length, 201);
});

test("キーが無ければ、Wikipedia を3件だけ聞く", async () => {
  const { doc, calls } = await search("箱根 温泉", {}, {
    query: { search: [
      { title: "箱根温泉", snippet: '<span class="searchmatch">箱根</span>の温泉' },
      { title: "箱根町", snippet: "町" }, { title: "芦ノ湖", snippet: "湖" }, { title: "4件目", snippet: "x" },
    ] },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/ja\.wikipedia\.org\/w\/api\.php\?/);
  assert.match(calls[0].url, /srlimit=3/);
  assert.equal(doc.engine, "wikipedia");
  assert.equal(doc.results.length, 3);
  assert.deepEqual(doc.results[0], {
    title: "箱根温泉", url: "https://ja.wikipedia.org/wiki/%E7%AE%B1%E6%A0%B9%E6%B8%A9%E6%B3%89",
    snippet: "箱根の温泉",
  });
});

test("TAVILY_API_KEY があれば、Tavily でウェブを検索する（キーは中継の中だけ）", async () => {
  const { doc, calls } = await search("箱根 ロープウェイ 運休", { TAVILY_API_KEY: "tvly-x" }, {
    results: [
      { title: "箱根ロープウェイ", url: "https://www.hakoneropeway.co.jp/", content: "運行状況" },
      { title: "http は捨てる", url: "http://example.com/", content: "x" },
    ],
  });
  assert.equal(calls[0].url, "https://api.tavily.com/search");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tvly-x");
  assert.equal(JSON.parse(calls[0].init.body).max_results, 3);
  assert.equal(doc.engine, "tavily");
  assert.deepEqual(doc.results, [
    { title: "箱根ロープウェイ", url: "https://www.hakoneropeway.co.jp/", snippet: "運行状況" },
  ]);
  assert.doesNotMatch(JSON.stringify(doc), /tvly-x/);
});

test("検索語が空なら断る", async () => {
  const { res } = await search("  ");
  assert.equal(res.status, 400);
});

test("返事の形をそろえる", () => {
  assert.deepEqual(wikiResults({}), []);
  assert.deepEqual(tavilyResults({ results: [{ url: "https://a.jp/", content: "c" }] }),
                   [{ title: "https://a.jp/", url: "https://a.jp/", snippet: "c" }]);
});

test("Gemma が調べたいと言えば、検索して抜き書きを渡し、答え直させる", async () => {
  const prompts = [];
  let asked = "";
  let shown = "";
  const got = await answerQuestion("箱根ロープウェイは今日動いてる？", {}, {
    call: async (p) => {
      prompts.push(p);
      return prompts.length === 1 ? { search: "箱根ロープウェイ 運行状況" }
        : { answer: "いまは平常運転です。", place: "箱根" };
    },
    webSearch: async (q) => {
      asked = q;
      return [{ title: "運行状況", url: "https://www.hakoneropeway.co.jp/", snippet: "全線で平常運転" }];
    },
    onSearch: (q) => { shown = q; },
  });
  assert.equal(asked, "箱根ロープウェイ 運行状況");
  assert.equal(shown, asked);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /"search"/);
  assert.match(prompts[1], /\[1\] 運行状況: 全線で平常運転/);
  // 2回目は、もう検索を頼めない（1回の質問につき1回まで）。
  assert.doesNotMatch(prompts[1], /"search"/);
  assert.equal(got.answer, "いまは平常運転です。");
  assert.deepEqual(got.sources, [{ title: "運行状況", url: "https://www.hakoneropeway.co.jp/" }]);
});

test("調べなくてよければ、検索しない（AIは1回だけ）", async () => {
  let n = 0;
  const got = await answerQuestion("富士山の標高は？", {}, {
    call: async () => { n++; return { answer: "3776mです。" }; },
    webSearch: async () => { throw new Error("呼ばない"); },
  });
  assert.equal(n, 1);
  assert.equal(got.answer, "3776mです。");
  assert.deepEqual(got.sources, []);
});

test("検索に失敗しても、知っていることで答える", async () => {
  const prompts = [];
  const got = await answerQuestion("今週末の花火大会は？", {}, {
    call: async (p) => { prompts.push(p); return prompts.length === 1 ? '{"search": "花火大会 今週末"}' : '{"answer": "確かめられませんでした。"}'; },
    webSearch: async () => { throw new Error("down"); },
  });
  assert.equal(got.ok, true);
  assert.match(prompts[1], /見つかりませんでした/);
  assert.deepEqual(got.sources, []);
});

test("検索の抜き書きは3件まで", () => {
  const lines = searchContext(Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, snippet: "s" })));
  assert.equal(lines.length, 4);
});
