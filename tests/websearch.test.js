// Gemma にネット検索をさせるテスト。
//
// Gemma は google_search を受け取らないので、中継（server/worker.js の
// /web/search）が代わりに検索し、短い抜き書きを渡します（js/qa.js）。
// 本物の検索先には行きません（fetch を差し替えます）。

import assert from "node:assert/strict";
import test from "node:test";

import worker, { LIMITS, RateLimiter, cleanSnippet, costOf, poolOf, tavilyResults, wikiResults }
  from "../server/worker.js";
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
  assert.doesNotMatch(cleanSnippet("&lt;script&gt;x&lt;/script&gt; <<script>b>"), /[<>]/);
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

test("Tavily の枠を使い切ったら、Wikipedia に切り替えて答える", async () => {
  // Tavily の無料枠（月1,000回）は全員で1つ。人ごとの枠では守れません。
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    calls.push(url);
    if (url.startsWith("https://api.tavily.com/")) {
      return new Response('{"detail":"usage limit exceeded"}', { status: 432 });
    }
    return new Response(JSON.stringify({ query: { search: [{ title: "箱根", snippet: "町" }] } }),
                        { headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}/web/search`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "箱根" }),
    }), { ALLOW_ORIGIN: ORIGIN, TAVILY_API_KEY: "tvly-x" });
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.engine, "wikipedia");
    assert.equal(doc.results[0].title, "箱根");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

// 利用枠の見積もり。検索は paid 側（Gemini・Routes と同じ枠）で数えます。
// 検索した質問1つ = 生成 + 検索 + 生成。既定の枠で何問続けて聞けるかを
// 数えておきます（server/worker.js の COST の注記と同じ数）。
test("検索した質問は、既定の枠で1分に5つ・1時間に36まで聞ける", async () => {
  assert.equal(poolOf("/web/search"), "paid");
  const one = costOf("/gemini/generate") * 2 + costOf("/web/search");
  assert.equal(one, 11);
  const fakeState = () => {
    const map = new Map();
    return { storage: { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v),
                        deleteAll: async () => map.clear(), setAlarm: async () => {} },
             blockConcurrencyWhile: (fn) => fn() };
  };
  const lim = `&limits=${encodeURIComponent(JSON.stringify(LIMITS))}`;
  const ask = async (rl) => {
    for (const path of ["/gemini/generate", "/web/search", "/gemini/generate"]) {
      const r = await (await rl.fetch(new Request(
        `https://rate/check?cost=${costOf(path)}&pool=${poolOf(path)}${lim}`))).json();
      if (!r.ok) return false;
    }
    return true;
  };
  const realNow = Date.now;
  try {
    // 続けざまに聞くと、1分の枠で止まります。
    let t = 1_000_000_000_000;
    Date.now = () => t;
    const burst = new RateLimiter(fakeState());
    let n = 0;
    while (n < 20 && await ask(burst)) n++;
    assert.equal(n, Math.floor(LIMITS.paid.minute / one));
    // 1分おきに聞くと、1時間の枠で止まります。
    const steady = new RateLimiter(fakeState());
    let m = 0;
    while (m < 100 && await ask(steady)) { m++; t += 61_000; }
    assert.equal(m, Math.floor(LIMITS.paid.hour / one));
  } finally {
    Date.now = realNow;
  }
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
