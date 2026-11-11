// tabisaki build / test / diff / narrate（旅程ファイルを使うコマンド）。
// packages/cli/bin/tabisaki-plan.mjs から呼びます。
//
// 終了コード:
//   build・narrate  0 = できた、1 = 組めなかった、2 = ファイルのまちがい
//   test            0 = 条件をすべて守っている、1 = 守れていない条件がある、2 = ファイルのまちがい
//   diff            0 = 違いなし、1 = 違いあり、2 = ファイルのまちがい（diff コマンドと同じ）

import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { loadJourney, buildJourney, checkJourney, diffJourneys, narrate, JourneyError, STYLES, FORMATS } from "./index.mjs";
import { simulateOnce, simulateMany, slack, checkMoves, parseRatio, describeConditions, simulationText, simulationJson, SIM_DEFAULTS, SIM_LIMITS } from "./simulate.mjs";
import { useWeather, weatherReplan, replannedYaml, outPathFor, loadState, saveState, decide, replanText, replanJson, WEATHER_PROVIDERS } from "./replan.mjs";

export const JOURNEY_COMMANDS = ["build", "test", "diff", "narrate", "simulate", "replan"];

export const JOURNEY_HELP = `旅程ファイル（YAML）を使うコマンド（書きかたは docs/journey-as-code.md）:

  tabisaki build <trip.yaml> [--output=markdown|text|json]   組む（output.file があればそこへ書く）
  tabisaki test <trip.yaml>                                  組んで、constraints を守っているか確かめる
  tabisaki diff <a.yaml|a.json> <b.yaml|b.json>              2つの旅程の違いを出す
  tabisaki narrate <trip.yaml> [--style=${STYLES.join("|")}]       旅の文にする
  tabisaki simulate <trip.yaml> [--delay=20%] [--late=15]    時計を進めてたどる（遅れ・寝坊・休みを試す）
      [--dwell=1.2] [--closed=<スポット>,…] [--on=<日付>] [--runs=200 --seed=1 --jitter=15%] [--output=text|json]
  tabisaki replan [trip.yaml] --weather-check                予報を見て、雨なら屋内に入れ替えた案を出す
      [--provider=${WEATHER_PROVIDERS.join("|")}] [--apply [--out=<ファイル>]] [--quiet] [--state=<ファイル>] [--strict] [--output=text|json]

  見本: examples/trips/hakone.yaml
`;

function usage(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

async function exists(f) {
  try { await access(f); return true; } catch { return false; }
}

/** 「plan-a」のように拡張子を省いても、plan-a.yaml を探します。 */
async function resolveFile(f) {
  if (await exists(f)) return f;
  for (const ext of [".yaml", ".yml", ".json"]) if (await exists(f + ext)) return f + ext;
  return f;
}

/**
 * @param {string} cmd build / test / diff / narrate
 * @param {string[]} files
 * @param {Record<string,string>} opts
 * @param {{stdout, stderr, core: () => Promise<object>, format: object}} io
 */
export async function runJourney(cmd, files, opts, { stdout, stderr, core, format }) {
  files = [...files];
  const allowedOptions = {
    build: new Set(["output", "lang"]),
    test: new Set(),
    diff: new Set(),
    narrate: new Set(["style"]),
    simulate: new Set(["delay", "late", "dwell", "closed", "on", "runs", "seed", "jitter", "output"]),
    replan: new Set(["weather-check", "provider", "rain", "apply", "out", "quiet", "state", "strict", "max-failures", "output"]),
  }[cmd];
  for (const key of Object.keys(opts)) {
    if (["help", "version"].includes(key)) continue;
    if (!allowedOptions?.has(key)) throw usage(`tabisaki ${cmd} では --${key} は使えません`);
  }
  // replan は、ファイルを書かなければ ./trip.yaml を見ます（cron に1行で書けるように）。
  if (cmd === "replan" && !files.length) files = ["trip.yaml"];
  const want = cmd === "diff" ? 2 : 1;
  if (files.length !== want) {
    throw usage(cmd === "diff" ? "比べる2つのファイルを書いてください。例: tabisaki diff plan-a.yaml plan-b.yaml"
      : `旅程ファイルを1つ書いてください。例: tabisaki ${cmd} examples/trips/hakone.yaml`);
  }
  const resolved = await Promise.all(files.map(resolveFile));

  if (cmd === "diff") {
    const snaps = [];
    let c = null;
    for (const f of resolved) {
      if (/\.json$/i.test(f)) {
        let j;
        try { j = JSON.parse(await readFile(f, "utf8")); } catch (e) {
          throw new JourneyError(f, [{ path: "", message: e.code === "ENOENT" ? "ファイルがありません" : "JSON として読めません（tabisaki build --output=json で出したものを使ってください）" }]);
        }
        if (j?.version !== 1 || !Array.isArray(j.days)) throw new JourneyError(f, [{ path: "", message: "旅程の JSON（version: 1）ではありません" }]);
        snaps.push(j);
      } else {
        const journey = await loadJourney(f);
        c ??= await core();
        const built = await buildJourney(c, journey);
        snaps.push(JSON.parse(format.toJson(built.result)));
      }
    }
    const { same, lines } = diffJourneys(snaps[0], snaps[1], { labelA: files[0], labelB: files[1] });
    stdout.write(lines.join("\n") + "\n");
    return same ? 0 : 1;
  }

  const [file] = resolved;
  if (cmd === "simulate") return runSimulate(file, files[0], opts, { stdout, stderr, core });
  if (cmd === "replan") return runReplan(file, files[0], opts, { stdout, stderr, core, format });
  const journey = await loadJourney(file);
  if (cmd === "narrate" && opts.style && !STYLES.includes(opts.style)) throw usage(`--style は ${STYLES.join(" / ")} のどれかです`);
  const fmtName = opts.output ?? journey.def.output.format;
  const fmt = fmtName === "md" ? "markdown" : fmtName;
  if (cmd === "build" && !FORMATS.includes(fmt)) throw usage(`--output は ${FORMATS.join(" / ")} のどれかです`);

  const built = await buildJourney(await core(), journey);
  for (const n of built.notes) stderr.write(`tabisaki: ${n}\n`);

  if (cmd === "build") {
    const text = fmt === "json" ? format.toJson(built.result) : fmt === "text" ? format.toPlainText(built.result, { lang: opts.lang }) : format.toMarkdown(built.result, { lang: opts.lang });
    // --output を付けたときは端末へ（ファイルに書く設定より、その場の指定を優先します）
    if (journey.def.output.file && !opts.output) {
      const out = path.resolve(journey.dir, journey.def.output.file);
      await writeFile(out, text);
      stderr.write(`tabisaki: 書き出しました: ${path.relative(process.cwd(), out) || out}\n`);
    } else stdout.write(text);
    return 0;
  }

  if (cmd === "narrate") {
    stdout.write(narrate(built, opts.style ?? journey.def.output.narrate));
    return 0;
  }

  // test
  const checks = checkJourney(built);
  const failed = checks.filter((c) => !c.ok);
  stdout.write(`${files[0]}: ${journey.def.title}\n`);
  for (const c of checks) stdout.write(`  ${c.ok ? (c.skipped ? "-" : "✓") : "✗"} ${c.name}: ${c.detail}\n`);
  const checked = checks.filter((c) => !c.skipped).length;
  stdout.write(failed.length ? `\n${failed.length}件の条件を守れていません（${checked}件を確かめました）\n` : `\n${checked}件の条件をすべて守っています\n`);
  return failed.length ? 1 : 0;
}

function numberOpt(opts, name, [min, max], fallback, { int = false, ratio = false } = {}) {
  if (opts[name] === undefined) return fallback;
  const v = ratio ? parseRatio(opts[name], name) : Number(opts[name]);
  if (!Number.isFinite(v) || (int && !Number.isInteger(v)) || v < min || v > max) {
    const show = (x) => (ratio ? `${Math.round(x * 100)}%` : x);
    throw usage(`--${name} は ${show(min)}〜${show(max)} の${int ? "整数" : "数"}で書いてください`);
  }
  return v;
}

const textOrJson = (opts) => {
  const f = opts.output ?? "text";
  if (f !== "text" && f !== "json") throw usage("--output は text / json のどれかです");
  return f;
};

/** tabisaki simulate。終了コード: 0 = 成り立つ、1 = 成り立たない、2 = ファイル・書きかたのまちがい */
async function runSimulate(file, shown, opts, { stdout, stderr, core }) {
  const fmt = textOrJson(opts);
  const o = {
    delay: numberOpt(opts, "delay", SIM_LIMITS.delay, SIM_DEFAULTS.delay, { ratio: true }),
    late: numberOpt(opts, "late", SIM_LIMITS.late, SIM_DEFAULTS.late, { int: true }),
    dwell: numberOpt(opts, "dwell", SIM_LIMITS.dwell, SIM_DEFAULTS.dwell),
    jitter: numberOpt(opts, "jitter", SIM_LIMITS.jitter, SIM_DEFAULTS.jitter, { ratio: true }),
    closed: new Set(),
    shiftDays: 0,
  };
  const runs = numberOpt(opts, "runs", SIM_LIMITS.runs, SIM_DEFAULTS.runs, { int: true });
  const seed = numberOpt(opts, "seed", [0, 4294967295], SIM_DEFAULTS.seed, { int: true });
  if ((opts.seed !== undefined || opts.jitter !== undefined) && !runs) throw usage("--seed と --jitter は --runs=<回数> と一緒に使います");
  if (opts.on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.on)) throw usage("--on は YYYY-MM-DD で書いてください");

  const journey = await loadJourney(file);
  const c = await core();
  const built = await buildJourney(c, journey);
  for (const n of built.notes) stderr.write(`tabisaki: ${n}\n`);
  const { itinerary, request } = built.result;

  if (opts.closed !== undefined) {
    const inTrip = new Map();
    for (const d of itinerary.days ?? []) for (const it of d.items ?? []) if (it.kind === "spot") inTrip.set(it.title, it);
    for (const name of String(opts.closed).split(",").map((s) => s.trim()).filter(Boolean)) {
      const hit = inTrip.get(name) ?? [...inTrip.values()].find((it) => String(it.spotId ?? it.place?.id) === name || it.title.includes(name));
      if (!hit) throw usage(`--closed の「${name}」は、この旅程に入っていません（入っているのは: ${[...inTrip.keys()].join("・")}）`);
      o.closed.add(hit.title);
    }
  }
  if (opts.on !== undefined) {
    const first = new Date(itinerary.days?.[0]?.items?.[0]?.start ?? request.departAt);
    const day0 = Math.floor((first.getTime() + 9 * 3600000) / 86400000);
    o.shiftDays = Math.floor(Date.parse(`${opts.on}T00:00:00Z`) / 86400000) - day0;
  }

  const run = simulateOnce(itinerary, request, o);
  const checks = checkMoves(itinerary, { maxLegMinutes: built.def.constraints.max_leg_minutes });
  const sl = slack(itinerary, request, o);
  const many = runs ? simulateMany(itinerary, request, { ...o, runs, seed }) : null;
  const view = { title: built.def.title, file: shown, conditions: describeConditions(o), options: o, run, checks, slack: sl, many };
  stdout.write(fmt === "json" ? simulationJson(view) : simulationText(view));
  return run.ok && checks.every((x) => x.ok) ? 0 : 1;
}

/**
 * tabisaki replan --weather-check。
 * 終了コード: 0 = 知らせることなし、1 = 見直しの案・雨の心配あり、2 = ファイル・書きかたのまちがい、
 *             3 = 天気が取れない（--strict のとき、または --state で続けて取れなかったとき）
 */
async function runReplan(file, shown, opts, { stdout, stderr, core, format }) {
  if (!opts["weather-check"]) {
    throw usage("tabisaki replan は --weather-check を付けて使います（付けたときだけ、予報を取りに api.open-meteo.com へ通信します）");
  }
  const fmt = textOrJson(opts);
  const provider = opts.provider ?? "open-meteo";
  if (!WEATHER_PROVIDERS.includes(provider)) throw usage(`--provider は ${WEATHER_PROVIDERS.join(" / ")} のどれかです`);
  if (opts.rain !== undefined && provider !== "mock") throw usage("--rain は --provider=mock と一緒に使います（試すための降水確率）");
  const rain = numberOpt(opts, "rain", [0, 100], 80);
  const maxFailures = numberOpt(opts, "max-failures", [1, 100], 3, { int: true });
  if (opts.out !== undefined && !opts.apply) throw usage("--out は --apply と一緒に使います");
  const dest = opts.apply ? outPathFor(file, opts.out ?? null) : null;

  const journey = await loadJourney(file);
  const c = await core();
  await useWeather({ provider, rain });
  const result = await weatherReplan(c, journey, { format, provider });
  for (const n of result.before.notes) stderr.write(`tabisaki: ${n}\n`);

  const prev = opts.state ? await loadState(opts.state) : { fingerprint: "", failures: 0 };
  const d = decide(result, prev, { strict: !!opts.strict, maxFailures, useState: !!opts.state });
  if (opts.state) await saveState(opts.state, d.state);

  let headline = d.headline;
  if (dest && result.status === "proposal") {
    const y = replannedYaml(journey, result.swaps, c.kb, result.alsoAvoided);
    await writeFile(dest, y.text);
    for (const n of y.notes) stderr.write(`tabisaki: ${n}\n`);
    headline += `\n書き出しました: ${path.relative(process.cwd(), dest) || dest}（元のファイルはそのままです）`;
  } else if (result.status === "proposal" && d.notify) {
    headline += `\n入れ替えた旅程ファイルを作るには: tabisaki replan ${shown} --weather-check --apply`;
  }
  const view = { file: shown, title: journey.def.title, result, headline, code: d.code };
  if (fmt === "json") stdout.write(replanJson(view));
  else if (d.notify || !opts.quiet) stdout.write(opts.quiet && d.code === 0 && !d.notify ? "" : replanText(view));
  return d.code;
}
