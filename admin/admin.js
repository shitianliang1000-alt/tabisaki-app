// 旅さき — 管理画面
//
// 旅行者向けの画面から、技術の言葉を全部こちらへ移しました。
// 「Gemini」「Routes API」「知識ベース」は、運用する人の言葉です。
//
// ここが答えるのは、運用する人が知りたいことです。
//   概要 / 設定 / 使用量 / 旅程の結果 / エラー / kb/ 点検 / スポット
// 件数・設定・変更待ちは Worker が持っていて（server/stats.js）、この画面は
// /private/api/ を通して読み書きします。**書き込みはこの画面からだけ**です
// （公開サイトからは届きません。server/admin.js）。
//
// **この画面に認証はありません。** GitHub Pages には置かず、Worker が
// 合言葉つきで配ります（server/admin.js）。

import { EMBED_MODEL, FALLBACK_MODELS, GEMINI_API_KEY, KB_INDEX_URL,
         LOCAL_BASE_URL, LOCAL_MODEL, MAPS_API_KEY, MODEL, MODEL_PROVIDER,
         PROXY_URL, USE_ROUTES_API } from "../js/config.js";
import { loadKnowledgeBase } from "../js/kb.js";
import { diagnoseGeminiKey } from "../js/ai.js";
import { diagnoseMapsKey } from "../js/routes.js";
import { freshnessOf } from "../js/confidence.js";
import { hiddenQuality, integrity, misclassified, misclassifiedGroups, search,
         unverified, WHY_LABEL } from "./kbcheck.js";
import { byCountry, CONDITION_LABEL, conditions, perDay, planOutcome,
         requestsByEndpoint, rounds, timing, totals, usersByDay } from "./statview.js";

const app = document.getElementById("app");

/** 要素を1つ作る。ui.js と同じ考えかたで、文字しか入れません。 */
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    const lowerK = k.toLowerCase();
    if (lowerK === "class") node.className = v;
    else if (lowerK.startsWith("on")) {
      if (typeof v === "function") {
        node.addEventListener(lowerK.slice(2), v);
      }
      // Neutralize inline event handlers passed as strings or array bypasses
      // Do nothing to prevent the attribute from being added to the element entirely
    } else if (lowerK === "srcdoc") {
      // srcdoc takes raw HTML. Since we intentionally do not use innerHTML,
      // we must drop srcdoc entirely to prevent XSS via HTML injection in iframes.
    } else if (["href", "src", "action", "formaction", "data"].includes(lowerK)) {
      if (v !== null && v !== undefined && v !== false) {
        const strV = String(v);
        const sanitized = strV.replace(/[\x00-\x20]/g, "").toLowerCase();
        const isDangerousData = sanitized.startsWith("data:") && !sanitized.startsWith("data:image/");
        if (sanitized.startsWith("javascript:") || sanitized.startsWith("vbscript:") || isDangerousData) {
          node.setAttribute(k, "about:blank");
        } else {
          node.setAttribute(k, strV);
        }
      }
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const row = (k, v, extra) => el("div", { class: "row" },
  el("span", { class: "k" }, k),
  el("span", { class: `v${extra === "mono" ? " mono" : ""}` }, v));

const pill = (text, kind) => el("span", { class: `pill ${kind}` }, text);

/** 数の偏りを、棒で見せます。数字だけだと気づけません。 */
function bars(pairs) {
  const max = Math.max(1, ...pairs.map(([, n]) => n));
  return el("div", { class: "bars" }, pairs.map(([name, n]) =>
    el("div", { class: "bar-row" },
      el("span", { class: "n" }, name),
      el("span", { class: "t" }, el("i", { style: `width:${n / max * 100}%` })),
      el("span", { class: "c" }, n.toLocaleString()))));
}


const section = (title, ...kids) => [el("h2", {}, title), ...kids];
const card = (...kids) => el("div", { class: "card" }, ...kids);
const note = (text, kind = "") => el("p", { class: `note ${kind}`.trim() }, text);
const num = (n) => Number(n).toLocaleString();
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const sec = (x) => (x == null ? "—" : x < 90 ? `${x.toFixed(1)} 秒` : `${(x / 60).toFixed(1)} 分`);

function table(head, rows) {
  return el("table", {},
    el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {},
      r.map((c) => el("td", { class: typeof c === "number" ? "num" : "" }, c))))));
}

// --- 管理用の呼び出し（/private/api/…）-------------------------------------
// この画面が Worker から配られているときだけ動きます。手元の簡易サーバーで
// 開いたときは 404 になるので、「Worker で開いてください」と出します。
const API = new URL("../api/", location.href).toString();
let apiOk = null;

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "X-Admin-Request": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* JSON でなければ、画面が使えない場所です */ }
  if (!res.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

async function haveApi() {
  if (apiOk !== null) return apiOk;
  try { await api("GET", "overview"); apiOk = true; } catch { apiOk = false; }
  return apiOk;
}

const needWorker = () => note(
  "この項目は、Worker から開いたときだけ使えます（…workers.dev/admin）。"
  + "手元の簡易サーバーでは、件数も設定も変更待ちもありません。");

// --- kb/ をそのまま読む -----------------------------------------------------
let rawKb = null;
async function loadRaw(onStep = () => {}) {
  if (rawKb) return rawKb;
  const base = new URL(`../${KB_INDEX_URL}`, location.href);
  const get = async (name) => {
    const res = await fetch(new URL(name, base));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.json();
  };
  const index = await get(base.pathname.split("/").pop());
  const regions = (await get(index.regionsFile ?? "regions.json")).regions ?? [];
  const spots = [];
  let done = 0;
  const queue = [...(index.shards ?? [])];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const sh = queue.shift();
      const doc = await get(sh.file);
      for (const s of doc.spots ?? []) { s._file = sh.file; spots.push(s); }
      onStep(++done, index.shards.length);
    }
  }));
  rawKb = { index, regions, spots };
  return rawKb;
}

// --- 変更待ちへの積み込み ---------------------------------------------------
async function queueEdit(edit, button) {
  if (!(await haveApi())) { alert("Worker から開いたときだけ使えます"); return; }
  button.disabled = true;
  try {
    await api("POST", "edits", edit);
    button.textContent = "変更待ちに入れました";
  } catch (e) {
    button.disabled = false;
    alert(e.message);
  }
}

const editButton = (label, edit) => {
  const b = el("button", { class: "act small", type: "button" }, label);
  b.addEventListener("click", () => queueEdit(edit, b));
  return b;
};

// ============================================================================
// タブ
// ============================================================================
const TABS = [
  ["overview", "概要"], ["settings", "設定"], ["usage", "使用量"],
  ["plans", "旅程の結果"], ["errors", "エラー"], ["kb", "kb/ 点検"], ["spots", "スポット"],
];

async function overview() {
  const out = el("div");
  out.append(...section("収録データ"));
  const dataCard = card();
  out.append(dataCard);
  let kb = null;
  try { kb = await loadKnowledgeBase(); } catch (e) { dataCard.append(row("読み込み", `失敗しました（${e.message}）`)); }
  if (kb) {
    const c = kb.manifest?.counts ?? {};
    dataCard.append(
      row("出どころ", KB_INDEX_URL || "同梱データ（KB_INDEX_URL 未設定）", "mono"),
      row("エリア", `${num(c.regions ?? kb.regions.length)} 件`),
      row("スポット", `${num(c.spots ?? kb.spots.length)} 件`),
      row("実際に読めた件数", `${num(kb.spots.length)} 件`));
    if (c.spots && c.spots > kb.spots.length) {
      // 読み込むときに、同じ場所・同じ名前のものを1つにまとめています
      // （js/dedupe.js）。ファイルの中身の食い違いは「kb/ 点検」で見ます。
      dataCard.append(note(`ファイルの件数 ${num(c.spots)} のうち、${num(c.spots - kb.spots.length)} 件は読み込み時に`
        + "同じ場所の重複として1つにまとめています。"));
    }
    const byCat = new Map();
    for (const s of kb.spots) byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
    out.append(...section("分類の内訳（上位12）", card(bars([...byCat].sort((a, b) => b[1] - a[1]).slice(0, 12)))));
    const bySrc = new Map();
    for (const s of kb.spots) {
      const key = s.source === "ai" ? "AI調査" : s.source === "estimated" ? "推定（分類ごとの目安）" : "確認済み";
      bySrc.set(key, (bySrc.get(key) ?? 0) + 1);
    }
    out.append(...section("情報の確からしさ", card(bars([...bySrc].sort((a, b) => b[1] - a[1])))));
    const stamped = kb.spots.map((s) => s.fetchedAt).filter(Number.isFinite);
    const fresh = stamped.length ? freshnessOf(Math.min(...stamped)) : null;
    out.append(...section("データの鮮度", card(
      row("確認日を持つ件数", `${num(stamped.length)} / ${num(kb.spots.length)} 件`),
      row("いちばん古いもの", fresh ? fresh.text : "確認日を持つデータがありません"))));
    out.append(...section("出典"));
    const srcCard = card();
    for (const s of kb.manifest?.sources ?? kb.attribution ?? []) {
      srcCard.append(row(s.name, s.url
        ? el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.url) : "（URLなし）"));
    }
    out.append(srcCard);
  }
  return out;
}

async function settings() {
  const out = el("div");
  const viaProxy = Boolean(String(PROXY_URL ?? "").trim());
  const local = MODEL_PROVIDER === "local";

  out.append(...section("サイトの設定（js/config.js）",
    card(
      row("キーの持ちかた", viaProxy
        ? el("span", {}, pill("プロキシ経由", "ok"), " ", PROXY_URL)
        : el("span", {}, pill("ブラウザに直書き", "warn"), " 公開するなら PROXY_URL を設定してください")),
      row("モデルの出どころ", local ? `自分で立てたサーバー（${LOCAL_MODEL} @ ${LOCAL_BASE_URL}）` : `${MODEL_PROVIDER}（${MODEL}）`),
      row("控えのモデル", local ? "—" : (FALLBACK_MODELS.join(", ") || "なし"), "mono"),
      row("埋め込み", local ? "使いません（語句検索に落ちます）" : EMBED_MODEL, "mono"),
      row("経路API", USE_ROUTES_API ? pill("使う", "ok") : el("span", {}, pill("使わない", "warn"), " 距離からの推定になります")),
      row("Gemini キー", viaProxy ? "サーバー側" : (GEMINI_API_KEY ? "設定済み" : "未設定")),
      row("Maps キー", viaProxy ? "サーバー側" : (MAPS_API_KEY ? "設定済み" : "未設定"))),
    note("ここは読むだけです。値を変えるには js/config.js を直して PR にします（キーはブラウザに置かないため）。")));

  if (!(await haveApi())) { out.append(needWorker()); return out; }
  const ov = await api("GET", "overview");

  out.append(...section("Worker の状態",
    card(
      row("Gemini キー", ov.secrets.GEMINI_API_KEY ? pill("入っている", "ok") : pill("入っていない", "warn")),
      row("Maps キー", ov.secrets.MAPS_API_KEY ? pill("入っている", "ok") : pill("入っていない", "warn")),
      row("Workers AI", ov.bindings.AI ? pill("使える", "ok") : pill("使えない", "warn")),
      row("回数制限（Durable Object）", ov.bindings.RATE ? pill(ov.rateLimit === "off" ? "切ってある" : "有効", ov.rateLimit === "off" ? "warn" : "ok") : pill("無い", "ng")),
      row("件数の置き場（STATS）", ov.bindings.STATS ? pill("有効", "ok") : pill("無い", "ng")),
      row("Analytics Engine（METRICS）", ov.bindings.METRICS ? pill("有効", "ok") : el("span", {}, pill("未設定", "warn"), " 使わなくても、件数は STATS に貯まります")),
      row("GitHub への書き込み", ov.secrets.GITHUB_TOKEN ? pill("GITHUB_TOKEN あり", "ok") : el("span", {}, pill("GITHUB_TOKEN なし", "warn"), " スポットの変更は JSON で書き出します")),
      row("呼び出しを許すサイト", ov.allowOrigin.join(", "), "mono"))));

  // 入口の入り切り
  const disabled = new Set(ov.settings.disabled);
  const boxes = ov.switchable.map((p) => {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !disabled.has(p);
    cb.addEventListener("change", () => (cb.checked ? disabled.delete(p) : disabled.add(p)));
    return row(p, el("label", {}, cb, " 使う"));
  });
  // 回数の上限
  const lim = ov.limits; const base = ov.limitsDefault;
  const field = (pool, unit) => {
    const i = el("input", { type: "number", min: "1", step: "1", value: String(lim[pool][unit]), class: "num-in" });
    return i;
  };
  const f = { free: { minute: field("free", "minute"), hour: field("free", "hour") },
              paid: { minute: field("paid", "minute"), hour: field("paid", "hour") } };
  const msg = el("span", { class: "v" }, "");
  const save = el("button", { class: "act", type: "button" }, "保存する");
  save.addEventListener("click", async () => {
    save.disabled = true; msg.textContent = "保存しています…";
    try {
      const body = {
        disabled: [...disabled],
        limits: {
          free: { minute: f.free.minute.value, hour: f.free.hour.value },
          paid: { minute: f.paid.minute.value, hour: f.paid.hour.value },
        },
      };
      await api("PUT", "settings", body);
      msg.textContent = "保存しました（反映まで最大30秒）";
    } catch (e) { msg.textContent = `保存できませんでした: ${e.message}`; }
    save.disabled = false;
  });
  out.append(...section("機能の入り切り",
    card(...boxes),
    note("切った入口は 503 を返し、外のサービスを呼びません（課金も止まります）。アプリは距離からの推定などに落ちます。")));
  out.append(...section("使用量の調整（1つのIPあたり）",
    card(
      row("無料枠（Yahoo!）1分", f.free.minute), row("無料枠（Yahoo!）1時間", f.free.hour),
      row("課金される側（Gemini・Routes）1分", f.paid.minute), row("課金される側 1時間", f.paid.hour),
      row("既定値", `無料 ${base.free.minute}/${base.free.hour}、課金 ${base.paid.minute}/${base.paid.hour}（1分/1時間）`),
      el("div", { class: "row" }, save, msg)),
    note("上限は、超えると 429 を返す点数です（Gemini 5点、Routes 3点、Yahoo! 1点）。環境変数 RATE_*_PER_MINUTE より、ここで決めた値が先に効きます。")));

  // 疎通
  const result = el("span", { class: "v" }, "まだ確かめていません");
  const btn = el("button", { class: "act", type: "button" }, "接続を確かめる");
  btn.addEventListener("click", async () => {
    btn.disabled = true; result.textContent = "確かめています…";
    const lines = [];
    try { const ai = await diagnoseGeminiKey(); lines.push(`AI: ${ai.ok ? "OK" : "NG"} — ${ai.message}`); } catch (e) { lines.push(`AI: NG — ${e.message}`); }
    try { const r = await diagnoseMapsKey(); lines.push(`経路: ${r.ok ? "OK" : "NG"} — ${r.message}`); } catch (e) { lines.push(`経路: NG — ${e.message}`); }
    result.textContent = lines.join(" / "); btn.disabled = false;
  });
  out.append(...section("疎通の確認", card(el("div", { class: "row" }, el("span", { class: "k" }, "実際に1回ずつ呼ぶ"), result, btn)),
    note("押したときだけ呼びます（課金対象です）。")));
  return out;
}

const dayPicker = (current, onPick) => {
  const sel = el("select", {}, [["7", "7日"], ["30", "30日"], ["90", "90日"]].map(([v, t]) => {
    const o = el("option", { value: v }, t); if (v === String(current)) o.selected = true; return o;
  }));
  sel.addEventListener("change", () => onPick(Number(sel.value)));
  return el("div", { class: "pick" }, "期間: ", sel);
};

async function withStats(days, draw) {
  const out = el("div");
  if (!(await haveApi())) { out.append(needWorker()); return out; }
  const stats = await api("GET", `stats?days=${days}`);
  out.append(dayPicker(days, (d) => { statsDays = d; render(); }));
  out.append(...draw(stats));
  return out;
}
let statsDays = 30;

const usage = () => withStats(statsDays, ({ counts }) => {
  const reqs = requestsByEndpoint(counts);
  const total = reqs.reduce((a, [, n]) => a + n, 0);
  const users = usersByDay(counts);
  const today = users.at(-1);
  const out = [];
  out.push(...section("接続回数", card(
    row("期間の合計", `${num(total)} 回`),
    row("きょうの利用者（匿名・推定）", today ? `${num(today.users)} 人 / ${num(today.requests)} 回` : "—")),
    total ? card(bars(reqs)) : note("まだ件数がありません。このページを入れてから、アプリが中継を呼ぶたびに数えます。")));
  const days = perDay(counts, "req");
  if (days.length) out.push(...section("日ごとの接続回数", card(bars(days.slice(-14).map(([d, n]) => [d.slice(5), n])))));
  const stat = [...totals(counts, "status")].sort((a, b) => b[1] - a[1]);
  if (stat.length) out.push(...section("エラーを返した回数（入口と番号）", card(bars(stat.slice(0, 12)))));
  const countries = byCountry(counts);
  if (countries.length) out.push(...section("場所（国）", card(bars(countries.slice(0, 10))),
    note("Cloudflare が付ける国コードだけです。県や市のような細かい場所は取りません。")));
  out.push(...section("利用者ごとの使用回数", users.length
    ? card(table(["日付", "利用者数", "回数", "多い順（匿名の鍵: 回数）"],
        users.slice(-14).reverse().map((u) => [u.day, u.users, u.requests,
          u.top.map(([k, n]) => `${k}: ${n}`).join("、")])))
    : note("まだありません。"),
    note("利用者は「その日だけの塩 + IP」のハッシュ頭8文字で区別します。IP は残さず、塩は日ごとに作り直すので、日をまたいで同じ人だとは分かりません。")));
  return out;
});

const plans = () => withStats(statsDays, ({ counts }) => {
  const o = planOutcome(counts);
  const t = timing(counts); const r = rounds(counts);
  const out = [];
  out.push(...section("旅程づくりの成功率",
    o.lowData ? note("「使われかたの集計に協力する」を入れた人のぶんだけなので、いまは件数が少ない状態です（"
      + `${num(o.total)} 件）。割合は目安にとどめてください。`) : "",
    card(row("成功", num(o.ok)), row("組めなかった", num(o.err)), row("成功率", pct(o.rate))),
    o.reasons.length ? card(el("p", { class: "cap" }, "組めなかった理由"), bars(o.reasons)) : "",
    o.byTransport.length ? card(el("p", { class: "cap" }, "成功した旅の移動手段"), bars(o.byTransport)) : ""));
  out.push(...section("かかった時間とラウンド数",
    card(row("平均の組み立て時間（成功）", `${sec(t.avgSecs)}（${num(t.n)} 件）`),
         row("AIに聞いた回数の平均", r.avg == null ? "—" : `${r.avg.toFixed(2)} 回（${num(r.n)} 件）`)),
    t.n ? card(el("p", { class: "cap" }, "時間の分布（秒）"), bars(t.dist)) : "",
    r.n ? card(el("p", { class: "cap" }, "ラウンド数の分布"), bars(r.dist.map(([k, n]) => [`${k} 回`, n]))) : ""));
  const cond = conditions(counts);
  const keys = Object.keys(CONDITION_LABEL).filter((k) => cond[k]);
  out.push(...section("入力条件の分布", keys.length
    ? el("div", {}, keys.map((k) => card(el("p", { class: "cap" }, CONDITION_LABEL[k]), bars(cond[k]))))
    : note("まだありません。"),
    note("協力してくれた人の、決まった選択肢だけです。入力した文・地名・旅程は送られません（js/metrics.js）。")));
  return out;
});

const errors = () => withStats(statsDays, ({ errors: list }) => {
  const rows = list.map((e) => [new Date(e.at).toLocaleString("ja-JP"), e.code, e.path, e.detail]);
  return section("エラーレポート（直近）", rows.length
    ? card(table(["時刻", "種類", "入口", "内容"], rows))
    : note("記録はありません。中継の 5xx と、協力者の「旅程を組めなかった」を記録します（文章や地名は残しません）。"));
});

// --- kb/ 点検 -------------------------------------------------------------------
async function kbPage() {
  const out = el("div");
  const prog = el("p", { class: "loading" }, "kb/ を読んでいます…");
  out.append(prog);
  const kb = await loadRaw((i, n) => { prog.textContent = `kb/ を読んでいます… ${i}/${n}`; });
  prog.remove();

  const issues = integrity(kb);
  out.append(...section("整合性", issues.length
    ? card(table(["", "内容", "件数", "例"], issues.map((x) => [
        pill(x.level === "ng" ? "要対応" : "確認", x.level), `${x.title}${x.detail ? `（${x.detail}）` : ""}`,
        x.n || "", x.ids.slice(0, 5).join(", ")])))
    : card(row("結果", pill("問題は見つかりませんでした", "ok")))));

  const un = unverified(kb.spots);
  out.append(...section("未確認・古いスポット",
    card(row("確認日が無い", `${num(un.unknown)} 件`), row("確認日が古い（60日以上）", `${num(un.stale)} 件`)),
    note("有名なもの・説明が無いものから順に並べています（上位200件）。確認日（fetchedAt）を取り込みで入れると、ここが働き始めます。"),
    card(table(["名前", "分類", "区分", "確認日"], un.top.slice(0, 50).map((x) =>
      [x.name, x.category, x.tier, x.days == null ? "なし" : `${x.days}日前`])))));

  const mis = misclassified(kb.spots);
  const groups = misclassifiedGroups(mis);
  const misCard = card();
  const pageSize = 30;
  mis.slice(0, pageSize).forEach((x) => misCard.append(el("div", { class: "row" },
    el("span", { class: "k" }, x.name), el("span", { class: "v" }, `${x.from} → ${x.to}`),
    editButton("再割り当て", { op: "category", id: x.id, regionId: x.regionId, name: x.name, category: x.to, from: x.from }))));
  out.append(...section("分類の誤りの疑い",
    card(row("件数", `${num(mis.length)} 件`)),
    groups.length ? card(bars(groups.slice(0, 10))) : "",
    mis.length ? misCard : "",
    note("名前の終わり（〜神社、〜美術館 など）と分類が食い違うものです。押すと変更待ちに入ります（「スポット」で確かめて反映します）。")));

  const hq = hiddenQuality(kb.spots);
  const hqCard = card();
  hq.rows.slice(0, 30).forEach((x) => hqCard.append(el("div", { class: "row" },
    el("span", { class: "k" }, x.name),
    el("span", { class: "v" }, `${WHY_LABEL[x.why]}${x.description ? `：${x.description.slice(0, 40)}` : ""}`))));
  out.append(...section("穴場の説明文の質",
    card(row("穴場の件数", num(hq.total)), row("説明が無い", num(hq.tally.none)), row("短すぎる", num(hq.tally.short)),
         row("住所だけ", num(hq.tally.address)), row("同じ文が何か所にも", num(hq.tally.repeated)), row("問題なし", num(hq.tally.ok))),
    hqCard));
  return out;
}

// --- スポットの追加・削除と、変更待ち -------------------------------------------
async function spotsPage() {
  const out = el("div");
  if (!(await haveApi())) { out.append(needWorker()); return out; }
  const kb = await loadRaw();

  const q = el("input", { type: "search", placeholder: "名前で探す", class: "wide" });
  const results = card();
  q.addEventListener("input", () => {
    results.textContent = "";
    for (const s of search(kb.spots, q.value, 20)) {
      results.append(el("div", { class: "row" },
        el("span", { class: "k" }, s.name), el("span", { class: "v" }, `${s.category} · ${s.regionId} · ${s.id}`),
        editButton("削除", { op: "delete", id: s.id, regionId: s.regionId, name: s.name }),
        editButton("名前の索引からも外して削除", { op: "delete", id: s.id, regionId: s.regionId, name: s.name, dropName: true })));
    }
  });
  out.append(...section("探して削除", card(el("div", { class: "row" }, q)), results));

  const cats = [...new Set(kb.spots.map((s) => s.category))].sort();
  const regionList = el("datalist", { id: "regions" }, kb.regions.map((r) => el("option", { value: r.id }, r.name ?? "")));
  const inp = (name, attrs = {}) => el("input", { name, class: "wide", ...attrs });
  const form = {
    name: inp("name"), regionId: inp("regionId", { list: "regions" }),
    category: el("select", { name: "category" }, cats.map((c) => el("option", { value: c }, c))),
    lat: inp("lat", { inputmode: "decimal" }), lng: inp("lng", { inputmode: "decimal" }),
    fame_tier: el("select", { name: "fame_tier" }, [["hidden", "穴場"], ["known", "知る人ぞ知る"], ["major", "定番"]]
      .map(([v, t]) => el("option", { value: v }, t))),
    description: inp("description"),
  };
  const add = el("button", { class: "act", type: "button" }, "追加を変更待ちに入れる");
  add.addEventListener("click", () => {
    const region = form.regionId.value.trim();
    if (!kb.regions.some((r) => r.id === region)) { alert("エリアの id が見つかりません"); return; }
    const n = kb.spots.filter((s) => s.regionId === region).length + 1;
    let id = `adm-${region}-${Date.now().toString(36)}`;
    if (kb.spots.some((s) => s.id === id)) id += n;
    queueEdit({ op: "add", spot: {
      id, regionId: region, name: form.name.value, category: form.category.value,
      lat: Number(form.lat.value), lng: Number(form.lng.value),
      fame_tier: form.fame_tier.value, description: form.description.value } }, add).then(() => { add.disabled = false; add.textContent = "追加を変更待ちに入れる"; loadEdits(); });
  });
  out.append(...section("スポットを足す",
    card(
      row("名前", form.name), row("エリアの id", el("span", {}, form.regionId, regionList)),
      row("分類", form.category), row("緯度", form.lat), row("経度", form.lng),
      row("定番・穴場", form.fame_tier), row("説明（任意・400字まで）", form.description),
      el("div", { class: "row" }, add)),
    note("エリアの id は regions.json のものです（候補が出ます）。座標は日本の範囲だけ受け付けます。")));

  // 変更待ち
  const list = card();
  const actions = el("div", { class: "row" });
  async function loadEdits() {
    const { edits } = await api("GET", "edits");
    list.textContent = ""; actions.textContent = "";
    if (!edits.length) { list.append(el("div", { class: "row" }, "変更待ちはありません")); return; }
    for (const e of edits) {
      const label = { add: "追加", delete: "削除", category: `分類 ${e.from || "?"} → ${e.category}`, description: "説明" }[e.op] ?? e.op;
      const rm = el("button", { class: "act small ghost", type: "button" }, "取り消す");
      rm.addEventListener("click", async () => { await api("DELETE", `edits?key=${encodeURIComponent(e.key)}`); loadEdits(); });
      list.append(el("div", { class: "row" }, el("span", { class: "k" }, e.name || e.id), el("span", { class: "v" }, label), rm));
    }
    const pr = el("button", { class: "act", type: "button" }, "PRにする");
    const msg = el("span", { class: "v" }, "");
    pr.addEventListener("click", async () => {
      pr.disabled = true; msg.textContent = "PRを作っています…";
      try {
        const r = await api("POST", "edits/publish");
        msg.textContent = "";
        msg.append(r.url ? el("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, "PRを開く") : "当てられる変更がありませんでした");
        loadEditsLater();
      } catch (err) { msg.textContent = err.message; pr.disabled = false; }
    });
    const dl = el("button", { class: "act ghost", type: "button" }, "JSONで書き出す");
    dl.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ edits }, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: "kb-edits.json" });
      document.body.append(a); a.click(); a.remove();
    });
    actions.append(pr, dl, msg);
  }
  const loadEditsLater = () => setTimeout(loadEdits, 600);
  await loadEdits();
  out.append(...section("変更待ち", list, card(actions),
    note("ここに積んだ変更は、まだ公開サイトに出ていません。「PRにする」で GitHub のプルリクエストを作り、マージすると公開されます"
      + "（GITHUB_TOKEN が無いときは JSON を書き出し、node tools/apply_kb_edits.mjs で当てます）。")));
  return out;
}

const PAGES = { overview, settings, usage, plans, errors, kb: kbPage, spots: spotsPage };

async function render() {
  const id = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : "overview";
  nav.querySelectorAll("a").forEach((a) => a.setAttribute("aria-current", String(a.dataset.id === id)));
  app.textContent = "";
  app.append(el("p", { class: "loading" }, "読み込んでいます…"));
  try {
    const page = await PAGES[id]();
    app.textContent = "";
    app.append(page);
  } catch (e) {
    app.textContent = "";
    app.append(note(`読み込めませんでした: ${e.message}`, "danger"));
  }
}

const nav = el("nav", { class: "tabs", "aria-label": "管理画面の項目" },
  TABS.map(([id, label]) => el("a", { href: `#${id}`, "data-id": id }, label)));
app.before(nav);
addEventListener("hashchange", render);
render();
