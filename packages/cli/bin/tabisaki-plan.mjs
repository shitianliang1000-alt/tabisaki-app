#!/usr/bin/env node
// 旅さき CLI: 端末（SSH の先でも）から旅程を組む。
//
//     node packages/cli/bin/tabisaki-plan.mjs plan "温泉と海をゆっくり楽しみたい" --days=2
//     ./tabisaki plan "京都の寺" --from=新大阪駅 --output=json
//
// 外へは通信しません（AI・実際の乗換・天気は使わず、収録データと距離からの目安で組みます）。
// --local を付けたときだけ、手元の LLM（Ollama など）に希望文の読み取りと行き先の選定を
// させます（docs/local-llm.md）。話す相手は手元の LLM だけです。
// 終了コード: 0 = 組めた、1 = 組めなかった、2 = 使いかたのまちがい

import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `使いかた: tabisaki plan "<希望の文>" [オプション]

  --from=<駅>         出発地（既定: 東京駅）。例: 新大阪駅・博多駅・札幌駅
  --days=<N>          日数 1〜14（既定: 1）
  --date=<YYYY-MM-DD> 出発日（既定: 明日）
  --start=<HH:MM>     出発の時刻（既定: 08:00）
  --back=<HH:MM>      最終日に帰り着く時刻（既定: 20:00）
  --transport=<手段>  any / transit / car / walk / local（既定: any）
  --output=<形式>     markdown / text / json（既定: markdown）
  --lang=<言語>       ja / en（既定: ja。環境変数 TABISAKI_LANG でも決められます）
  --kb=<名前>         ユーザーKB（~/.tabisaki/kbs/<名前>/）を公式の収録に重ねて組む
  --local             手元の LLM（Ollama など）で行き先を選ぶ（docs/local-llm.md）
  --model=<名前>      --local で使うモデル（既定: gemma4:e2b）
  --llm-url=<URL>     手元の LLM の行き先（既定: http://127.0.0.1:11434）

  tabisaki local setup [--model=…] [--pull]  手元の LLM を確かめる（--pull でモデルを取る）
  tabisaki local models                     勧めるモデルと、要るメモリ・ディスク

  tabisaki kb extract --region=<地方|都道府県> [--out=<file>]  地域の知識ベースを切り出す
  tabisaki kb index [--region=…] [--method=tfidf] [--out=…]   似たスポット検索の索引を作る
  tabisaki similar "<スポット名か文>" [--region=…] [--limit=10] [--index=<file>] [--output=json]

  tabisaki tui "<希望>" [同じオプション]   組んだ旅程を端末の中で見る（j/k・h/l・Enter・q）
  tabisaki spot help  スポットに別名・営業時間・季節・写真を足す（出典と確認の状態つき）
  tabisaki area help  自分でエリアを決める
  tabisaki help       これを出す
  tabisaki --version  版を出す

例:
  tabisaki plan "温泉と海をゆっくり楽しみたい" --days=2 --output=markdown
  tabisaki plan "京都で歴史を感じたい" --from=新大阪駅 --date=2026-11-03

時刻はすべて日本時間です。移動時間は距離からの目安で、実際の乗換は調べません。
`;

const OPTIONS = new Set(["from", "days", "date", "start", "back", "transport", "output", "lang", "kb",
  "model", "llm-url", "region", "out", "method", "limit", "index"]);
// 値を取らないもの。
const FLAGS = new Set(["help", "version", "local", "pull"]);
// まだ無いもの（docs/roadmap.md）。黙って無視せず、無いと言います。
const PLANNED = {};

export function parseArgs(argv) {
  const opts = {};
  const words = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { words.push(a); continue; }
    const [, key, value] = m;
    if (FLAGS.has(key)) {
      if (value !== undefined) throw usage(`--${key} は値を取りません（--${key} だけ書いてください）`);
      opts[key] = true;
      continue;
    }
    if (PLANNED[key]) throw usage(`--${key} はまだ使えません（計画中: Issue ${PLANNED[key]}）`);
    if (!OPTIONS.has(key)) throw usage(`知らないオプションです: --${key}（tabisaki help で一覧）`);
    if (value === undefined || value === "") throw usage(`--${key}=<値> の形で書いてください`);
    opts[key] = value;
  }
  return { opts, words };
}

const STATUS = { enabled: "使う", untrusted: "まだ控えていない", changed: "中身が変わった（控え直すまで使わない）", invalid: "宣言にまちがい" };

async function plugins([sub = "list", id], { stdout }) {
  const p = await import("../../core/plugins.mjs");
  const dir = p.pluginDir();
  if (sub === "list") {
    const all = await p.scanPlugins(dir);
    stdout.write(`置き場所: ${dir}\n`);
    if (!all.length) stdout.write("プラグインはありません\n");
    for (const x of all) {
      const m = x.manifest;
      stdout.write(`${x.id}${m ? ` ${m.version}（${m.name}・${m.author}・${m.license}）` : ""}: ${STATUS[x.status]}\n`);
      for (const e of x.errors ?? []) stdout.write(`  - ${e}\n`);
    }
    return 0;
  }
  if (!id) throw usage(`tabisaki plugins ${sub} <id> の形で書いてください`);
  if (sub === "trust") {
    const x = await p.trustPlugin(dir, id);
    const c = x.manifest.contributes;
    stdout.write(`${id} ${x.manifest.version} を控えました（sha256 ${x.sha256.slice(0, 12)}…）。` +
      `ひな形 ${(c.templates ?? []).length} 個・除外 ${(c.constraints ?? []).length} 個\n`);
    return 0;
  }
  if (sub === "untrust") {
    stdout.write((await p.untrustPlugin(dir, id)) ? `${id} を控えから外しました。消すときは ${dir}/${id} を消してください\n` : `${id} は控えにありません\n`);
    return 0;
  }
  throw usage(`plugins のあとは list / trust / untrust のどれかです`);
}

function usage(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv[0] === "spot" || argv[0] === "area") {
    const { main: spotMain } = await import("./spot.mjs");
    return spotMain(argv, { stdout, stderr });
  }
  try {
    const { opts, words } = parseArgs(argv);
    if (opts.version) { stdout.write(`tabisaki ${VERSION}\n`); return 0; }
    const [cmd, ...rest] = words;
    if (opts.help || !cmd || cmd === "help") { stdout.write(HELP); return cmd || opts.help ? 0 : 2; }
    if (cmd === "plugins") return await plugins(rest, { stdout });
    if (cmd !== "plan" && cmd !== "tui") throw usage(`知らないコマンドです: ${cmd}（tabisaki help で一覧）`);
    const wish = rest.join(" ").trim();
    if (!wish) throw usage(`希望の文を書いてください。例: tabisaki ${cmd} "温泉と海をゆっくり楽しみたい"`);
    if (cmd === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw usage("tui は端末の中で動かしてください（パイプやファイルに出すときは tabisaki plan）");
    }
    const output = opts.output ?? "markdown";
    if (!["markdown", "md", "text", "json"].includes(output)) throw usage(`--output は markdown / text / json のどれかです`);
    const core = await import("../../core/index.mjs");
    if (opts.lang !== undefined && !core.pickLang(opts.lang)) throw usage(`--lang は ${core.LANGS.join(" / ")} のどれかです`);
    const lang = core.resolveLang(opts.lang);
    const days = opts.days === undefined ? undefined : Number(opts.days);

    if ((opts.model || opts["llm-url"]) && !opts.local) throw usage("--model と --llm-url は --local といっしょに使います");
    let local = null;
    if (opts.local) {
      const baseUrl = core.resolveBaseUrl(opts["llm-url"]);
      const model = opts.model ?? core.DEFAULT_LOCAL_MODEL;
      // 組みはじめる前に確かめます。途中で失敗すると本体が黙って収録データだけで
      // 組み直すので、「--local を付けたのに使われていない」が起きます。
      await core.ensureLocalModel({ baseUrl, model });
      local = { baseUrl, model };
      stderr.write(`手元の LLM（${model}）で組んでいます。数分かかることがあります…\n`);
    }
    // 本体のログ（console.log・warn）は stderr へ。stdout は旅程だけにします（パイプで使えるように）。
    const log = console.log;
    const warn = console.warn;
    const info = console.info;
    const toErr = (...a) => stderr.write(a.map(String).join(" ") + "\n");
    const quiet = () => {};
    console.log = console.info = process.env.TABISAKI_DEBUG ? toErr : quiet;
    console.warn = process.env.TABISAKI_DEBUG ? toErr : quiet;
    let result;
    try {
      // 控えた（trust した）プラグインだけを読みます。TABISAKI_PLUGINS=0 で読みません。
      const plugins = process.env.TABISAKI_PLUGINS === "0" ? [] : await core.loadPlugins();
      const c = await core.createCore({ plugins, ...(opts.kb ? { userKb: opts.kb } : {}) });
      const rep = c.overlayReport;
      if (rep && (rep.orphans.length || rep.conflicts.length || rep.invalid.length)) {
        stderr.write(`tabisaki: ユーザーKB「${rep.name}」: 見失った差分 ${rep.orphans.length}件・公式と食い違う項目 ${rep.conflicts.length}件・使えない差分 ${rep.invalid.length}件\n`);
      }
      result = await c.plan({
        wish, from: opts.from, days, date: opts.date, start: opts.start, back: opts.back,
        transport: opts.transport,
      });
    } finally {
      console.log = log; console.warn = warn; console.info = info;
    }
    if (result.template) stderr.write(`ひな形「${result.template.name}」を使いました（プラグイン ${result.template.plugin}）\n`);
    if (cmd === "tui") {
      const { run } = await import("../../tui/tui.mjs");
      await run(result);
      return 0;
    }
    const text = output === "json" ? core.toJson(result)
      : output === "text" ? core.toPlainText(result, { lang }) : core.toMarkdown(result, { lang });
    stdout.write(text);
    return 0;
  } catch (e) {
    stderr.write(`tabisaki: ${e?.message ?? e}\n`);
    if (e?.exitCode) return e.exitCode;
    if (["invalid_input", "unknown_place", "invalid_name", "not_found", "bad_url"].includes(e?.code)) return 2;
    return 1;
  }
}

/** tabisaki kb extract / kb index / similar（Issue #353） */
async function kbCommand(cmd, rest, opts, { stdout, stderr }) {
  const kb = await import("../../core/kbtools.mjs");
  const say = (line) => stderr.write(line + "\n");
  if (cmd === "kb") {
    const [sub, ...extra] = rest;
    if (extra.length) throw usage(`余計な語があります: ${extra.join(" ")}`);
    if (sub === "extract") {
      if (!opts.region) throw usage("--region=<地方か都道府県> を書いてください（例: tabisaki kb extract --region=関東）");
      const doc = await kb.extractRegion(opts.region);
      const file = await kb.writeExtract(doc, opts.out);
      stdout.write(`${file}\n`);
      say(`${doc.prefectures.join("・")}: エリア ${doc.counts.regions}・スポット ${doc.counts.spots}（kb ${doc.kbHash}）`);
      return 0;
    }
    if (sub === "index") {
      const doc = await kb.extractRegion(opts.region ?? "全国");
      const index = kb.buildIndex(doc, { method: opts.method ?? "tfidf" });
      const file = await kb.writeIndex(index, opts.out);
      stdout.write(`${file}\n`);
      say(`スポット ${index.spots.length}・語 ${index.terms.length}（${index.method}・kb ${index.kbHash}）`);
      return 0;
    }
    throw usage("tabisaki kb extract か tabisaki kb index を使ってください");
  }
  const q = rest.join(" ").trim();
  if (!q) throw usage('探す名前か文を書いてください。例: tabisaki similar "清水寺"');
  const limit = opts.limit === undefined ? 10 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw usage("--limit は 1〜100 の整数です");
  const output = opts.output ?? "text";
  if (!["text", "json", "markdown", "md"].includes(output)) throw usage("--output は text / markdown / json のどれかです");
  // 索引があれば使い、無ければその場で作ります（全国で1〜2秒）。
  let index = opts.index ? await kb.readIndex(opts.index) : null;
  if (opts.index && !index) throw usage(`索引を読めません: ${opts.index}（tabisaki kb index で作れます）`);
  index ??= kb.buildIndex(await kb.extractRegion(opts.region ?? "全国"));
  const { query, results } = kb.similar(index, q, { limit });
  if (output === "json") {
    stdout.write(JSON.stringify({ version: 1, query: q, matched: query ? query.name : null, kbHash: index.kbHash, results }, null, 2) + "\n");
    return results.length ? 0 : 1;
  }
  if (!results.length) { stderr.write(`tabisaki: 「${q}」に似たスポットは見つかりませんでした\n`); return 1; }
  const head = query ? `「${query.name}」（${query.category}・${[query.region, query.prefecture].filter(Boolean).join("・")}）に似たスポット`
    : `「${q}」に近いスポット（収録に同じ名前が無いので、文として探しました）`;
  stdout.write(`${head}\n\n`);
  results.forEach((r, i) => {
    const where = [r.region, r.prefecture].filter(Boolean).join("・");
    const dist = r.km === null ? "" : `  ${r.km}km`;
    stdout.write(`${String(i + 1).padStart(2)}. ${r.name}（${r.category}）  ${where}${dist}  ${r.score}\n`);
  });
  return 0;
}

/** tabisaki local setup / models */
async function localCommand([sub, ...extra], opts, { stdout, stderr }) {
  const core = await import("../../core/local.mjs");
  if (extra.length) throw usage(`余計な語があります: ${extra.join(" ")}`);
  if (sub === "models") {
    stdout.write("勧めるモデル（大きさは Ollama の表示による目安）:\n\n");
    for (const m of core.RECOMMENDED_MODELS) {
      stdout.write(`  ${m.name.padEnd(12)} 取得 ${m.download.padEnd(10)} メモリ ${m.memory.padEnd(9)} ${m.license}  ${m.note}\n`);
    }
    stdout.write("\nほかのモデルも --model=<名前> で使えます（指示に従う力が弱いと、選定の当たりが下がります）。\n");
    return 0;
  }
  if (sub !== "setup") throw usage("tabisaki local setup か tabisaki local models を使ってください");
  const baseUrl = core.resolveBaseUrl(opts["llm-url"]);
  const model = opts.model ?? core.DEFAULT_LOCAL_MODEL;
  const say = (line) => stdout.write(line + "\n");
  say(`1. 手元の LLM につながるか（${baseUrl}）`);
  const info = await core.probeRuntime(baseUrl);
  say(`   つながりました（${info.runtime === "ollama" ? "Ollama" : "OpenAI 互換のサーバー"}・モデル ${info.models.length}個）`);
  say(`2. モデル「${model}」があるか`);
  if (!core.hasModel(info.models, model)) {
    if (!opts.pull || info.runtime !== "ollama") {
      await core.ensureLocalModel({ baseUrl, model }); // 直しかた付きで投げます
    }
    say(`   ありません。取ってきます（数GBあります。ネットが要るのはここだけです）`);
    let shown = "";
    await core.pullModel({ baseUrl, model, onProgress: (ev) => {
      const pct = ev.total ? ` ${Math.floor((ev.completed ?? 0) / ev.total * 100)}%` : "";
      const line = `   ${ev.status}${pct}`;
      if (line !== shown) { shown = line; stderr.write(line + "\n"); }
    } });
  }
  say("   あります");
  say("3. 実際に答えるか（はじめての読み込みは1分ほどかかります）");
  const { reply, ms } = await core.pingModel({ baseUrl, model });
  say(`   答えました（${(ms / 1000).toFixed(1)}秒）: ${reply.slice(0, 40) || "（空の返事）"}`);
  say("");
  say(`使えます。tabisaki plan "<希望>" --local${opts.model ? ` --model=${model}` : ""}${opts["llm-url"] ? ` --llm-url=${baseUrl}` : ""} で組めます。`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("tabisaki-plan.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
