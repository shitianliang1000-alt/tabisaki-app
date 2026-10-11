// 画面まわり。旅程を組む流れそのものは pipeline.js にあります。
//
// ここでやること:
//   ・入力を読んで旅の条件（trip）にする
//   ・pipeline.js を呼ぶ
//   ・結果を描く／エラーを日本語で出す
//   ・APIキーの疎通確認（「キーを入れたのに効かない」を切り分けるため）

import { KB_INDEX_URL, TILE_ATTRIBUTION, TILE_URL } from "./config.js";
import { clearSettings, cspAllows, effectiveConfig, loadSettings, maskKey,
         saveSettings } from "./settings.js";
import { callModel, canGround, describeSpot, diagnoseGeminiKey, hasApiKey }
  from "./ai.js";
import { proxyStatus } from "./endpoints.js";
import { discoverArea } from "./discover.js";
import { ensureRegions, loadKnowledgeBase, loadRegionIndex, mergeIntoKb, stagedKb }
  from "./kb.js";

import { clearRouteCache, diagnoseMapsKey, diagnoseYahooTransit,
         resetRoutesBreaker, routesUsage }
  from "./routes.js";
import { PLACES, findPlace, nearestPlaceInfo } from "./places.js";
import { findStop, preloadStops, searchStops } from "./stops.js";
import { END_MODES, formatHourField, makeTrip, parseHourField, validateTrip }
  from "./trip.js";
import { TripMap, pointsFromItinerary } from "./map.js";
import { haversineKm } from "./feasibility.js";
import { configureQuota, describeUsage, quota } from "./quota.js";
import { artFor } from "./art.js";
import { icon } from "./icons.js";
import { mixTargets } from "./mix.js";
import { photoFor } from "./photos.js";
import { followReading } from "./follow.js";
import { applyEdit, describeEdit, parseEdit } from "./edit.js";
import { applyReplan } from "./replan.js";
import { confidenceOf, describeSource, freshnessOf } from "./confidence.js";
import { isNetworkFailure, userFacing } from "./errors.js";
import { spotFit, tripFit } from "./fit.js";
import { paceBreakdown, slackLevel } from "./score.js";
import { VARIANTS, distinguishOf, recommendOf, summaryOf, tripsFor }
  from "./variants.js";
import { $, el, loadSketch, openSheet, renderItinerary, renderProgress, renderToday,
         scrollBehavior, suggestionButton } from "./ui.js";
import { catchUp } from "./today.js";
import { isOffline, watchConnection } from "./online.js";
import { conditionsOf, metricsEnabled, setMetricsEnabled, track } from "./metrics.js";
import { watchArrival } from "./arrive.js";
import { armNotices, askNotifyPermission, scheduleNotices }
  from "./notify.js";
import { requeryNextLeg } from "./nextleg.js";
import { orderDiff } from "./orderdiff.js";
import { reachOf } from "./reach.js";
import { clearTripMode, loadTripMode, saveTripMode } from "./tripmode.js";
import { searchYahooTransit } from "./yahoo-transit.js";
import { yahooFlags } from "./modes.js";
import { tripCodeFrom, tripLink, unpackTrip } from "./snapshot.js";
import { addHistory, clearHistory, freezeItinerary, loadHistory, removeHistory,
         replaceHistory, savedLabel, thawItinerary } from "./history.js";
import { applyTypeScale, initTypeScale, saveTypeScale } from "./typescale.js";

// 旅程を組む部分（js/pipeline.js とその先の約20モジュール、450KBほど）
// と、ファイルの書き出し・読み込み（js/transfer.js）は、開いた直後の
// フォームには要りません。静的に import すると、画面が出る前に全部を
// 取りに行って読み解くので、使うときに読みます。
//
// 「つくる」を押してから取りに行くと、そのぶん待たせます。画面が出て
// 手が空いたら（requestIdleCallback）先に読み始めておきます。
let pipelineModule = null;
let transferModule = null;
const loadPipeline = () => (pipelineModule ??= import("./pipeline.js")
  .catch((e) => { pipelineModule = null; throw e; }));
const loadTransfer = () => (transferModule ??= import("./transfer.js")
  .catch((e) => { transferModule = null; throw e; }));
async function planTrip(args) {
  return (await loadPipeline()).planTrip(args);
}
function warmModules() {
  const go = () => {
    loadPipeline().catch(() => {});
    loadSketch().catch(() => {});
    loadTransfer().catch(() => {});
  };
  if ("requestIdleCallback" in globalThis) requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

/** 待ち画面の絵に渡す、収録スポットの上限。読み込んだ順の末尾です
    （遅れて読むので、末尾が旅先の県のぶんになります）。 */
const MAX_SKETCH_STARS = 1200;

const state = { kb: null, map: null, bgMap: null, homeMap: null, trip: null,
                endMode: "origin", mode: "plan",
                // 人数。費用の概算に効きます（宿と入場は人数ぶん）。
                people: 1,
                discovering: false, aiSpots: 0,
                // ペースは、利用者が「もっとゆっくり」等を押したときだけ
                // 指定します。既定では希望文からの読み取りに任せます。
                pace: null, clearArea: false, avoidIds: [], editNote: "",
                // 旅行中モード（js/tripmode.js）。開き直しても続きます。
                tripMode: false,
                // avoidIds のうち、「外す」で件数ごと減らしたぶんと、
                // そのときの上限。条件を組み直しても残します（残さないと、
                // 外したはずの枠を別の場所が埋めて、押しても減りません）。
                removedIds: [], spotCap: null,
                // 「外す」を押す直前の旅程。戻すときにそのまま返します。
                // 組み直して返すと、**行き先ごと変わることがあります**。
                beforeRemove: null, keepBeforeRemove: false,
                // 3案とおすすめ。案を選び直すときに使い回します。
                plans: [], recommendKey: "", recommendWhy: "",
                chosenTrip: null,
                // 旅行中モードで「着いた」を押した予定
                arrivedAtId: "",
                // 当日のしたく。
                //   watch   … 現在地の見張り（js/arrive.js）
                //   notices … 仕掛けた知らせ（js/notify.js）
                //   hint    … 現在地から分かったこと。**旅程は変えません**
                //   note    … 断られた理由など、画面に出す一言
                // どちらも**押されてから**始めます。開いた瞬間に許可を
                // 求めるのは、いちばん断られる聞きかたです。
                today: { watch: null, notices: null, hint: null, note: "",
                         requeried: null, requerying: false },
                pinned: new Map() };

// --- 起動 -------------------------------------------------------------------

async function boot() {
  // **画面を組む前に、字の大きさを当てます。**
  //
  // あとから当てると、標準の大きさで一度描いてから大きくなるので、
  // 開いた瞬間に字が飛び跳ねます。
  initTypeScale();
  // 画面が出たあと、手が空いたら旅程づくりの部品を読み始めます。
  warmModules();

  state.map = new TripMap("map");
  state.map.configure({ tileUrl: TILE_URL, attribution: TILE_ATTRIBUTION });
  startBackgroundMap();
  // 携帯では、条件の画面に地図は出ていません（3画面に分けています）。
  // 見えていない地図のために Leaflet を待ち、地図のタイルを何枚も
  // 落とすのは、移動中の回線ではただの負担です。結果の画面に移った
  // ときに作ります。
  if (!isNarrow()) startHomeMap();

  configureQuota({ ask: askQuota, onChange: showQuota });

  registerServiceWorker();
  // 圏外のあいだは、そのことを上に1行出します（js/online.js）。
  const netBar = $("#net-status");
  if (netBar) watchConnection(netBar);
  // 圏外の帯が出たことも数えます。圏外のあいだは送れないので、
  // js/metrics.js が貯めておいて、つながったときに送ります。
  if (isOffline()) count("offline_seen");
  addEventListener("offline", () => count("offline_seen"));
  renderRecent();

  fillPlaces();
  setDefaultDates();
  wireForm();
  wireKeyPanel();
  wireChrome();
  updateWindowHelp();

  // 収録は 29,706件・4.8MB（gzip で約1MB）あります。
  // **要るぶんだけ読みます。**
  //
  // これまでは起動時に全部読んでいました。ところが「島根の旅程」に
  // 使うのは島根のぶんだけで、残り46県は読んで、照合して、捨てて
  // いました。行き先の絞り込みは、地名から**エリアの一覧**だけで
  // 決まります（js/pipeline.js の scope）。エリアの一覧は
  // regions.json（gzip で 66KB）にあり、スポットはそのあとで足ります。
  //
  // ここで取るのは索引とエリアだけです。県ごとの段は、旅程を組む
  // ときに、その希望に要るものだけを取ります（kb.js の ensureRegions。
  // 地名が書かれていない希望では、絞る材料が無いので全部です）。
  const fab = $("#make-plan");
  fab.querySelector(".fab-tx").textContent = "旅程をつくる";

  state.kbPromise = (async () => {
    const pre = await loadRegionIndex();
    // 段ごとに読める索引があるときだけ、遅れて読みます。
    // 無いとき（同梱データ、古い索引）は、これまでどおりまとめて読みます。
    return stagedKb(pre) ?? await loadKnowledgeBase(undefined, undefined, pre);
  })();

  // 旅行中モードのまま閉じていたら、開いた瞬間から旅行中の画面にします
  // （js/tripmode.js）。収録の読み込みは待ちません。旅程は覚えてあります。
  const kept = loadTripMode();
  if (kept?.trip) {
    kept.itin.restored = true;
    state.trip = kept.trip;
    state.tripMode = true;
    $("#placeholder").hidden = true;
    show(kept.itin, kept.trip);
  }

  try {
    state.kb = await state.kbPromise;
    if (state.kb.loadError) setBadge(state.kb.loadError, true);
    const restored = restoreConditions();
    if (restored === "url") {
      $("#ph-data").textContent = "共有されたリンクの条件を読み込みました。";
    }
    // 使う人には件数を、開発者には出どころを。
    const c0 = state.kb.manifest.counts;
    $("#key-kb").textContent =
      `全国${c0.regions}エリア・${c0.spots}スポット`;
    const devKb = $("#dev-kb");
    if (devKb) {
      devKb.textContent = KB_INDEX_URL
        ? `公開知識ベース（${KB_INDEX_URL}）` : "同梱データ（KB_INDEX_URL 未設定）";
    }
    // 収録件数やキーの有無は、旅行者が読んでも何もできない話です。
    // 出典は画面の下の「著作権表記」のページにまとめています（credits.html）。
    $("#ph-data").textContent = "";
  } catch (e) {
    setBadge(`データを読み込めません: ${e.message}`, true);
    $("#ph-data").textContent =
      "知識ベースを読み込めませんでした。web/ をサーバ経由で開いているか、"
      + "kb/ フォルダが同じ場所にあるかをご確認ください。";
  }
  // 旅程のリンク（#t=…）から来たときは、その旅程をそのまま開きます。
  // 収録が読めなくても開けます（旅程の中に、要るものは入っています）。
  await openSharedTrip();
}

/**
 * 送られてきた旅程のリンクを開きます（js/snapshot.js）。
 *
 * **組み直しません。** 送った人が見ていたのと同じ時刻・同じ場所を
 * 出すのが、このリンクの役目です。開いた旅程は、受け取った人の
 * 「前につくった旅」にも残ります（当日、圏外でも開けるように）。
 */
async function openSharedTrip() {
  const code = tripCodeFrom(location.hash);
  if (!code) return;
  // 開いたら、アドレス欄からは外します。残すと、条件を変えて組み直した
  // あとに再読み込みしたとき、送られてきた旅程に戻ってしまいます。
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch { /* 外せなくても、開くのには困りません */ }
  const out = await unpackTrip(code);
  if (!out.ok) { showError(out.error); return; }
  const t = out.trip;
  if (t.state) applyFormState(t.state);
  const itin = thawItinerary(t.itin);
  const trip = thawItinerary(t.trip ?? null) ?? state.trip;
  if (!trip?.departAt) { showError("旅程のリンクを読めませんでした（出発の日時がありません）。"); return; }
  itin.savedAt = t.savedAt;
  itin.sharedLink = true;
  state.trip = trip;
  showView("result");
  $("#placeholder").hidden = true;
  show(itin, trip);
  setBadge("送られてきた旅程を開きました");
  setTimeout(() => setBadge(kbBadgeText()), 3600);
}

/**
 * 電波の無いところでも、作った旅程を開けるようにします。
 *
 * 旅程がいちばん要るのは、家で作っているときではなく **現地** です。
 * 山の中でも地下でも、少なくとも画面と収録データは出てほしい。
 *
 * 失敗しても黙って進みます。Service Worker が使えないのは
 * http:// で開いた場合などで、そのときも旅程は普通に作れます。
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  // 起動を待たせません。読み込みが終わってから登録します。
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* 使えない環境では、ただ手前の機能が無いだけです */
    });
  });
}

// --- 前につくった旅 ---------------------------------------------------------

/**
 * 一覧を描きます。
 *
 * 押されたら、**保存したその旅程を、そのまま開きます**。組み直しません。
 * 同じ条件でも、組み直せば別の旅程になります（AIの選び方も、調べた便も
 * そのときのものです）。気に入って保存したのに知らない場所が並ぶのでは、
 * 保存とは言えません。作り直したいときのために、条件も一緒に残して
 * あります（旅程の上の「いまの条件で作り直す」）。
 */
function renderRecent() {
  const box = $("#recent");
  const list = $("#recent-list");
  if (!box || !list) return;

  const items = loadHistory();
  box.hidden = items.length === 0;
  list.replaceChildren();

  for (const item of items) {
    const row = el("button", {
      type: "button", class: "recent-row",
      title: item.itin ? "保存した旅程を開く" : "この条件でもう一度つくる",
      onclick: () => openHistory(item),
    },
      el("span", { class: "r-body" },
        el("span", { class: "r-title" }, item.title),
        el("span", { class: "r-sub" }, item.subtitle || item.when || "")),
      el("span", { class: "r-when" }, savedLabel(item.savedAt)));

    const del = el("button", {
      type: "button", class: "recent-del",
      "aria-label": `${item.title} を一覧から消す`,
      onclick: () => { removeHistory(item.id); renderRecent(); },
    }, icon("close"));

    list.append(el("li", { class: "recent-item" }, row, del));
  }
}

/**
 * 一覧の1件を押したとき。
 *
 * 旅程が入っていれば、それを開きます。入っていない（古い保存や、
 * 端末の空きが足りなくて条件だけ残ったもの）ときだけ組み直します。
 */
function openHistory(item) {
  if (!item.itin) { replayHistory(item); return; }
  applyFormState(item.state);
  saveConditions();
  const itin = thawItinerary(item.itin);
  const trip = thawItinerary(item.trip ?? null) ?? state.trip;
  itin.savedAt = item.savedAt;
  itin.onRebuild = () => replayHistory(item);
  state.trip = trip ?? state.trip;
  show(itin, trip ?? state.trip);
}

/** 条件を入力欄に戻して、そのまま組み直します。 */
function replayHistory(item) {
  applyFormState(item.state);
  // 日付だけは、そのままだと過去になっていることがあります。
  // 過ぎた日で組むと「出発時刻が過去です」で止まるので、
  // そのときは同じ長さのまま、次の同じ曜日へずらします。
  shiftPastDates();
  saveConditions();
  run();
}

/**
 * 出発日が過去なら、日数と時刻を保ったまま先の日へずらします。
 * 曜日を合わせるのは、休館日と混雑が曜日で決まるためです。
 */
function shiftPastDates() {
  const dep = $("#depart-at"), arr = $("#arrive-by");
  const d0 = new Date(dep.value), d1 = new Date(arr.value);
  if (!Number.isFinite(d0.getTime()) || d0 > new Date()) return;
  const weeks = Math.ceil((Date.now() - d0.getTime()) / (7 * 86400000));
  const shift = weeks * 7 * 86400000;
  dep.value = localInput(new Date(d0.getTime() + shift));
  if (Number.isFinite(d1.getTime())) {
    arr.value = localInput(new Date(d1.getTime() + shift));
  }
  updateWindowHelp();
}

/**
 * 出発日を「今日」「明日」「今週末」に飛ばします。
 *
 * 時刻はいま入っているものを保ちます（9:00 発なら 9:00 発のまま）。
 * 帰着は、出発からの日数を保って一緒に動かします。1泊2日で組んで
 * いた人が「明日」を押して日帰りになる、ということが無いように。
 *
 * @param {"today"|"tomorrow"|"saturday"|"sunday"} preset
 * @param {Date} [now]
 */
function applyDayPreset(preset, now = new Date()) {
  const dep = $("#depart-at"), arr = $("#arrive-by");
  const d0 = new Date(dep.value), d1 = new Date(arr.value);
  const target = new Date(now); target.setHours(0, 0, 0, 0);
  if (preset === "tomorrow") target.setDate(target.getDate() + 1);
  if (preset === "saturday" || preset === "sunday") {
    const want = preset === "saturday" ? 6 : 0;
    // 「今週末」は、いちばん近い土曜・日曜です。今日が土曜なら今日。
    const ahead = (want - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + ahead);
  }
  const h0 = Number.isFinite(d0.getTime()) ? [d0.getHours(), d0.getMinutes()] : [9, 0];
  const nextDep = new Date(target); nextDep.setHours(h0[0], h0[1], 0, 0);
  dep.value = localInput(nextDep);
  if (Number.isFinite(d0.getTime()) && Number.isFinite(d1.getTime())) {
    const start0 = new Date(d0); start0.setHours(0, 0, 0, 0);
    const start1 = new Date(d1); start1.setHours(0, 0, 0, 0);
    const spanDays = Math.max(0, Math.round((start1 - start0) / 86400000));
    const nextArr = new Date(target); nextArr.setDate(nextArr.getDate() + spanDays);
    nextArr.setHours(d1.getHours(), d1.getMinutes(), 0, 0);
    arr.value = localInput(nextArr);
  } else {
    const nextArr = new Date(target); nextArr.setHours(19, 0, 0, 0);
    arr.value = localInput(nextArr);
  }
  updateWindowHelp();
  saveConditions();
}

/** <input type="datetime-local"> が読める形。UTC にはしません。 */
function localInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** つくれた旅程を、一覧に1件足します。 */
function rememberTrip(itin, trip) {
  const days = itin.days?.length ?? 0;
  const d = trip.departAt;
  addHistory({
    title: itin.title ?? itin.regionName ?? "旅程",
    subtitle: [itin.prefecture, `${itin.spotCount ?? 0}か所`]
      .filter(Boolean).join("・"),
    when: `${d.getMonth() + 1}/${d.getDate()}から${days}日`,
    state: formState(),
    // できあがった旅程そのものも残します。開き直したときに、同じものが
    // 出るようにするためです。
    itin,
    trip,
  });
  renderRecent();
}

function setBadge(text, isError = false) {
  // 以前ここは #kb-status を前提にしていましたが、その要素は
  // 画面から無くなっています。読み込みに失敗したときだけ呼ばれるので、
  // 気づかれないまま TypeError で起動が止まっていました。
  const b = $("#kb-status") ?? $("#ph-data");
  if (!b) return;
  b.textContent = text;
  b.classList.toggle("err", isError);
}

/**
 * 出発地・到着地の候補。
 *
 * 主要駅78件は最初から並べておき、打ち始めたら全国の停留所
 * （駅9,612件・バス停65,606件、kb/stops-*.json）から絞って足します。
 *
 * 7万件を datalist にまとめて入れることはできません。件数ぶんの
 * DOM を作るので、ブラウザが数秒固まります。打たれた文字で絞って
 * 20件だけ差し替えます（ファイルの形ではなく、件数が問題です）。
 */
/** はじめて開いたときの出発地。 */
const DEFAULT_FROM = "東京駅";

function fillPlaces() {
  const list = $("#place-list");
  for (const p of PLACES) {
    list.append(el("option", { value: p.name }, `${p.area}`));
  }
  $("#depart-place").value = DEFAULT_FROM;

  for (const id of ["#depart-place", "#end-place"]) {
    $(id)?.addEventListener("input", (e) => suggestPlaces(e.currentTarget.value));
    // 停留所のデータは2.7MBあり、最初の1回は読み込みに数秒かかります。
    // 打ち始めてから取りにいくと、その数秒ぶん候補が出ません。
    // 欄に触れた時点で先に取り始めます（触れなければ取りません）。
    $(id)?.addEventListener("focus", preloadStops, { once: true });
  }
}

/** いま打たれている文字に合う停留所を、候補欄に差し込みます。 */
let suggestSeq = 0;
async function suggestPlaces(text) {
  const q = String(text ?? "").trim();
  const list = $("#place-list");
  if (!list) return;
  const seq = ++suggestSeq;
  // 1文字だと候補が多すぎて選べません。主要駅だけ出しておきます。
  const found = q.length >= 2 ? await searchStops(q, 20) : [];
  if (seq !== suggestSeq) return;   // もっと新しい入力が来ていたら捨てます

  list.textContent = "";
  const seen = new Set();
  for (const p of PLACES) {
    if (q && !p.name.includes(q)) continue;
    seen.add(p.name);
    list.append(el("option", { value: p.name }, p.area));
  }
  for (const s of found) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    list.append(el("option", { value: s.name },
      s.kind === "rail" ? "駅" : "バス停"));
  }
}

function setDefaultDates() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const dep = new Date(t); dep.setHours(9, 0, 0, 0);
  const ret = new Date(t); ret.setHours(19, 0, 0, 0);
  $("#depart-at").value = iso(dep);
  $("#arrive-by").value = iso(ret);
}

function wireKeyPanel() {
  const mark = (elm, ok, text) => {
    if (!elm) return;
    elm.textContent = text;
    elm.classList.toggle("ok", ok);
    elm.classList.toggle("ng", !ok);
  };

  // 使う人に向けては、「できるかどうか」だけを言います。
  //
  // 「Gemini」「Routes API」は、こちらの都合の名前です。使う人が
  // 知りたいのは「AIが効いているのか」だけです。
  // プロキシを使っているなら、キーはサーバー側にあります。
  // ブラウザ側が空なのは正常なので、「未設定」とは言いません。
  const refresh = () => {
    const cfg = effectiveConfig();
    const viaProxy = Boolean(cfg.proxyUrl);
    const aiOn = hasApiKey();
    const routesOn = viaProxy || Boolean(cfg.mapsKey);
    mark($("#key-gemini"), aiOn,
         aiOn ? "利用できます" : "使わない設定です（収録データから提案します）");
    mark($("#key-maps"), routesOn,
         routesOn ? "利用できます" : "使わない設定です（距離から推定します）");

    // 開発者向けには、どこから来た設定なのかまで出します。
    // 末尾4文字だけ見せます。「入れたはずのキーが効いているか」を
    // 確かめるのに、それ以上は要りません。
    const where = { settings: "この端末の設定", config: "config.js", none: "" };
    const dev = (id, key, from) => {
      const elm = $(id);
      if (!elm) return;
      if (viaProxy) mark(elm, true, `プロキシ経由（${where[cfg.from.proxyUrl]}）`);
      else if (key) mark(elm, true, `設定済み（${where[from]}・…${key.slice(-4)}）`);
      else mark(elm, false, "未設定");
    };
    dev("#dev-gemini", cfg.geminiKey, cfg.from.geminiKey);
    dev("#dev-maps", cfg.mapsKey, cfg.from.mapsKey);

    // ブラウザで入れたプロキシは、index.html の CSP に無ければ繋がりません。
    // 保存はできても動かない、を黙って通さないための注意書きです。
    const ph = $("#proxy-help");
    if (ph && cfg.proxyUrl && !cspAllows(cfg.proxyUrl)) {
      ph.replaceChildren(
        el("b", {}, "この入口は index.html の connect-src に含まれていないため、ブラウザが接続を拒みます。"),
        " index.html の ",
        el("code", {}, "connect-src"),
        " に ",
        new URL(cfg.proxyUrl).origin,
        " を足してください。"
      );
      ph.classList.add("ng");
    }
  };

  // 保存してあるものを欄に戻します（config.js の値は欄に出しません。
  // 消すべき対象ではないからです）。
  const fill = () => {
    const saved = loadSettings();
    const g = $("#in-gemini"), m = $("#in-maps"), px = $("#in-proxy");
    if (g) g.value = saved.geminiKey;
    if (m) m.value = saved.mapsKey;
    if (px) px.value = saved.proxyUrl;
  };

  const note = (text, ok) => {
    const n = $("#keys-note");
    if (!n) return;
    n.hidden = !text;
    n.textContent = text;
    n.classList.toggle("ok", Boolean(ok));
    n.classList.toggle("ng", !ok);
  };

  $("#save-keys")?.addEventListener("click", () => {
    const r = saveSettings({
      geminiKey: $("#in-gemini")?.value,
      mapsKey: $("#in-maps")?.value,
      proxyUrl: $("#in-proxy")?.value,
    });
    if (!r.ok) { note(r.errors.join("／"), false); return; }
    // 前の設定で失敗して止まっていた経路検索を、動かせる状態に戻します。
    resetRoutesBreaker();
    clearRouteCache();
    fill();
    refresh();
    const any = r.value.geminiKey || r.value.mapsKey || r.value.proxyUrl;
    note(any ? "保存しました。すぐに効きます（再読み込みは要りません）。"
             : "消しました。config.js の値に戻ります。", true);
  });
  $("#clear-keys")?.addEventListener("click", () => {
    clearSettings();
    resetRoutesBreaker();
    clearRouteCache();
    fill();
    refresh();
    note("この端末に保存していたキーを消しました。", true);
  });
  $("#show-keys")?.addEventListener("change", (e) => {
    const type = e.currentTarget.checked ? "text" : "password";
    for (const id of ["#in-gemini", "#in-maps"]) {
      const elm = $(id);
      if (elm) elm.type = type;
    }
  });

  const runInto = async (sel, btn, fn) => {
    const out = $(sel);
    btn.disabled = true;
    out.hidden = false;
    out.textContent = "確認しています…";
    out.classList.remove("ok", "ng");
    try {
      const r = await fn();
      out.textContent = r.message;
      out.classList.toggle("ok", r.ok);
      out.classList.toggle("ng", !r.ok);
    } catch (e) {
      out.textContent = String(e?.message ?? e);
      out.classList.add("ng");
    } finally {
      btn.disabled = false;
    }
  };
  const run = (btn, fn) => runInto("#key-result", btn, fn);
  $("#test-gemini").addEventListener("click", (e) =>
    run(e.currentTarget, () => diagnoseGeminiKey()));
  // 経路の確認は、電車・バス（Yahoo!路線情報）と徒歩・車（Google）の
  // 2つを見ます。使う先が分かれているので、片方だけ通っていることが
  // あります。
  const routeChecks = async () => {
    const [maps, yahoo] = await Promise.all([
      diagnoseMapsKey(), diagnoseYahooTransit(),
    ]);
    return {
      ok: maps.ok && yahoo.ok,
      message: `【電車・バス】${yahoo.message}\n\n【徒歩・車】${maps.message}`,
    };
  };
  $("#test-maps").addEventListener("click", (e) => run(e.currentTarget, routeChecks));
  // 開発者向けの欄を閉じていても押せる、まとめての確認。
  //
  // 経路の2つに、**行き先を選ぶAI（Gemma）**を加えた3点セットです。
  // AIが通らなくても旅程は作れます（収録データから機械的に選ぶ形に
  // 落ちます）。それでも、ここで見えるようにしておかないと
  // 「AIの意見を聞いていない気がする」ことに利用者が気づけません。
  const allChecks = async () => {
    const [maps, yahoo, ai, budget] = await Promise.all([
      diagnoseMapsKey(), diagnoseYahooTransit(), diagnoseGeminiKey(),
      proxyBudget(),
    ]);
    return {
      ok: maps.ok && yahoo.ok && ai.ok,
      message: `【行き先を選ぶAI】${ai.message}\n\n`
        + `【電車・バス】${yahoo.message}\n\n【徒歩・車】${maps.message}`
        + (budget ? `\n\n【中継の余力】${budget}` : ""),
    };
  };
  $("#test-conn").addEventListener("click", (e) =>
    runInto("#conn-result", e.currentTarget, allChecks));

  $("#reset-quota").addEventListener("click", () => {
    quota.reset();
    showQuota();
  });
  // チェックは「協力しない」です。入れたときだけ数えるのをやめます。
  const optOut = $("#optout-metrics");
  if (optOut) {
    optOut.checked = !metricsEnabled();
    optOut.addEventListener("change", () => setMetricsEnabled(!optOut.checked));
  }
  fill();
  refresh();
  showQuota();
}

/**
 * 中継の余力。
 *
 * 無料枠は、使い切ると**その日は誰も使えません**（追加課金ではなく、
 * その種類の処理が失敗します）。止まってから気づくのでは遅いので、
 * 押せば見えるようにしておきます。
 *
 * ここで見えるのは、この端末（IP）ぶんの点数です。Cloudflare の1日の
 * 合計（10万リクエスト／Workers AI 1万ニューロン）は、中継の外からは
 * 数えられないので、ダッシュボードで見る旨を添えます。
 */
async function proxyBudget() {
  try {
    const st = await proxyStatus(effectiveConfig());
    // 中継が古いと、点数が1枚よけいに包まれて届きます（usage.usage）。
    // 中継を入れ替えるまでのあいだ「undefined点」と出さないよう、
    // どちらの形でも読めるようにしておきます。
    const u = st?.usage?.usage ?? st?.usage;
    if (!Number.isFinite(u?.minute)) return "";
    // 枠は2つです。見出しは、使い切ると止まる側（お金のかかる処理）。
    // 電車・バスは費用がかからないので、大きく取ってあります。
    const paid = u.paid ?? u;
    const free = u.free;
    return `AI・経路API: 1分 ${paid.minute}/${paid.minuteLimit}点`
      + `・1時間 ${paid.hour}/${paid.hourLimit}点`
      + (free
        ? `\n電車・バス（Yahoo!路線情報）: 1分 ${free.minute}/${free.minuteLimit}`
          + `・1時間 ${free.hour}/${free.hourLimit}`
        : "")
      + "\n※ 電車・バスはこちらに費用がかからないので、別枠で大きく"
      + "取ってあります。旅程1本で30区間ほど調べても届きません。"
      + "\n1日の合計は Cloudflare のダッシュボードでご確認ください"
      + "（無料枠は10万リクエスト／日）。";
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- APIの使用量 ------------------------------------------------------------
// 50件ごとに手を止めて確認します。「気づいたら請求が膨らんでいた」を
// 起こさないための仕組みなので、確認は必ず画面の中央で行い、
// 返事をもらうまで先へ進みません。

function showQuota() {
  const box = $("#key-quota");
  if (!box) return;
  // 一覧の行に長い文を入れると、左の項目名と重なります。
  // ここは件数だけ。詳しい内訳は、確認ダイアログのほうで出します。
  box.textContent = quota.blocked
    ? `${quota.used}件で停止中`
    : `${quota.used}件（あと${quota.remaining}件で確認）`;
  box.title = describeUsage(quota);
  box.classList.toggle("ng", quota.blocked);
  box.classList.remove("ok");
}

/** 確認ダイアログ。押されたボタンだけが返事になります。 */
function askQuota({ used, byKind, next }) {
  const dlg = $("#quota-dialog");
  // 内訳も、旅行者に意味の通る言葉にします。
  // 「embed 12件」と書かれても、何のことか分かりません。
  const label = { routes: "乗換・所要時間の確認", gemini: "行き先の調査",
                  embed: "希望の読み取り" };
  const parts = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${label[k] ?? k} ${n}回`);
  $("#quota-detail").textContent =
    `ここまでに ${used}回 調べました`
    + (parts.length ? `（内訳: ${parts.join("・")}）` : "")
    + "。";
  $("#quota-go").querySelector("span").textContent = "詳しく調べる";
  // できないことを「します」と書かない。
  //
  // 「収録に無い場所をAIが探します」と出していましたが、AIを中継の中で
  // 動かしている（Workers AI）ときは検索ができません。収録済みの中から
  // 選ぶだけです。押す前に分かるようにします。
  const note = $("#quota-note");
  if (note) {
    note.textContent = canGround()
      ? "ここから先は、実際の乗換時間を調べたり、収録に無い場所をAIが"
        + "探したりします。ここまでにしても旅程は作れます"
        + "（移動時間は距離からの目安、行き先は収録済みの中から選びます）。"
      : "ここから先は、実際の乗換時間を調べ、AIが希望に合う行き先を"
        + "選びます。収録に無い場所をインターネットで探すことはしません"
        + "（いまの設定では、AIに検索の機能がありません）。"
        + "ここまでにしても旅程は作れます（移動時間は距離からの目安です）。";
  }

  return new Promise((resolve) => {
    const done = (ok) => {
      $("#quota-go").removeEventListener("click", yes);
      $("#quota-stop").removeEventListener("click", no);
      dlg.close();
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $("#quota-go").addEventListener("click", yes);
    $("#quota-stop").addEventListener("click", no);
    // Esc で閉じられると、続けたいのか止めたいのかが分かりません
    dlg.addEventListener("cancel", (e) => e.preventDefault());
    dlg.showModal();
  });
}


// --- 画面まわりの部品 -------------------------------------------------------

/**
 * 背景の地図。入力しているあいだも、地図はそこにあります。
 *
 * 真っ白な入力画面より、「これから出かける」という気配が残ります。
 * 触れませんし、ピンも線も出しません。読むものではないからです。
 * オフラインでもキャッシュ済みのタイルがぼやけて残ります。
 */
function startBackgroundMap() {
  const box = $("#bg-map");
  if (!box || !window.L) return;
  try {
    const map = window.L.map(box, {
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false,
      // 背景なので、読み上げにも操作にも載せません
      inertia: false,
    }).setView([35.68, 139.76], 9);
    window.L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(map);
    state.bgMap = map;
  } catch {
    // 地図が出せなくても、入力画面は成立します
  }
}

/**
 * まだ旅程が無いときに出す地図。いまいるあたりを映します。
 *
 * 「行き先が決まっていなくても大丈夫です」と文字で言うより、
 * 地図が出ているほうが、これから出かける気配が伝わります。
 *
 * ページを開いた時点では、位置情報を要求しません。
 * 何も操作していない相手にいきなり「現在地を使用しますか？」を出すのは、
 * 何のために聞かれているのか分からないぶん、断られて当然です。
 * 「現在地から探す」を押されたときだけ取りにいきます（locateHere）。
 */
/**
 * 地図の部品が届くのを待ちます。
 *
 * 読み込みは async にしてあります（ページ全体を止めないため）。
 * そのぶん、app.js が動き出した時点では、まだ届いていないことがあります。
 * 待つのはここだけです。条件の入力も旅程づくりも、地図を待ちません。
 *
 * @param {number} timeoutMs これを過ぎたら、地図なしで進みます
 */
function whenLeaflet(timeoutMs = 8000) {
  if (window.L) return Promise.resolve(true);
  return new Promise((resolve) => {
    const limit = Date.now() + timeoutMs;
    const tick = () => {
      if (window.L) return resolve(true);
      if (Date.now() > limit) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// エリアを地図で探す（js/areamap.js）。開いたときに初めて読みます。
// 開かない人には、地図の画面の部品を読ませません。
let areaMap = null;
let areaModule = null;
let areaPicked = "";

function wireAreaMap() {
  const btn = $("#open-area-map");
  const dlg = $("#area-dialog");
  if (!btn || !dlg?.showModal) {
    if (btn) btn.hidden = true;
    return;
  }
  $("#area-close")?.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  btn.addEventListener("click", async () => {
    try {
      if (!areaMap) {
        const [mod, kb] = await Promise.all([
          import("./areamap.js"), state.kbPromise]);
        areaModule = mod;
        areaMap = mod.setupAreaMap(dlg, {
          regions: kb?.regions ?? [], tileUrl: TILE_URL,
          attribution: TILE_ATTRIBUTION, onPick: pickArea,
        });
        // Leaflet は async で読んでいます。まだ届いていなければ少し待ちます
        // （届かなければ、一覧だけで選べます）。
        await whenLeaflet(3000);
      }
      areaMap.open();
    } catch (e) {
      setBadge(`エリアの地図を開けませんでした: ${e.message}`, true);
    }
  });
}

function pickArea(area) {
  const note = $("#note");
  note.value = areaModule.noteWithArea(note.value, area.name, areaPicked);
  areaPicked = area.name;
  // 札と同じく input を起こします（欄が伸び、条件も保存されます）。
  note.dispatchEvent(new Event("input", { bubbles: true }));
  const said = $("#area-picked");
  if (said) said.textContent = `「${area.name}」を入れました。続けて書き足せます。`;
  note.focus();
  note.setSelectionRange(note.value.length, note.value.length);
}

/**
 * 最初の地図で必ず収める枠（南西, 北東）。北九州から道東まで。
 *
 * 九州の南端と北海道の北端まで含めると、広い画面でも縮尺が1段
 * 引かれて大陸が半分を占めます。縮尺を小数にすると（zoomSnap）
 * タイルの継ぎ目に白い線が出るので、整数のまま、この枠で1段寄せます。
 * 中心はこの枠の中心なので、寄せたときも端が少し切れるだけです。
 */
const JAPAN_HOME_VIEW = [[33, 130.5], [43.5, 145]];

let homeMapStarted = false;

async function startHomeMap() {
  const box = document.getElementById("home-map");
  if (!box) return;
  if (homeMapStarted) return;   // 2度作らない
  homeMapStarted = true;
  await whenLeaflet();
  if (!window.L) {
    // 地図を読み込めない環境で、灰色の四角を黙って出さないこと。
    // 旅程づくりは地図が無くても成立します。
    box.classList.add("map-fallback");
    box.textContent = "地図を読み込めませんでした"
      + "（インターネット接続をご確認ください）。"
      + "旅程はこのままつくれます。";
    return;
  }
  try {
    // 最初に見せるのは日本列島です。中心と縮尺を決め打ちにしていた
    // ころは、広い画面だと大陸と朝鮮半島が半分を占め、外国語の地名が
    // 日本より目立っていました。本州を囲む枠に合わせ、画面の大きさに
    // 応じた縮尺を Leaflet に選ばせます。
    const map = window.L.map(box, {
      zoomControl: true, scrollWheelZoom: false,
      attributionControl: true,
    }).fitBounds(JAPAN_HOME_VIEW);
    window.L.tileLayer(TILE_URL,
      { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    state.homeMap = map;
  } catch {
    return;   // 地図が出せなくても、入力はできます
  }

}

/**
 * 「現在地から探す」を押されたときだけ、位置情報を取りにいきます。
 *
 * 取れたら、いちばん近い出発地の候補を入れます。緯度経度をそのまま
 * 出発地にはしません。経路検索は駅を起点にするほうが実態に合いますし、
 * 利用者から見ても「新宿駅から」のほうが確かめようがあります。
 *
 * 位置を送る先はありません。この関数の中だけで使います。
 */
function locateHere() {
  const btn = document.getElementById("use-here");
  // 知らせる場所は、押したボタンのすぐ下です。
  // 以前は初期画面の地図の下に出していたので、旅程を作ったあとは
  // 画面から消えていて、押しても何も起きないように見えていました。
  const note = document.getElementById("here-note");
  const say = (text, warn = false) => {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("warn", warn);
  };
  const reset = () => {
    if (!btn) return;
    btn.disabled = false;
    btn.querySelector("span:last-child").textContent = "現在地から探す";
  };

  if (!navigator.geolocation) {
    say("この環境では現在地を取得できません。出発地は駅名で入力してください。", true);
    return;
  }
  // https でないページでは、ブラウザが**聞かずに断ります**。
  // 利用者は何も押していないのに「許可されていません」と出るので、
  // 自分が拒否したのだと思ってしまいます。理由が違うので、先に分けます。
  if (!window.isSecureContext) {
    say("このページは暗号化されていない接続（http）で開かれているため、"
      + "ブラウザが現在地の利用を許しません。https で開くか、"
      + "出発地を駅名で入力してください。", true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.querySelector("span:last-child").textContent = "探しています…";
  }
  say("現在地を確かめています…");

  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const found = nearestPlaceInfo(lat, lng);
    const near = found?.place ?? null;
    if (near) {
      $("#depart-place").value = near.name;
      saveConditions();
      // 「東京駅に19:00までに戻る」の文も書き換えます。
      // これを呼んでいなかったので、出発地を入れ替えても画面の文が
      // 前のままでした。**押しても反映されない**、に見えます。
      updateWindowHelp();
    }
    try {
      state.homeMap?.setView([lat, lng], 11, { animate: true });
      window.L?.circleMarker([lat, lng], {
        radius: 8, color: "#007AFF", fillColor: "#007AFF", fillOpacity: .85,
        weight: 3, opacity: .35,
      }).addTo(state.homeMap);
      moveBackgroundMap(lat, lng, 10);
    } catch { /* 地図の演出です。失敗しても続けます */ }
    reset();
    // どれくらい近いのかで、言うべきことが変わります。
    // 100km 先の駅を「いちばん近い駅」とだけ書いて入れると、
    // 現在地を取ったのに、まったく違う土地から旅程が組まれます。
    const FAR_KM = 30;
    if (!near) {
      say("現在地は分かりましたが、近くに収録している駅がありませんでした。"
        + "出発地は駅名で入力してください。", true);
    } else if (found.km > FAR_KM) {
      say(`いちばん近い収録の駅は「${near.name}」で、現在地から約${found.km}km`
        + "あります。ここを出発地にしましたが、"
        + "もっと近い駅があれば直接入力してください。", true);
    } else {
      say(`出発地を「${near.name}」にしました`
        + `（現在地から約${Math.max(1, found.km)}km、いちばん近い駅）。`);
    }
  }, (err) => {
    reset();
    // 何が起きたかで、次にすることが変わります。
    //
    //   1 PERMISSION_DENIED    … 断られた（本人が断ったとは限りません）
    //   2 POSITION_UNAVAILABLE … 測れなかった（屋内・機内モードなど）
    //   3 TIMEOUT              … 時間切れ
    //
    // 1 を「あなたが断りました」と書くのは誤りです。組織の設定や
    // 拡張機能、端末側の設定でも 1 になります。**押していないのに
    // 「許可されていません」と出る**のはこれでした。
    const msg = {
      1: "このブラウザでは現在地を使えませんでした"
        + "（設定・拡張機能・端末側で止められていることがあります）。"
        + "出発地は駅名で入力してください。",
      2: "現在地を測れませんでした（屋内や電波の届かない場所で起きます）。"
        + "出発地は駅名で入力してください。",
      3: "現在地の取得に時間がかかりすぎました。"
        + "もう一度押すか、出発地を駅名で入力してください。",
    }[err?.code] ?? "現在地を取得できませんでした。"
      + "出発地は駅名で入力してください。";
    say(msg, true);
  }, { timeout: 8000, maximumAge: 600000 });
}

/** 背景の地図を、いま見ている場所へ寄せます。 */
function moveBackgroundMap(lat, lng, zoom = 10) {
  if (!state.bgMap || !Number.isFinite(lat)) return;
  try { state.bgMap.setView([lat, lng], zoom, { animate: true }); }
  catch { /* 背景の演出なので、失敗しても黙って続けます */ }
}

// --- 雰囲気チップ -----------------------------------------------------------
// 旅のきっかけは、記述欄の下の札にまとめました。
//
// ここには以前、色の面のカード（温泉・歴史・自然…）を6枚、別に並べて
// いました。同じ「書く言葉のきっかけ」が2か所に分かれていて、画面の
// 1枚目がカードで埋まっていました。**同じ役目のものは1か所にまとめます。**
// 札（index.html の data-example）に寄せたので、ここは要りません。

// --- 穴場の度合いを、星の粒で見せる -----------------------------------------
// 「40%」と書かれても、それがどれくらいかは伝わりません。
// 粒が増えるのが見えれば、動かしながら決められます。

function renderMix(value) {
  // 10か所のうち何か所が定番で、何か所が穴場か。**帯の幅がその数**です。
  //
  // **実際に選ぶ関数から引きます。** ここで別の式を持つと、画面には
  // 「穴場10」と出ているのに定番のほうが多く返る、ということが起きます
  // （実際そうなっていて、スライダーの向きが逆に見えていました）。
  const t = mixTargets(10, value / 100);

  for (const [id, n] of [["#mix-seg-major", t.major],
                         ["#mix-seg-known", t.known],
                         ["#mix-seg-hidden", t.hidden]]) {
    const seg = $(id);
    if (!seg) continue;
    seg.style.width = `${n * 10}%`;
    // 字が入らない幅では、書いても読めません。名前 → 数 → 何も、の順に
    // 落とします（数は下の文にも出ています）。
    seg.classList.toggle("is-empty", n === 0);
    seg.classList.toggle("is-narrow", n > 0 && n <= 1);
    seg.classList.toggle("is-tight", n >= 2 && n <= 3);
    const num = seg.querySelector("em");
    if (num) num.textContent = String(n);
  }

  const set = (id, text) => { const e = $(id); if (e) e.textContent = text; };
  set("#mix-classic-n", String(t.major));
  set("#mix-known-n", String(t.known));
  set("#mix-hidden-n", String(t.hidden));

  const help = $("#hidden-bias-help");
  if (help) {
    help.textContent = value <= 20 ? "誰でも知っている場所を中心に組みます"
      : value <= 45 ? "定番を軸に、穴場を少し混ぜます"
      : value <= 75 ? "定番と穴場を半分ずつ混ぜます"
      : "あまり知られていない場所を中心に組みます";
  }
}

/**
 * 1日のうち、観光にあてる時間帯。
 *
 * 長さではなく時刻で聞きます。旅程を組む側は端から時刻で考えるので、
 * 聞いた時刻をそのまま枠として使えます。
 */
function renderDayWindow() {
  const start = parseHourField($("#day-start")?.value);
  const end = parseHourField($("#day-end")?.value);
  const help = $("#day-hours-help");
  if (!help) return;
  if (start === null || end === null) { help.textContent = ""; return; }
  const hours = end - start;
  if (hours <= 0) {
    help.textContent = "終わりの時刻は、始めの時刻より後にしてください。";
    help.classList.add("warn");
    return;
  }
  help.classList.remove("warn");
  const len = Number.isInteger(hours) ? `${hours}時間`
    : `${Math.floor(hours)}時間30分`;
  const mood = hours <= 6 ? "朝はゆっくり、夕方には宿へ戻ります"
    : hours <= 9 ? "ふつうに歩ける長さです"
      : hours <= 12 ? "朝から夜まで、しっかり動きます"
        : "かなり長い一日です。連日だと疲れが残ります";
  help.textContent = `1日あたり${len}・${mood}`;
}

/**
 * 取り消せない操作の確認。
 *
 * window.confirm は使いません。文面を日本語で整えられず、この画面の
 * 作りからも浮きます（すでに <dialog> の作法があります）。**何が
 * どれだけ消えるのか**を数えて出せることのほうが大事です。
 *
 * 閉じかたは3通りあります（「やめる」・幕を押す・Esc）。どれでも
 * 「やめた」として扱います。取り消せない操作なので、迷ったときは
 * 何もしないほうが正しいからです。
 *
 * @param {{title:string, detail:string, yes:string}} opts
 * @returns {Promise<boolean>} 実行してよいか
 */
function confirmDanger({ title, detail, yes }) {
  const dlg = $("#confirm-dialog");
  if (!dlg?.showModal) {
    // <dialog> が使えない古い環境。黙って実行はしません。
    return Promise.resolve(globalThis.confirm?.(`${title}\n${detail}`) === true);
  }
  $("#confirm-title").textContent = title;
  $("#confirm-detail").textContent = detail;
  const yesBtn = $("#confirm-yes");
  yesBtn.querySelector("span").textContent = yes;

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      yesBtn.removeEventListener("click", onYes);
      $("#confirm-no").removeEventListener("click", onNo);
      dlg.removeEventListener("click", onScrim);
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    // 幕（ダイアログの外側）を押したときも、やめたことにします。
    const onScrim = (e) => { if (e.target === dlg) finish(false); };
    // Esc。ブラウザが勝手に閉じるので、ここで受け取ります。
    const onClose = () => finish(false);
    yesBtn.addEventListener("click", onYes);
    $("#confirm-no").addEventListener("click", onNo);
    dlg.addEventListener("click", onScrim);
    dlg.addEventListener("close", onClose);
    dlg.showModal();
    // 指が最初に触れるのは「やめる」です。取り消せない操作の上に
    // 指を置いた状態で開くのは、危ない作りです。
    $("#confirm-no").focus();
  });
}

// --- 画面の共通部品 ---------------------------------------------------------

function wireChrome() {
  // 前につくった旅を、まとめて消す。
  // 端末に残るものなので、消す手段は必ず画面から届くところに置きます。
  //
  // **押した瞬間に消していました。** 履歴は端末にしか無いので、
  // 消したら戻せません（サーバーにも控えはありません）。取り消せない
  // 操作には、色と確認の両方が要ります（ガイドライン: destructive）。
  $("#recent-clear")?.addEventListener("click", async () => {
    const n = loadHistory().length;
    if (!n) return;
    const ok = await confirmDanger({
      title: "つくった旅を、すべて消しますか",
      detail: `${n}件を消します。この端末にしか残っていないので、`
        + "消すと戻せません。",
      yes: "すべて消す",
    });
    if (!ok) return;
    clearHistory();
    renderRecent();
  });

  // つくった旅の控え。端末の保存は消えるものなので、外へ出す手を
  // 画面から届くところに置きます。
  $("#backup-export")?.addEventListener("click", exportBackup);
  $("#backup-import")?.addEventListener("click", () => {
    $("#backup-file")?.click();
  });
  $("#backup-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    // 同じファイルを続けて選べるように、値を空に戻します
    // （戻さないと、2度目の change が起きません）。
    e.target.value = "";
    await importTripFile(file);
  });

  // 設定。ふだんは見えなくてよいものを、ここにまとめます。
  // 配色に切り替えは置きません。端末の設定（ダークモード）に合わせます。
  const settings = $("#settings-dialog");
  $("#open-settings")?.addEventListener("click", () => {
    showQuota();
    showRoutesUsage();
    settings?.showModal();
  });
  $("#settings-close")?.addEventListener("click", () => settings?.close());
  settings?.addEventListener("click", (e) => {
    if (e.target === settings) settings.close();
  });

  // 地図を大きく見る。旅程は下に残したままにします
  // （地図だけになると「どこの話か」を見失うためです）
  $("#map-expand")?.addEventListener("click", () => {
    const box = $("#result");
    box.classList.toggle("map-full");
    setTimeout(() => state.map.invalidate(), 340);
  });

  const bias = $("#hidden-bias");
  if (bias) {
    renderMix(Number(bias.value));
    bias.addEventListener("input", () => renderMix(Number(bias.value)));
    bias.addEventListener("change", saveConditions);
  }

  renderDayWindow();
  for (const id of ["#day-start", "#day-end"]) {
    $(id)?.addEventListener("input", renderDayWindow);
    $(id)?.addEventListener("change", () => {
      saveConditions();
      updateWindowHelp();
    });
  }
}

function togglePin(spot) {
  if (state.pinned.has(spot.id)) state.pinned.delete(spot.id);
  else state.pinned.set(spot.id, spot);
  renderPinned();
}

/** 「必ず行く」に入れた場所を、旅程の条件側に出しておきます。 */
function renderPinned() {
  const box = $("#pinned");
  box.textContent = "";
  box.hidden = state.pinned.size === 0;
  if (!state.pinned.size) return;
  box.append(el("label", {}, "必ず行く場所（絶対条件）"));
  const list = el("div", { class: "pin-list" });
  // 出発地が収録の駅なら、そこからの目安を札の下に添えます（js/reach.js）。
  const from = findPlace($("#depart-place").value);
  for (const spot of state.pinned.values()) {
    const chip = el("span", { class: "pin-chip" }, `${spot.name}`);
    chip.append(el("button", {
      type: "button", title: "外す", "aria-label": `${spot.name}を外す`,
      onClick: () => { state.pinned.delete(spot.id); renderPinned(); },
    }, "×"));
    const reach = reachOf(from, spot);
    if (!reach) { list.append(chip); continue; }
    const item = el("span", { class: "pin-item" }, chip);
    item.append(el("small", { class: `pin-reach${reach.far ? " is-far" : ""}` },
      reach.text + (reach.far ? "。日帰りだと現地の時間がほとんど残りません" : "")));
    list.append(item);
  }
  box.append(list);
  box.append(el("p", { class: "help" },
    "ここに入れた場所は、時間が足りなくても旅程から削られません。"
    + "入れられなかった場合は理由を表示します。"));
}

/**
 * 開発者向けの欄を出すかどうか。
 *
 * APIキー・中継のURLは、公開版の利用者が触るものではありません
 * （キーは中継側にあります）。出しておくと、直す必要のない場所を
 * 疑わせます。`?debug=1` を付けたときだけ出します。
 * 一度付ければ、その端末では覚えます（毎回URLを打たずに済むように）。
 */
function wantsDevPanel() {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? "");
    if (q.get("debug") === "1") {
      globalThis.localStorage?.setItem("tabisaki.debug", "1");
      return true;
    }
    if (q.get("debug") === "0") {
      globalThis.localStorage?.removeItem("tabisaki.debug");
      return false;
    }
    return globalThis.localStorage?.getItem("tabisaki.debug") === "1";
  } catch {
    return false;
  }
}

function wireForm() {
  // 予算と移動手段。押されたものを覚えるだけの、同じ形の切り替えです。
  // 選ばれていることを、**読み上げにも出します。**
  //
  // これまで印は is-selected（見た目）だけでした。画面を見ない人には
  // 「おまかせ・電車・バス・車…」が並んでいるだけで、どれがいま選ばれて
  // いるのか分かりません。押した状態として aria-pressed を持たせます
  // （単一選択なので、押すたびに他を false に戻します）。
  const segmented = (sel, key, onPick) => {
    const all = () => document.querySelectorAll(`${sel} button`);
    for (const btn of all()) {
      // 最初の状態も書いておきます（見た目と読み上げを合わせます）。
      btn.setAttribute("aria-pressed",
                       String(btn.classList.contains("is-selected")));
      btn.addEventListener("click", () => {
        for (const b of all()) {
          const on = b === btn;
          b.classList.toggle("is-selected", on);
          b.setAttribute("aria-pressed", String(on));
        }
        onPick(btn.dataset[key]);
      });
    }
  };
  segmented("#budget-choice", "budget", (v) => {
    state.budgetYen = v ? Number(v) : null;
    // 予算を決めたときだけ、扱いを聞きます。決めていない人に
    // 「目安か厳守か」を聞いても、答えようがありません。
    const box = $("#budget-mode");
    if (box) box.hidden = !state.budgetYen;
    setBudgetHelp();
  });
  segmented("#budget-mode", "mode", (v) => {
    state.budgetMode = v === "strict" ? "strict" : "guide";
    setBudgetHelp();
  });
  segmented("#transport-choice", "transport", (v) => {
    state.transport = v ?? "any";
  });
  // 移動の考えかた。移動そのものを楽しみたい人（青春18きっぷなど）向け。
  segmented("#journey-choice", "journey", (v) => {
    state.enjoyTravel = v === "enjoy";
  });
  // 字の大きさ。押した瞬間に画面ぜんぶが変わります（rem で書いて
  // あるので、根の大きさを書き換えるだけで全部ついてきます）。
  const scaleNow = String(initTypeScale());
  for (const btn of document.querySelectorAll("#type-scale-choice button")) {
    const on = btn.dataset.scale === scaleNow;
    btn.classList.toggle("is-selected", on);
    btn.setAttribute("aria-pressed", String(on));
  }
  segmented("#type-scale-choice", "scale", (v) => {
    const n = saveTypeScale(v);
    applyTypeScale(n);
  });
  // 宿の取りかた。連泊と周遊は、同じ日数でも別の旅です（stays.js）。
  segmented("#stay-choice", "stay", (v) => {
    state.stayStyle = v ?? "auto";
  });
  // 食べたいもの。6択なので、切り替えではなくメニューにしました
  // （ガイドラインのセグメンテッドコントロールは2〜5個までで、
  // 6つ並べると390pxで字が詰まり、字を大きくすると溢れます）。
  // 店は持っていないので、決まるのは「その土地の何を食べるか」
  // までです（meals.js）。
  // 人数。費用の計算は people を受け取れるのに、聞く欄がどこにも
  // ありませんでした（つねに1人ぶんの概算です）。
  const people = $("#people-choice");
  if (people) {
    people.addEventListener("change", () => {
      state.people = Math.max(1, Number(people.value) || 1);
      setBudgetHelp();
    });
  }
  const food = $("#food-choice");
  if (food) {
    food.addEventListener("change", () => {
      state.foodGenre = food.value || "any";
    });
  }
  // 食べられないもの。海鮮・麺までは選べるのに、ベジタリアン・
  // アレルギー・ハラール・子ども向けがどこにも入りませんでした。
  // 店は持っていないので変わるのは地図へ渡す言葉までですが、
  // そこが変われば店選びは変わります。
  // 同行者。足の話です（食事の条件は上の diet が持ちます）。
  for (const btn of document.querySelectorAll("#companions-choice button")) {
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      btn.classList.toggle("is-selected", on);
    });
  }
  for (const btn of document.querySelectorAll("#diet-choice button")) {
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(on));
      btn.classList.toggle("is-selected", on);
    });
  }

  for (const btn of document.querySelectorAll("#end-choice button")) {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#end-choice button")
        .forEach((b) => b.classList.toggle("is-selected", b === btn));
      state.endMode = btn.dataset.end;
      const other = state.endMode === "other";
      $("#end-place-field").hidden = !other;
      $("#end-help").textContent = other
        ? "行きと帰りで場所が違う旅（片道・乗り継ぎ）もこれで組めます。"
        : "旅を終えたときに、出発した駅へ戻る前提で組みます。";
      updateWindowHelp();
    });
  }
  wireAreaMap();
  for (const btn of document.querySelectorAll("[data-example]")) {
    btn.addEventListener("click", () => {
      const note = $("#note");
      note.value = btn.dataset.example;
      // input を起こします。入れないと、欄は伸びず（書いた分だけ伸びる
      // 仕掛けが input を見ています）、条件も保存されません。
      note.dispatchEvent(new Event("input", { bubbles: true }));
      // 出発地つきの札（人気の条件）。まだ既定の出発地のままなら入れます。
      // 自分で出発地を書き換えた人の駅は、上書きしません。
      const from = $("#depart-place");
      if (btn.dataset.from && [DEFAULT_FROM, ""].includes(from.value.trim())) {
        from.value = btn.dataset.from;
        from.dispatchEvent(new Event("change", { bubbles: true }));
      }
      note.focus();
      // 書き換えてもらうための下書きなので、末尾にカーソルを置きます。
      note.setSelectionRange(note.value.length, note.value.length);
    });
  }
  for (const chip of document.querySelectorAll(".md-chip[data-genre]")) {
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(on));
      chip.classList.toggle("is-selected", on);
      saveConditions();
    });
  }
  $("#use-here").addEventListener("click", locateHere);
  for (const chip of document.querySelectorAll("[data-day-preset]")) {
    chip.addEventListener("click", () => applyDayPreset(chip.dataset.dayPreset));
  }
  // 書いた分だけ欄が伸びます。3行の枠に5行書くと、上が隠れて
  // 自分が何を書いたか読めません。
  const note = $("#note");
  const grow = () => {
    note.style.height = "auto";
    note.style.height = `${Math.min(320, note.scrollHeight)}px`;
  };
  note.addEventListener("input", grow);
  // 起動したときには伸ばしません。この時点の欄は必ず空で（保存した条件を
  // 戻すのは収録を読んだあとです）、ここで高さを測ると、画面をまだ一度も
  // 描いていないうちに、ページ全体の配置を計算させることになります
  // （PageSpeed の「強制リフロー」）。戻した文があるときは、戻した側で
  // input を起こして伸ばします（restoreConditions）。
  $("#depart-at").addEventListener("change", updateWindowHelp);
  $("#depart-place").addEventListener("change", () => {
    updateWindowHelp();
    renderPinned();
  });
  $("#reset-form")?.addEventListener("click", resetConditions);
  $("#arrive-by").addEventListener("change", updateWindowHelp);
  // 引数なしで呼びます。そのまま渡すと、クリックイベントが
  // 「条件」として渡ってしまいます。
  $("#make-plan").addEventListener("click", () => run());
  $("#back-to-form").addEventListener("click", () => showView("form"));

  // 開発者向けの欄は、既定では出しません（?debug=1 で出ます）。
  const dev = document.getElementById("dev-settings");
  if (dev) dev.hidden = !wantsDevPanel();
  $("#avoid-crowds").addEventListener("change", saveConditions);
  for (const id of ["#note", "#depart-place", "#end-place", "#depart-at",
                    "#arrive-by"]) {
    $(id).addEventListener("change", saveConditions);
  }
  $("#end-place").addEventListener("change", updateWindowHelp);
  // 入力中どこにいても Ctrl/⌘ + Enter で作成できるようにします
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (state.mode === "plan") run();
    }
  });
}

/**
 * 入力した時間の幅を、そのまま日本語の一文にします。
 *
 * 「帰着」という語だけでは、どこへ帰るのかが分かりません。
 * 「東京駅に19:00までに戻る」と書けば、読んだ瞬間に意味が通ります。
 */
function updateWindowHelp() {
  const dep = new Date($("#depart-at").value);
  const arr = new Date($("#arrive-by").value);
  const help = $("#window-help");
  const mins = Math.floor((arr - dep) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) {
    help.textContent = "帰着は出発より後の時刻にしてください。";
    help.classList.add("warn");
    return;
  }
  if (mins < 150) {
    help.classList.add("warn");
    help.textContent = `旅程を組むにはあと${150 - mins}分ほど必要です。`;
    return;
  }
  help.classList.remove("warn");

  const nights = Math.max(0, Math.round(
    (new Date(arr).setHours(0, 0, 0, 0) - new Date(dep).setHours(0, 0, 0, 0))
    / 86400000));
  const span = nights === 0
    ? `日帰り・${Math.floor(mins / 60)}時間${mins % 60 ? `${mins % 60}分` : ""}`
    : `${nights}泊${nights + 1}日`;

  const hhmm = `${String(arr.getHours()).padStart(2, "0")}:`
    + String(arr.getMinutes()).padStart(2, "0");
  const back = state.endMode === "other"
    ? ($("#end-place").value.trim() || "終える場所")
    : ($("#depart-place").value.trim() || "出発地");
  const verb = state.endMode === "other" ? "着く" : "戻る";
  help.textContent = `${span}・${back}に${hhmm}までに${verb}`;
}

/**
 * 打たれた名前から場所を決めます。
 *
 * まず主要駅78件、当たらなければ全国の停留所（駅・バス停）から探します。
 * 「収録の78駅にしか出発地を置けない」ままだと、最寄りが載っていない
 * 人はこのアプリを使い始めることすらできません。
 */
async function resolvePlace(text) {
  const hit = findPlace(text);
  if (hit) return hit;
  const stop = await findStop(text);
  return stop ? { name: stop.name, lat: stop.lat, lng: stop.lng } : null;
}

async function readTrip() {
  // 「必ず行く」を、県の段を読みながら戻している途中かもしれません
  // （restorePinned）。待たずに組むと、入れたはずの場所が抜けます。
  await state.pinsReady;
  // **拾うのは興味のチップだけです。**
  //
  // ここは画面のチップを種類で選ばずに拾っていました。押されている
  // チップは興味だけ、という前提です。移動手段のような単一選択を
  // チップに変えた瞬間に、それが「興味」として混ざります
  // （dataset.genre は undefined なので、黙って undefined が並びます）。
  // data-genre を持つものに限ります。
  const genres = [...document.querySelectorAll(
    '.md-chip[data-genre][aria-pressed="true"]')].map((c) => c.dataset.genre);
  const other = state.endMode === "other";
  const end = other ? await resolvePlace($("#end-place").value) : null;
  // 予約済みの宿。決まっているなら、毎晩そこを終点にします。
  //
  // 旅程を組む側は「指定された宿」を前から受け取れました
  // （planner.js の pushLodging → lodging.js の explicit）。無かったのは
  // 入力する欄です。住所か駅名で足ります（予約番号は要りません）。
  const lodgingText = String($("#lodging-place")?.value ?? "").trim();
  const lodgingPlace = lodgingText ? await resolvePlace(lodgingText) : null;
  if (lodgingText && !lodgingPlace) {
    // 引けない名前を黙って落とすと、「宿を書いたのに別の場所に泊まる
    // 旅程」が出ます。書いた人には分かりません。
    throw Object.assign(new Error(
      `宿の場所「${lodgingText}」が見つかりませんでした。`
      + "駅名か、収録にある地名で入れてください。"), { suggestions: [] });
  }
  return makeTrip({
    // 泊数ぶん、同じ宿を並べます（validateTrip は泊数と件数が合わないと
    // 断ります）。泊数は出発と帰着の日付差です。
    lodging: lodgingPlace ? Array.from(
      { length: Math.max(0, Math.round(
        (new Date($("#arrive-by").value).setHours(0, 0, 0, 0)
         - new Date($("#depart-at").value).setHours(0, 0, 0, 0)) / 86400000)) },
      () => ({ place: lodgingPlace })) : [],
    origin: await resolvePlace($("#depart-place").value),
    destination: end,
    returnTo: null,
    endMode: other ? END_MODES.END_AT_DESTINATION : END_MODES.RETURN_TO_ORIGIN,
    departAt: new Date($("#depart-at").value),
    arriveBy: new Date($("#arrive-by").value),
    note: $("#note").value,
    interests: genres,
    // 予算の上限。決めていなければ null（見ません）。
    budgetYen: state.budgetYen ?? null,
    budgetMode: state.budgetMode ?? "guide",
    // 何で移動するか。車が使えるかどうかで、組める旅程が変わります。
    transport: state.transport ?? "any",
    // 移動そのものを楽しみたいか。遠い土地や長い乗車を減点しません。
    enjoyTravel: state.enjoyTravel === true,
    // 食べたいものの向き。昼食・夕食にその土地の名物を当てます。
    people: state.people ?? 1,
    foodGenre: state.foodGenre ?? "any",
    diet: [...document.querySelectorAll(
      '#diet-choice button[aria-pressed="true"]')].map((b) => b.dataset.diet),
    companions: [...document.querySelectorAll(
      '#companions-choice button[aria-pressed="true"]')]
      .map((b) => b.dataset.companion),
    // 宿の取りかた。連泊か、泊まるたびに移動か。
    // 宿が決まっているなら連泊です。予約したホテルがあるのに
    // 「泊まり歩く」で組むと、別の街に宿が置かれます。
    stayStyle: lodgingPlace ? "base" : (state.stayStyle ?? "auto"),
    // 定番と穴場のまぜかた。画面では星の粒として出しています。
    hiddenBias: (Number($("#hidden-bias")?.value ?? 40)) / 100,
    // 1日のうち、観光にあてる時間帯。帰着時刻とは別のことです。
    dayStartHour: parseHourField($("#day-start")?.value) ?? 9,
    dayEndHour: parseHourField($("#day-end")?.value) ?? 18.5,
    ...(state.pace ? { pace: state.pace } : {}),
    avoidCrowds: $("#avoid-crowds").checked,
    must: {
      spotIds: [...state.pinned.keys()],
      // 「◯◯は外して」と言われた場所は、次からも出しません
      avoidSpotIds: state.avoidIds ?? [],
      removedSpotIds: state.removedIds ?? [],
      spotCap: state.spotCap ?? null,
    },
  });
}

const SAVE_KEY = "tabisaki.lastTrip";

/** 入力欄の中身。保存・共有・復元で同じ形を使います。 */
function formState() {
  return {
    note: $("#note").value,
    from: $("#depart-place").value,
    to: $("#end-place").value,
    end: state.endMode,
    dep: $("#depart-at").value,
    arr: $("#arrive-by").value,
    genres: [...document.querySelectorAll(
      '.md-chip[data-genre][aria-pressed="true"]')].map((c) => c.dataset.genre),
    crowd: $("#avoid-crowds").checked,
    bias: Number($("#hidden-bias")?.value ?? 40),
    dayStart: $("#day-start")?.value ?? "09:00",
    dayEnd: $("#day-end")?.value ?? "18:30",
    pinned: [...state.pinned.keys()],
    // 「必ず行く」の場所のエリア。開く側でまだその県を読んでいなくても、
    // 先に読んでから戻せるように（restorePinned）。
    pinR: [...new Set([...state.pinned.values()].map((s) => s.regionId).filter(Boolean))],
    lodging: $("#lodging-place")?.value ?? "",
  };
}

function applyFormState(v) {
  if (!v) return;
  if (v.note) $("#note").value = v.note;
  if (v.from) $("#depart-place").value = v.from;
  if (v.to) $("#end-place").value = v.to;
  if (v.lodging && $("#lodging-place")) $("#lodging-place").value = v.lodging;
  if (v.dep) $("#depart-at").value = v.dep;
  if (v.arr) $("#arrive-by").value = v.arr;
  if (typeof v.crowd === "boolean") $("#avoid-crowds").checked = v.crowd;
  if (Number.isFinite(v.bias) && $("#hidden-bias")) {
    $("#hidden-bias").value = String(v.bias);
    renderMix(v.bias);
  }
  // 以前の保存は「1日に動ける時間（長さ）」でした。朝9時から数えて
  // 同じ長さになる時間帯に読み替えます（保存を捨てずに済ませます）。
  if (v.dayStart) $("#day-start").value = v.dayStart;
  if (v.dayEnd) $("#day-end").value = v.dayEnd;
  if (!v.dayStart && Number.isFinite(v.hours)) {
    $("#day-start").value = "09:00";
    $("#day-end").value = formatHourField(Math.min(23.5, 9 + v.hours));
  }
  renderDayWindow();
  if (v.end === "other") {
    document.querySelector('[data-end="other"]')?.click();
  }
  for (const chip of document.querySelectorAll(".md-chip[data-genre]")) {
    const on = (v.genres ?? []).includes(chip.dataset.genre);
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("is-selected", on);
  }
  if (v.pinned?.length) state.pinsReady = restorePinned(v.pinned, v.pinR);
  renderPinned();
  updateWindowHelp();
}

/**
 * 「必ず行く」を id から戻します。
 *
 * 収録は県ごとに遅れて読みます（kb.js の stagedKb）。開いた直後は
 * まだどの県も読んでいないので、id を引いても見つからず、共有された
 * 条件やエリアのページから来た「必ず行く」が黙って消えていました。
 * エリアが分かっていれば、その県の段を先に読んでから入れます。
 * 分からない id（古いリンク）は、全国を読みにはいきません。
 */
async function restorePinned(ids, regionIds = []) {
  const kb = state.kb;
  if (!kb) return;
  const want = [...new Set(ids ?? [])];
  if (want.some((id) => !kb.spotsById?.has(id)) && regionIds?.length) {
    try { await ensureRegions(kb, regionIds); } catch { /* 読めなければ、見つかったぶんだけ */ }
  }
  for (const id of want) {
    const spot = kb.spotsById?.get(id);
    if (spot) state.pinned.set(id, spot);
  }
  renderPinned();
  updateWindowHelp();
}

/**
 * 条件を最初の状態に戻します。
 *
 * 欄を1つずつ既定値へ戻すと、既定値を2か所に書くことになり
 * （ここと、初めて開いたときの組み立て）、どちらかがずれます。
 * 保存した条件を消して、条件の付かない URL で開き直します。
 * 「前につくった旅」と設定（文字の大きさ・旅行中モードなど）は残します。
 */
function resetConditions() {
  const ok = globalThis.confirm?.(
    "入力した条件をすべて最初の状態に戻します。"
    + "画面に出ている旅程も閉じます（「前につくった旅」は残ります）。よろしいですか？");
  if (!ok) return;
  try { globalThis.localStorage?.removeItem(SAVE_KEY); } catch { /* 無くても戻せます */ }
  location.replace(location.pathname);
}

/** 条件を保存します（次に開いたときに、また入力し直さなくて済むように）。 */
function saveConditions() {
  try {
    globalThis.localStorage?.setItem(SAVE_KEY, JSON.stringify(formState()));
  } catch { /* 保存できなくても動作に影響はありません */ }
}

function restoreConditions() {
  // URL に条件が入っていればそれを優先（共有されたリンクを開いた場合）
  try {
    const q = new URLSearchParams(location.search).get("p");
    if (q) {
      applyFormState(JSON.parse(unpack(q)));
      return "url";
    }
  } catch { /* 壊れたリンクは無視して、保存済みに落ちます */ }
  let restored = null;
  try {
    const raw = globalThis.localStorage?.getItem(SAVE_KEY);
    if (raw) {
      applyFormState(JSON.parse(raw));
      restored = "saved";
      // 長い文を戻したときに、欄を文の長さまで伸ばします。
      const box = $("#note");
      if (box.value) box.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch { /* 無ければ既定値のまま */ }
  // エリアのページ（areas/）から来たとき。`?q=` は「どんな旅にしたい？」
  // の欄に入れるだけです。**勝手に組み始めません**（日時や出発地は、
  // その人の保存済みの条件のほうが合っています）。
  try {
    const note = noteFromQuery(location.search);
    if (note) {
      const box = $("#note");
      box.value = note;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      restored = "query";
    }
    // モデルコースから来たときは、コースの場所を「必ず行く」に入れます。
    // 前の旅の「必ず行く」は外します（よその土地の場所が混ざると、
    // 組めない旅程になります）。
    const pin = pinsFromQuery(location.search);
    if (pin.ids.length) {
      state.pinned.clear();
      state.pinsReady = restorePinned(pin.ids, pin.regions);
      restored = "course";
    }
  } catch { /* 読めない欄は無視します */ }
  return restored;
}

/** `?pin=a,b&area=kamakura`。id は英数字と - _ だけ、20か所までにします。 */
function pinsFromQuery(search) {
  const q = new URLSearchParams(search ?? "");
  const ok = (x) => /^[\w-]{1,80}$/.test(x);
  const split = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(ok);
  return { ids: split(q.get("pin")).slice(0, 20), regions: split(q.get("area")).slice(0, 5) };
}

/** `?q=` の文。長すぎるものは切ります（欄に貼れる長さで十分です）。 */
function noteFromQuery(search) {
  const q = new URLSearchParams(search ?? "").get("q");
  const text = String(q ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : "";
}

/** いまの条件をURLにして、共有できるようにします。 */
/**
 * URL に載せられる形にします。
 *
 * 素の base64 には + と / が出てきます。+ はクエリ文字列では空白として
 * 解釈されるので、そのまま貼ると壊れたリンクになります（実際になりました）。
 * URL 安全な字だけを使う版に置き換えます。
 */
function pack(text) {
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unpack(code) {
  const b64 = code.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(b64)));
}

/**
 * いま画面に出ている旅程を、ファイルにして渡します。
 *
 * 条件のリンクは**条件だけ**を運びます。受け取った人が開くと、その場で
 * 組み直されるので時刻が変わり、同行者と同じ時刻で回れません。
 * 凍結した旅程そのものを渡せば、その人の端末で同じ時刻の旅程が開きます。
 *
 * どこにも送りません。ブラウザの中でファイルを作って、端末に保存する
 * だけです。
 */
async function exportTrip(itin, trip) {
  const { toTripFile, tripFilename } = await loadTransfer();
  const doc = toTripFile({
    id: null,
    title: itin?.title ?? "旅",
    savedAt: Date.now(),
    state: formState(),
    trip: freezeItinerary(trip ?? null),
    itin: freezeItinerary(itin ?? null),
  });
  downloadJson(doc, tripFilename);
  setBadge("旅程のファイルを保存しました");
  setTimeout(() => setBadge(kbBadgeText()), 2600);
}

/** 履歴ぜんぶを、控えのファイルにします。 */
async function exportBackup() {
  const list = loadHistory();
  if (!list.length) {
    setBadge("控えにする旅がまだありません");
    setTimeout(() => setBadge(kbBadgeText()), 2600);
    return;
  }
  const { toBackupFile, tripFilename } = await loadTransfer();
  const doc = toBackupFile(list);
  downloadJson(doc, tripFilename);
  setBadge(`${list.length}件を控えに書き出しました`);
  setTimeout(() => setBadge(kbBadgeText()), 2600);
}

/** JSON を端末に保存します（.ics と同じやりかたです）。 */
function downloadJson(doc, tripFilename) {
  const blob = new Blob([JSON.stringify(doc, null, 1)],
                        { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = tripFilename(doc);
  document.body.append(a);
  a.click();
  a.remove();
  // すぐに消すと、保存が始まる前に無効になることがあります。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * ファイルから読み込みます。
 *
 * **手元の履歴は消しません。** 混ぜるだけです。控えを読み込んだら
 * 手元の旅程が消えた、はいちばん困ります。
 */
async function importTripFile(file) {
  if (!file) return;
  let text = "";
  try {
    text = await file.text();
  } catch (e) {
    setBadge(`ファイルを開けませんでした（${e?.message ?? e}）`);
    setTimeout(() => setBadge(kbBadgeText()), 4000);
    return;
  }
  let transfer;
  try {
    transfer = await loadTransfer();
  } catch (e) {
    setBadge(`ファイルを開けませんでした（${e?.message ?? e}）`);
    setTimeout(() => setBadge(kbBadgeText()), 4000);
    return;
  }
  const { mergeTrips, readTripFile } = transfer;
  const out = readTripFile(text);
  if (!out.ok) {
    // **黙って読み違えません。** 何が違うのかを言います。
    setBadge(out.error);
    setTimeout(() => setBadge(kbBadgeText()), 5000);
    return;
  }
  const { list, added, replaced } = mergeTrips(loadHistory(), out.trips);
  replaceHistory(list);
  renderRecent();
  setBadge(`${added}件を読み込みました`
    + (replaced ? `（${replaced}件は上書き）` : ""));
  setTimeout(() => setBadge(kbBadgeText()), 3600);
}

/**
 * いま画面に出ている旅程を、リンクにして渡します（js/snapshot.js）。
 *
 * 条件のリンクと違って、受け取った人の画面にも**同じ旅程**が出ます。
 * 旅程はリンクの # の後ろに入っていて、どこにも預けません。
 * 長すぎてリンクにできないときは、ファイルで渡す方法を案内します。
 */
async function shareTripLink(itin, trip) {
  let url = null;
  try {
    url = await tripLink({
      title: itin?.title ?? "旅",
      savedAt: Date.now(),
      state: formState(),
      trip: freezeItinerary(trip ?? null),
      itin: freezeItinerary(itin ?? null),
    }, `${location.origin}${location.pathname}`);
  } catch { url = null; }
  if (!url) {
    setBadge("旅程が長すぎてリンクにできません。「この旅程をファイルで渡す」をお使いください");
    setTimeout(() => setBadge(kbBadgeText()), 5000);
    return;
  }
  const title = `旅さき — ${itin?.title ?? "旅程"}`;
  if (navigator.share && (!navigator.canShare || navigator.canShare({ url }))) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    setBadge("旅程のリンクをコピーしました");
    setTimeout(() => setBadge(kbBadgeText()), 2600);
  } catch {
    globalThis.prompt?.("このURLを共有してください", url);
  }
}

async function shareConditions() {
  const packed = pack(JSON.stringify(formState()));
  const url = `${location.origin}${location.pathname}?p=${packed}`;
  // 共有シートのある端末（携帯）では、それを開きます。コピーして
  // LINE を開いて貼る、の3手が1手になります。
  if (navigator.share && (!navigator.canShare || navigator.canShare({ url }))) {
    try {
      await navigator.share({ title: "旅さき — この条件で旅程をつくる", url });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
      // 共有できない端末は、下のコピーに落ちます
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    setBadge("条件のリンクをコピーしました");
    setTimeout(() => setBadge(kbBadgeText()), 2600);
  } catch {
    // クリップボードが使えない環境では、URL を直接見せます
    globalThis.prompt?.("このURLを共有してください", url);
  }
}

function kbBadgeText() {
  if (!state.kb) return "";
  // 件数は索引の数を出します。読み込み済みの数を出すと、県ごとに
  // 遅れて読むぶんだけ「収録が減った」ように見えます（実際の収録は
  // 29,706件のままで、読んでいないだけです）。
  const spots = state.kb.manifest?.counts?.spots ?? state.kb.spots.length;
  return `収録 ${state.kb.regions.length}エリア / ${spots}スポット`
    + (state.aiSpots ? `（うちAI調べ ${state.aiSpots}件）` : "");
}

/** 経路APIを何回呼び、何が返ったかを、キーの欄に出します。 */
function showRoutesUsage() {
  const u = routesUsage();
  const box = $("#routes-usage");
  if (!box) return;
  if (!u.calls && !u.skipped && !u.yahooLegs) {
    box.textContent = ""; box.hidden = true; return;
  }
  box.hidden = false;
  // 電車・バスの時刻はYahoo!に聞きます。**ここを出していませんでした。**
  // 30区間を調べた旅程でも画面には何も出ないので、「一度しか
  // 問い合わせていないのでは」と見えていました。区間の数と、そのうち
  // 時刻が入った数を、そのまま出します。
  const parts = [];
  if (u.yahooLegs) {
    parts.push(`電車・バス: ${u.yahooLegs}区間中 ${u.yahooHits}区間で時刻表`
      + `（問い合わせ ${u.yahooAsks}回）`);
  }
  parts.push(`Googleの経路: ${u.calls}回`);
  if (u.failures) parts.push(`失敗 ${u.failures}回`);
  if (u.skipped) parts.push(`省略 ${u.skipped}回`);
  if (u.breakerOpen) parts.push("失敗が続いたため停止中");
  box.textContent = parts.join(" / ");
  box.classList.toggle("ng",
    Boolean(u.failures || u.breakerOpen
            || (u.yahooLegs && u.yahooHits < u.yahooLegs)));
  if (u.lastError) box.title = u.lastError;
  showQuota();
}

/**
 * うまくいかなかったことを伝えます。
 *
 * 「Routes API 403」のような技術用語は表に出しません。旅行者が
 * 知りたいのは「それで、旅程は作れるのか」の一点です。
 * 元のエラーは「技術的な詳細」を開いた人だけが見ます。
 */
/**
 * いま見せる面（携帯だけ）。条件 → 生成中 → 結果。
 *
 * 広い画面では左右に並んでいるので、この値は使われません（css の
 * 媒体条件の中だけで効きます）。切り替えたら先頭へ戻します。
 * 前の画面のスクロール位置のままだと、切り替わったことに気づけません。
 */
function setBudgetHelp() {
  const help = $("#budget-help");
  if (!help) return;
  // 人数を選んだら、合計がいくらになるのかを先に言います。
  // 「ひとり3万円まで」で4人なら、旅の合計は12万円です。**そこを
  // 黙っていると、合計を見たときに驚かせます。**
  const n = state.people ?? 1;
  const total = state.budgetYen && n > 1
    ? `${n}人だと合計 約${(state.budgetYen * n).toLocaleString("ja-JP")}円です。`
    : "";
  help.textContent = total + (!state.budgetYen
    ? "決めなければ、費用は概算として出すだけです。"
    : state.budgetMode === "strict"
      ? "収まらないときは、入場料の高い場所から外して組み直します。"
        + "外した場所の名前は出します。"
      : "超えたぶんを勝手に削りはしません。超えていたら、そう伝えます。");
}

function isNarrow() {
  return Boolean(globalThis.matchMedia?.("(max-width: 860px)")?.matches);
}

function showView(view) {
  document.body.dataset.view = view;
  // 結果の画面に移ったら、そこで地図を用意します（携帯では、ここが
  // 地図の見え始めです）。2度目以降は startHomeMap 側で弾かれます。
  if (view === "result" && isNarrow()) startHomeMap();
  globalThis.scrollTo?.({ top: 0, behavior: scrollBehavior() });
}

/**
 * 使われかたを1件数えます（js/metrics.js）。名前の無い件数だけです。
 * 中継（PROXY_URL）が無いときと、設定で外したときは送りません。
 */
function count(event, detail = "", extra = null) {
  track(event, detail, { proxyUrl: effectiveConfig().proxyUrl, extra });
}

/** 組めなかった理由を、数えるための言葉にします（js/errors.js と同じ分け方）。 */
function failureKind(e) {
  const msg = e?.message ?? String(e);
  if (isNetworkFailure(msg)) return isOffline() ? "offline" : "network";
  return "plan";
}

function showError(text, suggestions = [], kind = "plan") {
  const box = $("#form-error");
  box.textContent = "";
  box.hidden = !text;
  if (!text) return;

  // 通信そのものが切れたときは、ブラウザの原文（Failed to fetch）を
  // そのまま出さず、圏外かどうかで言い分けます（js/errors.js）。
  if (kind === "plan" && isNetworkFailure(text)) {
    kind = isOffline() ? "offline" : "network";
  }
  const m = userFacing(kind, text);
  const notice = el("div", { class: "notice notice--error" });
  notice.append(el("h3", {}, m.title === "うまくいきませんでした"
    ? "旅程を作れませんでした" : m.title));
  notice.append(el("p", {}, kind === "plan" ? String(text) : m.body));

  // 何が起きたかだけでは、読んだ人は止まります。次にできることを書きます。
  // 多くの場合、答えは「そのまま旅程は作れます」です。
  if (m.next && kind !== "plan") {
    notice.append(el("p", { class: "notice-next" }, m.next));
  }

  if (m.detail && kind !== "plan") {
    const det = el("details", {});
    det.append(el("summary", {}, "技術的な詳細"));
    det.append(el("pre", {}, [m.detail, m.hint].filter(Boolean).join("\n\n")));
    notice.append(det);
  }
  box.append(notice);

  if (suggestions.length) {
    // 「できません」で終わらせない。押せば条件を書き換えて組み直します。
    box.append(el("div", { class: "relax-list", style: "margin-top:12px" },
      suggestions.map((s) => suggestionButton(s, applySuggestion))));
  }
  box.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
}

/**
 * 旅程は作れたが、一部がうまくいかなかったことを伝えます。
 * 旅程の上に、控えめな箱として出します。
 */
function noticeFor(kind, raw) {
  const m = userFacing(kind, raw);
  const box = el("div", { class: "notice" });
  box.append(el("h3", {}, m.title), el("p", {}, m.body));
  if (m.detail) {
    const det = el("details", {});
    det.append(el("summary", {}, "技術的な詳細"));
    det.append(el("pre", {}, [m.detail, m.hint].filter(Boolean).join("\n\n")));
    box.append(det);
  }
  return box;
}

/**
 * 「もっとゆっくり」などの調整。
 *
 * 条件の画面まで戻らせると、そこで手が止まります。旅程のすぐ上に
 * 置いて、押したらそのまま組み直します。書き換えるのは条件だけで、
 * 組み立ては同じエンジンが行います（AIに旅程を作り直させません）。
 */
function adjustPlan(key) {
  const bias = $("#hidden-bias");
  const move = (delta) => {
    if (!bias) return;
    bias.value = String(Math.max(0, Math.min(100, Number(bias.value) + delta)));
    renderMix(Number(bias.value));
  };
  if (key === "slower") state.pace = "relaxed";
  if (key === "fuller") state.pace = "packed";
  if (key === "hidden") move(+25);
  if (key === "classic") move(-25);
  saveConditions();
  run();
}

/**
 * 言葉で旅程を直します。
 *
 * AIがやるのは「言われたことを条件の書き換えに翻訳する」だけです。
 * 旅程は、これまでと同じ手順（営業時間と移動時間の照合）で組み直します。
 * AIに旅程そのものを作らせると、実行できない旅程が返ってきます。
 */
async function editPlan(text, itin, trip) {
  const patch = await parseEdit(text, itin,
    hasApiKey() ? { call: (prompt, o) => callModel(prompt, o) } : {});
  const said = describeEdit(patch, itin);
  if (patch.empty) return said;   // 読み取れないときは、何もしません

  const next = applyEdit(patch, trip);
  syncFormTo(next);
  state.trip = next;
  // 組み直すと画面が作り直されるので、返した文はそこで消えます。
  // 次に描かれる旅程へ持っていって、何をしたかを残します。
  state.editNote = said;
  run(next);
  return said;
}

/**
 * 旅程の1か所を、差し替える／外す。
 *
 * どちらも「その場所を候補から外して、もう一度組み直す」だけです。
 * 旅程を直接いじらないのは、editPlan と同じ理由です。1か所を手で
 * 差し替えると、その前後の移動時間も営業時間も合わなくなります。
 *
 * 違いは件数です。「外す」は1か所ぶん減らし、「別の候補」は減らしません
 * （空いた枠を、別の場所が埋めます）。減らさずに外すと、押した人には
 * 何も起きていないように見えます。
 *
 * 減らす数ではなく、上限を「いま出ている件数マイナス1」として渡します。
 * 「入れてよい数」から1を引いても、収録が少ない土地では実際の件数が
 * 変わらないためです（11まで入れてよくても10しか入らない、など）。
 */
function editSpot({ id, name, action }, trip, itin) {
  if (!id) return;
  const remove = action === "remove";
  // 「外す」の直前を、そのまま取っておきます。
  //
  // **戻すときに組み直すと、元の旅程は返ってきません。** 組み直しは
  // そのときの手元のデータで走るので、行き先ごと変わることがあります
  // （5か所の草津が、2か所の別の旅になりました）。
  //
  // 押し間違えて「戻す」を押した人が欲しいのは、新しい旅程ではなく
  // **さっきまで見ていた旅程**です。取っておいて、そのまま返します。
  if (remove) {
    state.beforeRemove = { id, trip, itin };
    state.keepBeforeRemove = true;
  }
  const next = applyEdit({
    remove: [id],
    removeCount: remove ? [id] : [],
    spotCap: remove ? Math.max(1, (itin?.spotCount ?? 2) - 1) : null,
  }, trip);
  syncFormTo(next);
  state.trip = next;
  count(remove ? "spot_remove" : "spot_replace");
  state.editNote = remove
    ? `「${name}」を旅程から外して、組み直しました。`
    : `「${name}」の代わりになる場所を探して、組み直しました。`;
  run(next);
}

/**
 * 回る順を、押されたとおりに書き換えて組み直します。
 *
 * 並べ替えだけして時刻をそのまま使うことはしません。開館前に着く旅程や、
 * 閉館後に着く旅程ができます。**条件を書き換えて、同じエンジンを通します**
 * （「別の候補」とまったく同じ道です）。その順で入らなければ、これまで
 * どおり入らないぶんが落ちて、落ちたことが画面に出ます。
 *
 * @param {{id?:string, dir?:string, ids?:string[]}} req
 */
function reorderSpots(req, trip, itin) {
  // 旅程に出ている並び（全日ぶん）を、そのまま下敷きにします。
  const perDay = (itin?.days ?? []).map((d) => (d.items ?? [])
    .filter((i) => i.kind === "spot" && (i.spotId ?? i.place?.id))
    .map((i) => i.spotId ?? i.place.id));

  let moved = null;
  if (Array.isArray(req.ids) && req.ids.length > 1) {
    // 掴んで動かしたとき。その日の並びが、そのまま渡ってきます。
    const set = new Set(req.ids);
    const di = perDay.findIndex((day) => day.some((x) => set.has(x)));
    if (di < 0) return;
    // 渡ってきた並びのうち、その日にある場所だけを採ります
    // （日をまたぐ移動は、宿と移動の話になるのでここではできません）。
    const mine = req.ids.filter((x) => perDay[di].includes(x));
    const rest = perDay[di].filter((x) => !mine.includes(x));
    perDay[di] = [...mine, ...rest];
    moved = "順番";
  } else if (req.id && req.dir) {
    const di = perDay.findIndex((day) => day.includes(req.id));
    if (di < 0) return;
    const day = perDay[di];
    const at = day.indexOf(req.id);
    const to = req.dir === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= day.length) return;   // 端では何も起きません
    [day[at], day[to]] = [day[to], day[at]];
    moved = req.dir === "up" ? "1つ前" : "1つ後";
  }
  if (!moved) return;

  const next = {
    ...trip,
    must: { ...trip.must, orderedSpotIds: perDay.flat() },
  };
  syncFormTo(next);
  state.trip = next;
  state.editNote = "回る順を変えて、組み直しました"
    + "（その順で入らない立ち寄りは落ちます）。";
  // 組み直したあとに、前と比べて移動がどう変わったかを出します
  // （js/orderdiff.js）。比べる相手は、いま画面に出ている旅程です。
  state.orderFrom = { itin, trip: next };
  run(next);
}

/**
 * その場所にいる時間を書き換えて、組み直します。
 *
 * 既定は分類ごとの目安です（美術館70分、神社35分）。目安が合わない
 * ことはあるので、動かせるようにします。伸ばしたぶんは後ろの予定に
 * 効くので、**時刻は組み直します**。
 */
function tuneDwell({ id, name, minutes }, trip) {
  if (!id || !Number.isFinite(minutes)) return;
  const next = {
    ...trip,
    must: {
      ...trip.must,
      dwellById: { ...(trip.must?.dwellById ?? {}), [id]: minutes },
    },
  };
  syncFormTo(next);
  state.trip = next;
  state.editNote = `「${name}」にいる時間を${minutes}分にして、`
    + "組み直しました。";
  run(next);
}

/**
 * 外した場所を、候補に戻します。
 *
 * 「必ず行く」にはしません。戻すのは「外した」を取り消すことであって、
 * 「絶対に入れて」とは別のことです。戻したうえで入らなければ、
 * それは営業時間や移動時間が許さなかったということです。
 */
function restoreSpot({ id, name }, trip) {
  if (!id) return;
  // 直前に外したものを戻すなら、取っておいた旅程をそのまま返します。
  // 組み直しません（組み直すと、別の旅になって返ってきます）。
  const kept = state.beforeRemove;
  if (kept && kept.id === id && kept.itin && kept.trip) {
    state.beforeRemove = null;
    syncFormTo(kept.trip);
    state.trip = kept.trip;
    state.editNote = `「${name}」を戻しました（外す前の旅程です）。`;
    show(kept.itin, kept.trip);
    return;
  }
  const removed = (trip.must?.removedSpotIds ?? []).filter((x) => x !== id);
  const wasRemoved = (trip.must?.removedSpotIds ?? []).includes(id);
  const cap = trip.must?.spotCap;
  const next = {
    ...trip,
    must: {
      ...trip.must,
      spotIds: [...(trip.must?.spotIds ?? [])],
      avoidSpotIds: (trip.must?.avoidSpotIds ?? []).filter((x) => x !== id),
      removedSpotIds: removed,
      // 「外す」で減らした1か所ぶんを返します。まだ外したままの場所が
      // 残っていれば、そのぶんの上限は残します。
      spotCap: removed.length && Number.isFinite(cap)
        ? cap + (wasRemoved ? 1 : 0)
        : null,
    },
  };
  syncFormTo(next);
  state.trip = next;
  state.editNote = `「${name}」を候補に戻して、組み直しました。`;
  run(next);
}

/** 書き換えた条件を、左の入力欄に反映します。 */
function syncFormTo(t) {
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  $("#depart-at").value = iso(t.departAt);
  $("#arrive-by").value = iso(t.arriveBy);
  if (t.paceChosen) state.pace = t.pace;
  if ($("#hidden-bias")) {
    $("#hidden-bias").value = String(Math.round(t.hiddenBias * 100));
    renderMix(Number($("#hidden-bias").value));
  }
  for (const chip of document.querySelectorAll(".md-chip[data-genre]")) {
    const on = t.interests.includes(chip.dataset.genre);
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("is-selected", on);
  }
  state.avoidIds = t.must.avoidSpotIds;
  state.removedIds = t.must.removedSpotIds ?? [];
  state.spotCap = t.must.spotCap ?? null;
  state.pinned.clear();
  for (const id of t.must.spotIds) {
    const spot = state.kb?.spotsById?.get(id);
    if (spot) state.pinned.set(id, spot);
  }
  renderPinned();
  updateWindowHelp();
  saveConditions();
}

function applySuggestion(s) {
  const a = s.apply ?? {};
  const dep = new Date($("#depart-at").value);
  const arr = new Date($("#arrive-by").value);
  const iso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  if (a.extendMinutes) {
    $("#arrive-by").value = iso(new Date(arr.getTime() + a.extendMinutes * 60000));
  }
  if (a.startEarlierMinutes) {
    $("#depart-at").value = iso(new Date(dep.getTime() - a.startEarlierMinutes * 60000));
  }
  if (a.addNights) {
    $("#arrive-by").value = iso(new Date(arr.getTime() + a.addNights * 86400000));
  }
  if (a.shortenDays) {
    $("#arrive-by").value = iso(new Date(arr.getTime() - a.shortenDays * 86400000));
  }
  if (a.pace) state.pace = a.pace;
  if (a.clearArea) state.clearArea = true;
  updateWindowHelp();
  run();
}

// --- 本体 -------------------------------------------------------------------

/**
 * 旅程を組みます。
 * @param {object} [override] 条件を指定する場合（言葉での修正など）。
 *   省略すると、左の入力欄から読みます。
 */
async function run(override) {
  const trip = override ?? await readTrip();
  showError("");

  if (!trip.origin) {
    showError("出発地が見つかりません。一覧から駅名を選んでください。");
    return;
  }
  if (state.endMode === "other" && !trip.destination) {
    showError("終える場所が見つかりません。一覧から駅名を選んでください。");
    return;
  }
  const errors = validateTrip(trip);
  if (errors.length) { showError(errors.join(" / ")); return; }
  state.trip = trip;
  // 組み直したら、取っておいた「外す前」は古くなります。**残すと、
  // 何度も組み直したあとの「戻す」が、ずっと前の旅程を返します。**
  // 外した直後の1回ぶんだけを取っておくのが editSpot の役目なので、
  // そこで入れ直されます。
  if (!state.keepBeforeRemove) state.beforeRemove = null;
  state.keepBeforeRemove = false;
  // 携帯では、ここから結果の画面に移ります（css の data-view）。
  // 条件のページに留まったままだと、旅程ができても自分でスクロール
  // して探すことになります。
  showView("result");
  $("#placeholder").hidden = true;
  $("#result").hidden = true;
  $("#progress").hidden = false;
  const progress = $("#progress");
  // 前回の札を残さない。残すと、経過時間が前回の開始から数え続けます。
  progress.textContent = "";
  // 途中でやめられるようにします。前のぶんがまだ走っていれば、止めます
  // （言葉で直す・組み直すは、組み立て中にも押せます）。
  state.planAbort?.abort();
  const ctrl = new AbortController();
  state.planAbort = ctrl;
  const { signal } = ctrl;
  const fab = $("#make-plan");
  fab.disabled = true;
  fab.querySelector(".fab-tx").textContent = "組み立てています…";
  // 出発地のあたりへ、背景の地図を寄せておきます
  moveBackgroundMap(trip.origin.lat, trip.origin.lng, 8);
  // 数えるとき（協力してくれる人だけ）に添える、かかった時間と条件の区分。
  const startedAt = Date.now();
  const facts = () => ({
    s: (Date.now() - startedAt) / 1000,
    c: conditionsOf(trip, { pinned: state.pinned.size }),
  });

  try {
    // まだ読み終わっていなければ、ここで待ちます。押した人にとっては
    // 「組み立ての一部」で、待つ理由も画面に出ます。
    if (!state.kb) {
      renderProgress(progress, 0, "旅先のデータを読んでいます", {
        trip, stars: () => state.kb?.spots?.slice(-MAX_SKETCH_STARS) ?? [],
        tileUrl: TILE_URL, attribution: TILE_ATTRIBUTION,
      });
      addCancel(progress, ctrl);
      state.kb = await untilAborted(state.kbPromise, signal);
    }
    if (!state.kb) throw new Error("データを読み込めていません。");
    resetRoutesBreaker();
    const itin = await buildPlans(trip, progress, ctrl);
    signal.throwIfAborted();
    showRoutesUsage();
    show(itin, trip);
    count("plan_ok", trip.transport,
          { ...facts(), r: Math.max(1, ...(state.plans ?? []).map((p) => p.itin?.rounds ?? 1)) });
  } catch (e) {
    if (signal.aborted) {
      // やめたのは失敗ではありません。理由も出さず、条件の画面へ戻します。
      // （次の組み立てがもう始まっているなら、画面はそちらに任せます。）
      if (state.planAbort === ctrl || state.planAbort === null) {
        progress.textContent = "";
        $("#progress").hidden = true;
        $("#placeholder").hidden = false;
        showView("form");
        setBadge("組み立てをやめました");
        setTimeout(() => setBadge(kbBadgeText()), 2600);
      }
      return;
    }
    count("plan_error", failureKind(e), facts());
    $("#progress").hidden = true;
    $("#placeholder").hidden = false;
    // うまくいかなかったときは、条件の画面へ戻します。理由は
    // 条件の下に出るので、結果の画面に残すと読めません。
    showView("form");
    showError(e.message ?? String(e), e.suggestions ?? []);
  } finally {
    // あとから始まった組み立てがあれば、ボタンはそちらのものです。
    if (state.planAbort === ctrl || state.planAbort === null) {
      state.planAbort = null;
      fab.disabled = false;
      fab.querySelector(".fab-tx").textContent = "旅程をつくる";
    }
  }
}

/**
 * 組み立て中の札に「やめる」を置きます。
 *
 * 条件によっては作り直しが4回まで続き、待ちが数分になります。途中で
 * 条件を変えたくなっても、これまでは終わるまで待つしかなく、その間も
 * AIと経路への問い合わせが裏で走り続けていました。押せば、走っている
 * 通信も含めて止めます（AbortController を pipeline の下まで渡しています）。
 *
 * 札は js/ui.js の renderProgress が作り直すことがあるので、描くたびに
 * 置き直します（すでにあれば何もしません）。
 */
function addCancel(progress, ctrl) {
  const card = progress.querySelector(".plan-card");
  if (!card || card.querySelector(".plan-cancel")) return;
  const btn = el("button", {
    type: "button", class: "md-btn md-btn--outlined md-state plan-cancel",
    onclick: () => {
      btn.disabled = true;
      btn.querySelector("span").textContent = "やめています…";
      ctrl.abort();
    },
  }, el("span", {}, "やめる"));
  card.append(btn);
}

/**
 * 待っている約束を、やめると言われた時点で手放します。
 * 約束そのもの（収録の読み込みなど）は止めません。次に使うからです。
 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve(promise).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * 3案を作って、おすすめを1つ選びます。
 *
 * 費用について
 * ------------
 * 案ごとに一から作り直すと、同じ希望文をモデルに3回読ませることに
 * なります。読み取り（understandRequest）と検索用ベクトルは1回だけ
 * 計算し、3案で使い回します。増えるのは「候補から選ぶ」呼び出しだけです。
 *
 * さらに、案を比べるあいだは **経路も天気も取りません**。
 * 採用が決まった案にだけ、実際の経路と天気を取りにいきます。
 */
async function buildPlans(trip, progress, ctrl) {
  const signal = ctrl?.signal;
  // 絵に渡す材料。段が進むたびに、読み込まれた収録（星）と候補を
  // 渡します。pipeline が候補と決まった順を extra に乗せてきます。
  // 星は「取りに行く関数」で渡します。収録は県ごとに遅れて読まれる
  // ので、写しを渡すと読み込みが終わる前の空のままになります。
  const onProgress = (step, note, extra) => {
    renderProgress(progress, step, note, {
      trip,
      stars: () => state.kb?.spots?.slice(-MAX_SKETCH_STARS) ?? [],
      // 待っているあいだの絵に、地の形を敷きます（js/sketch.js）。
      tileUrl: TILE_URL, attribution: TILE_ATTRIBUTION,
      ...(extra ?? {}),
    });
    if (ctrl) addCancel(progress, ctrl);
  };
  const variants = tripsFor(trip);

  // 1案目。ここで希望文の読み取りと検索用ベクトルが決まります。
  // （収録のうち要るぶんも、ここで読まれます。pipeline.js の
  //   loadNeededSpots。2案目以降は読み込み済みなので取りません。）
  const first = await planTrip({
    trip: variants[0].trip, kb: state.kb,
    ignoreAreas: state.clearArea,
    mustRegionIds: pinnedRegionIds(),
    useRoutes: false, useWeather: false, onProgress, signal,
  });

  // 残りの案は、読み取りを使い回して作ります。
  //
  // 「日本全国」のような広い指定なら、案ごとに別の地方を出します。
  // 3案とも同じ土地だと、ペースが違うだけで選びようがありません。
  const used = first.spread ? [...(first.regionIds ?? [])] : [];
  const rest = [];
  for (const v of variants.slice(1)) {
    onProgress(3, `${VARIANTS[v.key].label}の案を組み立てています`);
    try {
      const itin = await planTrip({
        trip: v.trip, kb: state.kb,
        ignoreAreas: state.clearArea,
        mustRegionIds: pinnedRegionIds(),
        useRoutes: false, useWeather: false,
        query: first.query, vector: first.vector,
        avoidRegionIds: used, signal,
      });
      if (first.spread) used.push(...(itin.regionIds ?? []));
      rest.push({ key: v.key, trip: v.trip, itin });
    } catch {
      // やめると言われたなら、残りの案は作りません。
      signal?.throwIfAborted();
      // 成立しない案は、並べません（「作れませんでした」を3つ並べても
      // 選びようがありません）
    }
  }

  const plans = [{ key: variants[0].key, trip: variants[0].trip, itin: first },
                 ...rest];
  state.plans = plans;

  const best = recommendOf(plans) ?? plans[0];
  state.recommendKey = best.key;
  state.recommendWhy = best.reason ?? "";

  return finishPlan(best.key, onProgress, signal);
}

/**
 * 「必ず行く」に指定された場所のエリア。
 *
 * 収録は県ごとに遅れて読みます（kb.js）。指定された場所が読んでいない
 * 県にあると、**指定が黙って落ちます**。押した場所が消えるのは
 * いちばん悪い結果なので、そのエリアだけは先に読ませます。
 * 指定はこの画面で押されたものなので、エリアはこちらが知っています。
 */
function pinnedRegionIds() {
  const out = new Set();
  for (const spot of state.pinned?.values() ?? []) {
    if (spot?.regionId) out.add(spot.regionId);
  }
  return out;
}

/**
 * 採用した案だけ、実際の経路と天気を取って仕上げます。
 * ここが唯一の課金対象です。
 */
async function finishPlan(key, onProgress, signal) {
  const chosen = (state.plans ?? []).find((p) => p.key === key);
  if (!chosen) throw new Error("その案が見つかりません");

  onProgress?.(4, `${VARIANTS[key].label}の経路と天気を確認しています`);
  const itin = await planTrip({
    trip: chosen.trip, kb: state.kb,
    ignoreAreas: state.clearArea,
    mustRegionIds: pinnedRegionIds(),
    query: chosen.itin.query, vector: chosen.itin.vector,
    onProgress, signal,
  });

  // 案の一覧（カードに出すぶんだけ）
  // 「何が違うのか」は、3案を並べて比べてから決めます。
  const diff = distinguishOf(state.plans ?? []);
  itin.variants = (state.plans ?? []).map((p) => ({
    key: p.key,
    score: p.itin?.score?.total ?? 0,
    summary: summaryOf(p.itin),
    distinct: diff.get(p.key) ?? "",
    fatigue: p.itin?.score?.fatigue ?? null,
  }));
  itin.variantKey = key;
  itin.recommendKey = state.recommendKey;
  itin.recommendWhy = state.recommendWhy;
  state.chosenTrip = chosen.trip;
  return itin;
}

/** 旅程のいちばん最後の時刻。帰りの余裕を出すために使います。 */
function lastEnd(itin) {
  const all = (itin.days ?? []).flatMap((d) => d.items ?? []);
  return all.length ? all.at(-1).end : itin.days?.[0]?.date;
}

/** 旅程に混ざっている情報の出どころを、ぜんぶ集めます。 */
function collectSources(itin) {
  const out = [];
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      if (item.kind === "spot" && item.place) {
        out.push(confidenceOf("hours", item.place));
      } else if (item.kind === "transit") {
        out.push(confidenceOf("travel", item));
      }
    }
  }
  return out;
}

/**
 * 旅程に混ざっている情報のうち、いちばん古いものの鮮度。
 *
 * 平均を出しても意味がありません。10件のうち9件が今日のもので、
 * 1件が3年前なら、その旅程で困るのは3年前の1件です。
 */
function oldestFreshness(itin) {
  let oldest = null;
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      const at = item.place?.fetchedAt;
      if (!Number.isFinite(at)) continue;
      if (oldest === null || at < oldest) oldest = at;
    }
  }
  return freshnessOf(oldest);
}

/** 案を選び直します。経路と天気は、選ばれた案にだけ取りにいきます。 */
async function switchVariant(key) {
  if (!state.plans?.length || key === state.trip?.__variantKey) { /* 続行 */ }
  const progress = $("#progress");
  $("#result").hidden = true;
  $("#progress").hidden = false;
  progress.textContent = "";
  state.planAbort?.abort();
  const ctrl = new AbortController();
  state.planAbort = ctrl;
  try {
    const itin = await finishPlan(key,
      (step, note, extra) => {
        renderProgress(progress, step, note, {
          trip: state.chosenTrip ?? state.trip,
          stars: () => state.kb?.spots?.slice(-MAX_SKETCH_STARS) ?? [],
          tileUrl: TILE_URL, attribution: TILE_ATTRIBUTION,
          ...(extra ?? {}),
        });
        addCancel(progress, ctrl);
      }, ctrl.signal);
    ctrl.signal.throwIfAborted();
    showRoutesUsage();
    state.trip = state.chosenTrip;
    syncFormTo(state.chosenTrip);
    show(itin, state.chosenTrip);
  } catch (e) {
    progress.textContent = "";
    $("#progress").hidden = true;
    $("#result").hidden = false;
    // やめたときは、選び直す前の旅程に戻すだけです。
    if (!ctrl.signal.aborted) showError(e.message ?? String(e));
  } finally {
    if (state.planAbort === ctrl) state.planAbort = null;
  }
}

/**
 * 旅行中モードに入る・出る（js/tripmode.js）。
 *
 * 入ると、画面は「今日の旅」の札だけになります（css の
 * body[data-trip-mode]）。旅程は端末に覚えておくので、閉じて開き
 * 直しても旅行中の画面から始まります。出ると、ふだんの結果の画面に
 * 戻ります（旅程はそのままです）。
 */
function setTripMode(on, itin, trip) {
  state.tripMode = on;
  applyTripModeView();
  if (on) saveTripMode(itin, trip);
  else clearTripMode();
  renderTodayBox(itin, trip);
  if (on) showView("result");
  else globalThis.scrollTo?.({ top: 0, behavior: scrollBehavior() });
}

function applyTripModeView() {
  if (state.tripMode) document.body.dataset.tripMode = "on";
  else delete document.body.dataset.tripMode;
}

/**
 * 「今日の旅」を出すかどうかを決め、出します。
 * 旅の当日でなければ、何も出しません（当日でないのに
 * 「次はここです」と出しても、混乱するだけです）。
 */
function renderTodayBox(itin, trip) {
  const box = $("#today");
  if (!box) return;
  const now = new Date();
  const first = itin.days?.[0]?.date;
  const last = itin.days?.at(-1)?.items?.at(-1)?.end ?? itin.days?.at(-1)?.date;
  const during = first && last
    && now >= new Date(new Date(first).setHours(0, 0, 0, 0))
    && now <= new Date(new Date(last).getTime() + 6 * 3600000);
  // 旅行中モードにしたら、当日でなくても出します（前日に試す人がいます）。
  box.hidden = !during && !state.tripMode;
  if (box.hidden) return;

  // 遅れているかどうか。押された「着いた」から数えます。
  itin.catchUp = state.arrivedAtId
    ? catchUp(itin, now, { endBy: trip.arriveBy,
                           arrivedAtId: state.arrivedAtId })
    : null;

  renderToday(box, itin, trip, {
    now,
    tripMode: state.tripMode,
    onTripMode: (on) => setTripMode(on, itin, trip),
    // 現在地から分かったこと（js/arrive.js）。**旅程は変えません。**
    arrivedHint: state.today.hint,
    notifyOn: Boolean(state.today.notices),
    watchOn: Boolean(state.today.watch),
    todayNote: state.today.note,
    // 次の区間だけを引き直した結果（js/nextleg.js）。旅程は変えません。
    requeried: state.today.requeried,
    requerying: state.today.requerying,
    onArrived: (id) => {
      state.arrivedAtId = id;
      // 押されたら、その場所の知らせは役目を終えます。
      state.today.hint = null;
      renderTodayBox(itin, trip);
    },
    onNotify: async (want) => {
      state.today.note = "";
      state.today.notices?.stop();
      state.today.notices = null;
      if (!want) { renderTodayBox(itin, trip); return; }
      const ok = await askNotifyPermission();
      if (!ok.ok) {
        state.today.note = ok.why;
        renderTodayBox(itin, trip);
        return;
      }
      const list = scheduleNotices(itin, new Date());
      state.today.notices = armNotices(list, {
        show: ({ title, body }) => {
          try {
            // eslint-disable-next-line no-new
            new Notification(title, { body, tag: "tabisaki-next" });
          } catch { /* 鳴らせなくても、画面は動き続けます */ }
        },
      });
      if (!state.today.notices.count) {
        state.today.note = "この先に、知らせる予定がありませんでした。";
      }
      renderTodayBox(itin, trip);
    },
    // 次の区間だけを、いまの時刻で引き直します。
    //
    // 旅程ぜんぶを組み直すと1〜2分かかり、**残りの旅程が別のものに
    // 変わります**。10分遅れただけの人が払う代償としては大きすぎます。
    // 聞くのは1回、変えるのはその行の説明だけです。
    onRequery: async () => {
      if (state.today.requerying) return;
      state.today.requerying = true;
      state.today.note = "";
      renderTodayBox(itin, trip);
      let got = null;
      try {
        got = await requeryNextLeg(itin, async (from, to, when) => {
          try {
            return await searchYahooTransit(from, to, {
              departAt: when,
              modes: yahooFlags(trip.transport ?? "any"),
            });
          } catch {
            return null;
          }
        });
      } finally {
        state.today.requerying = false;
      }
      state.today.requeried = got?.note ?? null;
      if (!got) {
        // 何が足りないのかで、言うことが変わります。
        state.today.note = "次の便を調べ直せませんでした"
          + "（この先に電車・バスの区間が無いか、時刻表に届きませんでした）。";
      }
      renderTodayBox(itin, trip);
    },
    onWatchArrival: (want) => {
      state.today.note = "";
      state.today.watch?.stop();
      state.today.watch = null;
      state.today.hint = null;
      if (!want) { renderTodayBox(itin, trip); return; }
      state.today.watch = watchArrival({
        // 組み直されても追いつけるよう、そのつど今の旅程を渡します。
        // 組み直すと renderTodayBox がまた呼ばれ、見張りは
        // 作り直されます。ここは今の旅程を見ていれば足ります。
        getItinerary: () => itin,
        onArrive: (found) => {
          state.today.hint = found;
          renderTodayBox(itin, trip);
        },
        onDeny: (why) => {
          state.today.note = why;
          state.today.watch?.stop();
          state.today.watch = null;
          renderTodayBox(itin, trip);
        },
      });
      renderTodayBox(itin, trip);
    },
    onCatchUp: (actions) => {
      // 短縮と削除を、条件の書き換えに直します。組み直しは
      // これまでと同じエンジンが行います。
      const drop = actions.filter((a) => a.kind === "drop" && a.spotId)
        .map((a) => a.spotId);
      const next = {
        ...state.trip,
        must: {
          ...state.trip.must,
          spotIds: [...(state.trip.must?.spotIds ?? [])],
          avoidSpotIds: [...new Set([
            ...(state.trip.must?.avoidSpotIds ?? []), ...drop])],
        },
        pace: "packed", paceChosen: true,
      };
      state.editNote = itin.catchUp.summary;
      state.trip = next;
      syncFormTo(next);
      run(next);
    },
  });
}

function show(itin, trip) {
  $("#progress").hidden = true;
  $("#result").hidden = false;
  // 直前に言葉で直した内容を、組み直したあとの画面にも残します
  itin.editNote = state.editNote ?? "";
  state.editNote = "";
  // 並べ替えの結果なら、前の旅程と比べた差を添えます。組み直しが
  // 失敗して別の操作の結果が来たときは、比べません（別物どうしです）。
  const from = state.orderFrom;
  state.orderFrom = null;
  itin.orderDiff = from && from.trip === trip ? orderDiff(from.itin, itin) : null;
  // 外した場所は、名前を残しておきます。押し間違えたときに戻せないと、
  // 「外す」を押すのが怖くなり、結局使われません。
  itin.dropped = (trip.must?.avoidSpotIds ?? [])
    .map((id) => state.kb?.spotsById?.get(id))
    .filter(Boolean)
    .map((s) => ({ id: s.id, name: s.name }));

  // なぜこの旅程なのか、どれくらい余裕があるのか、情報はどこから来たのか。
  // どれもプログラム側で数えます（AIには採点させません）。
  itin.fit = tripFit(itin, trip);
  itin.pace = paceBreakdown(itin);
  itin.slack = slackLevel(itin.days?.at(-1)
    ? Math.round((trip.arriveBy - lastEnd(itin)) / 60000) : null);
  itin.sourceMix = describeSource(collectSources(itin));
  // 「確認済み」と「最新」は別のことなので、分けて出します。
  // いちばん古い1件を、旅程全体の鮮度とします。
  itin.freshness = oldestFreshness(itin);

  // スポットごとの「選んだ理由」も、軸つきにします。
  let prev = null;
  for (const day of itin.days ?? []) {
    for (const item of day.items ?? []) {
      if (item.kind !== "spot" || !item.place) continue;
      item.fit = spotFit(item.place, trip, {
        at: item.start,
        fromKm: prev ? haversineKm(prev, item.place) : undefined,
      });
      prev = item.place;
    }
  }

  // 旅の当日は、「今日の旅」を旅程の上に出します。
  // 当日に知りたいのは、次に何をすればいいかだけです。
  //
  // 組み直したら、当日のしたくは**いったん全部やめます**。前の旅程の
  // 時刻で仕掛けた知らせがそのまま残ると、消したはずの立ち寄りの
  // 出発時刻に鳴ります。押し直してもらうほうが確かです。
  state.today.watch?.stop();
  state.today.notices?.stop();
  state.today = { watch: null, notices: null, hint: null, note: "",
                  requeried: null, requerying: false };
  renderTodayBox(itin, trip);

  renderItinerary($("#itinerary"), itin, trip, {
    onBack: () => {
      $("#result").hidden = true;
      $("#placeholder").hidden = false;
    },
    onShare: () => shareConditions(trip),
    onShareTrip: () => shareTripLink(itin, trip),
    onExport: () => exportTrip(itin, trip),
    onDay: (index) => state.map.showDay(index),
    onHover: (item, on) => state.map.highlight(item.spotId, on),
    onSuggest: applySuggestion,
    onAdjust: adjustPlan,
    onVariant: (key) => switchVariant(key),
    onEdit: (text) => editPlan(text, itin, trip),
    onReplan: (picked) => {
      // 選ばれたぶんだけ条件に足して、同じ手順で組み直します。
      const next = applyReplan(trip, picked);
      syncFormTo(next);
      state.trip = next;
      state.editNote = picked.length === 1
        ? picked[0].text
        : `天気・日没・混雑から ${picked.length}件 を反映して組み直しました。`;
      run(next);
    },
    onSpotEdit: (req) => editSpot(req, trip, itin),
    // 回る順と、いる時間。どちらも条件を書き換えて組み直します。
    onSpotOrder: (req) => reorderSpots(req, trip, itin),
    onSpotDwell: (req) => tuneDwell(req, trip),
    onRestore: (d) => restoreSpot(d, trip),
    // 「まだ目安があります」への答え。同じ条件で組み直します。
    // 引けなかった区間だけをもう一度聞く仕組みは持っていないので、
    // 素直に組み直します（時刻表に聞く回数と間隔は組むたびに
    // 数え直すので、混んでいて外した区間が入ることがあります）。
    onRecheck: () => run(trip),
    onSpot: openSpotSheet,
    // 当日でなく「今日の旅」が出ていないときは、旅程の上から入れます。
    onTripMode: $("#today")?.hidden ? () => setTripMode(true, itin, trip) : null,
  });

  // 旅行中モードで開き直したときは、一覧に足し直しません（足すと、
  // 開くたびに一覧のいちばん上へ動きます）。
  if (!itin.restored) rememberTrip(itin, trip);
  // 旅行中モードのまま組み直した（「削る」など）ら、新しいほうを覚えます。
  if (state.tripMode) {
    if (!itin.restored) saveTripMode(itin, trip);
    applyTripModeView();
    showView("result");
  }

  // ピンを押したときも、旅程の行と同じシートを開きます（往復できます）。
  const points = pointsFromItinerary(itin, trip, { onSpot: openSpotSheet });
  state.map.render(points);
  state.map.invalidate();
  // 広い画面では地図が旅程の横に固定されます。読み進めた行の印を、
  // 地図の側でも濃くします（js/follow.js）。狭い画面では地図は上に
  // あって読んでいるあいだは見えないので、動かしません。
  state.stopFollow?.();
  state.stopFollow = sideMapLayout()
    ? followReading($(".pane-result"),
        () => document.querySelectorAll("#itinerary .tl.spot[data-spot]"),
        (id) => state.map.follow(id))
    : null;
  // 背景の地図も、その旅先へ寄せます。左で条件を直しているあいだも
  // 「いまどこの話をしているか」が背後に残ります。
  const first = points.find((p) => p.kind === "spot") ?? points[0];
  if (first) moveBackgroundMap(first.lat, first.lng, 9);
}

/** 地図を旅程の横に固定する幅か（css/app.css の同じ値と揃えます）。 */
function sideMapLayout() {
  return Boolean(globalThis.matchMedia?.("(min-width: 1360px)")?.matches);
}

/**
 * 立ち寄り1件の説明を開きます。旅程の行からも、地図のピンからも。
 *
 * 携帯では、地図は旅程の上にあります。下のほうの立ち寄りを押すと、
 * ピンは寄っているのに**画面の外**、という状態になっていました。
 * 押されたら地図を画面に入れてから、シートを半分の高さで開きます
 * （上半分に地図が残ります。ui.js の dragSheet）。
 */
function openSpotSheet(item) {
  const id = item.spotId ?? item.place?.id;
  if (item.place) {
    state.map.focus(item.place.lat, item.place.lng);
    state.map.highlight(id, true);
  }
  if (isNarrow()) {
    $("#map")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }
  openSheet(item, {
    describe: (sp) => describeSpot(sp),
    onClose: () => state.map.highlight(id, false),
  });
}

document.addEventListener("DOMContentLoaded", boot);
