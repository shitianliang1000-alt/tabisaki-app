// PHP 版の zip から、国土数値情報の「非商用」のデータを外す（tools/strip_noncommercial.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripNoncommercial } from "../tools/strip_noncommercial.mjs";

const put = (dir, f, v) => writeFile(join(dir, f), JSON.stringify(v));
const get = async (dir, f) => JSON.parse(await readFile(join(dir, f), "utf8"));

test("観光資源・文化施設・バス停を外し、件数と索引をそろえる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-"));
  await put(dir, "index.json", {
    regionsFile: "regions.json",
    shards: [{ file: "spots-jp01-a.json", count: 4, prefecture: "A県", regions: ["r1", "r2"] }],
    counts: { regions: 2, spots: 4 },
    sources: [{ name: "国土数値情報 観光資源（国土交通省）" }, { name: "Wikipedia" }],
  });
  await put(dir, "spots-jp01-a.json", { spots: [
    { id: "a", regionId: "r1", name: "残る", src: "wikidata" },
    { id: "b", regionId: "r1", name: "観光資源", src: "kokudo" },
    { id: "c", regionId: "r2", name: "文化施設", dataSource: "国土数値情報 文化施設" },
    { id: "d", regionId: "r1", name: "分類だけ文化施設", category: "文化施設" },
  ] });
  await put(dir, "regions.json", { regions: [{ id: "r1", spotCount: 3 }, { id: "r2", spotCount: 1 }] });
  await put(dir, "names.json", { names: "残る\n観光資源\n文化施設\n分類だけ文化施設" });
  await put(dir, "tags-jp01-a.json", { tags: { a: {}, b: {}, c: {} } });
  await put(dir, "verification-jp01-a.json", { records: { b: {}, d: {} } });
  await put(dir, "stops-bus.json", { tiles: [{ file: "stops-bus/1_1.json" }] });
  await mkdir(join(dir, "stops-bus"));
  await put(dir, "stops-bus/1_1.json", { stops: [] });

  const r = await stripNoncommercial(dir);
  assert.deepEqual(r, { spots: 2, regions: 1, kept: 2 });
  assert.deepEqual((await get(dir, "spots-jp01-a.json")).spots.map((s) => s.id), ["a", "d"]);
  const ix = await get(dir, "index.json");
  assert.deepEqual(ix.counts, { regions: 1, spots: 2 });
  assert.deepEqual(ix.shards[0], { file: "spots-jp01-a.json", count: 2, prefecture: "A県", regions: ["r1"] });
  assert.deepEqual(ix.sources, [{ name: "Wikipedia" }]);
  assert.deepEqual((await get(dir, "regions.json")).regions, [{ id: "r1", spotCount: 2 }]);
  assert.equal((await get(dir, "names.json")).names, "残る\n分類だけ文化施設");
  assert.deepEqual(Object.keys((await get(dir, "tags-jp01-a.json")).tags), ["a"]);
  assert.deepEqual(Object.keys((await get(dir, "verification-jp01-a.json")).records), ["d"]);
  assert.deepEqual(await get(dir, "stops-bus.json"), { tiles: [] });
  assert.equal(existsSync(join(dir, "stops-bus")), false);
});

test("PHP 版の組み立ては、非商用のデータを外した kb/ から作る", async () => {
  const sh = await readFile(new URL("../tools/build_php.sh", import.meta.url), "utf8");
  assert.match(sh, /strip_noncommercial\.mjs/);
});
