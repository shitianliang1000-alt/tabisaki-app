// tabisaki spot … / tabisaki area …: スポットに情報を足す・確かめる・エリアを決める。
//
// 足した情報は手元の spots.json（TABISAKI_HOME、無ければ ~/.tabisaki）に入り、
// 公式の kb/ には触りません。形と決まりは packages/core/spotinfo.mjs と docs/spot-data.md。
// 終了コード: 0 = できた、1 = できなかった（通信・ファイル）、2 = 使いかたのまちがい

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const HELP = `使いかた: tabisaki spot <コマンド> … / tabisaki area <コマンド> …

  spot show <スポット>                        収録の値と足した値を、出典・確認の状態と並べて出す
  spot alias add <スポット> <別名> [--source=…] [--url=…]
  spot alias rm <スポット> <別名>
  spot hours set <スポット> <9:00-17:00|24h> --source=<出典> [--url=…]
                 [--closed=月,火] [--last-entry=16:30] [--closed-season=12-29..01-03]
  spot hours rm <スポット>
  spot seasonal add <スポット> <催しの名前> --from=MM-DD --to=MM-DD --source=<出典> [--url=…] [--note=…]
  spot photo add <スポット> (--url=<https…> | --file=<手元の写真>) --license=<ライセンス> --author=<撮った人> [--page=…]
  spot enrich <スポット> [--dry-run]          Wikidata・Commons から別名と写真を補う（未確認で入る）
  spot verify <スポット> [aliases|hours|seasonal|photos|all]   人が確かめた印を付ける
  spot generate <エリアの名前> [--count=5]    AI に候補を出させる（未確認。旅程には使わない）
  spot candidates                             AI の候補の一覧
  spot check                                  spots.json の形と、収録との食いちがいを確かめる

  area define <id> --name=<名前> (--center=<緯度,経度> --radius=<km> | --spots=<スポット,…>)
  area ls [--custom-only]                     エリアの一覧（--custom-only で手で決めたものだけ）
  area rm <id>

  <スポット> は名前・別名・id のどれでも。同じ名前がいくつもあるときは id で選びます。
  共通: --output=json（show・ls・candidates・check）

置き場: TABISAKI_HOME（無ければ ~/.tabisaki）の spots.json と photos/
AI: TABISAKI_LLM_URL（例 http://127.0.0.1:11434）と TABISAKI_LLM_MODEL、要れば TABISAKI_LLM_KEY
`;

const FLAG_RE = /^--([a-z-]+)(?:=(.*))?$/;
const BOOL = new Set(["dry-run", "custom-only", "help"]);

function usage(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

export function parse(argv) {
  const opts = {};
  const words = [];
  for (const a of argv) {
    const m = FLAG_RE.exec(a);
    if (!m) { words.push(a); continue; }
    const [, key, value] = m;
    if (BOOL.has(key)) { opts[key] = true; continue; }
    if (value === undefined || value === "") throw usage(`--${key}=<値> の形で書いてください`);
    opts[key] = value;
  }
  return { opts, words };
}

const ALLOWED = {
  "spot show": ["output"],
  "spot alias add": ["source", "url"],
  "spot alias rm": [],
  "spot hours set": ["source", "url", "closed", "last-entry", "closed-season"],
  "spot hours rm": [],
  "spot seasonal add": ["source", "url", "from", "to", "note"],
  "spot photo add": ["url", "file", "license", "author", "page"],
  "spot enrich": ["dry-run"],
  "spot verify": [],
  "spot generate": ["count", "llm-url", "model"],
  "spot candidates": ["output"],
  "spot check": ["output"],
  "area define": ["name", "center", "radius", "spots"],
  "area ls": ["custom-only", "output"],
  "area rm": [],
};

function need(opts, key, hint) {
  if (!opts[key]) throw usage(`--${key}=… が要ります${hint ? `（${hint}）` : ""}`);
  return opts[key];
}

function httpsUrl(u, key) {
  if (u !== undefined && !/^https?:\/\/\S+$/.test(u)) throw usage(`--${key} は http(s) の URL です: ${u}`);
  return u;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const realFetch = fetchImpl;
  try {
    const { opts, words } = parse(argv);
    const [group, sub, sub2, ...rest] = words;
    if (opts.help || !sub || sub === "help") { stdout.write(HELP); return sub || opts.help ? 0 : 2; }
    const three = `${group} ${sub} ${sub2}`;
    const key = ALLOWED[three] ? three : `${group} ${sub}`;
    if (!ALLOWED[key]) throw usage(`知らないコマンドです: ${group} ${sub}（tabisaki spot help で一覧）`);
    for (const k of Object.keys(opts)) {
      if (!ALLOWED[key].includes(k)) throw usage(`${key} では --${k} は使えません（tabisaki spot help）`);
    }
    const args = key === three ? rest : [sub2, ...rest].filter((x) => x !== undefined);

    const info = await import("../../core/spotinfo.mjs");
    const ud = await import("../../core/userdata.mjs");
    const file = ud.storePath(env);
    const store = await ud.loadStore(file);
    const today = env.TABISAKI_TODAY && /^\d{4}-\d{2}-\d{2}$/.test(env.TABISAKI_TODAY) ? env.TABISAKI_TODAY : info.todayJst();

    // 収録を読みます（数百ミリ秒）。本体のログは stderr にも出しません。
    const core = await import("../../core/index.mjs");
    const log = console.log; const warn = console.warn; const cinfo = console.info;
    console.log = console.warn = console.info = () => {};
    let kb;
    try { kb = (await core.createCore({ userData: false })).kb; } finally { console.log = log; console.warn = warn; console.info = cinfo; }
    // createCore は通信を切ります。enrich・generate は外へ出るので、元の fetch を使います。
    const spotIds = new Set(kb.spots.map((s) => s.id));
    const save = () => ud.saveStore(store, file, { spotIds });
    const out = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
    const json = opts.output === "json";
    if (opts.output && opts.output !== "json" && opts.output !== "text") throw usage("--output は text か json です");

    const pick = (q) => {
      if (!q) throw usage("スポットの名前か id を書いてください");
      const hits = info.findSpots(kb, q, store);
      if (!hits.length) throw usage(`「${q}」は収録にありません（名前・別名・id で探します）`);
      if (hits.length > 1) {
        throw usage(`「${q}」はいくつもあります。id で選んでください:\n${hits.slice(0, 12).map((s) => `  ${s.id}  ${s.name}（${s.region ?? s.regionId}・${s.category}）`).join("\n")}`);
      }
      return hits[0];
    };
    const entryOf = (id) => (store.spots[id] ??= {});
    const manualSource = (name) => ({ name: opts.source ?? name, url: httpsUrl(opts.url, "url") });
    const clean = (o) => JSON.parse(JSON.stringify(o));

    if (group === "spot") {
      if (sub === "show") {
        const s = pick(args[0]);
        const e = store.spots[s.id] ?? {};
        const { fetchedAtOf } = await import("../../core/src/kb.js");
        const at = fetchedAtOf(s);
        const kbDay = at ? info.todayJst(new Date(at)) : null;
        const fields = [];
        for (const kind of ["aliases", "hours", "seasonal", "photos"]) {
          const list = kind === "hours" ? (e.hours ? [e.hours] : []) : (e[kind] ?? []);
          for (const f of list) fields.push({ kind, field: f, freshness: info.freshness(f, kind, today) });
        }
        if (json) {
          out(JSON.stringify({ version: 1, spot: s, kb: { source: s.src ?? s.dataSource ?? null, license: s.license ?? null, fetchedOn: kbDay }, extras: fields }, null, 2));
          return 0;
        }
        const lines = [`${s.name}（${s.id}・${s.region ?? s.regionId}・${s.category}）`];
        lines.push(`  収録: 出どころ ${s.src ?? s.dataSource ?? "手入力"}${s.license ? `（${s.license}）` : ""}・取り込み ${kbDay ?? "不明"}`);
        const kbHours = Number.isFinite(s.open) ? `${info.clockText(s.open)}〜${info.clockText(s.close)}` : "なし（分類ごとの目安で組みます）";
        lines.push(`  収録の営業時間: ${kbHours}`);
        if (!fields.length) lines.push("  足した情報: まだありません（spot enrich・spot hours set などで足せます）");
        const label = { aliases: "別名", hours: "営業時間", seasonal: "季節", photos: "写真" };
        for (const { kind, field: f, freshness: fr } of fields) {
          const v = kind === "hours" ? info.describeHoursValue(f.value)
            : kind === "seasonal" ? `${f.value.name} ${f.value.from}〜${f.value.to}${f.value.note ? `（${f.value.note}）` : ""}`
              : kind === "photos" ? `${f.value.url ?? f.value.file} © ${f.value.author}（${f.source.license}）` : f.value;
          lines.push(`  ${label[kind]}: ${v}`);
          lines.push(`    ${fr.verified ? "✓" : "?"} ${fr.label}${fr.verified ? `・出典 ${f.source.name}` : ""}${f.source.url ? `・${f.source.url}` : ""}`);
        }
        if (fields.some((x) => !x.freshness.verified)) lines.push("  ? の値は未確認です。旅程の計算には使いません（spot verify で確かめた印を付けます）");
        out(lines.join("\n"));
        return 0;
      }

      if (sub === "alias") {
        const s = pick(args[0]);
        const name = String(args[1] ?? "").trim();
        if (!name) throw usage("別名を書いてください");
        const e = entryOf(s.id);
        e.aliases ??= [];
        if (sub2 === "add") {
          if (e.aliases.some((f) => f.value === name)) throw usage(`「${name}」はもう入っています`);
          e.aliases.push(info.makeField(name, { origin: "manual", source: manualSource("手入力"), today }));
        } else {
          const before = e.aliases.length;
          e.aliases = e.aliases.filter((f) => f.value !== name);
          if (e.aliases.length === before) throw usage(`「${name}」は入っていません`);
        }
        store.spots[s.id] = clean(e);
        await save();
        out(`${sub2 === "add" ? "足しました" : "消しました"}: ${s.name} の別名「${name}」`);
        return 0;
      }

      if (sub === "hours") {
        const s = pick(args[0]);
        const e = entryOf(s.id);
        if (sub2 === "rm") {
          if (!e.hours) throw usage(`${s.name} に足した営業時間はありません`);
          delete e.hours;
          await save();
          out(`消しました: ${s.name} の営業時間（収録の値に戻ります）`);
          return 0;
        }
        need(opts, "source", "どこで確かめたか。例: 公式サイト");
        let value;
        try {
          value = info.parseHours(args[1] ?? "", { closed: opts.closed, lastEntry: opts["last-entry"], closedSeason: opts["closed-season"] });
        } catch (err) { throw usage(err.message); }
        e.hours = info.makeField(value, { origin: "manual", source: manualSource(), today });
        store.spots[s.id] = clean(e);
        await save();
        out(`入れました: ${s.name} ${info.describeHoursValue(value)}（出典 ${opts.source}）`);
        return 0;
      }

      if (sub === "seasonal") {
        const s = pick(args[0]);
        const name = String(args[1] ?? "").trim();
        if (!name) throw usage("催しの名前を書いてください（例: 紅葉ライトアップ）");
        need(opts, "source", "どこで確かめたか");
        const from = need(opts, "from", "MM-DD");
        const to = need(opts, "to", "MM-DD");
        try { info.parseMmddRange(`${from}..${to}`); } catch (err) { throw usage(err.message); }
        const e = entryOf(s.id);
        e.seasonal ??= [];
        e.seasonal.push(info.makeField(clean({ name, from, to, note: opts.note }), { origin: "manual", source: manualSource(), today }));
        store.spots[s.id] = clean(e);
        await save();
        out(`入れました: ${s.name} の「${name}」${from}〜${to}`);
        return 0;
      }

      if (sub === "photo") {
        const s = pick(args[0]);
        const license = need(opts, "license", "例: CC BY 4.0・自分で撮影（無断転載不可）");
        const author = need(opts, "author", "撮った人");
        if (Boolean(opts.url) === Boolean(opts.file)) throw usage("--url か --file のどちらか一方を書いてください");
        const value = { author };
        if (opts.url) value.url = httpsUrl(opts.url, "url");
        if (opts.file) {
          const dir = ud.photoDir(env);
          await mkdir(dir, { recursive: true });
          const base = `${s.id}-${Date.now()}${path.extname(opts.file).toLowerCase()}`;
          await copyFile(opts.file, path.join(dir, base));
          value.file = base;
        }
        const e = entryOf(s.id);
        e.photos ??= [];
        e.photos.push(info.makeField(value, { origin: "manual", source: { name: opts.page ? "写真の元のページ" : "手入力", url: httpsUrl(opts.page, "page"), license }, today }));
        store.spots[s.id] = clean(e);
        await save();
        out(`入れました: ${s.name} の写真（${license}・${author}）${value.file ? ` → ${path.join(ud.photoDir(env), value.file)}` : ""}`);
        return 0;
      }

      if (sub === "enrich") {
        const s = pick(args[0]);
        const { enrichSpot } = await import("../../core/enrich.mjs");
        const r = await enrichSpot(s, { fetchImpl: realFetch, today });
        const e = entryOf(s.id);
        const have = new Set([...(e.aliases ?? []).map((f) => f.value)]);
        const newAliases = r.aliases.filter((f) => !have.has(f.value));
        const havePhoto = new Set((e.photos ?? []).map((f) => f.value.url));
        const newPhotos = r.photos.filter((f) => !havePhoto.has(f.value.url));
        const lines = [`${s.name}: 別名 ${newAliases.length}件・写真 ${newPhotos.length}件（どれも未確認）`];
        for (const f of newAliases) lines.push(`  別名 ${f.value}（${f.source.name}・${f.source.license}）`);
        for (const f of newPhotos) lines.push(`  写真 ${f.value.url} © ${f.value.author}（${f.source.license}）`);
        for (const n of r.notes) lines.push(`  ・${n}`);
        if (!opts["dry-run"] && (newAliases.length || newPhotos.length)) {
          if (newAliases.length) e.aliases = [...(e.aliases ?? []), ...newAliases];
          if (newPhotos.length) e.photos = [...(e.photos ?? []), ...newPhotos];
          store.spots[s.id] = clean(e);
          await save();
          lines.push(`入れました。確かめたら: tabisaki spot verify ${s.id}`);
        } else if (opts["dry-run"]) lines.push("（--dry-run なので入れていません）");
        if (!e.aliases?.length && !e.photos?.length && !e.hours && !e.seasonal?.length) delete store.spots[s.id];
        out(lines.join("\n"));
        return 0;
      }

      if (sub === "verify") {
        const s = pick(args[0]);
        const what = args[1] ?? "all";
        const kinds = what === "all" ? ["aliases", "hours", "seasonal", "photos"] : [what];
        if (!kinds.every((k) => ["aliases", "hours", "seasonal", "photos"].includes(k))) throw usage("aliases / hours / seasonal / photos / all のどれかです");
        const e = store.spots[s.id];
        if (!e) throw usage(`${s.name} に足した情報はありません`);
        let n = 0;
        for (const k of kinds) {
          if (k === "hours") { if (e.hours && e.hours.status !== "verified") { e.hours = info.verifyField(e.hours, today); n += 1; } continue; }
          e[k] = (e[k] ?? []).map((f) => (f.status === "verified" ? f : (n += 1, info.verifyField(f, today))));
        }
        await save();
        out(`確かめた印を付けました: ${s.name} の ${n}件（${today}）`);
        return 0;
      }

      if (sub === "generate") {
        const area = args.join(" ").trim();
        if (!area) throw usage("エリアの名前を書いてください（例: 軽井沢）");
        const count = opts.count === undefined ? 5 : Number(opts.count);
        if (!Number.isInteger(count) || count < 1 || count > 20) throw usage("--count は 1〜20 です");
        const url = opts["llm-url"] ?? env.TABISAKI_LLM_URL;
        const model = opts.model ?? env.TABISAKI_LLM_MODEL;
        if (!url || !model) throw usage("AI の場所が要ります: TABISAKI_LLM_URL と TABISAKI_LLM_MODEL（または --llm-url・--model）");
        httpsUrl(url, "llm-url");
        const { generateCandidates } = await import("../../core/enrich.mjs");
        const list = await generateCandidates({ area, count, url, model, apiKey: env.TABISAKI_LLM_KEY, fetchImpl: realFetch, today });
        const lines = [`${area} の候補 ${list.length}件（AI の出力。未確認で、旅程には使いません）`];
        for (const f of list) {
          const hit = info.findSpots(kb, f.value.name, store);
          if (hit.length) f.value.inKb = hit.map((x) => x.id);
          lines.push(`  ${f.value.name}${f.value.category ? `（${f.value.category}）` : ""}${hit.length ? ` … 収録にあり: ${hit[0].id}` : " … 収録になし"}`);
        }
        store.candidates = [...(store.candidates ?? []), ...list];
        await save();
        out(lines.join("\n"));
        return 0;
      }

      if (sub === "candidates") {
        const list = store.candidates ?? [];
        if (json) { out(JSON.stringify({ version: 1, candidates: list }, null, 2)); return 0; }
        if (!list.length) { out("候補はまだありません（spot generate で出せます）"); return 0; }
        out(list.map((f) => `${f.value.area}: ${f.value.name}${f.value.inKb ? `（収録: ${f.value.inKb[0]}）` : "（収録になし）"}  ? ${info.freshness(f, "candidates", today).label}`).join("\n"));
        return 0;
      }

      if (sub === "check") {
        const errors = info.validateStore(store, { spotIds });
        const stale = [];
        for (const [id, e] of Object.entries(store.spots)) {
          for (const kind of ["aliases", "hours", "seasonal", "photos"]) {
            const list = kind === "hours" ? (e.hours ? [e.hours] : []) : (e[kind] ?? []);
            for (const f of list) {
              const fr = info.freshness(f, kind, today);
              if (fr.verified && fr.stale) stale.push(`${id} の ${kind}: ${fr.label}`);
            }
          }
        }
        const unverified = Object.values(store.spots).flatMap((e) => [e.hours, ...(e.aliases ?? []), ...(e.seasonal ?? []), ...(e.photos ?? [])]).filter((f) => f && f.status !== "verified").length;
        if (json) out(JSON.stringify({ version: 1, file, errors, stale, unverified }, null, 2));
        else {
          out([`${file}`, errors.length ? `直すところ ${errors.length}件:` : "形は正しいです", ...errors.map((x) => `  ✗ ${x}`),
            stale.length ? `古いかもしれない値 ${stale.length}件:` : "", ...stale.map((x) => `  ! ${x}`),
            `未確認の値: ${unverified}件`].filter(Boolean).join("\n"));
        }
        return errors.length ? 1 : 0;
      }
    }

    if (group === "area") {
      if (sub === "define") {
        const id = String(args[0] ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw usage("id は英小文字・数字・ハイフンで書きます（例: my-onsen）");
        if (kb.regionsById?.has?.(id)) throw usage(`id「${id}」は収録のエリアと同じです。別の id にしてください`);
        const name = need(opts, "name");
        const area = { name };
        if (opts.spots) {
          if (opts.center || opts.radius) throw usage("--spots と --center・--radius は一緒に使えません");
          area.spots = opts.spots.split(/[,、]/).map((q) => pick(q.trim()).id);
        } else {
          const c = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(need(opts, "center", "緯度,経度"));
          if (!c) throw usage("--center は 緯度,経度 です（例: 36.35,138.63）");
          area.center = { lat: Number(c[1]), lng: Number(c[2]) };
          area.radiusKm = Number(need(opts, "radius", "km"));
        }
        area.createdAt = today;
        store.areas[id] = area;
        await save();
        const n = info.spotsInArea(kb, area).length;
        out(`決めました: ${id}「${name}」（収録のスポット ${n}か所が入ります）`);
        return 0;
      }
      if (sub === "rm") {
        const id = args[0];
        if (!store.areas[id]) throw usage(`手で決めたエリア「${id}」はありません`);
        delete store.areas[id];
        await save();
        out(`消しました: ${id}`);
        return 0;
      }
      if (sub === "ls") {
        const custom = Object.entries(store.areas).map(([id, a]) => ({ id, name: a.name, custom: true, spots: info.spotsInArea(kb, a).length }));
        const builtin = opts["custom-only"] ? [] : kb.regions.map((r) => ({ id: r.id, name: r.name, custom: false, spots: kb.spotsByRegion?.get?.(r.id)?.length ?? 0 }));
        const rows = [...custom, ...builtin];
        if (json) { out(JSON.stringify({ version: 1, areas: rows }, null, 2)); return 0; }
        if (!rows.length) { out("手で決めたエリアはまだありません（area define で決めます）"); return 0; }
        out(rows.map((r) => `${r.custom ? "*" : " "} ${r.id.padEnd(16)} ${r.name}（${r.spots}か所）`).join("\n"));
        return 0;
      }
    }
    throw usage(`知らないコマンドです: ${words.join(" ")}`);
  } catch (e) {
    stderr.write(`tabisaki: ${e?.message ?? e}\n`);
    return e?.exitCode ?? 1;
  }
}
