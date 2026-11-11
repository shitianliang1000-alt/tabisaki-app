#!/usr/bin/env node
// 旅さき CLI: 端末（SSH の先でも）から旅程を組む。
//
//     node packages/cli/bin/tabisaki-plan.mjs plan "温泉と海をゆっくり楽しみたい" --days=2
//     ./tabisaki plan "京都の寺" --from=新大阪駅 --output=json
//
// 外へは通信しません（AI・実際の乗換・天気は使わず、収録データと距離からの目安で組みます）。
// --local を付けたときだけ、手元の LLM（Ollama など）に希望文の読み取りと行き先の選定を
// させます（docs/local-llm.md）。話す相手は手元の LLM だけです。
// --hybrid を付けたときは、手元の LLM で答え、確信度が低いときだけクラウドのモデルに
// 聞き直します（docs/model-router.md）。そのときだけ、希望の文がクラウドへ出ます。
// sync だけは、指定したカレンダー（CalDAV）にも書き込みます。
// 終了コード: 0 = 組めた、1 = 組めなかった、2 = 使いかたのまちがい

import { readFileSync } from "node:fs";
import { JOURNEY_COMMANDS, JOURNEY_HELP, runJourney } from "../../journey/cli.mjs";

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
                      （書かなければ kb switch で決めたもの。--kb=official で重ねない）
  --local             手元の LLM（Ollama など）で行き先を選ぶ（docs/local-llm.md）
  --model=<名前>      --local で使うモデル（既定: gemma4:e2b）
  --llm-url=<URL>     手元の LLM の行き先（既定: http://127.0.0.1:11434）
  --hybrid            手元の LLM で答え、確信度が低いときと Web 検索が要るときだけクラウドへ
                      回す（docs/model-router.md。クラウドの入口は GEMINI_API_KEY か --cloud-url）
  --threshold=<0〜1>  --hybrid でクラウドへ回す確信度の閾値（既定: 0.75）
  --cloud-url=<URL>   --hybrid で使う中継（Cloudflare Worker）の入口

  tabisaki router stats [--target=0.2]  使い分けの記録をまとめ、閾値の目安を出す
  tabisaki router log [--limit=20]      使い分けの記録を新しい順に出す
  tabisaki router threshold [<0〜1>]    いまの閾値を出す（値を書くと変える）

  tabisaki local setup [--model=…] [--pull]  手元の LLM を確かめる（--pull でモデルを取る）
  tabisaki local models                     勧めるモデルと、要るメモリ・ディスク

  tabisaki kb extract --region=<地方|都道府県> [--out=<file>]  地域の知識ベースを切り出す
  tabisaki kb index [--region=…] [--method=tfidf] [--out=…]   似たスポット検索の索引を作る
  tabisaki kb help    自分のユーザーKBを分ける・切り替える・比べる・まとめる・点検する
  tabisaki similar "<スポット名か文>" [--region=…] [--limit=10] [--index=<file>] [--output=json]

  tabisaki trace "<希望>" [同じオプション] [--research] [--search-file=<json>] [--output=text|json]
                      開発者向け: 工程・Research Agent の考えと道具・収録のID・経路の出どころ・
                      裏取りを流して出し、問題の起きた工程の見立てを出す（docs/dev-trace.md）
  tabisaki trace --input=<file.json>  保存した記録（--output=json）か旅程を読み直して見立てる

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
  "model", "llm-url", "region", "out", "method", "limit", "index", "caldav-url", "style",
  "threshold", "cloud-url", "target", "search-file", "input",
  "delay", "late", "dwell", "closed", "on", "runs", "seed", "jitter", "provider", "rain", "state", "max-failures"]);
// 値を取らないもの。
const FLAGS = new Set(["help", "version", "local", "hybrid", "pull", "dry-run", "yes", "remove", "research",
  "weather-check", "apply", "quiet", "strict"]);
// 旅程を組むコマンド。
const COMMANDS = new Set(["plan", "tui", "sync", "voice-plan", "trace"]);
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

/**
 * 旅程に重ねるユーザーKB。--kb を書いていればそれ、無ければ kb switch で決めたものです。
 * --kb=official は「重ねない」です。決めていなければ null（公式の収録だけ）。
 */
async function userKbFor(core, opts, { stderr, env = process.env } = {}) {
  if (opts.kb === "official") return null;
  if (opts.kb) return opts.kb;
  try {
    const store = core.userkb.openStore({ home: core.userkb.userKbHome(env) });
    const name = await store.current();
    if (!name) return null;
    await store.load(name);
    stderr?.write(`tabisaki: ユーザーKB「${name}」を重ねて組みます（kb switch で決めたもの。重ねないときは --kb=official）\n`);
    return name;
  } catch {
    return null; // 決めた先が読めないときは、公式の収録だけで組みます
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
  const userKb = await userKbFor(core, opts, { stderr });
  const c = await core.createCore({ plugins, local, ...(userKb ? { userKb } : {}) });
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
  // kb extract / kb index（収録の切り出し。下の kbCommand）のほかは、ユーザーKB のコマンドです。
  if (argv[0] === "kb" && argv[1] !== "extract" && argv[1] !== "index") {
    const { runKb } = await import("./kbuser.mjs");
    return runKb(argv[1] ?? "help", argv.slice(2), { stdout, stderr, stdin, env });
  }
  try {
    const { opts, words } = parseArgs(argv);
    if (opts.version) { stdout.write(`tabisaki ${VERSION}\n`); return 0; }
    const [cmd, ...rest] = words;
    if (JOURNEY_COMMANDS.includes(cmd)) {
      const core = await import("../../core/index.mjs");
      return await runJourney(cmd, rest, opts, {
        stdout, stderr,
        core: async () => {
          const coreModule = await import("../../core/index.mjs");
          const plugins = process.env.TABISAKI_PLUGINS === "0" ? [] : await coreModule.loadPlugins();
          return coreModule.createCore({ plugins });
        },
        format: { toJson: core.toJson, toPlainText: core.toPlainText, toMarkdown: core.toMarkdown },
      });
    }
    if (opts.help || !cmd || cmd === "help") { stdout.write(HELP); return cmd || opts.help ? 0 : 2; }
    if (cmd === "plugins") return await plugins(rest, { stdout });
    if (cmd === "local") return await localCommand(rest, opts, { stdout, stderr });
    if (cmd === "router") return await routerCommand(rest, opts, { stdout, env });
    if (cmd === "kb" || cmd === "similar") return await kbCommand(cmd, rest, opts, { stdout, stderr });
    if (cmd === "sync") return await sync(opts, rest, { stdout, stderr, stdin, env });
    if (cmd !== "plan" && cmd !== "tui" && cmd !== "voice-plan" && cmd !== "trace") throw usage(`知らないコマンドです: ${cmd}（tabisaki help で一覧）`);
    if (cmd !== "trace" && (opts.research || opts["search-file"] !== undefined || opts.input !== undefined)) {
      throw usage("--research / --search-file / --input は tabisaki trace で使ってください");
    }
    if (cmd === "trace" && opts["search-file"] !== undefined && !opts.research) throw usage("--search-file は --research といっしょに使います");
    if (cmd === "trace" && opts.input !== undefined) return await traceInput(opts, { stdout });
    if (cmd !== "sync" && (opts["caldav-url"] !== undefined || opts["dry-run"] || opts.remove)) {
      throw usage("CalDAV 用の --caldav-url / --dry-run / --yes / --remove は tabisaki sync で使ってください");
    }
    let wish;
    if (cmd === "voice-plan") {
      const recognized = await voicePlan(opts, rest, { stderr, stdin, env });
      if (typeof recognized === "number") return recognized;
      wish = recognized;
    } else {
      wish = rest.join(" ").trim();
    }
    if (!wish) throw usage(`希望の文を書いてください。例: tabisaki ${cmd} "温泉と海をゆっくり楽しみたい"`);
    if (cmd === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw usage("tui は端末の中で動かしてください（パイプやファイルに出すときは tabisaki plan）");
    }
    const output = opts.output ?? (cmd === "trace" ? "text" : "markdown");
    if (cmd === "trace" && !["text", "json"].includes(output)) throw usage("tabisaki trace の --output は text / json のどちらかです");
    if (!["markdown", "md", "text", "json", "ics"].includes(output)) throw usage(`--output は markdown / text / json / ics のどれかです`);
    const core = await import("../../core/index.mjs");
    if (opts.lang !== undefined && !core.pickLang(opts.lang)) throw usage(`--lang は ${core.LANGS.join(" / ")} のどれかです`);
    const lang = core.resolveLang(opts.lang);
    const days = opts.days === undefined ? undefined : Number(opts.days);
    if ((opts.model || opts["llm-url"]) && !opts.local && !opts.hybrid) throw usage("--model と --llm-url は --local か --hybrid といっしょに使います");
    if ((opts.threshold !== undefined || opts["cloud-url"]) && !opts.hybrid) throw usage("--threshold と --cloud-url は --hybrid といっしょに使います");
    if (opts.local && opts.hybrid) throw usage("--local と --hybrid は、どちらか一方だけにしてください");
    let local = null;
    let hybrid = null;
    if (opts.hybrid) {
      const rl = await import("../../core/router-log.mjs");
      const baseUrl = core.resolveBaseUrl(opts["llm-url"]);
      const model = opts.model ?? core.DEFAULT_LOCAL_MODEL;
      const { threshold } = rl.resolveThreshold(opts.threshold, env);
      const cloud = cloudFor(opts, env);
      await core.ensureLocalModel({ baseUrl, model });
      hybrid = { local: { baseUrl, model }, threshold, cloud, onRecord: rl.fileRecorder(env) };
      stderr.write(`手元の LLM（${model}）で組み、確信度が ${threshold} 未満のときだけクラウドに聞き直します…\n`);
    }
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
    let recorder = null;
    try {
      // 控えた（trust した）プラグインだけを読みます。TABISAKI_PLUGINS=0 で読みません。
      const plugins = process.env.TABISAKI_PLUGINS === "0" ? [] : await core.loadPlugins();
      const userKb = await userKbFor(core, opts, { stderr, env });
      const c = await core.createCore({ plugins, ...(userKb ? { userKb } : {}), local, hybrid });
      const rep = c.overlayReport;
      if (rep && (rep.orphans.length || rep.conflicts.length || rep.invalid.length)) {
        stderr.write(`tabisaki: ユーザーKB「${rep.name}」: 見失った差分 ${rep.orphans.length}件・公式と食い違う項目 ${rep.conflicts.length}件・使えない差分 ${rep.invalid.length}件\n`);
      }
      const request = {
        wish, from: opts.from, days, date: opts.date, start: opts.start, back: opts.back,
        transport: opts.transport,
      };
      if (cmd === "trace") {
        // 開発者向けの見える化（Issue #444）。工程は起きた順に stderr へ流します。
        const dt = await import("../../core/devtrace.mjs");
        recorder = dt.createTraceRecorder({ write: (line) => stderr.write(line + "\n") });
        const hooks = { onProgress: recorder.onProgress, onStep: recorder.onStep };
        result = opts.research
          ? await c.research(request, { ...hooks, search: opts["search-file"] ? searchFromFile(opts["search-file"]) : null })
          : await c.plan(request, hooks);
        recorder.finish();
      } else {
        result = await c.plan(request);
      }
    } finally {
      console.log = log; console.warn = warn; console.info = info;
    }
    if (result.ai?.provider === "hybrid") stderr.write(routeSummary(result.ai.routes) + "\n");
    if (result.template) stderr.write(`ひな形「${result.template.name}」を使いました（プラグイン ${result.template.plugin}）\n`);
    if (cmd === "trace") {
      const dt = await import("../../core/devtrace.mjs");
      const report = dt.explain(result, recorder?.events ?? []);
      stdout.write(output === "json" ? JSON.stringify(report, null, 2) + "\n" : dt.formatExplain(report));
      return 0;
    }
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
    for (const line of String(e?.message ?? e).split("\n")) stderr.write(`tabisaki: ${line}\n`);
    if (e?.exitCode) return e.exitCode;
    if (["invalid_input", "unknown_place", "invalid_name", "not_found", "bad_url", "setup", "auth"].includes(e?.code)) return 2;
    return 1;
  }
}

/**
 * --search-file の検索結果（手元で決めた答え）。ネットへは出ずに Research Agent を試すためのもの。
 * [{title, url, snippet}] ならどの語でも同じ答え、{"語": [...], "*": [...]} なら語ごとの答え。
 */
function searchFromFile(file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw usage(`--search-file を読めません: ${file}（${e.message}）`);
  }
  if (!Array.isArray(doc) && (typeof doc !== "object" || doc === null)) throw usage("--search-file は配列か、語ごとの配列を持つ JSON にしてください");
  return async (q) => (Array.isArray(doc) ? doc : doc[q] ?? doc["*"] ?? []);
}

/** tabisaki trace --input=<file>: 保存した記録か旅程を読み直して見立てます。 */
async function traceInput(opts, { stdout }) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(opts.input, "utf8"));
  } catch (e) {
    throw usage(`--input を読めません: ${opts.input}（${e.message}）`);
  }
  const dt = await import("../../core/devtrace.mjs");
  // tabisaki trace --output=json の記録ならそのまま、旅程（{itinerary}）なら見立てから作ります。
  const report = doc?.evidence && doc?.diagnosis ? { stages: [], ...doc }
    : doc?.itinerary ? dt.explain(doc) : null;
  if (!report) throw usage("--input は tabisaki trace --output=json の記録か、{itinerary} を持つ JSON にしてください");
  const output = opts.output ?? "text";
  if (!["text", "json"].includes(output)) throw usage("tabisaki trace の --output は text / json のどちらかです");
  stdout.write(output === "json" ? JSON.stringify(report, null, 2) + "\n" : dt.formatExplain(report));
  return 0;
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

/**
 * --hybrid のクラウドの入口。キー（GEMINI_API_KEY）があれば Google の API へ直接、
 * 無ければ --cloud-url（TABISAKI_PROXY_URL）の中継へ。どちらも無ければ使いかたのまちがいです。
 */
function cloudFor(opts, env) {
  const key = String(env.TABISAKI_GEMINI_KEY || env.GEMINI_API_KEY || "").trim();
  let proxy = String(opts["cloud-url"] || env.TABISAKI_PROXY_URL || "").trim();
  while (proxy.endsWith("/")) proxy = proxy.slice(0, -1);
  if (proxy && !/^https:\/\/[^\s/]+/i.test(proxy)) throw usage("--cloud-url は https:// で始まる URL です");
  if (opts["cloud-url"] || (!key && proxy)) return { proxyUrl: proxy, geminiKey: "" };
  if (key) return { proxyUrl: "", geminiKey: key };
  throw usage("--hybrid には、クラウドの入口が要ります。環境変数 GEMINI_API_KEY（Google AI Studio のキー）か、"
    + "--cloud-url=<中継の URL> を指定してください（docs/model-router.md）");
}

/** 1回の旅程づくりで、どちらに何件回したかを1行にします。 */
function routeSummary(routes = []) {
  const n = (f) => routes.filter(f).length;
  const local = n((r) => r.route === "local");
  const cloud = n((r) => r.route === "cloud");
  const low = n((r) => r.reason === "low_confidence");
  const web = n((r) => r.reason === "web_search");
  const parts = [`手元 ${local}件・クラウド ${cloud}件`];
  if (low) parts.push(`確信度が低くて聞き直した ${low}件`);
  if (web) parts.push(`Web 検索のため ${web}件`);
  return `使い分け: ${parts.join("・")}（記録: tabisaki router log）`;
}

/** tabisaki router stats / log / threshold（Issue #439） */
async function routerCommand([sub = "stats", ...extra], opts, { stdout, env }) {
  const rl = await import("../../core/router-log.mjs");
  const router = await import("../../core/src/router.js");
  if (sub === "threshold") {
    if (extra.length > 1) throw usage(`余計な語があります: ${extra.slice(1).join(" ")}`);
    if (extra.length) {
      const file = await rl.saveThreshold(extra[0], env);
      stdout.write(`閾値を ${Number(extra[0])} にしました（${file}）\n`);
      return 0;
    }
    const { threshold, from } = rl.resolveThreshold(undefined, env);
    const where = { env: "環境変数 TABISAKI_ROUTER_THRESHOLD", file: rl.settingsPath(env), default: "既定" }[from];
    stdout.write(`閾値: ${threshold}（${where}）\n`);
    return 0;
  }
  if (extra.length) throw usage(`余計な語があります: ${extra.join(" ")}`);
  const entries = await rl.readRouteLog(env);
  if (sub === "log") {
    const limit = opts.limit === undefined ? 20 : Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw usage("--limit は 1〜1000 の整数です");
    if (opts.output === "json") { stdout.write(JSON.stringify(entries.slice(-limit).reverse(), null, 2) + "\n"); return 0; }
    if (!entries.length) { stdout.write(`記録はまだありません（${rl.logPath(env)}）\n`); return 0; }
    for (const e of entries.slice(-limit).reverse()) {
      const conf = Number.isFinite(e.confidence) ? ` 確信度 ${e.confidence}${e.method === "heuristic" ? "（目安）" : ""}` : "";
      const model = e.route === "cloud" ? e.cloudModel : e.localModel;
      stdout.write(`${e.at}  ${String(e.task).padEnd(10)} ${e.route === "cloud" ? "クラウド" : "手元    "} ${model ?? ""}  ${e.reason}${conf}  ${e.ms}ms\n`);
    }
    return 0;
  }
  if (sub !== "stats") throw usage("tabisaki router stats / log / threshold のどれかを使ってください");
  const target = opts.target === undefined ? 0.2 : Number(opts.target);
  if (!Number.isFinite(target) || target < 0 || target > 1) throw usage("--target は 0〜1 の数です（クラウドへ回したい割合。例: 0.2）");
  const sum = router.summarizeRoutes(entries);
  const { threshold } = rl.resolveThreshold(undefined, env);
  const suggest = router.suggestThreshold(entries, { target });
  if (opts.output === "json") {
    stdout.write(JSON.stringify({ ...sum, threshold, target, suggestedThreshold: suggest }, null, 2) + "\n");
    return 0;
  }
  const say = (line) => stdout.write(line + "\n");
  say(`記録: ${sum.total}件（${rl.logPath(env)}）`);
  if (!sum.total) return 0;
  say(`  手元 ${sum.byRoute.local ?? 0}件・クラウド ${sum.byRoute.cloud ?? 0}件`);
  say(`  手元で答えた ${sum.localTried}件のうち、クラウドに聞き直した ${sum.handedOver}件（${Math.round(sum.handOverRate * 100)}%）`);
  say(`  理由: ${Object.entries(sum.byReason).map(([k, v]) => `${k} ${v}`).join("・")}`);
  if (sum.confidence) {
    const c = sum.confidence;
    say(`  確信度: 最小 ${c.min}・25% ${c.p25}・中央 ${c.median}・75% ${c.p75}・最大 ${c.max}`);
  }
  say(`いまの閾値: ${threshold}`);
  say(suggest === null
    ? "閾値の目安: 確信度（logprobs）の記録が20件たまると出します"
    : `閾値の目安: ${suggest}（手元の答えの ${Math.round(target * 100)}% をクラウドへ回す値。tabisaki router threshold ${suggest} で変えられます）`);
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
  // `tabisaki spot history | head` のように、読む側が先に閉じても落ちないようにします。
  process.stdout.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(0);
    throw e;
  });
  process.exitCode = await main(process.argv.slice(2));
}
