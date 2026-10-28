#!/usr/bin/env node
// 旅さき CLI: 端末（SSH の先でも）から旅程を組む。
//
//     node packages/cli/bin/tabisaki-plan.mjs plan "温泉と海をゆっくり楽しみたい" --days=2
//     ./tabisaki plan "京都の寺" --from=新大阪駅 --output=json
//
// 外へは通信しません（AI・実際の乗換・天気は使わず、収録データと距離からの目安で組みます）。
// --local を付けたときだけ、手元の LLM（Ollama など）に希望文の読み取りと行き先の選定を
// させます（docs/local-llm.md）。話す相手は手元の LLM だけです。
// sync だけは、指定したカレンダー（CalDAV）にも書き込みます。
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
  --output=<形式>     markdown / text / json / ics（既定: markdown）
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
  tabisaki sync "<希望>" --caldav-url=<URL> [同じオプション] [--dry-run] [--yes]
                      組んだ旅程を CalDAV のカレンダーに書き込む（同じ旅は上書き）
  tabisaki sync --remove --caldav-url=<URL> ["<希望>" と同じオプション]
                      旅さきが書いた予定を消す（希望を書かなければ、そのカレンダーの分すべて）
  tabisaki voice-plan <録音.wav> [同じオプション] [--yes]
                      手元の whisper.cpp で声を文字にし、確かめてから組む
  tabisaki spot help  スポットに別名・営業時間・季節・写真を足す（出典と確認の状態つき）
  tabisaki area help  自分でエリアを決める
  tabisaki help       これを出す
  tabisaki --version  版を出す

例:
  tabisaki plan "温泉と海をゆっくり楽しみたい" --days=2 --output=markdown
  tabisaki plan "京都で歴史を感じたい" --from=新大阪駅 --date=2026-11-03

時刻はすべて日本時間です。移動時間は距離からの目安で、実際の乗換は調べません。
sync と voice-plan の設定（合言葉・モデル）は docs/calendar-and-voice.md にあります。
`;

const OPTIONS = new Set(["from", "days", "date", "start", "back", "transport", "output", "lang", "kb",
  "model", "llm-url", "region", "out", "method", "limit", "index", "caldav-url"]);
// 値を取らないもの。
const FLAGS = new Set(["help", "version", "local", "pull", "dry-run", "yes", "remove"]);
// 旅程を組むコマンド。
const COMMANDS = new Set(["plan", "tui", "sync", "voice-plan"]);
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

/**
 * 端末で1行たずねます。端末でない（パイプ・cron）ときは null を返します。
 * @returns {Promise<string|null>}
 */
async function ask(question, { stdin, stderr }) {
  if (!stdin?.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 本体のログ（console.log・warn）は stderr へ。stdout は旅程だけにします（パイプで使えるように）。 */
async function quietly(stderr, fn) {
  const log = console.log;
  const warn = console.warn;
  const info = console.info;
  const toErr = (...a) => stderr.write(a.map(String).join(" ") + "\n");
  const quiet = () => {};
  console.log = console.info = process.env.TABISAKI_DEBUG ? toErr : quiet;
  console.warn = process.env.TABISAKI_DEBUG ? toErr : quiet;
  try {
    return await fn();
  } finally {
    console.log = log; console.warn = warn; console.info = info;
  }
}

/** ユーザーKB の差分に問題があれば、stderr に1行で知らせます。 */
function reportOverlay(c, stderr) {
  const rep = c.overlayReport;
  if (rep && (rep.orphans.length || rep.conflicts.length || rep.invalid.length)) {
    stderr.write(`tabisaki: ユーザーKB「${rep.name}」: 見失った差分 ${rep.orphans.length}件・公式と食い違う項目 ${rep.conflicts.length}件・使えない差分 ${rep.invalid.length}件\n`);
  }
}

function planRequest(opts, wish) {
  return {
    wish, from: opts.from, days: opts.days === undefined ? undefined : Number(opts.days),
    date: opts.date, start: opts.start, back: opts.back, transport: opts.transport,
  };
}

async function runCmd(cmd) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", cmd], { encoding: "utf8", timeout: 30_000 }, (err, out) => {
      if (err) reject(Object.assign(new Error("TABISAKI_CALDAV_PASSWORD_CMD が失敗しました"), { exitCode: 2 }));
      else resolve(out);
    });
  });
}

/** tabisaki sync */
async function sync(opts, words, io) {
  const { stdout, stderr, env } = io;
  // 旅程を組むあいだは fetch を「外へ出ない」ものに替えます（packages/core）。
  // カレンダーへは本物の fetch で送るので、替わる前に取っておきます。
  const netFetch = globalThis.fetch;
  const caldav = await import("../../core/caldav.mjs");
  if (!opts["caldav-url"]) throw usage("--caldav-url=<カレンダーの URL> を付けてください（docs/calendar-and-voice.md）");
  const calendar = caldav.checkCalendarUrl(opts["caldav-url"]);
  const file = caldav.statePath(env);
  const state = await caldav.loadState(file);
  const wish = words.join(" ").trim();
  const core = await import("../../core/index.mjs");

  if (opts.remove) {
    let seed;
    if (wish) seed = caldav.tripSeed(await core.normalizeRequest(planRequest(opts, wish)));
    const plan = await caldav.removeEvents({ calendar, seed, state, dryRun: true });
    if (!plan.removed.length) { stderr.write("tabisaki: このカレンダーに、旅さきが書いた予定はありません\n"); return 0; }
    if (opts["dry-run"]) { stdout.write(`消す予定: ${plan.removed.length}件（${calendar.host}）\n`); return 0; }
    if (!opts.yes) {
      const a = await ask(`${calendar.host} から、旅さきが書いた予定 ${plan.removed.length}件を消します。よいですか [y/N] `, io);
      if (a === null) throw usage("端末でないときは --yes を付けてください");
      if (!/^y(es)?$/i.test(a)) { stderr.write("やめました。\n"); return 0; }
    }
    const credentials = await caldav.credentialsFrom(env, runCmd);
    const r = await caldav.removeEvents({ calendar, credentials, seed, state, fetch: netFetch });
    await caldav.saveState(file, state);
    stdout.write(`消しました: ${r.removed.length}件${r.kept.length ? `（消せなかったもの ${r.kept.length}件）` : ""}\n`);
    return r.kept.length ? 1 : 0;
  }

  if (!wish) throw usage('希望の文を書いてください。例: tabisaki sync "温泉" --caldav-url=https://…/calendars/me/travel/');
  const result = await quietly(stderr, () => planWith(core, opts, wish, { stderr }));
  const seed = caldav.tripSeed(result.request);
  const events = caldav.splitEvents(await core.toIcs(result, { seed }));
  if (!events.length) throw new Error("カレンダーに入れる予定がありませんでした");
  const plan = await caldav.syncEvents({ calendar, events, seed, state, dryRun: true });

  const list = events.map((e) => `  ${e.start.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d).*/, "$2/$3 $4:$5")}  ${e.summary}`).join("\n");
  stderr.write(`${result.itinerary.title ?? "旅程"} を ${calendar.host} に書き込みます（${events.length}件`
    + `${plan.removed.length ? `、前に書いて今回は無い ${plan.removed.length}件を消します` : ""}）:\n${list}\n`);
  if (opts["dry-run"]) { stdout.write(`書き込む予定: ${events.length}件・消す予定: ${plan.removed.length}件（まだ何も送っていません）\n`); return 0; }
  if (!opts.yes) {
    const a = await ask("よいですか [y/N] ", io);
    if (a === null) throw usage("端末でないときは、確かめたうえで --yes を付けてください（--dry-run で中身を見られます）");
    if (!/^y(es)?$/i.test(a)) { stderr.write("やめました。何も送っていません。\n"); return 0; }
  }
  const credentials = await caldav.credentialsFrom(env, runCmd);
  try {
    const r = await caldav.syncEvents({ calendar, credentials, events, seed, state, fetch: netFetch });
    stdout.write(`書き込みました: ${r.put.length}件${r.removed.length ? `・消しました: ${r.removed.length}件` : ""}\n`);
    return r.kept.length ? 1 : 0;
  } finally {
    await caldav.saveState(file, state);
  }
}

/** tabisaki voice-plan。組む文（string）か、やめたときの終了コード（number）を返します。 */
async function voicePlan(opts, words, io) {
  const { stderr, env } = io;
  const { transcribe } = await import("../../core/voice.mjs");
  if (words.length !== 1) throw usage("録音のファイルを1つだけ指定してください。例: tabisaki voice-plan wish.wav");
  const heard = await transcribe(words[0], { env });
  stderr.write(`聞き取った文: ${heard}\n`);
  let wish = heard;
  if (!opts.yes) {
    const a = await ask("Enter でこの文で組みます。直すときは書き直して Enter、やめるときは n: ", io);
    if (a === null) throw usage("端末でないときは、聞き取った文を確かめたうえで --yes を付けてください");
    if (/^n(o)?$/i.test(a)) { stderr.write("やめました。\n"); return 0; }
    if (a) wish = a;
  }
  return wish; // 続きは plan と同じ
}

/** 控えたプラグインとユーザーKB・手元の LLM を合わせて、旅程を1つ組みます。 */
async function planWith(core, opts, wish, { stderr, local = null }) {
  // 控えた（trust した）プラグインだけを読みます。TABISAKI_PLUGINS=0 で読みません。
  const plugins = process.env.TABISAKI_PLUGINS === "0" ? [] : await core.loadPlugins();
  const c = await core.createCore({ plugins, local, ...(opts.kb ? { userKb: opts.kb } : {}) });
  reportOverlay(c, stderr);
  const result = await c.plan(planRequest(opts, wish));
  if (result.template) stderr.write(`ひな形「${result.template.name}」を使いました（プラグイン ${result.template.plugin}）\n`);
  return result;
}

export async function main(argv, {
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env,
} = {}) {
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
    if (cmd === "kb" || cmd === "similar") return await kbCommand(cmd, rest, opts, { stdout, stderr });
    if (cmd === "local") return await localCommand(rest, opts, { stdout, stderr });
    if (!COMMANDS.has(cmd)) throw usage(`知らないコマンドです: ${cmd}（tabisaki help で一覧）`);
    if (opts["caldav-url"] && cmd !== "sync") throw usage("--caldav-url は tabisaki sync で使います");
    if ((opts["dry-run"] || opts.remove) && cmd !== "sync") throw usage("--dry-run と --remove は tabisaki sync で使います");
    if (opts.yes && cmd !== "sync" && cmd !== "voice-plan") throw usage("--yes は sync と voice-plan で使います");
    const io = { stdout, stderr, stdin, env };
    if (cmd === "sync") return await sync(opts, rest, io);
    let wish = rest.join(" ").trim();
    if (cmd === "voice-plan") {
      const picked = await voicePlan(opts, rest, io);
      if (typeof picked === "number") return picked;
      wish = picked;
    }
    if (!wish) throw usage(`希望の文を書いてください。例: tabisaki ${cmd} "温泉と海をゆっくり楽しみたい"`);
    if (cmd === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw usage("tui は端末の中で動かしてください（パイプやファイルに出すときは tabisaki plan）");
    }
    const output = opts.output ?? "markdown";
    if (!["markdown", "md", "text", "json", "ics"].includes(output)) throw usage(`--output は markdown / text / json / ics のどれかです`);
    const core = await import("../../core/index.mjs");
    if (opts.lang !== undefined && !core.pickLang(opts.lang)) throw usage(`--lang は ${core.LANGS.join(" / ")} のどれかです`);
    const lang = core.resolveLang(opts.lang);
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
    const result = await quietly(stderr, () => planWith(core, opts, wish, { stderr, local }));
    if (cmd === "tui") {
      const { run } = await import("../../tui/tui.mjs");
      await run(result);
      return 0;
    }
    const text = output === "ics" ? await core.toIcs(result)
      : output === "json" ? core.toJson(result)
      : output === "text" ? core.toPlainText(result, { lang }) : core.toMarkdown(result, { lang });
    stdout.write(text);
    return 0;
  } catch (e) {
    stderr.write(`tabisaki: ${e?.message ?? e}\n`);
    if (e?.exitCode) return e.exitCode;
    if (["invalid_input", "unknown_place", "invalid_name", "not_found", "bad_url", "setup", "auth"].includes(e?.code)) return 2;
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
