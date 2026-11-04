// 開発者向けの見える化（Issue #444。docs/dev-trace.md）。
//
// 旅程ができるまでの工程を、開発者が追えるようにします。
//
//   - Research Agent（research.js）の「考え → 道具 → 結果」を、起きた順に流して出す
//   - 組み立ての6つの段（pipeline.js の onProgress）を、かかった時間つきで出す
//   - 旅程の行ごとに、収録（kb）のスポットID・経路の出どころ（経路の取り口・目安）・
//     裏取り（grounding.js）の結果を並べる
//   - 問題のある答えから、どの工程で起きたかの見立てを出す
//
// 通常の利用者の画面（Web 版・アプリ）には出しません。CLI（tabisaki trace）と、
// Node.js から core を使う人だけのものです。Web 版の js/ からは読みません。

/** 工程（並びは処理の順）。step は pipeline.js の onProgress の番号。 */
export const STAGES = Object.freeze([
  { key: "research", step: null, label: "調べもの（Research Agent）" },
  { key: "understand", step: 0, label: "希望の読み取り" },
  { key: "candidates", step: 1, label: "候補地さがし" },
  { key: "propose", step: 2, label: "旅程の案づくり" },
  { key: "check", step: 3, label: "営業時間・移動の照合" },
  { key: "adjust", step: 4, label: "照合をもとにした作り直し" },
  { key: "route", step: 5, label: "経路と時刻" },
  { key: "grounding", step: null, label: "裏取り（ハルシネーション検証）" },
]);

const STAGE_BY_STEP = new Map(STAGES.filter((s) => s.step !== null).map((s) => [s.step, s]));
const STAGE_BY_KEY = new Map(STAGES.map((s) => [s.key, s]));
const ORDER = new Map(STAGES.map((s, i) => [s.key, i]));
const LEVELS = { error: 0, warn: 1, info: 2 };

/**
 * 記録係。core.plan の onProgress と、core.research の onStep に渡します。
 * write を渡すと、1件ごとに1行ずつ書きます（流して出す）。
 *
 * @param {{now?: () => number, write?: (line: string) => void}} [opts]
 */
export function createTraceRecorder({ now = Date.now, write = null } = {}) {
  const t0 = now();
  const events = [];
  const push = (e) => {
    const ev = { ms: now() - t0, ...e };
    events.push(ev);
    if (write) write(formatEvent(ev));
    return ev;
  };
  return {
    events,
    onStep(step) {
      push({ kind: "research", state: step?.state ?? null, thought: step?.thought ?? "",
        tool: step?.action?.tool ?? null, args: step?.action?.args ?? null,
        observation: step?.observation ?? null, toolMs: step?.ms ?? null });
    },
    onProgress(step, note = "", extra = {}) {
      const ev = { kind: "stage", step, stage: STAGE_BY_STEP.get(step)?.key ?? `step${step}`, note: note || "" };
      // 候補の一覧（数百件）は持たず、数だけ残します。
      if (Array.isArray(extra?.picks)) ev.picks = extra.picks.length;
      if (Array.isArray(extra?.route)) ev.route = extra.route.map((s) => s?.name).filter(Boolean);
      push(ev);
    },
    /** 終わった時刻を残します（最後の段の長さを出すため）。 */
    finish() {
      return push({ kind: "end" });
    },
  };
}

const sec = (ms) => `${(ms / 1000).toFixed(2).padStart(6)}s`;

/** 流して出す1行。 */
export function formatEvent(ev) {
  if (ev.kind === "research") {
    const tool = ev.tool ? ` → ${ev.tool}${ev.args ? ` ${short(ev.args)}` : ""}` : "";
    const obs = ev.observation ? ` ⇒ ${short(ev.observation)}` : "";
    return `[${sec(ev.ms)}] 調べもの ${ev.state ?? ""}: ${ev.thought}${tool}${obs}`;
  }
  if (ev.kind === "stage") {
    const label = STAGE_BY_KEY.get(ev.stage)?.label ?? ev.stage;
    const more = [ev.note, ev.picks != null ? `候補 ${ev.picks}件` : "", ev.route ? `順: ${ev.route.join(" → ")}` : ""]
      .filter(Boolean).join(" / ");
    return `[${sec(ev.ms)}] 段${ev.step} ${label}${more ? `: ${more}` : ""}`;
  }
  if (ev.kind === "end") return `[${sec(ev.ms)}] 終わり`;
  return `[${sec(ev.ms)}] ${short(ev)}`;
}

function short(v, max = 160) {
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// 日本時間の HH:MM。
function hhmm(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "--:--";
  const d = new Date(t + 9 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
const minutesOf = (it) => {
  const a = Date.parse(it.start);
  const b = Date.parse(it.end);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 60000) : null;
};

/** 段ごとのかかった時間とメモ。 */
export function stageTimeline(events = []) {
  const list = events.filter((e) => e.kind === "stage" || e.kind === "research" || e.kind === "end");
  const rows = [];
  for (const e of list) {
    const key = e.kind === "research" ? "research" : e.kind === "end" ? null : e.stage;
    if (!key) continue;
    let row = rows.find((r) => r.key === key);
    if (!row) {
      row = { key, label: STAGE_BY_KEY.get(key)?.label ?? key, startMs: e.ms, endMs: e.ms, notes: [] };
      rows.push(row);
    }
    row.endMs = e.ms;
    if (e.note && !row.notes.includes(e.note) && row.notes.length < 5) row.notes.push(e.note);
  }
  // 段の長さは、次の段が始まるまで（最後の段は「終わり」まで）。
  const endAt = events.find((e) => e.kind === "end")?.ms ?? rows.at(-1)?.endMs ?? 0;
  rows.forEach((r, i) => { r.ms = Math.max(0, (rows[i + 1]?.startMs ?? endAt) - r.startMs); });
  return rows.map(({ key, label, ms, notes }) => ({ key, label, ms, notes }));
}

/** 旅程の行ごとの根拠（収録のID・経路の出どころ・裏取りの結果）。 */
export function evidenceRows(itinerary) {
  const spots = [];
  const legs = [];
  const others = [];
  (itinerary?.days ?? []).forEach((day, d) => {
    for (const it of day.items ?? []) {
      const g = it.grounding ?? {};
      const base = { day: d + 1, at: hhmm(it.start), title: it.title ?? "", status: g.status ?? "unchecked", source: g.source ?? null };
      if (it.kind === "spot") {
        spots.push({ ...base, spotId: it.spotId ?? it.place?.id ?? null, category: it.place?.category ?? null,
          hours: it.estimated ? "目安" : "収録", minutes: minutesOf(it), reason: it.reason ?? "" });
      } else if (it.kind === "transit") {
        legs.push({ ...base, minutes: minutesOf(it), km: typeof it.km === "number" ? Math.round(it.km * 10) / 10 : null,
          routed: Boolean(it.routed), mode: it.walk ? "walk" : it.drive ? "car" : it.taxi ? "taxi" : "transit",
          detail: it.detail ?? "", reason: it.reason ?? "" });
      } else {
        others.push({ ...base, kind: it.kind, placeId: it.place?.id ?? null });
      }
    }
  });
  return { spots, legs, others };
}

/**
 * 見立て。旅程・調べもの・AI の様子から、気になる点を工程ごとに挙げます。
 * いちばん先の工程で起きた、いちばん重いものを cause にします。
 *
 * @param {{research?: object, itinerary?: object, ai?: object}} result
 * @returns {{findings: {stage: string, level: "error"|"warn"|"info", text: string}[], cause: object|null}}
 */
export function diagnose(result = {}) {
  const f = [];
  const add = (stage, level, text) => f.push({ stage, level, text });
  const r = result.research;
  const it = result.itinerary;

  if (r) {
    if (r.status === "out_of_scope") add("research", "error", `調べもので行き先が決まりませんでした: ${r.message}`);
    for (const s of r.trace ?? []) {
      if (s.observation && s.observation.ok === false && s.action?.tool !== "ask_user") {
        add("research", "warn", `道具 ${s.action?.tool} が失敗: ${s.observation.error?.code ?? ""} ${s.observation.error?.message ?? ""}`.trim());
      }
    }
    if (r.status === "answered") add("research", "info", `ネットで${r.searches}回調べ、${(r.order ?? []).map((s) => s.name).join("・")}を見つけました`);
  }
  if (result.ai?.error) add("understand", "warn", `AI が答えられず、収録データだけで組み直しました: ${result.ai.error}`);
  for (const route of result.ai?.routes ?? []) {
    if (route.reason === "low_confidence") add("understand", "info", `手元の LLM の確信度 ${route.confidence ?? "-"} が閾値未満で、クラウドへ回しました（${route.task ?? ""}）`);
  }
  if (!it) {
    if (!r || r.status !== "out_of_scope") add("propose", "error", "旅程がありません");
    return finish(f);
  }

  const warnings = it.warnings ?? [];
  if (warnings.some((w) => /AIに聞けなかった/.test(w)) && !result.ai?.error) {
    // AI を頼んでいない（CLI の既定）なら、ふつうのことです。
    add("understand", result.ai ? "warn" : "info", "AI を使わず、希望文の読み取りと行き先の選定は機械的に行いました");
  } else if (it.fromModel === false) {
    add("propose", "info", "案は AI ではなく、収録データから機械的に作りました");
  }
  if (it.coverage && it.coverage.level && it.coverage.level !== "ok") {
    add("candidates", "warn", `希望に合う収録が少なめです（${it.coverage.level}）${it.coverage.text ? `: ${it.coverage.text}` : ""}`);
  }
  if (!it.spotCount) add("candidates", "error", "立ち寄るスポットが1つもありません");

  const g = it.grounding;
  if (!g) add("grounding", "error", "裏取り（grounding）の結果がありません。planTrip を通っていない旅程です");
  else {
    if (g.removed?.length) add("propose", "error", `案に収録で確かめられない場所が入っていて、裏取りで外しました: ${g.removed.map((x) => `${x.name}（${x.why}）`).join("・")}`);
    if (g.rewritten?.length) add("propose", "warn", `AI の文に収録に無い固有名があり、書き直しました: ${g.rewritten.map((x) => x.names?.join("・")).join(" / ")}`);
    if (g.rebound?.length) add("propose", "info", `近い名前の収録スポットに結び直しました: ${g.rebound.map((x) => `${x.from}→${x.to}`).join("・")}`);
    if (g.trains?.length) add("route", "warn", `収録の時刻表に無い列車名を外しました: ${g.trains.join("・")}`);
    if (g.ok === false) add("grounding", "error", "裏取りで問題が残りました");
  }

  for (const w of it.hoursWarnings ?? []) add("check", "warn", String(w));
  const { spots, legs } = evidenceRows(it);
  const guessedHours = spots.filter((s) => s.hours === "目安").length;
  if (guessedHours) add("check", "info", `${spots.length}か所のうち${guessedHours}か所は営業時間が分類ごとの目安です`);

  const extend = (it.suggestions ?? []).find((s) => s.id === "extend");
  if (extend) add("adjust", "warn", extend.detail || "時間が足りず、立ち寄りを外しました");
  if ((it.rounds ?? 0) >= 4) add("adjust", "info", `照合のあと${it.rounds - 1}回作り直しました`);

  const estimated = legs.filter((l) => l.status === "estimate").length;
  if (legs.length && estimated) {
    add("route", it.usedRoutesApi ? "warn" : "info",
      `${legs.length}区間のうち${estimated}区間は距離からの目安です${it.usedRoutesApi ? "（経路の取り口で引けなかった区間があります）" : "（経路の取り口を使っていません）"}`);
  }
  if (typeof it.slackMin === "number" && it.slackMin < 15) add("route", "warn", `帰りの余裕が${it.slackMin}分しかありません`);
  return finish(f);
}

function finish(findings) {
  findings.sort((a, b) => (ORDER.get(a.stage) ?? 99) - (ORDER.get(b.stage) ?? 99));
  const worst = Math.min(...findings.map((x) => LEVELS[x.level] ?? 9), 9);
  const cause = worst <= LEVELS.warn ? findings.find((x) => LEVELS[x.level] === worst) : null;
  return { findings, cause: cause ? { ...cause, label: STAGE_BY_KEY.get(cause.stage)?.label ?? cause.stage } : null };
}

/**
 * 開発者向けの記録をまとめます。
 * @param {{research?: object, itinerary?: object, ai?: object, request?: object}} result
 * @param {object[]} [events] createTraceRecorder の events
 */
export function explain(result = {}, events = []) {
  const it = result.itinerary ?? null;
  const evidence = it ? evidenceRows(it) : { spots: [], legs: [], others: [] };
  return {
    version: 1,
    wish: result.request?.wish ?? "",
    stages: stageTimeline(events),
    research: result.research ? {
      status: result.research.status, message: result.research.message,
      searches: result.research.searches, sources: result.research.sources ?? [],
      steps: (result.research.trace ?? []).map((s) => ({ state: s.state, thought: s.thought,
        tool: s.action?.tool ?? null, args: s.action?.args ?? null, observation: s.observation ?? null, ms: s.ms ?? null })),
    } : null,
    ai: result.ai ?? null,
    plan: it ? { title: it.title, region: it.regionId ?? null, regions: it.regionIds ?? [], fromModel: Boolean(it.fromModel),
      rounds: it.rounds ?? null, usedRoutesApi: Boolean(it.usedRoutesApi), slackMin: it.slackMin ?? null,
      query: it.query ?? null, verifyNote: it.verifyNote ?? "" } : null,
    evidence,
    grounding: it?.grounding ?? null,
    diagnosis: diagnose(result),
  };
}

const MARK = { error: "✗", warn: "!", info: "・" };
const STATUS_JA = { verified: "確認済み", rebound: "結び直し", removed: "外した", estimate: "目安", unchecked: "未確認" };

/** 端末向けの文。 */
export function formatExplain(report) {
  const out = [];
  const line = (s = "") => out.push(s);
  line("旅さき 開発者向けの記録（tabisaki trace）");
  if (report.wish) line(`希望: ${report.wish}`);
  line();

  if (report.stages.length) {
    line("■ 工程（かかった時間）");
    for (const s of report.stages) line(`  ${sec(s.ms)}  ${s.label}${s.notes.length ? `  ${s.notes.join(" / ")}` : ""}`);
    line();
  }

  if (report.research) {
    const r = report.research;
    line(`■ 調べもの（Research Agent）: ${r.status}  検索 ${r.searches ?? 0}回`);
    r.steps.forEach((s, i) => {
      line(`  ${String(i + 1).padStart(2)}. [${s.state}] ${s.thought}`);
      if (s.tool) line(`      道具: ${s.tool} ${short(s.args ?? {}, 120)}${s.ms != null ? `（${s.ms}ms）` : ""}`);
      if (s.observation) line(`      結果: ${short(s.observation, 140)}`);
    });
    if (r.message) line(`  答え: ${r.message}`);
    for (const src of r.sources ?? []) line(`  出典: ${src.title} ${src.url}`);
    line();
  }

  if (report.plan) {
    const p = report.plan;
    line(`■ 旅程: ${p.title}  エリア ${p.regions.join(",") || p.region || "-"}  案: ${p.fromModel ? "AI" : "機械的"}  照合 ${p.rounds ?? "-"}回  余裕 ${p.slackMin ?? "-"}分`);
    if (p.query) line(`  読み取り: ${short(p.query, 200)}`);
    if (p.verifyNote) line(`  照合のメモ: ${p.verifyNote}`);
    line();
  }

  const ev = report.evidence;
  if (ev.spots.length) {
    line("■ 立ち寄り先と収録のID（KB 参照）");
    for (const s of ev.spots) {
      line(`  ${s.day}日目 ${s.at} ${s.title} [${s.spotId ?? "IDなし"}] ${s.category ?? ""}  ${STATUS_JA[s.status] ?? s.status}（${s.source ?? "-"}）  営業時間: ${s.hours}`);
    }
    line();
  }
  if (ev.legs.length) {
    line("■ 移動（経路の取り口の結果）");
    for (const l of ev.legs) {
      line(`  ${l.day}日目 ${l.at} ${l.title}  ${l.minutes ?? "-"}分${l.km != null ? `・${l.km}km` : ""}  ${l.routed ? "経路を引いた" : "目安"}（${l.source ?? "-"}）${l.reason ? `  ${l.reason}` : ""}`);
    }
    line();
  }

  const g = report.grounding;
  if (g) {
    line(`■ 裏取り: 確かめた ${g.checked}・確認済み ${g.verified}・目安 ${g.estimated}・外した ${g.removed?.length ?? 0}・結び直し ${g.rebound?.length ?? 0}・列車名 ${g.trains?.length ?? 0}・書き直し ${g.rewritten?.length ?? 0}`);
    line();
  }

  if (report.ai?.routes?.length) {
    line("■ モデルの使い分け");
    for (const r of report.ai.routes) line(`  ${r.task ?? "-"}: ${r.route ?? "-"}  確信度 ${r.confidence ?? "-"}${r.reason ? `（${r.reason}）` : ""}`);
    line();
  }

  const d = report.diagnosis;
  line("■ 見立て");
  if (!d.findings.length) line("  気になる点は見つかりませんでした。");
  for (const x of d.findings) line(`  ${MARK[x.level] ?? "・"} ${STAGE_BY_KEY.get(x.stage)?.label ?? x.stage}: ${x.text}`);
  line(d.cause ? `  → 先に見る工程: ${d.cause.label}` : "  → 直すべき工程は見当たりません。");
  return out.join("\n") + "\n";
}
