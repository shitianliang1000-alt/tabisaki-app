// PHP 版の about.php が読むデータ（data/areas.json）を作ります。
//
//     node tools/build_php_data.mjs <組み立てたサイトの場所>
//
// 紹介できるエリア（説明を持つもの）と、収録の数だけを書きます。
// エリアのページ（areas/<県>/<エリア>.html）があれば、その場所も添えます。
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { curatedRegions } from "./build_area_pages.mjs";

const out = process.argv[2] ?? ".php-site";
const ROOT = new URL("../", import.meta.url).pathname;
const read = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));

const raw = await read("kb/regions.json");
const regions = Array.isArray(raw) ? raw : Object.values(raw.regions ?? raw);
const index = await read("kb/index.json");
const spotCount = (index.shards ?? []).reduce((n, s) => n + (Number(s.count) || 0), 0);
const prefCount = new Set((index.shards ?? []).map((s) => s.prefecture)).size || 47;

// どのエリアのページがどの県の下にあるか（組み立てた areas/ から読みます）。
const pageOf = new Map();
const areasDir = join(out, "areas");
if (existsSync(areasDir)) {
  for (const pref of await readdir(areasDir, { withFileTypes: true })) {
    if (!pref.isDirectory()) continue;
    for (const f of await readdir(join(areasDir, pref.name))) {
      if (f.endsWith(".html") && f !== "index.html") pageOf.set(f.slice(0, -5), `areas/${pref.name}/${f}`);
    }
  }
}

const areas = curatedRegions(regions).map((r) => ({
  id: r.id, name: r.name, prefecture: r.prefecture,
  tagline: r.tagline, description: r.description,
  genres: r.genres ?? [], station: r.station,
  page: pageOf.get(r.id) ?? null,
}));

await mkdir(join(out, "data"), { recursive: true });
await writeFile(join(out, "data", "areas.json"),
  JSON.stringify({ prefCount, spotCount, areas }, null, 0));
console.log(`php data: ${areas.length} areas, ${spotCount} spots → ${out}/data/areas.json`);
