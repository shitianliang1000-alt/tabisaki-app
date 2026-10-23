// トップ（PHP 版の index.php と、Cloudflare 版の server/landing.js）が読む
// データ（data/areas.json）を作ります。
//
//     node tools/build_php_data.mjs <組み立てたサイトの場所> [書き出す先]
//
// 書き出す先を省くと <組み立てたサイトの場所>/data/areas.json です。
//
// 紹介できるエリア（説明を持つもの）と、収録の数だけを書きます。
// エリアのページ（areas/<県>/<エリア>.html）があれば、その場所も添えます。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { curatedRegions } from "./build_area_pages.mjs";
import { parseCourse } from "./course.mjs";

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


const areas = [];
for (const r of curatedRegions(regions)) {
  const page = pageOf.get(r.id) ?? null;
  let course = [];
  if (page) course = parseCourse(await readFile(join(out, page), "utf8"));
  const image = page && existsSync(join(out, page.replace(/\.html$/, ".png"))) ? page.replace(/\.html$/, ".png") : null;
  areas.push({
    id: r.id, name: r.name, prefecture: r.prefecture,
    tagline: r.tagline, description: r.description,
    genres: r.genres ?? [], station: r.station,
    lat: r.lat ?? null, lng: r.lng ?? null,
    page, image, course,
  });
}

/**
 * お知らせ。リポジトリの履歴から、使う人に関わる変更だけを拾います
 * （テスト・注釈・取り込みのような、中の作業は載せません）。
 * 履歴が無い組み立て（浅い clone など）では空のままです。
 */
function newsFromGit() {
  let log = "";
  try {
    log = execFileSync("git", ["log", "-n", "120", "--no-merges", "--pretty=%ad|%s", "--date=short"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return []; }
  const skip = /テスト|試験|注釈|CodeQL|Sentinel|^Update |^Merge |取り込|作り直す|^main |CI|lint/i;
  // 置き場所や組み立ての話（js・Worker・PHP・GitHub など）は、使う人には分からないので載せません。
  const backstage = /\bjs\b|\.js|\.html|ファイル|GitHub|Worker|Cloudflare|InfinityFree|PHP|ひな形|起動|sw\b|ビルド|組み立て|sitemap|lastmod|\bh1\b|https|中継/i;
  const seen = new Set();
  const out = [];
  for (const line of log.split("\n")) {
    const [date, ...rest] = line.split("|");
    const title = rest.join("|").trim();
    if (!date || !title || skip.test(title) || backstage.test(title) || seen.has(title)) continue;
    seen.add(title);
    const tag = /PHP|Cloudflare|公開|ページ|sitemap/.test(title) ? "サイト"
      : /チャット|AI|Gemma|質問/.test(title) ? "チャット"
      : /エリア|収録|穴場|上高地|県/.test(title) ? "行き先"
      : "改善";
    // 「チャット：〜」のように頭に分類が書いてあるものは、札と重なるので外します。
    out.push({ date, title: title.replace(/^[^：:、。\s]{1,8}[：:]\s*/, ""), tag });
    if (out.length >= 6) break;
  }
  return out;
}

const dest = process.argv[3] ?? join(out, "data", "areas.json");
await mkdir(dirname(dest), { recursive: true });
// build は組み立てた時刻です。トップの CSS・JS の ?v= に使い、古いものが残らないようにします。
await writeFile(dest,
  JSON.stringify({ build: Date.now().toString(36), prefCount, spotCount, areas, news: newsFromGit() }, null, 0));
const withCourse = areas.filter((a) => a.course.length).length;
console.log(`php data: ${areas.length} areas (${withCourse} with course), ${spotCount} spots → ${dest}`);
