// 地域別の知識ベース切り出しと、似たスポット検索（Issue #353）の試験。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AREAS, PREFECTURES, buildIndex, evaluate, extractRegion, readIndex, resolveRegion, similar, writeIndex,
} from "../packages/core/kbtools.mjs";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("地方・都道府県・略した名前・複数を、都道府県の並びにする", () => {
  assert.equal(PREFECTURES.length, 47);
  assert.deepEqual(resolveRegion("関東"), ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"]);
  assert.deepEqual(resolveRegion("京都"), ["京都府"]);
  assert.deepEqual(resolveRegion("奈良県,京都府"), ["京都府", "奈良県"]);
  assert.deepEqual(resolveRegion("近畿地方"), AREAS.近畿);
  assert.equal(resolveRegion("全国").length, 47);
  // 8地方区分で全都道府県がちょうど1回ずつ
  const eight = ["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州沖縄"].flatMap((a) => AREAS[a]);
  assert.deepEqual(eight, PREFECTURES);
  assert.throws(() => resolveRegion("どこか"), /知りません/);
  assert.throws(() => resolveRegion(""), /--region/);
});

test("切り出しは同じ kb から同じ中身になり、出典を持ち、地域の外を含まない", async () => {
  const a = await extractRegion("京都府");
  const b = await extractRegion("京都");
  assert.equal(JSON.stringify(a.spots), JSON.stringify(b.spots));
  assert.equal(a.kbHash, b.kbHash);
  assert.match(a.kbHash, /^[0-9a-f]{16}$/);
  assert.ok(a.spots.length > 1000);
  assert.ok(a.spots.every((s) => s.prefecture === "京都府"));
  assert.ok(a.spots.every((s) => s.id && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng)));
  const regionIds = new Set(a.regions.map((r) => r.id));
  assert.ok(a.spots.every((s) => regionIds.has(s.regionId)), "スポットのエリアは切り出しに入っている");
  assert.ok(a.sources.length >= 5 && a.sources.every((s) => s.name));
  assert.ok(Object.values(a.spotsBySrc).reduce((x, y) => x + y, 0) === a.spots.length);
  assert.match(a.notice, /非商用/);
  // 出典の項目（src・license など）を落とさない
  const src = JSON.parse(readFileSync(new URL("../kb/spots-jp26-kyoto.json", import.meta.url), "utf8")).spots;
  assert.equal(a.spots.filter((s) => s.src).length, src.filter((s) => s.src).length);
  assert.equal(a.spots.filter((s) => s.license).length, src.filter((s) => s.license).length);
});

test("関東の切り出しは全国より小さく、ちょうど7都県ぶん", async () => {
  const kanto = await extractRegion("関東");
  const manifest = JSON.parse(readFileSync(new URL("../kb/index.json", import.meta.url), "utf8"));
  const expected = manifest.shards.filter((s) => AREAS.関東.includes(s.prefecture)).reduce((n, s) => n + s.count, 0);
  assert.equal(kanto.counts.spots, expected);
  assert.equal(kanto.files.length, 7);
});

test("似たスポット: 同名が多い名前は有名なほうを起点にし、同じ分類が上に来る", async () => {
  const index = buildIndex(await extractRegion("全国"));
  const r = similar(index, "清水寺", { limit: 5 });
  assert.equal(r.query.prefecture, "京都府");
  assert.ok(r.results.every((x) => x.category === "寺院"));
  assert.ok(!r.results.some((x) => x.id === r.query.id), "自分自身は出さない");
  const kin = similar(index, "金閣寺", { limit: 3 });
  assert.ok(kin.results.length === 3 && kin.results[0].score >= kin.results[2].score);
  // 文で探すときは、1字（寺）からも分類を読む
  const text = similar(index, "紅葉の寺", { limit: 5 });
  assert.equal(text.query, null);
  assert.ok(text.results.filter((x) => x.category === "寺院").length >= 4);
});

test("評価用データで precision@5 の平均が 0.9 以上", async () => {
  const { cases } = JSON.parse(readFileSync(new URL("./fixtures/similar-eval.json", import.meta.url), "utf8"));
  const index = buildIndex(await extractRegion("全国"));
  const r = evaluate(index, cases, 5);
  assert.ok(r.mean >= 0.9, JSON.stringify(r.rows.filter((x) => x.precision < 1), null, 1));
});

test("索引は書き出して読み戻しても同じ答え。faiss は理由を書いて断る", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tabisaki-idx-"));
  try {
    const index = buildIndex(await extractRegion("奈良県"));
    const file = await writeIndex(index, path.join(dir, "nara.json"));
    const back = await readIndex(file);
    assert.deepEqual(similar(back, "東大寺", { limit: 5 }).results, similar(index, "東大寺", { limit: 5 }).results);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => buildIndex({ spots: [] }, { method: "faiss" }), /tfidf だけ/);
});

test("CLI: kb extract・kb index・similar と、使いかたのまちがい", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tabisaki-cli-"));
  try {
    const ex = run("kb", "extract", "--region=沖縄", `--out=${path.join(dir, "o.json")}`);
    assert.equal(ex.status, 0, ex.stderr);
    assert.equal(JSON.parse(readFileSync(ex.stdout.trim(), "utf8")).prefectures[0], "沖縄県");
    const ix = run("kb", "index", "--region=沖縄", `--out=${path.join(dir, "i.json")}`);
    assert.equal(ix.status, 0, ix.stderr);
    const sim = run("similar", "首里城", `--index=${ix.stdout.trim()}`, "--limit=3", "--output=json");
    assert.equal(sim.status, 0, sim.stderr);
    const j = JSON.parse(sim.stdout);
    assert.equal(j.results.length, 3);
    assert.match(j.matched, /首里城/);
    const text = run("similar", "首里城", "--region=沖縄", "--limit=2");
    assert.match(text.stdout, /に似たスポット\n\n 1\. /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const args of [["kb", "extract"], ["kb", "extract", "--region=どこか"], ["kb", "index", "--method=faiss"],
    ["kb", "nope"], ["similar"], ["similar", "x", "--limit=0"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^tabisaki: /);
  }
});
