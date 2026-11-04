// 国土数値情報の非商用データ（観光資源 P12・文化施設 P27・バス停留所 P11）を公開しない（docs/kokudo-licenses.md）。
// 公開の kb/ に戻ってきていないか、サイトの組み立てが kb-private/ を拾わないかを見ます。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const kb = new URL("../kb/", import.meta.url);
const isNoncommercial = (s) => s?.src === "kokudo" || /P27|文化施設/.test(String(s?.dataSource ?? ""));

test("公開の kb/ に、観光資源 P12・文化施設 P27 のスポットが無い", () => {
  const found = [];
  for (const f of readdirSync(kb).filter((f) => /^spots-.*\.json$/.test(f))) {
    for (const s of JSON.parse(readFileSync(new URL(f, kb), "utf8")).spots) if (isNoncommercial(s)) found.push(`${f}: ${s.id}`);
  }
  assert.deepEqual(found.slice(0, 5), [], `${found.length}件。node tools/split_noncommercial.mjs --write で外してください`);
});

test("公開の kb/ に、バス停留所 P11 が無い", () => {
  assert.equal(existsSync(new URL("stops-bus.json", kb)), false);
  assert.equal(existsSync(new URL("stops-bus/", kb)), false);
});

test("kb-private/ はリポジトリにもサイトにも入らない", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^\/kb-private\/$/m);
  for (const f of ["tools/build_site.sh", "tools/build_php.sh", "tools/build_worker.sh"]) {
    const sh = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(sh, /kb-private/, f);
  }
});
