// 画面の描画。DOM 操作はここに閉じ込め、ロジックは他のモジュールに任せます。

import { directionsFromHereUrl, linksForItem, mapsSearchUrl } from "./links.js";
import { TIER_LABEL } from "./mix.js";
import { profileOf } from "./feasibility.js";
import { crowdLevel } from "./crowd.js";
import { describeHours, hoursFor } from "./hours.js";
import { describeTransit } from "./transit.js";
import { artFor } from "./art.js";
import { confidenceOf, describeSource, freshnessOf, reservationOf }
  from "./confidence.js";
import { paceBreakdown, slackLevel } from "./score.js";
import { VARIANTS } from "./variants.js";
import { qualityOf, spotFit, tripFit } from "./fit.js";
import { currentStep } from "./today.js";
import { photoFor, photoPageOf } from "./photos.js";
import { estimatedTravel } from "./reliability.js";
import { isTouring, longDriveNote, restSlots } from "./touring.js";
import { itineraryText } from "./share.js";
import { KIND_NOTE } from "./modes.js";
import { icon } from "./icons.js";
import { NOTICE_LIMITS } from "./notify.js";
import { describeOrderDiff } from "./orderdiff.js";
import { laterToday } from "./tripmode.js";

// 行の先頭の記号の「名前」です。形は js/icons.js が持っています。
//
// もとは絵文字（🚃 📍 🍽 …）でした。同じ旅程が iPhone と Android で
// 別の顔になり、多色の絵だけが画面から浮き、17px でも大きさが
// そろいませんでした。名前だけをここに置きます。
const ICON = {
  transit: "transit", spot: "spot", meal: "meal", lodging: "lodging",
  free: "free", luggage: "luggage",
  // 日をまたいで着いた朝の目印（夜行・長距離フェリー・深夜便）。
  arrive: "arrive",
};

/** 行の先頭の記号の名前。乗り物は、乗るものによって変えます。 */
function iconFor(item, itin) {
  if (item.kind === "transit") {
    if (item.taxi) return "taxi";
    if (item.walk) return "walk";
    // 区間ごとに乗るものが違う旅（電車＋現地の車）では、区間の側が
    // 答えを持っています。持っているほうを先に見ます。
    if (item.drive === true) return "car";
    if (itin?.transport === "transit+car") return "transit";
    // 車の旅で電車の記号を出すと、乗り換えを探すことになります。
    if (isTouring(itin)) return "car";
  }
  return ICON[item.kind] ?? "dot";
}

/**
 * 「動きを減らす」設定にしているか。
 *
 * CSS は prefers-reduced-motion に対応していますが、**JS が起こす
 * 動きには効きません。** スクロールの behavior:"smooth"、地図の
 * setView、シートの絵の視差——どれも設定に関わらず動いていました。
 *
 * 毎回読み直します。設定はページを開いたままでも変えられます。
 */
export function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
      ?.matches === true;
  } catch {
    return false;
  }
}

/**
 * スクロールの動きかた。
 *
 * 動きを減らす設定なら "auto"（ぱっと移る）にします。**行く先は
 * 同じです。** 滑らかに動かないだけで、できることは減りません。
 */
export function scrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDay(d) {
  // 保存から戻した旅程では文字列で届くことがあります。見出し1つの
  // ために画面ごと落とすより、読める形にして出します。
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ja-JP",
    { month: "long", day: "numeric", weekday: "short" });
}

export function fmtDuration(min) {
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    const lowerK = k.toLowerCase();
    if (lowerK === "class") node.className = v;
    // html: の逃げ道は置きません。
    //
    // 一度でも innerHTML の入口を作ると、いつか誰かが AI の返答や
    // 外部データをそこへ通します。このアプリは、AIの文・Wikipediaの
    // 抜粋・利用者の入力を画面に出します。全部が入口になり得ます。
    //
    // テキストしか入らない作りにしておけば、その心配ごと自体が
    // 無くなります。強調や改行が要るときは、要素を分けてください。
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
          // XSS防止: href への javascript: の埋め込みを防ぐ
          // AIや外部データからのURLに悪意のあるコードが含まれていても発火しないようにします
          node.setAttribute(k, "about:blank");
        } else {
          node.setAttribute(k, strV);
        }
      }
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * 既にある要素に、子を足します。
 *
 * el() は「無いもの（null）は足さない」を守っていますが、素の
 * node.append() は違います。DOM の append は Node でないものを
 * **文字列にして**足すので、null を渡すと画面に「null」という
 * 4文字が出ます。実際、外した場所が1つも無い旅程では、
 * 「言葉で直す」の下に null と表示されていました
 * （droppedList() は、戻すものが無ければ null を返します）。
 *
 * 呼ぶ側で .filter(Boolean) を書けば防げますが、130 か所ある
 * append のどれか1つで書き忘れると、また画面に出ます。書き忘れ
 * ようのない足しかたを1つ用意して、そちらを使います。
 *
 * @param {Node} node   足す先
 * @param {...any} children 足すもの（null・undefined・false は飛ばします）
 * @returns {Node} node（続けて書けるように、そのまま返します）
 */
export function put(node, ...children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// --- 進行状況 ---------------------------------------------------------------

export const STEPS = [
  "ご希望を読み取っています",
  "候補地を探しています",
  "AIが旅程の案を作っています",
  "各スポットの時間を確認しています",
  "確認結果をもとに調整しています",
  "経路と時刻を組み立てています",
];

/**
 * 6つの段を、利用者にとっての3つの区切りにまとめたもの。
 *
 * 6段の一覧だけだと、どれも同じ太さの行で、「いまどこか」は小さな
 * 丸の色でしか分かりませんでした。待っている人が知りたいのは
 * 「いま何をしていて、全体のどのあたりか」なので、大きな区切りを
 * 札のいちばん上に出し、細かい6段はその下に残します。
 */
export const PHASES = [
  { label: "行き先えらび", doing: "行き先を選んでいます", steps: [0, 1, 2] },
  { label: "時間の照合", doing: "営業時間と照合しています", steps: [3, 4] },
  { label: "経路と時刻", doing: "経路と時刻を組んでいます", steps: [5] },
];

/** 段（0〜5）が、3つの区切りのどこにあたるか。 */
export function phaseOf(step) {
  const s = Math.max(0, Math.min(step, STEPS.length - 1));
  return PHASES.findIndex((p) => p.steps.includes(s));
}

/**
 * 待っているあいだの画面。
 *
 * 回る輪だけだと、進んでいるのか固まったのかが分かりません。
 * いま何をしていて、あと何が残っているかを、そのまま並べます。
 * ピンが生えて波紋が広がるのは、地図が育っている合図です。
 */
/**
 * これを過ぎたら、なぜ待たされているのかを書きます。
 *
 * 遅い理由は、電車の時刻を1区間ずつ実際に調べているからです。それを
 * 黙っていると「固まった」に見えます。書いてあれば、待つ理由になります。
 */
const SLOW_AFTER_SEC = 40;

// 待ち画面の絵（js/sketch.js）と .ics の書き出し（js/ical.js）は、
// 開いた直後には要りません。静的に import すると、フォームを出すだけの
// 起動でも毎回取りに行って読み解くので、使う場面で初めて読みます。
// 圏外でも sw.js が先に入れてあるので読めます。
let sketchModule = null;
let icalModule = null;
export const loadSketch = () => (sketchModule ??= import("./sketch.js"));
const loadIcal = () => (icalModule ??= import("./ical.js"));

const fmtElapsed = (sec) =>
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export function renderProgress(container, step, detail = "", extra = null) {
  // 作り直さず、書き換えます。
  //
  // 以前は毎回 textContent = "" で消して組み直していました。段が進む
  // たびに画面がちらつき、経過時間のような**動き続けるもの**は置け
  // ませんでした（作り直した瞬間に止まるので）。
  let card = container.querySelector(".plan-card");
  if (!card) {
    container.textContent = "";
    card = el("div", { class: "plan-card" });
    card.append(
      el("ol", { class: "phase-row", "aria-label": "旅程づくりの進み具合" },
        PHASES.map((p, i) => el("li", {},
          el("span", { class: "phase-num", "aria-hidden": "true" }, String(i + 1)),
          el("span", { class: "phase-label" }, p.label)))),
      el("p", { class: "step-count" }, ""),
      el("p", { class: "step-text" }, "旅を組み立てています"),
      el("p", { class: "step-detail" }, ""),
      el("div", { class: "md-progress", role: "progressbar",
                  "aria-valuemin": "1", "aria-valuemax": String(STEPS.length) },
        el("i", { style: "width:0%" })),
      el("ul", { class: "step-list" },
        STEPS.map((s) => el("li", {}, el("span", { class: "dot" }),
                                      el("span", {}, s)))),
      el("p", { class: "step-elapsed" },
        el("span", { class: "step-clock" }, "0:00"),
        el("span", { class: "step-slow" }, "")),
    );
    container.append(card);
    startClock(container, card);
    // 待っているあいだに、旅が形になっていくのを見せます（js/sketch.js）。
    // 出発地・読み込まれた収録・候補・決まった順を、本物の座標で描きます。
    // 6段の一覧と経過時間だけでは、止まっていないことは分かっても
    // 何が起きているのかは分かりませんでした。
    //
    // **札を画面に置いてから**載せます。絵は「札が画面から消えたら
    // 止まる」作法で動くので、置く前に載せると最初の1コマで自分から
    // 止まります（実際そうなって、何も描かれませんでした）。
    //
    // 絵のモジュールは遅れて届きます。届くまでに来た材料は
    // __sketchPending に貯めて、載せた直後にまとめて渡します。
    if (extra?.trip) {
      card.__sketchPending = {};
      const ctx = {
        trip: extra.trip,
        // 地の形。点だけでは「どこを探しているのか」が読めません。
        // 地図が読めない環境では、これまでどおり点と線だけになります。
        tileUrl: extra.tileUrl ?? null,
        attribution: extra.attribution ?? "",
      };
      loadSketch().then(({ mountSketch }) => {
        // 届く前に旅程ができて札が消えていたら、載せません。
        if (!card.isConnected) return;
        card.__sketch = mountSketch(card, ctx);
        card.__sketch.update(card.__sketchPending);
        card.__sketchPending = null;
      }).catch(() => {
        // 絵が無くても、段の一覧と経過時間で待てます。
        card.__sketchPending = null;
      });
    }
  }

  card.querySelector(".step-detail").textContent =
    detail || STEPS[Math.min(step, STEPS.length - 1)];
  // いまの区切りを、札の見出しにします。
  const ph = phaseOf(step);
  card.querySelector(".step-text").textContent = PHASES[ph].doing;
  card.querySelector(".step-count").textContent =
    `${PHASES.length}つのうち${ph + 1}つ目・${PHASES[ph].label}`;
  card.querySelectorAll(".phase-row li").forEach((li, i) => {
    li.className = i < ph ? "done" : i === ph ? "active" : "";
    if (i === ph) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
    li.firstChild.replaceChildren(...(i < ph ? [icon("check")] : [String(i + 1)]));
  });
  // 絵に、いまの段と材料を渡します。
  if (card.__sketch || card.__sketchPending) {
    const patch = { step };
    if (extra?.stars) patch.stars = extra.stars;
    if (extra?.picks) patch.picks = extra.picks;
    if (extra?.route) patch.route = extra.route;
    if (card.__sketch) card.__sketch.update(patch);
    else Object.assign(card.__sketchPending, patch);
  }
  const bar = card.querySelector(".md-progress");
  bar.setAttribute("aria-valuenow", String(step + 1));
  bar.querySelector("i").style.width =
    `${((step + 1) / STEPS.length) * 100}%`;
  card.querySelectorAll(".step-list li").forEach((li, i) => {
    li.className = i < step ? "done" : i === step ? "active" : "";
    li.lastChild.textContent = STEPS[i];
    // 済んだ段の印。以前は色の付いた丸だけで、**色でしか区別が
    // 付きませんでした**。丸の中にチェックを入れます。文字の「✓」では
    // なく、ほかの記号と同じ線で描いたものです（js/icons.js）。
    li.firstChild.replaceChildren(...(i < step ? [icon("check")] : []));
  });
}

/**
 * 経過時間を数えます。
 *
 * 段は6つしかないので、最後の段に入ってからが長く感じます。実際、
 * 全区間の時刻を調べるあいだは1分以上動きません。時計が動いていれば、
 * 止まっていないことだけは分かります。
 *
 * 止めかたは「札が画面から消えたら」です。組み上がると app.js が
 * #progress を隠すので、そこで自分から終わります。呼ぶ側に後始末を
 * 頼むと、いつか誰かが忘れて、裏で数え続けます。
 */
function startClock(container, card) {
  const began = Date.now();
  const clock = card.querySelector(".step-clock");
  const slow = card.querySelector(".step-slow");
  const id = setInterval(() => {
    if (!card.isConnected || container.hidden) { clearInterval(id); return; }
    const sec = Math.floor((Date.now() - began) / 1000);
    clock.textContent = fmtElapsed(sec);
    if (sec >= SLOW_AFTER_SEC && !slow.textContent) {
      slow.textContent = "電車とバスの時刻を、1区間ずつ実際に調べています。"
        + "目安で埋めずに待つぶん、少し時間がかかります。";
    }
  }, 1000);
}

// --- 旅程 -------------------------------------------------------------------

export function renderItinerary(container, itin, trip, handlers = {}) {
  container.textContent = "";

  // 出す順を、読む順に合わせます。
  //
  // 以前は、作った順（要約→適合度→ペース→出典→点数→混雑→費用→…→旅程）
  // に積んでいました。豪華ではあるのですが、旅行者が最初に見たいのは
  // 「で、何時にどこへ行くのか」です。それが20個の分析パネルの下に
  // あると、たどり着く前に読むのをやめます。
  //
  //   要約 → 3案 → 旅程 → 言葉で直す → （折りたたみ）詳しく見る
  //
  // 分析は消しません。畳んでおくだけです。
  const detail = [];
  let adjustBox = null;
  let talkBox = null;
  let variantsBox = null;

  // 日数は「並んでいる日の数」ではなく、初日から最終日までの日付の差です。
  // 予定が何も入らなかった日（連泊のみの日）は表に出さないので、
  // 数えると1日足りなくなります。
  const nights = itin.days.length
    ? Math.round((itin.days.at(-1).key - itin.days[0].key) / 86400000)
    : 0;
  const title = itin.title ?? itin.regionName;
  // 見出しと同じことを繰り返さない（AIが見出しを付けなかった場合の控え）
  const sub = itin.headline && !itin.headline.startsWith(title)
    ? itin.headline : itin.prefecture;

  // 保存した旅程を開いているとき。
  //
  // そのまま出すのは、そのほうが「保存した」と言えるからです。ただし
  // 営業時間も混雑も日が変われば変わるので、**いつ作ったものか**は
  // 添えます。作り直したくなったときの入口も、ここに置きます。
  if (itin.savedAt) {
    const when = new Date(itin.savedAt);
    const line = el("p", { class: "fine" },
      `${when.getFullYear()}年${when.getMonth() + 1}月${when.getDate()}日`
      + "に保存した旅程です。営業時間や混雑は、そのときのものです。");
    const box = el("section", { class: "panel saved-note" }, line);
    if (itin.onRebuild) {
      const go = el("button", { type: "button", class: "md-chip md-chip--assist md-state" },
                    "いまの条件で作り直す");
      go.addEventListener("click", () => itin.onRebuild());
      box.append(go);
    }
    container.append(box);
  }

  put(container,
    el("header", { class: "itin-head" },
      el("h2", {}, title),
      el("p", { class: "sub" }, sub),
      // 宿をどう取る旅か。連泊なら、そう書きます。
      //
      // 「松江 2日 → 出雲 1日」だけでは、宿を動かすのかどうかが
      // 分かりません。連泊はそこが要点なので、1行で言います。
      stayLine(itin)));

  // 旅行中モードの入口（当日は「今日の旅」の札の中にあります）。
  if (handlers.onTripMode) {
    const go = el("button", {
      type: "button", class: "md-chip md-chip--assist md-state trip-mode-entry",
    }, el("span", {}, "旅行中モードで開く"));
    go.addEventListener("click", () => handlers.onTripMode());
    container.append(go);
  }

  // 回る順を変えた直後なら、前と比べて移動がどう変わったかを出します。
  // 新しい旅程が出るだけでは、入れ替えて得だったのかが分かりません。
  const change = describeOrderDiff(itin.orderDiff);
  if (change) {
    container.append(el("section", {
      class: `panel order-diff order-diff--${change.tone}`, role: "status",
    },
      el("p", { class: "order-diff-head" },
        el("span", { class: "order-diff-badge" },
          change.tone === "better" ? "短くなりました"
            : change.tone === "worse" ? "長くなりました" : "移動は同じです"),
        el("b", {}, change.head)),
      ...change.lines.map((t) => el("p", { class: "fine" }, t))));
  }

  // 判断を、数字より先に置きます。
  //
  // 「無理のなさ 82/100」だけを見せても、82が良いのか悪いのかは
  // 読み手には決められません。まず「ゆとりあり」と言い切って、
  // 数字はその根拠として添えます。
  const verdict = summaryVerdict(itin);

  container.append(...[
    el("div", { class: "summary" },
      verdict
        ? el("p", { class: `verdict lv-${verdict.level}` },
            el("strong", {}, verdict.label),
            el("span", {}, verdict.detail))
        : null,
      itin.rationale ? el("p", { class: "why" }, itin.rationale) : null,
      el("div", { class: "stats" },
        stat(nights > 0 ? `${nights}泊${nights + 1}日` : "日帰り", "日程"),
        stat(`${itin.spotCount}か所`, "立ち寄り"),
        nights > 0
          ? stat(fmtDuration(sightseeingMinutes(itin)), "見学の合計")
          : stat(fmtDuration(tripMinutes(itin)), "所要"),
        // 何人ぶんの金額なのかを書きます。人数を選べるようにしたので、
        // 「¥34,000」とだけ出すと、ひとりぶんか合計か分かりません。
        itin.cost
          ? stat(`¥${itin.cost.total.toLocaleString()}`,
                 (itin.people ?? 1) > 1
                   ? `概算費用（${itin.people}人ぶん）` : "概算費用")
          : stat(itin.usedRoutesApi ? "実経路" : "推定", "移動時間"),
        // 歩く量は、行けるかどうかを左右します。「約8,400円」と同じ
        // 高さに置かないと、当日になって気づくことになります。
        //
        // 名前は「歩く量」ではなく「移動での歩き」です。数えているのは
        // **場所と場所のあいだ**を歩く区間だけで、着いた先の境内や
        // 庭園を歩く量は入っていません（そこは誰も測っていないので、
        // 足せば作り話になります）。「歩く量」と書くと1日の合計に
        // 読めて、実際より少ない数を信じさせてしまいます。
        walkSteps(itin)
          ? stat(`約${walkSteps(itin).toLocaleString()}歩`, "移動での歩き")
          : null,
        // このアプリの値打ちは「AIが旅程を書けること」ではなく、
        // **実際に行けるかを確かめてあること**です。確かめた事実は
        // 旅程の中に散らばっていて見えないので、1か所に集めて出します。
        itin.reliability
          ? stat("★".repeat(itin.reliability.stars)
              + "☆".repeat(5 - itin.reliability.stars), "確かめた度合い")
          : null)),
  ].filter(Boolean));

  // 0. 何を確かめたのか。
  //
  //    「AIが作った旅行プラン」と「実際に行けるか確かめた旅行プラン」の
  //    違いは、ここが見えるかどうかです。畳みません。
  if (itin.reliability) {
    const r = itin.reliability;
    container.append(el("section", { class: `panel checked lv-${r.level}` },
      el("div", { class: "panel-head" },
        el("h3", {}, "確かめたこと"),
        // 星は1つずつの要素にします。まとめて "★★☆☆☆" と書くと、
        // 1つずつ灯すことも、数を読み上げに渡すこともできません。
        // 星の並びは1つの絵として読ませます。span のままでは名前
        // （aria-label）を付けられず、読み上げには★の羅列が流れます。
        el("span", { class: "checked-stars", role: "img",
                     "aria-label": `5段階で${r.stars}` },
          Array.from({ length: 5 }, (_, i) => el(i < r.stars ? "b" : "i", {
            "aria-hidden": "true", style: `--i:${i}`,
          }, i < r.stars ? "★" : "☆")))),
      el("p", { class: "score-summary" }, r.summary),
      el("ul", { class: "check-list" }, r.checks.map((c) => el("li",
        { class: c.ok ? "ok" : "warn" },
        icon(c.ok ? "check" : "warn", { class: "ck-ic" }),
        el("span", { class: "ck-label" }, c.label),
        el("span", { class: "ck-detail" }, c.detail)))),
      recheckRow(itin, handlers)));
  }

  // 1. 旅の意味づけ。
  //
  //    以前は旅程の**前**に置いていました。最初に知りたいのは
  //    「どこへ行き、何時に何をするか」で、意味づけはそのあとです。
  //    畳んで、読みたい人だけが開けるようにします。
  if (itin.story?.length) {
    detail.push(el("section", { class: "panel story" },
      el("h3", {}, "この旅の流れ"),
      el("ul", { class: "panel-list" },
        itin.story.map((t, i) => el("li", {},
          itin.days.length > 1 ? `${i + 1}日目 — ${t}` : t)))));
  }

  // 1. 3案。旅行に唯一の正解はないので、並べて選んでもらいます。
  //    ただし「どれがおすすめか」は言います。放り出さないこと。
  if (itin.variants?.length > 1 && handlers.onVariant) {
    const box = el("section", { class: "panel variants" });
    variantsBox = box;
    // 「3つの案から選べます」だけだと、選ぶ材料がありません。
    // どれを推すのかを見出しで先に言います。
    const rec = VARIANTS[itin.recommendKey]?.label;
    box.append(el("h3", {}, rec
      ? `あなたには「${rec}」がおすすめです`
      : "3つの案から選べます"));

    const cards = el("div", { class: "variant-cards" });
    for (const v of itin.variants) {
      const def = VARIANTS[v.key] ?? {};
      const card = el("button", {
        type: "button",
        class: `variant md-state${v.key === itin.variantKey ? " is-selected" : ""}`,
        "aria-pressed": v.key === itin.variantKey ? "true" : "false",
      });
      // append は null をそのまま「null」という文字として入れます。
      // 条件つきの要素は、必ずここで落とします。
      //
      // 並べる順は、選ぶときに見る順です。
      //   名前 → 何が違うか → 中身（何か所・移動） → 点
      // 以前は点をいちばん上に大きく出していました。66と68を
      // 見比べても、どちらが自分に合うかは決められません。
      card.append(...[
        el("span", { class: "v-head" },
          icon(def.icon ?? "dot", { class: "v-ic" }),
          el("b", { class: "v-name" }, def.label ?? v.key),
          v.key === itin.recommendKey
            ? el("span", { class: "v-badge" }, "おすすめ") : null),
        v.distinct ? el("span", { class: "v-distinct" }, v.distinct) : null,
        el("span", { class: "v-sum" }, v.summary ?? ""),
        el("span", { class: "v-blurb" }, def.blurb ?? ""),
        Number.isFinite(v.score)
          ? el("span", { class: "v-score" }, `無理のなさ ${v.score}`)
          : null,
      ].filter(Boolean));
      card.addEventListener("click", () => handlers.onVariant(v.key));
      cards.append(card);
    }
    box.append(cards);
    if (itin.recommendWhy) {
      box.append(el("p", { class: "variant-why" }, itin.recommendWhy));
    }
  }

  // 2. なぜこの旅程なのか。軸ごとの点で説明します。
  if (itin.fit) {
    detail.push(el("section", { class: "panel fit" },
      el("div", { class: "panel-head" },
        el("h3", {}, "ご希望との適合度"),
        el("span", { class: "fit-total" },
          el("b", {}, String(itin.fit.total)), el("i", {}, "/100"))),
      el("p", { class: "score-summary" }, itin.fit.summary),
      axisList(itin.fit.axes),
      el("p", { class: "fine" },
        "ご希望のジャンル・移動のしやすさ・混雑の避けやすさ・"
        + "定番と穴場のバランスから、こちらで計算しています"
        + "（AIの採点ではありません）。")));
  }

  // 3. 帰りの余裕と、旅のペース。
  //    「成立している」と「安心して行ける」は別です。
  if (itin.slack || itin.pace) {
    const box = el("section", { class: "panel pace" });
    box.append(el("h3", {}, "この旅のペース"));
    if (itin.slack && itin.slack.level !== "unknown") {
      box.append(el("div", { class: `slack slack--${itin.slack.level}` },
        el("span", { class: "sl-num" }, fmtDuration(itin.slack.minutes)),
        el("span", { class: "sl-body" },
          el("span", { class: "sl-label" },
            `帰りの余裕 — ${itin.slack.label}`),
          el("p", { class: "sl-text" }, itin.slack.text))));
    }
    if (itin.pace?.rows?.length) {
      box.append(el("div", { class: "pace-bar", role: "img",
        "aria-label": itin.pace.rows
          .map((r) => `${r.label} ${fmtDuration(r.minutes)}`).join("、") },
        itin.pace.rows.map((r) =>
          el("i", { class: r.key, style: `width:${r.share}%` }))));
      box.append(el("ul", { class: "pace-legend" },
        itin.pace.rows.map((r) => el("li", {},
          el("span", { class: `dot ${r.key}` }),
          el("b", {}, r.label),
          el("span", {}, fmtDuration(r.minutes))))));
      if (itin.pace.walkKm > 0) {
        box.append(el("p", { class: "fine" },
          `歩く距離はあわせて約 ${itin.pace.walkKm}km です。`));
      }
    }
    detail.push(box);
  }

  // 4. 情報の確からしさ。出どころの違うものを、同じ顔で並べないこと。
  if (itin.sourceMix) {
    detail.push(el("section", { class: "panel sources-mix" },
      el("div", { class: "panel-head" },
        el("h3", {}, "この旅程の情報について"),
        srcChip(itin.sourceMix)),
      el("p", { class: "score-summary" }, itin.sourceMix.text),
      // 何が起きているかを言うだけでなく、どうすればいいかまで書きます。
      // 「AI調査」だけを見せると、「AIが適当に言っている？」と
      // 受け取られます。言いたいのは「まだ裏が取れていない」です。
      itin.sourceMix.action
        ? el("p", { class: "src-action" }, itin.sourceMix.action) : null,
      el("ul", { class: "panel-list src-legend" },
        [["level-verified", "収録データ",
          "収録の実データ、または経路検索・時刻表で取れた値です。"
          + "行く日に変わっていないことまでは、お約束できません。"],
         ["level-estimated", "目安", "分類ごとの目安、または距離からの計算です。"],
         ["level-ai", "AI調査",
          "AIが検索して得た情報で、公式では確認できていません。"
          + "訪問前に公式サイトでご確認ください。"]]
          // 凡例の印は、旅程の中に出るものと**同じ形**にします。
          // 別の絵を並べると、照らし合わせられません。
          .map(([ic, k, v]) => el("li", {}, icon(ic), el("b", {}, k), ` … ${v}`))),
      // 「確認済み」と「最新」は別です。いつ取ったものかを併記します。
      itin.freshness
        ? el("p", { class: `freshness lv-${itin.freshness.level}` },
            itin.freshness.text)
        : null));
  }

  // 旅程の質。AIの自己採点ではなく、こちらで数えた値です。
  // 何点かより「どこが弱いか」が読めることを優先します。
  if (itin.score) {
    const sc = itin.score;
    detail.push(...[el("section", { class: `panel score lv-${scoreClass(sc.total)}` },
      el("div", { class: "panel-head" },
        el("h3", {}, "この旅程の無理のなさ"),
        el("span", { class: "score-total" },
          el("b", {}, String(sc.total)), el("i", {}, "/100"))),
      el("p", { class: "score-summary" }, sc.summary),
      // 疲労は目盛りで出します。「55点」より「やや疲れる」のほうが、
      // 行くか行かないかの判断に使えます。
      el("div", { class: `fatigue lv-${fatigueClass(sc.fatigue)}` },
        el("span", { class: "fg-label" }, "疲労の見込み"),
        el("span", { class: "fg-bar", role: "img",
                     "aria-label": `疲労 ${sc.fatigue} / 100（${sc.fatigueLabel}）` },
          el("i", { style: `width:${sc.fatigue}%` })),
        el("span", { class: "fg-word" }, sc.fatigueLabel)),
      sc.tooHard
        ? el("p", { class: "fg-warn" },
            "この旅程は人にはきつい部類です。"
            + "「もっとゆっくり」で立ち寄りを減らすことをおすすめします。")
        : null,
      el("ul", { class: "score-parts" },
        sc.parts.map((p) => el("li", { class: p === sc.weakest ? "weak" : "" },
          el("span", { class: "sp-label" }, p.label),
          el("span", { class: "sp-bar", role: "img",
                       "aria-label": `${p.label} ${p.score}点` },
            el("i", { style: `width:${p.score}%` })),
          el("span", { class: "sp-num" }, String(p.score)),
          el("span", { class: "sp-note" }, p.note)))),
      el("p", { class: "fine" },
        "移動時間・歩き続ける長さ・日ごとのばらつき・希望との合い方から、"
        + "こちらで計算しています（AIの採点ではありません）。"))].filter(Boolean));
  }

  // 混雑の見込み。実測ではないことを、数字の隣に必ず書きます。
  if (itin.crowd?.perSpot?.length) {
    const c = itin.crowd;
    detail.push(el("section", { class: `panel crowd lv-${levelClass(c.score)}` },
      el("div", { class: "panel-head" },
        el("h3", {}, "混雑の見込み"),
        el("span", { class: "crowd-badge" }, c.label)),
      el("div", { class: "meter", role: "img",
                  "aria-label": `混雑の見込み ${c.score} / 100（${c.label}）` },
        el("i", { style: `width:${c.score}%` })),
      el("ul", { class: "panel-list" },
        c.notes.map((n) => el("li", {}, n))),
      el("p", { class: "fine" },
        "知名度・曜日・時間帯・季節・場所の性格からの推定です（実測ではありません）。")));
  }

  // 費用の内訳
  if (itin.cost?.rows?.length) {
    detail.push(el("section", { class: "panel cost-panel" },
      el("div", { class: "panel-head" },
        el("h3", {}, "この旅のお金の目安"),
        el("span", { class: "cost-total" }, `¥${itin.cost.total.toLocaleString()}`)),
      el("ul", { class: "cost-rows" },
        itin.cost.rows.map((r) => el("li", {},
          el("span", { class: "cr-label" }, r.label),
          el("span", { class: "cr-bar" },
            el("i", { style: `width:${Math.round(r.yen / itin.cost.total * 100)}%` })),
          el("span", { class: "cr-yen" }, `¥${r.yen.toLocaleString()}`),
          el("span", { class: "cr-note" }, r.note)))),
      el("p", { class: "fine" },
        "交通費は距離からの概算、宿泊費は分類ごとの目安です。"
        + "実際の運賃・宿泊費とは差が出ます。予算を決めるときは、"
        + "少し多めに見ておいてください。"
        + ((itin.people ?? 1) > 1
          ? `この合計は${itin.people}人ぶんです。`
            + (itin.cost.cars > 1
              ? `車は${itin.cost.cars}台で数えています。` : "")
          : "")),
      // 数えていないものを、**数えたふりをしません**。
      // 「予算内です」と言われたのに現地で足りない、がいちばん困ります。
      itin.cost.missing?.length
        ? el("p", { class: "fine" },
            `${itin.cost.missing.join("・")}は含んでいません`
            + "（場所ごとに無料と有料が入り混じり、料金を持っていません）。")
        : null));
  }

  // 希望に応えられたかどうか（応えられていれば何も出さない）
  if (itin.coverage && itin.coverage.level !== "ok") {
    const box = el("section", { class: `panel coverage ${itin.coverage.level}` },
      el("h3", {}, itin.coverage.level === "miss"
        ? "ご希望に合う場所が見つかりませんでした"
        : "ご希望の場所は、今回の旅程には入りませんでした"),
      el("p", {}, itin.coverage.text));
    if (itin.coverage.alternatives?.length) {
      box.append(el("div", { class: "alt" },
        itin.coverage.alternatives.map((s) => el("span", {}, s.name))));
    }
    detail.push(box);
  }

  if (itin.verifyNote) {
    detail.push(el("section", { class: "panel verify-note" },
      el("h3", {}, itin.verifyNote.includes("が案を作成")
        ? "AIの案を検証しました" : "案を検証しました"),
      el("p", {}, itin.verifyNote)));
  }

  // その時期ならではのこと。9月の京都と11月の京都は別の旅です。
  if (itin.seasonNotes?.length) {
    detail.push(el("section", { class: "panel season" },
      el("h3", {}, "この時期について"),
      el("ul", { class: "panel-list" },
        itin.seasonNotes.map((t) => el("li", {}, t)))));
  }

  // 荷物。旅程の時刻は合っているのに現地でつらい、という差がここに出ます。
  if (itin.luggage?.days?.length) {
    const box = el("section", { class: "panel luggage" });
    box.append(el("h3", {}, "荷物をどうするか"),
               el("p", { class: "score-summary" }, itin.luggage.summary));
    for (const day of itin.luggage.days) {
      box.append(el("ul", { class: "panel-list" },
        day.options.map((o) => el("li", {},
          el("b", {}, `${o.label} — `), o.text))));
    }
    box.append(el("p", { class: "fine" },
      "ロッカーの空き状況までは分かりません。"
      + "大きい荷物用は数が少ないので、朝のうちが確実です。"));
    detail.push(box);
  }

  // 営業時間まわりの注意。定休日が確認できていない施設をここに出します。
  if (itin.hoursWarnings?.length) {
    detail.push(el("section", { class: "panel notes hours-notes" },
      el("h3", {}, "営業時間のご確認をおすすめします"),
      el("ul", { class: "panel-list" },
        itin.hoursWarnings.map((w) => el("li", {}, w)))));
  }

  if (itin.warnings?.length) {
    detail.push(el("section", { class: "panel notes" },
      el("h3", {}, "お伝えしておくこと"),
      el("ul", { class: "panel-list" },
        itin.warnings.map((w) => el("li", {}, w)))));
  }

  // どこから得た情報かを示します。検索で調べた場合だけ出ます。
  if (itin.sources?.length) {
    detail.push(el("section", { class: "panel sources" },
      el("h3", {}, "調べたときに参照したページ"),
      el("ul", { class: "src-list" },
        itin.sources.map((s) => el("li", {},
          el("a", { href: s.url, target: "_blank", rel: "noreferrer" },
             s.title)))),
      el("p", { class: "fine" },
        "AIが検索して得た情報です。営業時間・料金は必ず公式でご確認ください。")));
  }

  // この旅程の弱点。AIに自己採点させるのではなく、こちらで計算しています。
  if (itin.critique?.length) {
    detail.push(el("section", { class: "panel critique" },
      el("h3", {}, "この旅程について"),
      el("ul", {}, itin.critique.map((c) =>
        el("li", { class: c.level },
          el("span", { class: "c-label" }, c.label),
          el("span", { class: "c-text" }, c.text))))));
  }

  if (itin.suggestions?.length && handlers.onSuggest) {
    detail.push(el("section", { class: "panel relax" },
      el("h3", {}, "この旅をもっと成立させるには"),
      el("div", { class: "relax-list" },
        itin.suggestions.map((s) => suggestionButton(s, handlers.onSuggest)))));
  }

  // 天気・日没・混雑からの見直し。**黙って変えません。**
  // 雨だからと勝手に行き先を差し替えられたら、楽しみにしていた場所が
  // 理由も分からず消えます。理由を添えて出し、押されたら組み直します。
  const rp = itin.replan;
  if (rp && (rp.suggestions?.length || rp.days?.length || rp.notes?.length
             || rp.normals?.text)) {
    const box = el("section", { class: "panel replan" });
    box.append(...[el("div", { class: "panel-head" },
      el("h3", {}, "天気・日没・混雑から見ると"),
      rp.suggestions?.length
        ? el("span", { class: "replan-count" },
            `${rp.suggestions.length}件`)
        : null)].filter(Boolean));

    if (rp.days?.length) {
      box.append(el("ul", { class: "panel-list weather-days" },
        rp.days.map((t) => el("li", {}, t))));
    }

    // 予報の出ない先の旅（16日より先）に、その時期の「ふつう」。
    //
    // **予報ではありません。** 過去の観測の平均です。ここを読み違えると
    // 「10月20日は24℃」になるので、文のほうにも必ず書いてあります
    // （js/normals.js の describeNormals）。
    if (rp.normals?.text) {
      box.append(el("p", { class: "normals" },
        icon("sunset"),
        el("span", {}, rp.normals.text)));
    }

    const picked = new Set();
    if (rp.suggestions?.length) {
      const list = el("ul", { class: "replan-list" });
      for (const s of rp.suggestions) {
        const li = el("li", { class: `rp ${s.kind}` });
        const label = el("label", { class: "rp-pick" });
        const box2 = el("input", { type: "checkbox" });
        box2.addEventListener("change", () => {
          if (box2.checked) picked.add(s); else picked.delete(s);
          go.disabled = picked.size === 0;
          go.textContent = picked.size
            ? `選んだ ${picked.size}件で組み直す` : "組み直す";
        });
        label.append(box2,
          icon({ rain: "rain", sunset: "sunset", crowd: "crowd" }[s.kind]
            ?? "dot", { class: "rp-ic" }),
          el("span", { class: "rp-tx" }, s.text));
        li.append(label);
        list.append(li);
      }
      box.append(list);

      var go = el("button", { class: "rp-go", disabled: true }, "組み直す");
      go.addEventListener("click", () => handlers.onReplan?.([...picked]));
      box.append(el("div", { class: "rp-actions" }, go));
    }

    if (rp.notes?.length) {
      box.append(el("p", { class: "fine" }, rp.notes.join(" ")));
    }
    box.append(el("p", { class: "fine" },
      "選んだものだけを条件に足して、これまでと同じ手順で組み直します。"
      + "押さないかぎり、旅程は変わりません。"));
    detail.push(box);
  }

  // 6. 旅程を直す。作り直しの入口を、旅程のすぐ下に置きます。
  //    条件の画面まで戻らせると、そこで手が止まります。
  //
  //    よくある直しかた（4つのチップ）と、言葉で書く欄を、**1つの箱**に
  //    まとめました。以前は「この旅程を調整する」と「言葉で直す」が
  //    別々の見出しで縦に並んでいて、しかも下に付く断り書きが
  //    ほとんど同じことを言っていました（どちらも「条件を書き換えて
  //    組み直すだけ」）。同じ仕事をする入口が2つに割れていると、
  //    「どっちを使えばいいのか」を考えさせてしまいます。
  //
  //    直しかたは2通りでも、起きることは1つです。断り書きも1つに
  //    します。
  const adjustChips = handlers.onAdjust ? [
    { key: "slower", label: "もっとゆっくり",
      note: "立ち寄りを減らし、1か所あたりの時間を延ばします" },
    { key: "fuller", label: "もっと詰めこむ",
      note: "1日に回る数を増やします" },
    { key: "hidden", label: "もっと穴場に",
      note: "知る人ぞ知る場所の割合を上げます" },
    { key: "classic", label: "定番を中心に",
      note: "誰でも知っている場所を厚くします" },
  ] : [];

  // 言葉で直す。AIは「条件の書き換え」に翻訳するだけで、
  // 旅程そのものは、これまでと同じエンジンが組み直します。
  if (handlers.onEdit) {
    const box = el("section", { class: "panel talk" });
    // 入力欄と押すボタンは、条件の画面と同じ部品にします。
    // 素のブラウザ部品のままだと、ここだけ別のアプリのように見えます。
    const input = el("input", {
      type: "text", id: "edit-text", class: "md-field-input",
      // 390px では、長い例は途中で切れます（「／もう1泊増やして／…」の
      // あたりで見えなくなっていました）。よくある直しかたは上の
      // チップに出ているので、ここは「文で書ける」ことだけ示します。
      placeholder: "例）もう1泊増やして",
      autocomplete: "off", "aria-label": "どう直したいか",
    });
    const field = el("label", { class: "md-field" }, input);
    // 直前に言葉で直した内容があれば、組み直したあとも残します。
    // 何を言ってこうなったのかが分からないと、次の一手が打てません。
    const out = el("p", { class: "talk-out" }, itin.editNote ?? "");
    out.hidden = !itin.editNote;
    const send = el("button", { type: "button",
                                class: "md-btn md-btn--filled md-state talk-go" },
                    el("span", {}, "直す"));
    const go = async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      out.hidden = false;
      out.className = "talk-out";
      out.textContent = "ご要望を読み取っています…";
      try {
        const said = await handlers.onEdit(text);
        out.textContent = said;
      } catch (e) {
        out.className = "talk-out ng";
        out.textContent = String(e?.message ?? e);
      } finally {
        send.disabled = false;
      }
    };
    send.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    put(box,
      el("h3", {}, "旅程を直す"),
      adjustChips.length
        ? el("div", { class: "adjust-row" },
            adjustChips.map((c) => {
              const b = el("button", { type: "button",
                                       class: "md-chip md-chip--assist md-state",
                                       title: c.note }, c.label);
              b.addEventListener("click", () => handlers.onAdjust(c.key));
              return b;
            }))
        : null,
      el("div", { class: "talk-row" }, field, send),
      out,
      droppedList(itin, handlers),
      el("p", { class: "fine" },
        "押しても書いても、することは「条件の書き換え」です。"
        + "旅程はこれまでと同じ手順（営業時間と移動時間の照合）で"
        + "組み直します。AIに旅程を作らせることはしません。"
        + "経路の問い合わせは、採用した案にだけ行われます。"));
    talkBox = box;
  }

  // 「言葉で直す」が出ない画面（onEdit が無い）でも、チップだけは
  // 使えるようにしておきます。まとめたせいで入口ごと消える、という
  // ことにならないように。
  if (!talkBox && adjustChips.length) {
    adjustBox = el("section", { class: "panel adjust" },
      el("h3", {}, "この旅程を調整する"),
      el("div", { class: "adjust-row" },
        adjustChips.map((c) => {
          const b = el("button", { type: "button",
                                   class: "md-chip md-chip--assist md-state",
                                   title: c.note }, c.label);
          b.addEventListener("click", () => handlers.onAdjust(c.key));
          return b;
        })),
      el("p", { class: "fine" },
        "押すと条件を書き換えて、旅程を組み直します。"
        + "経路の問い合わせは、採用した案にだけ行われます。"));
  }

  // --- 日ごと ---
  const sunById = new Map((itin.sun ?? []).map((n) => [n.itemId, n]));
  const daysWrap = el("div", { class: "days" });

  // 何日もある旅程は、日を選べるようにします。
  // 10日ぶんを縦に積むと、目当ての日にたどり着くまでが遠すぎます。
  if (itin.days.length > 1) {
    const tabs = el("div", { class: "day-tabs", role: "tablist",
                             "aria-label": "日を選ぶ" });
    itin.days.forEach((day, i) => {
      const btn = el("button", {
        type: "button", class: `day-tab${i === 0 ? " on" : ""}`,
        role: "tab", "aria-selected": i === 0 ? "true" : "false",
        "aria-controls": `day-${i}`, id: `daytab-${i}`,
      }, el("b", {}, `${i + 1}日目`), el("span", {}, fmtDay(day.date)));
      btn.addEventListener("click", () => selectDay(i));
      tabs.append(btn);
    });
    const all = el("button", { type: "button", class: "day-tab all" },
      el("b", {}, "全日"), el("span", {}, `${itin.days.length}日ぶん`));
    all.addEventListener("click", () => selectDay(-1));
    tabs.append(all);
    daysWrap.append(tabs);

    function selectDay(index) {
      for (const [i, sec] of [...daysWrap.querySelectorAll(".day")].entries()) {
        sec.hidden = index >= 0 && i !== index;
      }
      for (const [i, b] of [...tabs.querySelectorAll(".day-tab")].entries()) {
        const on = i === (index < 0 ? itin.days.length : index);
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      }
      handlers.onDay?.(index);
    }
  }

  itin.days.forEach((day, di) => {
    const section = el("section", {
      class: "day", id: `day-${di}`, role: "tabpanel",
      "aria-labelledby": itin.days.length > 1 ? `daytab-${di}` : null,
    });
    section.hidden = itin.days.length > 1 && di !== 0;
    section.append(el("h3", { class: "day-head" },
      el("b", {}, itin.days.length > 1 ? `${di + 1}日目` : "旅程"),
      el("span", {}, fmtDay(day.date)),
      el("i", {}, dayShape(day))));

    // その日ぜんぶに関わる一言。行ごとの注記とは別に、日の頭に置きます。
    //
    //   passNote  … 同じ会社に何回乗るか（js/tickets.js）
    //   walkLoad  … 移動だけでどれだけ歩くか（js/access.js）
    //
    // walkLoad は書き足されていたのに、**どこにも出していませんでした**。
    // 数えたものを画面に出さないのは、数えていないのと同じです。
    for (const [kind, text] of [["pass", day.passNote],
                                ["walk", day.walkLoad]]) {
      if (!text) continue;
      section.append(el("p", { class: `day-note day-note--${kind}` },
        icon(kind === "pass" ? "ticket" : "walk"),
        el("span", {}, text)));
    }

    const list = el("ol", { class: "timeline" });
    day.items.forEach((item, ii) => {
      list.append(renderItem(item, ii, itin, handlers, sunById.get(item.id)));
    });
    section.append(list);
    daysWrap.append(section);
  });
  // --- ここから並べ直し ---------------------------------------------------
  //
  // 旅程を、いちばん上に置きます。
  //
  // 以前は 3案 が旅程より上にありました。けれど、旅程ができた直後に
  // 知りたいのは「で、何時にどこへ行くのか」です。案を選び直すのは、
  // それを見たあとの話です。順番が逆でした。
  //
  //   要約 → 流れ → 旅程 → 3案 → 旅程を直す → 詳しく見る
  container.append(daysWrap);
  if (variantsBox) container.append(variantsBox);
  if (talkBox) container.append(talkBox);
  if (adjustBox) container.append(adjustBox);
  if (detail.length) {
    const more = el("details", { class: "more" });
    more.append(el("summary", {},
      el("span", {}, "この旅程をくわしく見る"),
      el("span", { class: "more-count" }, `${detail.length}件`)));
    more.append(...detail);
    container.append(more);
  }

  // 旅程を文字で渡す。同行者に送るのは LINE やメールなので、
  // いま画面に出ているとおりの時刻と場所を、そのまま貼れる形にします。
  // 共有シート（navigator.share）がある端末ではそれを開き、無ければ
  // クリップボードに入れます。
  const copyBtn = el("button", {
    type: "button", class: "md-btn md-btn--filled md-state share-text",
  }, el("span", {}, "旅程を送る / コピー"));
  copyBtn.addEventListener("click", async () => {
    const text = itineraryText(itin);
    const label = copyBtn.querySelector("span");
    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare({ text }))) {
        await navigator.share({ title: itin.title ?? "旅程", text });
        return;
      }
      await navigator.clipboard.writeText(text);
      label.textContent = "コピーしました";
    } catch (e) {
      // 共有シートを閉じただけなら、何も言いません。
      if (e?.name === "AbortError") return;
      label.textContent = "コピーできませんでした";
    }
    setTimeout(() => { label.textContent = "旅程を送る / コピー"; }, 2600);
  });

  // カレンダーに入れる。
  //
  // 旅程を作ったあと、旅行者が次にすることはこれです。当日に開くのは
  // このアプリではなくカレンダーだからです。前日の夜に通知が出て、
  // 朝に予定が並んでいる。そこまで届かないと、作った旅程は使われません。
  //
  // .ics は Google・Apple・Outlook がどれも読める形式です。書き出しは
  // ブラウザの中だけで済むので、どこにも送りません。
  const calBtn = el("button", {
    type: "button", class: "md-btn md-btn--tonal md-state cal-ics",
  }, el("span", {}, "カレンダーに入れる"));
  // 押してから取りに行くと、端末によっては「押した直後」の扱いが切れて
  // 保存が止められます。ボタンを出した時点で読み始めておきます。
  loadIcal().catch(() => {});
  calBtn.addEventListener("click", async () => {
    const label = calBtn.querySelector("span");
    let toIcs, icsFilename;
    try {
      ({ toIcs, icsFilename } = await loadIcal());
    } catch {
      icalModule = null;
      label.textContent = "書き出せませんでした";
      setTimeout(() => { label.textContent = "カレンダーに入れる"; }, 2600);
      return;
    }
    const text = toIcs(itin);
    if (!text) { label.textContent = "予定がありません"; return; }
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([text], {
        type: "text/calendar;charset=utf-8",
      }));
      const a = el("a", { href: url, download: icsFilename(itin) });
      a.style.display = "none";
      document.body.append(a);
      a.click();
      // すぐ外すと、端末によっては download の名前が読まれないまま
      // 「download」という名前で保存されます。1拍おいてから外します。
      setTimeout(() => a.remove(), 0);
      label.textContent = "書き出しました";
    } catch {
      label.textContent = "書き出せませんでした";
    } finally {
      // 取り消しは、保存が始まるのを待ってから。すぐ消すと、端末に
      // よっては中身の無いファイルが落ちます。
      if (url) setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    setTimeout(() => { label.textContent = "カレンダーに入れる"; }, 2600);
  });

  container.append(...[el("div", { class: "actions" },
    copyBtn,
    calBtn,
    handlers.onSave
      ? el("button", { type: "button", class: "md-btn md-btn--tonal md-state keep",
                       onClick: (e) => {
          handlers.onSave();
          e.currentTarget.querySelector("span").textContent = "保存しました";
          e.currentTarget.disabled = true;
        } }, el("span", {}, "この旅を保存する"))
      : null,
    el("button", { type: "button", class: "md-btn md-btn--tonal md-state",
                   onClick: handlers.onBack },
      el("span", {}, "条件を変えてつくり直す")),
    el("button", { type: "button", class: "md-btn md-btn--outlined md-state",
                   onClick: () => window.print() },
      el("span", {}, "印刷 / PDFで保存")),
    // **いま画面に出ているとおりの旅程**を、リンクで渡します
    // （js/snapshot.js）。受け取った人の画面にも同じ時刻・同じ場所が
    // 出ます。条件のリンクは、受け取った側で組み直すので別の旅程になります。
    handlers.onShareTrip
      ? el("button", { type: "button",
                       class: "md-btn md-btn--tonal md-state share-trip",
                       onClick: handlers.onShareTrip },
          el("span", {}, "この旅程のリンクを共有"))
      : null,
    handlers.onShare
      ? el("button", { type: "button", class: "md-btn md-btn--outlined md-state",
                       onClick: handlers.onShare },
          el("span", {}, "条件のリンクを共有"))
      : null,
    // **いま画面に出ているとおりの旅程**を、ファイルで渡します。
    //
    // 条件のリンクは条件だけを運びます。受け取った人が開くと、その場で
    // 組み直されるので時刻が変わり、同行者と同じ時刻で回れません。
    // 文字のコピーは固定ですが、地図もリンクも失われ、読み込み直すことも
    // できません。凍結した旅程そのものを渡せば、その人の端末で同じ時刻の
    // 旅程が開きます。控えとしても使えます。
    handlers.onExport
      ? el("button", { type: "button", class: "md-btn md-btn--outlined md-state",
                       onClick: handlers.onExport },
          el("span", {}, "この旅程をファイルで渡す"))
      : null)].filter(Boolean));
}

/** その日の一行要約。開いていない日でも中身が想像できるように。 */
function dayShape(day) {
  const spots = day.items.filter((i) => i.kind === "spot");
  if (!spots.length) return "移動と休息の日";
  const first = day.items.find((i) => i.kind === "spot");
  const last = [...day.items].reverse().find((i) => i.kind === "spot");
  return `${spots.length}か所 · ${fmtTime(first.start)}〜${fmtTime(last.end)}`;
}

function levelClass(score) {
  if (score >= 78) return "high";
  if (score >= 58) return "mid";
  if (score >= 36) return "low";
  return "calm";
}

function tripMinutes(itin) {
  const all = itin.days.flatMap((d) => d.items);
  if (!all.length) return 0;
  return Math.round((all.at(-1).end - all[0].start) / 60000);
}

function stat(value, label) {
  return el("div", {}, el("strong", {}, value), el("span", {}, label));
}

/**
 * 旅行中モードの画面。
 *
 * 当日に知りたいのは「次に何をすればいいか」だけです。長い旅程を
 * 出しても、スクロールして自分の現在地を探しているあいだに電車が
 * 出ていきます。次の一手を大きく出し、遅れているときだけ
 * 「どこを削れば帰れるか」を添えます。
 */
export function renderToday(container, itin, trip, handlers = {}) {
  container.textContent = "";
  const now = handlers.now ?? new Date();
  const step = currentStep(itin, now);
  const box = el("section", { class: "today" });

  // 旅行中モード（js/tripmode.js）。ワンタップで、画面をこの札と
  // 「このあとの予定」だけにします。開き直しても、そのまま始まります。
  if (handlers.onTripMode) {
    const on = handlers.tripMode === true;
    const b = el("button", {
      type: "button", "aria-pressed": String(on),
      class: `md-btn md-state trip-mode-btn ${on ? "md-btn--text" : "md-btn--filled"}`,
    }, el("span", {}, on ? "ふだんの画面に戻る" : "旅行中モードにする"));
    b.addEventListener("click", () => handlers.onTripMode(!on));
    box.append(el("div", { class: "trip-mode-bar" },
      el("p", { class: "trip-mode-label" },
        on ? "旅行中モード" : "旅の当日は、次の予定だけを大きく出せます"),
      b));
  }

  if (step.phase === "before") {
    box.append(el("p", { class: "today-when" }, "旅はまだ始まっていません"),
               el("p", { class: "today-next" },
                 `出発は ${fmtDay(itin.days[0].date)} です。`));
    container.append(box);
    return;
  }
  if (step.status === "done" || step.phase === "after") {
    box.append(el("p", { class: "today-when" }, "今日の予定はここまでです"),
               el("p", { class: "today-next" }, "おつかれさまでした。"));
    container.append(box);
    return;
  }

  const n = step.next;
  box.append(el("p", { class: "today-when" },
    `${step.day + 1}日目 ・ ${fmtTime(now)} 現在`));

  if (n) {
    box.append(el("p", { class: "today-label" },
      step.status === "during" ? "次の予定" : "つぎは"));
    box.append(el("p", { class: "today-next" }, n.title));
    // 移動なら「出発」、見学や食事なら「から」。
    // 見学に「出発」と書くと、そこを出る時刻に読めます。
    const when = n.kind === "transit" ? "出発" : "から";
    box.append(el("p", { class: "today-at" },
      `${fmtTime(n.start)} ${when}`
      + (step.minutesUntil > 0 ? ` ・ あと ${step.minutesUntil}分` : "")));
    if (n.detail) box.append(el("p", { class: "today-detail" }, n.detail));

    // 旅行中にいちばん要るのは「そこへどう行くか」です。
    //
    // 案内そのものを自前で作る必要はありません。地図アプリのほうが
    // ずっとよくできています。ここでやるべきは、**引き渡しを一手で
    // 済ませる**ことです。現在地は取りません。origin を空にすると、
    // 地図アプリ側が自分で現在地を使います。
    const target = n.place ?? n.to ?? n.spot;
    const nav = directionsFromHereUrl(target);
    if (nav) {
      box.append(el("a", {
        class: "today-nav md-state", href: nav,
        target: "_blank", rel: "noopener noreferrer",
      }, icon("forward"),
         el("span", {}, `現在地から「${target.name ?? n.title}」へ案内`)));
    }

    if (n.transit?.segments?.length) box.append(transitSteps(n.transit));

    // いま着いたことを押せるようにします。遅れはここから数えます。
    //
    // 押す対象は「行き先」です。移動そのものに「着いた」とは言いません
    // （「小町通りへ移動 に着いた」は日本語として通りません）。
    //
    // 現在地から分かったときは、**そちら**を先に見ます。予定の順に
    // 出していると、1か所飛ばして先へ進んだ人が押せる相手がいません。
    const hint = handlers.arrivedHint ?? null;
    const arrivable = hint?.item
      ?? [step.current, n]
        .find((x) => x && ["spot", "meal", "lodging"].includes(x.kind));
    if (hint?.item) {
      // **決めません。** 位置から分かるのは「近くにいる」までで、
      // 中に入ったかは分かりません。押すのは本人です。
      box.append(el("p", { class: "today-hint" },
        icon("locate"),
        el("span", {},
          `現在地から、「${hint.item.title}」の近く`
          + `（約${Math.max(10, Math.round(hint.km * 1000))}m）にいるようです。`
          + "着いていれば、下を押してください。")));
    }
    if (handlers.onArrived && arrivable) {
      const btn = el("button", { class: "md-btn md-btn--tonal md-state",
                                 type: "button" },
        el("span", {}, `「${arrivable.title}」に着いた`));
      btn.addEventListener("click", () => handlers.onArrived(arrivable.id));
      box.append(el("div", { class: "today-actions" }, btn));
    }
  }

  // 旅行中モードでは、旅程の一覧を隠すので、その日の残りをここに
  // 短く並べます。「次の次」が見えないと、時間の配りかたが決められません。
  if (handlers.tripMode) {
    const later = laterToday(itin, step);
    if (later.length) {
      box.append(el("p", { class: "today-label today-later-label" }, "このあとの予定"),
        el("ol", { class: "today-later" }, later.map((i) =>
          el("li", {}, el("span", { class: "time" }, fmtTime(i.start)),
                       el("span", {}, i.title)))));
    }
  }

  // 当日のしたく。押されてから聞きます。
  //
  // 開いた瞬間に通知と現在地の許可を求めるのは、いちばん断られる
  // 聞きかたです（何に使うのか分からないためです）。使うと決めた人が
  // 押したときに、はじめて聞きます。
  if (handlers.onNotify || handlers.onWatchArrival || handlers.onRequery) {
    const row = el("div", { class: "today-actions" });
    if (handlers.onNotify) {
      const on = handlers.notifyOn === true;
      const b = el("button", {
        class: `md-btn md-state ${on ? "md-btn--filled" : "md-btn--tonal"}`,
        type: "button", "aria-pressed": String(on),
      }, icon("wait"), el("span", {},
        on ? "出発を知らせています" : "出発を知らせる"));
      b.addEventListener("click", () => handlers.onNotify(!on));
      row.append(b);
    }
    if (handlers.onWatchArrival) {
      const on = handlers.watchOn === true;
      const b = el("button", {
        class: `md-btn md-state ${on ? "md-btn--filled" : "md-btn--tonal"}`,
        type: "button", "aria-pressed": String(on),
      }, icon("locate"), el("span", {},
        on ? "現在地で気づいています" : "現在地で気づく"));
      b.addEventListener("click", () => handlers.onWatchArrival(!on));
      row.append(b);
    }
    // 次の区間だけ、いまの時刻で引き直す（js/nextleg.js）。
    //
    // 10分遅れただけで旅程ぜんぶを組み直すと、1〜2分かかるうえ
    // **残りの旅程が別のものに変わります**。聞くのは1回、変えるのは
    // その行の説明だけにします。
    if (handlers.onRequery) {
      const busy = handlers.requerying === true;
      const b = el("button", {
        class: "md-btn md-btn--tonal md-state", type: "button",
        disabled: busy ? "" : null,
      }, icon("transit"), el("span", {},
        busy ? "調べています…" : "次の便を調べ直す"));
      b.addEventListener("click", () => handlers.onRequery());
      row.append(b);
    }
    box.append(row);
    // 引き直した結果。**旅程の時刻は動いていません。**
    if (handlers.requeried?.text) {
      const lv = handlers.requeried.level;
      box.append(el("p", {
        class: `today-requery lv-${lv}`,
      },
        icon(lv === "push" ? "warn" : lv === "early" ? "check" : "transit"),
        el("span", {}, handlers.requeried.text)));
    }
    // **できないことを、できないと書きます。**
    if (handlers.notifyOn) {
      box.append(el("p", { class: "today-note" }, NOTICE_LIMITS));
    }
    if (handlers.watchOn) {
      box.append(el("p", { class: "today-note" },
        "現在地は、この端末の中で予定の場所と見比べるだけに使います。"
        + "どこにも送りません。"));
    }
    if (handlers.todayNote) {
      box.append(el("p", { class: "today-note warn" }, handlers.todayNote));
    }
  }

  // 遅れ
  if (itin.catchUp?.lateMin > 0) {
    const c = itin.catchUp;
    const late = el("div", {
      class: `notice${c.enough ? "" : " notice--error"}`,
    });
    late.append(el("h3", {}, `${c.lateMin}分 遅れています`),
                el("p", {}, c.summary));
    if (c.actions.length && handlers.onCatchUp) {
      const row = el("div", { class: "today-actions" });
      const btn = el("button", { class: "md-btn md-btn--filled md-state",
                                 type: "button" },
        el("span", {}, "この形で組み直す"));
      btn.addEventListener("click", () => handlers.onCatchUp(c.actions));
      row.append(btn);
      late.append(row);
    }
    box.append(late);
  }

  container.append(box);
}

/** 軸ごとの点を、星と数字で並べます。 */
function axisList(axes) {
  return el("ul", { class: "axes" }, (axes ?? []).map((a) => el("li", {},
    icon(a.icon, { class: "ax-ic" }),
    el("span", { class: "ax-label" }, a.label),
    el("span", { class: "ax-stars", role: "img", "aria-label": `${a.stars} / 5` },
      el("span", {}, "★".repeat(a.stars)),
      el("span", { class: "off" }, "★".repeat(5 - a.stars))),
    el("span", { class: "ax-score" }, String(a.score)),
    a.note ? el("span", { class: "ax-note" }, a.note) : null)));
}

/** 情報の出どころの印。色だけでなく、必ず言葉を添えます。 */
/**
 * 「まだ目安があります。もう一度調べますか」の1行。
 *
 * **出すのは、もう一度調べれば直ることがあるときだけです。**
 * 近くに駅もバス停も無い区間は、何度作り直しても目安のままです。
 * そこへ「もう一度調べる」を出すと、直らないことに時間を使わせます。
 *
 * 押すと、同じ条件でもう一度組み直します。時刻表に聞く回数と間隔は
 * 組むたびに数え直すので、混んでいて引けなかった区間が入ることが
 * あります（区間そのものに便が無いなら、やはり変わりません）。
 */
function recheckRow(itin, handlers) {
  const est = estimatedTravel(itin);
  if (!est.retryable || !handlers.onRecheck) return null;
  // 車の旅に「時刻」はありません。引くのは道のりです。
  const what = isTouring(itin) ? "道のり" : "時刻";
  const row = el("div", { class: "recheck" });
  const btn = el("button", {
    type: "button", class: "md-btn md-btn--tonal md-state",
  }, el("span", {}, `${what}をもう一度調べる`));
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.querySelector("span").textContent = "調べています…";
    handlers.onRecheck();
  });
  row.append(btn, el("p", { class: "fine" },
    `${est.retryable}区間は${what}を引けませんでした。`
    + "同じ条件で組み直すと、入ることがあります。"));
  return row;
}

/**
 * 拠点の1行。
 *
 * 連泊（宿を動かさない旅）では、どこに何泊するかが要点です。
 * 泊まり歩く旅では、どの順に移るかが要点です。同じ「松江 2日 →
 * 出雲 1日」でも、意味が違うので書き分けます。
 */
function stayLine(itin) {
  const stays = itin.stays ?? [];
  if (itin.stayStyle === "base" && itin.basedAt) {
    const nights = Math.max(1, (itin.days?.length ?? 1) - 1);
    const areas = stays.map((s) => s.name).join("・");
    return el("p", { class: "stay-line" },
      `${itin.basedAt}に${nights}泊`
      + (areas && stays.length > 1 ? `（日中は ${areas}）` : ""));
  }
  if (stays.length > 1) {
    return el("p", { class: "stay-line" },
      stays.map((s) => `${s.name} ${s.days}日`).join(" → "));
  }
  return null;
}

function srcChip(c, extra = "", source = "") {
  const title = [c.text, c.checkedAt ? `（${c.checkedAt} 時点）` : ""]
    .filter(Boolean).join("");
  // 「確認済み」とだけ書かれても、何で確かめたのかが分かりません。
  // 当日ずれたときに、疑う先が変わります。
  const text = source ? `${c.label}・${source}`
    : extra ? `${c.label}・${extra}` : c.label;
  return el("span", { class: `src src--${c.level}`, title },
    icon(c.icon, { class: "src-ic" }),
    el("span", {}, text));
}

/** 乗換の手順を、開閉できる形で並べます。 */
function alternativeRoutes(list) {
  const box = el("details", { class: "transit-steps" });
  box.append(el("summary", {}, `ほかの行き方（${list.length}件）`));
  const inner = el("div", { style: "padding:8px 14px 14px" });
  inner.append(el("ul", { class: "quality" }, list.map((r) => el("li", {},
    el("span", { class: "q-label" },
      `${r.departure ?? ""}→${r.arrival ?? ""}`
      + (r.transfers != null ? ` / 乗換${r.transfers}回` : "")
      + (r.fareYen ? ` / ¥${r.fareYen.toLocaleString()}` : ""))))));
  box.append(inner);
  return box;
}

function transitSteps(t) {
  const lines = describeTransit(t);
  const box = el("details", { class: "transit-steps" });
  const head = [
    t.boardAt && t.alightAt ? `${t.boardAt} → ${t.alightAt}` : "乗り換えの手順",
    t.headline,
  ].filter(Boolean).join("　");
  box.append(el("summary", {}, head));
  box.append(el("ol", { class: "ts-list" },
    t.segments.map((seg, i) => el("li", { class: `ts ${seg.kind}` },
      icon({ walk: "walk", wait: "wait", ride: "transit" }[seg.kind] ?? "dot",
        { class: "ts-ic" }),
      el("span", { class: "ts-tx" }, lines[i])))));
  return box;
}

/** 点の帯。色だけで意味を伝えないよう、必ず数字と言葉を添えます。 */
function scoreClass(n) {
  return n >= 75 ? "good" : n >= 55 ? "mid" : "bad";
}

/**
 * 旅程全体を、まず一言で言い切ります。
 *
 * 見るのは「無理がないか」だけです。適合度も混雑も点はありますが、
 * 最初に知りたいのは「この予定で本当に回れるのか」です。それが
 * 通ってから、好みに合うかを見ます。順番を逆にすると、
 * 帰れない旅程に「ご希望との相性 92点」と書くことになります。
 */
/**
 * その旅程で歩くおおよその歩数。
 *
 * 徒歩と印の付いた移動の距離を足して、1kmあたり1350歩で数えます
 * （歩幅74cmの見当）。乗り物の移動は数えません。
 */
function walkSteps(itin) {
  const km = (itin.days ?? []).flatMap((d) => d.items)
    .filter((i) => i.kind === "transit" && i.walk)
    .reduce((a, i) => a + (i.km ?? 0), 0);
  if (!(km > 0)) return 0;
  return Math.round((km * 1350) / 100) * 100;
}

function summaryVerdict(itin) {
  const total = itin?.score?.total;
  if (!Number.isFinite(total)) return null;
  const slack = itin.slack;
  const back = slack && slack.level !== "unknown" && Number.isFinite(slack.minutes)
    ? `帰りの余裕 ${fmtDuration(slack.minutes)}`
    : "";
  const level = scoreClass(total);
  const label = level === "good" ? "無理なく回れます"
    : level === "mid" ? "少し急ぎめです"
      : "かなり詰まっています";
  const detail = [back, `無理のなさ ${total}/100`]
    .filter(Boolean).join("・");
  return { level, label, detail };
}

/** 疲労の段階。0〜30 ゆったり / 〜60 普通 / 〜80 やや疲れる / それ以上 過密。 */
function fatigueClass(n) {
  return n >= 80 ? "hard" : n >= 60 ? "warn" : n >= 30 ? "mid" : "easy";
}

/**
 * カードの絵。まず art.js の色の面を敷き、写真が取れたら上に重ねます。
 *
 * 写真を待ってからカードを出すのは間違いです。通信は失敗しますし、
 * 遅れます。先に絵で出しておき、届いたぶんだけ静かに差し替えます。
 */
function cardArt(spot, { tall = false } = {}) {
  const art = artFor(spot);
  const box = el("div", { class: tall ? "sheet-art" : "card-art",
                          style: `background-image:${art.css}` });
  if (spot?.fame_tier) {
    box.append(el("em", { class: `tier ${spot.fame_tier}` },
      TIER_LABEL[spot.fame_tier]));
  }
  box.append(icon(art.icon, { class: "art-ic" }));

  const img = el("img", { alt: "", loading: "lazy", decoding: "async",
                          class: tall ? "" : "card-photo" });
  photoFor(spot).then((url) => {
    if (!url) return;
    img.addEventListener("load", () => {
      img.classList.add("on");
      const credit = photoCredit(url);
      if (credit) box.append(credit);
    }, { once: true });
    img.src = url;
  }).catch(() => { /* 写真は飾りです。取れなくても絵のままで十分です */ });
  box.prepend(img);
  return box;
}

/**
 * 写真の隅に置く出典のリンク。撮った人とライセンスは、その先の
 * 説明ページに書いてあります（Wikimedia の写真は表示が条件です）。
 */
function photoCredit(url) {
  const page = photoPageOf(url);
  if (!page) return null;
  return el("a", { class: "photo-credit", href: page,
                   target: "_blank", rel: "noreferrer" },
    "写真: Wikimedia Commons");
}

/**
 * 旅程のカードの上に敷く写真。
 *
 * 写真が取れるまでは何も出しません（箱は畳んだまま）。取れなかった
 * カードに空の枠が残ると、壊れて見えます。届いたら静かに開きます。
 * Wikipedia の記事名を持たない場所は、問い合わせもしません。
 */
function spotPhoto(spot) {
  if (!spot?.wikipedia) return null;
  // 写真そのものは飾り（alt は空）。出典のリンクだけは読み上げにも
  // 出すので、箱ごと aria-hidden にはしません。
  const box = el("div", { class: "card-photo-band" });
  const img = el("img", { alt: "", decoding: "async" });
  box.append(img);
  photoFor(spot).then((url) => {
    if (!url) return;
    img.addEventListener("load", () => {
      box.classList.add("on");
      const credit = photoCredit(url);
      if (credit) box.append(credit);
    }, { once: true });
    // 要約APIの縮小版は幅320pxです。カードの幅いっぱいに敷くと粗いので、
    // 640px 版を先に頼みます。元の写真がそれより小さいと Wikimedia は
    // 返さないので、そのときは届いた縮小版に戻します。
    const wide = widerThumb(url);
    if (wide !== url) {
      img.addEventListener("error", () => { img.src = url; }, { once: true });
    }
    img.src = wide;
  }).catch(() => { /* 写真は飾りです */ });
  return box;
}

/** Wikimedia の縮小版URLを、幅640pxのものに書き換えます。形が違えばそのまま。 */
export function widerThumb(url, px = 640) {
  return String(url ?? "").replace(/\/(\d+)px-([^/]+)$/,
    (m, w, rest) => (Number(w) < px ? `/${px}px-${rest}` : m));
}

/** 携帯の幅か。シートを半分で開くかどうかの判断に使います。 */
function isNarrowScreen() {
  return Boolean(globalThis.matchMedia?.("(max-width: 860px)")?.matches);
}

/**
 * シートを、摘みで上下に動かせるようにします。
 *
 * 止まる場所は3つだけです。半分（peek）、全部（full）、閉じる。
 * 指を離した位置に一番近いところへ寄せます。中途半端な高さで止めると、
 * 次にどう動かせるのかが分からなくなります。
 *
 * 引いている途中は transition を切ります（指に付いてこないと、
 * 引いているのか固まっているのか分かりません）。
 */
function dragSheet(sheet, scrim, close) {
  const PEEK = 0.52;          // 画面のこれだけを下へ隠して開きます
  const height = () => sheet.getBoundingClientRect().height || 1;
  let y = Math.round(height() * PEEK);
  let state = "peek";
  let from = null;
  let startY = 0;

  const put = (px, smooth = true) => {
    sheet.style.transition = smooth
      ? "transform var(--hig-mid, .3s) var(--hig-ease, ease)" : "none";
    sheet.style.transform = `translateY(${Math.max(0, px)}px)`;
  };

  // 入ってくる動きは、下から半分の位置まで。CSS の登場アニメーションは
  // translateY を上書きするので、ここでは使いません。
  sheet.classList.add("dragging-sheet");
  sheet.dataset.state = "peek";
  scrim.dataset.state = "peek";
  put(height(), false);
  requestAnimationFrame(() => put(y));

  /** 3つのうちどれかへ寄せます。 */
  const go = (next) => {
    if (next === "closed") { put(height()); setTimeout(close, 220); return; }
    state = next;
    y = next === "full" ? 0 : Math.round(height() * PEEK);
    sheet.dataset.state = state;
    scrim.dataset.state = state;
    put(y);
  };

  const settle = (px) => {
    const h = height();
    const peek = Math.round(h * PEEK);
    // 半分より下へ引ききったら閉じます
    if (px > peek + h * 0.18) { go("closed"); return; }
    go(px < peek * 0.5 ? "full" : "peek");
  };

  const onDown = (e) => {
    // 中身をスクロールしているときは、シートを動かしません
    if (state === "full" && sheet.scrollTop > 0) return;
    if (e.target.closest("a, button, summary, input")) return;
    from = e.pointerId;
    startY = e.clientY - y;
    sheet.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (from !== e.pointerId) return;
    put(e.clientY - startY, false);
    e.preventDefault();
  };
  const onUp = (e) => {
    if (from !== e.pointerId) return;
    from = null;
    settle(e.clientY - startY);
  };

  sheet.addEventListener("pointerdown", onDown);
  sheet.addEventListener("pointermove", onMove);
  sheet.addEventListener("pointerup", onUp);
  sheet.addEventListener("pointercancel", onUp);

  // 摘みは、押しても（キーボードでも）開け閉めできるようにします。
  // 引く操作しか用意しないと、指以外では半分のままになります。
  const grip = sheet.querySelector(".md-sheet-handle");
  if (grip) {
    const btn = el("button", {
      type: "button", class: "sheet-toggle",
      "aria-label": "この場所の説明を全部見る",
    });
    // 摘みそのものを押せるようにします。摘みの横に別のボタンを足すより、
    // 「ここをつかむ」場所と「ここを押す」場所が同じほうが迷いません。
    const bar = grip.querySelector("i");
    if (bar) btn.append(bar);
    const arrow = el("span", { class: "arrow", "aria-hidden": "true" });
    arrow.append(icon("chevron-up"));
    btn.append(arrow);
    btn.addEventListener("click", () => {
      const next = state === "full" ? "peek" : "full";
      go(next);
      btn.setAttribute("aria-label", next === "full"
        ? "説明を半分に戻す" : "この場所の説明を全部見る");
      // 山形の向きだけを差し替えます。**回転させません**——
      // 「動きを減らす」設定のときに回るのは、この摘みだけではないので
      // 個別に止めるより、はじめから回さないほうが確かです。
      arrow.replaceChildren(icon(next === "full" ? "chevron-down"
        : "chevron-up"));
    });
    grip.append(btn);
  }
}

/** 滞在時間の刻み（分）。1分単位で選べても、選ぶ意味がありません。 */
const DWELL_STEP = 15;
const DWELL_MIN = 15;
const DWELL_MAX = 300;

/**
 * 順番と滞在時間を、その場で動かす行。
 *
 * 掴んで動かす操作だけにはしません。指でも押せるよう上下のボタンを
 * 置き、キーボードでも同じことができるようにします（掴む操作しか
 * 用意しないと、指以外では並べ替えられません）。
 */
function tuneRow(item, itin, handlers) {
  const id = item.spotId ?? item.place.id;
  const row = el("div", { class: "spot-tune" });

  if (handlers.onSpotOrder) {
    const move = (dir, label) => {
      const b = el("button", {
        type: "button", class: "tune-move", "data-move": dir,
        "aria-label": `${item.title}を${label}`,
      }, icon(dir === "up" ? "up" : "down"));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        handlers.onSpotOrder({ id, dir });
      });
      return b;
    };
    const grip = el("span", { class: "tune-grip", "aria-hidden": "true",
                              title: "掴んで動かすと、回る順が変わります" },
                    icon("drag"));
    dragReorder(grip, handlers);
    row.append(grip, move("up", "1つ前に回す"), move("down", "1つ後に回す"));
  }

  if (handlers.onSpotDwell) {
    const minutes = Math.max(1,
      Math.round((new Date(item.end) - new Date(item.start)) / 60000));
    const out = el("output", { class: "tune-out" }, fmtDuration(minutes));
    const bar = el("input", {
      type: "range", class: "tune-bar",
      min: String(DWELL_MIN), max: String(DWELL_MAX), step: String(DWELL_STEP),
      value: String(clampDwell(minutes)),
      "aria-label": `${item.title}にいる時間`,
    });
    // 引いている途中では組み直しません。離したときに1回だけです
    // （引くたびに組み直すと、経路検索を何十回も叩きます）。
    bar.addEventListener("input", (e) => {
      e.stopPropagation();
      out.textContent = fmtDuration(Number(bar.value));
    });
    bar.addEventListener("change", (e) => {
      e.stopPropagation();
      handlers.onSpotDwell({ id, name: item.title, minutes: Number(bar.value) });
    });
    bar.addEventListener("click", (e) => e.stopPropagation());
    row.append(el("span", { class: "tune-cap" }, "いる時間"), bar, out);
  }
  return row;
}

/**
 * 掴んで動かして、回る順を変える。
 *
 * 動かしているあいだは、その場で行を入れ替えて見せます。影だけを
 * 動かして最後にまとめて並べ替えると、「どこに入るのか」が分からない
 * まま指を離すことになります。
 *
 * 動かせるのは**同じ日のなか**だけです。日をまたぐ移動は、宿と
 * 移動時間の話になるので、ここではできません（条件から組み直します）。
 *
 * 指を離したら、その並びを条件に書いて組み直します。ここで時刻を
 * そのまま使うと、開館前に着く旅程ができます。
 */
function dragReorder(grip, handlers) {
  let li = null;
  let list = null;
  let before = "";

  const rows = () => [...list.querySelectorAll(":scope > li.tl.spot")];
  const idsOf = () => rows().map((e) => e.dataset.spot).filter(Boolean);

  // 動かしている途中の pointermove / pointerup は、**窓で受けます**。
  //
  // 掴んだ要素で受けていたときは、1回入れ替えたところで動かなく
  // なりました。入れ替えは節を付け替える操作で、いったん文書から
  // 外れるため、**ポインタの捕捉がそこで外れます**。指を離した
  // ことにも気づけず、並べ替えたのに組み直されませんでした。
  const onMove = (e) => {
    if (!li) return;
    e.preventDefault();
    for (const other of rows()) {
      if (other === li) continue;
      const box = other.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      const where = other.compareDocumentPosition(li);
      // 相手の真ん中を越えたら、その前か後ろへ入れます
      if (e.clientY < mid && (where & Node.DOCUMENT_POSITION_FOLLOWING)) {
        list.insertBefore(li, other);
        break;
      }
      if (e.clientY > mid && (where & Node.DOCUMENT_POSITION_PRECEDING)) {
        list.insertBefore(li, other.nextSibling);
        break;
      }
    }
  };

  const end = (e) => {
    globalThis.removeEventListener("pointermove", onMove);
    globalThis.removeEventListener("pointerup", end);
    globalThis.removeEventListener("pointercancel", end);
    if (!li) return;
    li.classList.remove("dragging");
    const ids = idsOf();
    const changed = ids.join(",") !== before;
    li = null;
    e?.stopPropagation?.();
    if (changed) handlers.onSpotOrder({ ids });
  };

  grip.addEventListener("pointerdown", (e) => {
    li = grip.closest("li.tl");
    list = li?.parentElement;
    if (!list) { li = null; return; }
    before = idsOf().join(",");
    li.classList.add("dragging");
    globalThis.addEventListener("pointermove", onMove, { passive: false });
    globalThis.addEventListener("pointerup", end);
    globalThis.addEventListener("pointercancel", end);
    e.preventDefault();
    e.stopPropagation();
  });
}

function clampDwell(min) {
  const v = Math.round(min / DWELL_STEP) * DWELL_STEP;
  return Math.min(DWELL_MAX, Math.max(DWELL_MIN, v));
}

/**
 * 外した場所と、戻すためのボタン。
 *
 * 外したものが画面から消えるだけだと、押し間違えたときに戻せません。
 * 「戻せる」と分かっているから、気軽に外せます。
 */
function droppedList(itin, handlers) {
  const dropped = itin?.dropped ?? [];
  if (!dropped.length || !handlers.onRestore) return null;
  const box = el("div", { class: "dropped" });
  box.append(el("p", { class: "fine" }, "外した場所"));
  const list = el("ul", { class: "dropped-list" });
  for (const d of dropped) {
    const b = el("button", {
      type: "button", class: "dropped-back",
      "aria-label": `${d.name}を旅程に戻す`,
    }, `${d.name} を戻す`);
    b.addEventListener("click", () => handlers.onRestore(d));
    list.append(el("li", {}, b));
  }
  box.append(list);
  return box;
}

function renderItem(item, index, itin, handlers, sunNote) {
  const minutes = Math.round((item.end - item.start) / 60000);
  // 所要時間に比例した高さにします。数字を読まなくても、
  // どこが詰まっていてどこに余裕があるかが形で分かります。
  const height = Math.max(46, Math.min(150, 42 + minutes * 0.62));
  const li = el("li", {
    class: `tl ${item.kind}`,
    style: `--i:${Math.min(index, 14)};--h:${Math.round(height)}px`,
    "data-item": item.id,
    "data-spot": item.spotId ?? null,
  });

  li.append(
    el("div", { class: "time" },
      el("b", {}, fmtTime(item.start)),
      el("span", {}, fmtDuration(minutes))),
    el("div", { class: "rail" }, el("i", {})),
  );

  const body = el("div", { class: `body${item.kind === "spot" ? " tap" : ""}` });

  // スポットのカードは、写真の代わりに分類の色をごく薄く敷くだけにします
  // （写真は無く、art.js の色面を大きく出すと目立ちすぎるため）。
  const spotArt = item.kind === "spot" ? artFor(item.place) : null;
  if (spotArt) {
    body.classList.add("card-tinted");
    body.style.setProperty("--card-hue", spotArt.hue);
  }
  const info = item.kind === "spot" ? el("div", { class: "card-info" }) : body;
  if (item.kind === "spot") {
    const photo = spotPhoto(item.place);
    if (photo) body.append(photo);
    body.append(info);
  }
  // 立ち寄りの補足（広い場所・同行者・選んだ理由など）は、畳んで後ろに
  // 回します。どれも正しい話ですが、旅程を上から追っている人がまず
  // 知りたいのは「何時に・どこで・何時まで開いているか」です。
  // 全部を開いて並べると、その3つが説明の間に埋もれます。
  const extra = item.kind === "spot" ? el("div", { class: "spot-more-body" }) : info;

  const title = el("div", { class: "title" },
    icon(spotArt?.icon ?? iconFor(item, itin)),
    el("span", { class: "tx" }, item.title));
  if (item.place?.fame_tier) {
    title.append(el("em", { class: `tier ${item.place.fame_tier}` },
      TIER_LABEL[item.place.fame_tier]));
  }
  if (item.kind === "spot" && item.place && itin.crowd) {
    const c = crowdLevel(item.place, item.start);
    title.append(el("em", {
      class: `crowd-chip lv-${levelClass(c.score)}`,
      title: c.reasons.join("・") || "混雑の見込み",
    }, c.label));
  }
  // 何を食べる土地か。題に添えると、旅程を眺めただけで分かります。
  // 出すのは料理（または収録にある食事どころ）の名前だけです。
  // 店名をこちらで作ることはしません（meals.js）。
  if (item.kind === "meal" && (item.food?.spotName || item.food?.dish)) {
    title.append(el("em", { class: "dish" },
      item.food.spotName ?? item.food.dish));
  }
  info.append(title);

  if (item.detail) {
    const line = el("p", { class: "detail" }, el("span", {}, item.detail));
    // 実際に経路検索で取れた時間なのか、距離からの推定なのか。
    // 同じ「約42分」でも、意味がまったく違います。
    if (item.kind === "transit") {
      const c = confidenceOf("travel", item);
      // 出どころは、印の言葉と重ならないときだけ添えます
      //（「推定・距離からの推定」は同じことを2度言っています）。
      const src = c.source && c.source !== "距離からの推定" ? c.source : "";
      line.append(" ", srcChip(c, "", src));
    }
    info.append(line);
    // 乗り物ならではの断り書き（js/modes.js の KIND_NOTE）。
    //
    // 「4時間46分」とだけ出しても、空路の区間は現地で足りません。
    // 空港には早く着く必要があり、搭乗券は別に取る必要があります。
    // 船は欠航します。routes.js が路線名から見分けた種類ごとに、
    // 旅程が現地で壊れないために要ることだけを書きます。
    if (item.kind === "transit" && item.vehicle?.kinds?.length) {
      for (const kind of item.vehicle.kinds) {
        const note = KIND_NOTE[kind];
        if (!note) continue;
        info.append(el("p", { class: "sun vehicle" },
          icon(kind),
          el("span", {}, note)));
      }
      // 指定した乗り物で組めなかったとき。黙って陸の経路を出すと、
      // 指定を無視したことに気づけません。
      if (item.vehicle.preferMet === false) {
        info.append(el("p", { class: "sun vehicle tight" },
          icon("warn"),
          el("span", {},
            "指定した乗り物（飛行機・船）を使う便が見つからなかったので、"
            + "ほかの乗り物で組んでいます。")));
      }
    }
    // いまの時刻で引き直した結果（js/nextleg.js）。
    //
    // 当日の一画（今日の旅）にも出しますが、旅程の行まで下りてきた人が
    // 見るのはこちらです。**この行の時刻は動いていません。** 動かすと、
    // 同行者に送った旅程と手元の旅程が食い違います。
    if (item.requeried?.text) {
      info.append(el("p", {
        class: `sun requeried${item.requeried.level === "push" ? " tight" : ""}`,
      },
        icon(item.requeried.level === "push" ? "warn" : "transit"),
        el("span", {}, item.requeried.text)));
    }
    // 切符のこと（js/tickets.js）。
    //
    // 「15,290円」と書いてあっても、当日みどりの窓口の前で止まります。
    // 新幹線は乗車券と特急券の2枚で、指定席か自由席かを買うときに
    // 決める必要があります。**得かどうかは言いません**（券の名前も
    // 値段も持っていません）。確かめるきっかけだけを置きます。
    for (const t of item.tickets ?? []) {
      info.append(el("p", { class: "sun ticket" },
        icon("ticket"),
        el("span", {}, t.text)));
    }
    // 終電の線（js/lasttrain.js）。
    //
    // 「18:40発」とだけ書いてあっても、あと何分粘れるのかが
    // 分かりません。その駅の終電を並べて置きます。
    // 予定が終電より後なら、赤で出します（**この旅程では帰れません**）。
    if (item.lastTrain?.text) {
      info.append(el("p", {
        class: `sun lasttrain${item.lastTrain.level === "over" ? " tight"
          : item.lastTrain.level === "tight" ? " near" : ""}`,
      },
        icon(item.lastTrain.level === "over" ? "warn" : "wait"),
        el("span", {}, item.lastTrain.text)));
    }
    // 長い運転には、休憩のことを添えます。「4時間の移動」と1行だけ
    // 書いておいて、休むことに触れないのは不親切です。
    if (item.kind === "transit" && isTouring(itin) && item.walk !== true) {
      const note = longDriveNote(
        Math.round((new Date(item.end) - new Date(item.start)) / 60000));
      if (note) {
        info.append(el("p", { class: "sun rest" },
          icon("free"),
          el("span", {}, note)));
      }
      // 休憩の枠。「2時間ごとに休憩を」と書くだけでは、旅程は
      // その時間を数えていません。何時ごろ・何分見ておくかを出します。
      // **どこで休むかは言いません**（店名も道の駅名も作りません）。
      const rest = restSlots(item, itin.slack?.minutes ?? null);
      if (rest) {
        info.append(el("p",
          { class: `sun rest${rest.fits === false ? " tight" : ""}` },
          icon("rest"),
          el("span", {},
            `休憩の目安: ${rest.times.join("ごろ・")}ごろ`
            + `（1回15分・合計${rest.minutes}分）。${rest.note}`)));
      }
    }
    // 移動そのものの楽しみ（js/scenic.js）。
    //
    // 走る道と乗る路線では、**確かさが違います**。路線は調べた結果に
    // 名前が書いてあるので言い切れますが、どの道を通るかは分かりません。
    // 言いかたを分けます。
    if (item.scenic?.kind === "line") {
      info.append(el("p", { class: "sun scenic" },
        icon("scenic"),
        el("span", {},
          `${item.scenic.name}。${item.scenic.what}`)));
    } else if (item.scenic?.kind === "road") {
      for (const r of item.scenic.roads) {
        info.append(el("p", { class: "sun scenic" },
          icon("road"),
          el("span", {},
            `この辺り（約${r.km}km）に${r.name}があります。${r.what}`
            + (r.note ? ` ${r.note}` : "")
            + "（この旅程の経路には入れていません）")));
      }
    }
  }

  // 公共交通の中身。所要時間だけでは、現地で予定どおりかを確かめられません。
  // 折りたたんで置き、必要なときだけ開けるようにします。
  if (item.transit?.segments?.length) {
    info.append(transitSteps(item.transit));
  }
  // ほかの行き方。Yahoo!は候補を3本出します。採ったのは「いちばん早く
  // 着く」ものですが、安いほうや乗換の少ないほうを選びたいこともあります。
  if (item.alternatives?.length) {
    info.append(alternativeRoutes(item.alternatives));
  }
  // 点ではないもの（道・広い場所）。
  //
  // 「山背古道 40分」と書かれても、どこから入ってどこへ抜けるのかが
  // 決まっていません。**経路は組み替えていません**（道の形を持って
  // いないので、推し量ると行けない旅程ができます）。分かることを
  // 言い切り、分からないことは分からないと書きます。
  if (item.shape?.kind === "trail") {
    const sh = item.shape;
    const stop = (st) => (st ? `最寄り: ${st.name}${st.km ? `・約${st.km}km` : ""}` : "最寄りは分かりません");
    if (sh.entry && sh.exit) {
      extra.append(el("p", { class: "sun shape" },
        icon("forward"),
        el("span", {},
          `これは道の名前です。収録には両端があります（約${sh.km}km）。`
          + `入口: ${sh.entry.name}（${stop(sh.entryStop)}）／`
          + `出口: ${sh.exit.name}（${stop(sh.exitStop)}）。`
          + "歩き通すなら、帰りは入口ではなく出口の最寄りから乗ることに"
          + "なります。この旅程の時刻は入口へ戻る前提で組んであるので、"
          + "通り抜ける場合は次の移動を出口から確かめてください。")));
    } else {
      extra.append(el("p", { class: "sun shape" },
        icon("forward"),
        el("span", {},
          "これは道の名前です。収録にあるのは道の上の1点だけで、"
          + "入口ではありません。どこから入ってどこへ抜けるのかは、"
          + "こちらでは分かりません。"
          + (sh.entryStop ? `この点の最寄りは ${sh.entryStop.name}`
              + `（約${sh.entryStop.km}km）です。` : "")
          + "通り抜けるなら、帰りは抜けた先の最寄りから乗ることになります。")));
    }
  } else if (item.shape?.kind === "wide") {
    const sh = item.shape;
    const parts = [
      "これは広い場所の名前です。座標は代表の1点で、入口ではありません。",
    ];
    if (sh.inside?.length) {
      parts.push("中の行き先として収録にあるのは: "
        + sh.inside.map((x) => `${x.name}（約${x.km}km）`).join("、")
        + "。どこへ行くかで最寄りもかかる時間も変わります。");
    } else {
      parts.push("中の行き先は収録にありません。どこへ行くかで最寄りも"
        + "かかる時間も変わります。");
    }
    if (sh.stop) {
      parts.push(`代表の点の最寄りは ${sh.stop.name}（約${sh.stop.km}km）です。`);
    }
    extra.append(el("p", { class: "sun shape" },
      icon("area"),
      el("span", {}, parts.join(""))));
  }

  // 同行者のための一言（js/access.js）。
  //
  // 収録に「バリアフリーかどうか」はありません。持っているのは分類
  // だけなので、**「行けません」とは言いません**。何がつらい分類
  // なのかと、確かめ先を書きます。決めるのは本人です。
  if (item.access?.why) {
    extra.append(el("p", { class: "sun access" },
      icon("access"),
      el("span", {}, item.access.why)));
  }

  // 同じ地点にある別の立ち寄り。
  //
  // 座標が同じなので、移動は0分です。ただし**同じものかどうかは
  // 分かりません**（「九重山」と「久住山」は同じ座標の別名ですが、
  // 「小樽美術館」と「小樽文学館」は同じ建物の別の施設です）。
  // 決めずに、そう書きます。
  if (item.sameSpot?.length) {
    extra.append(el("p", { class: "sun samespot" },
      icon("samespot"),
      el("span", {},
        `${item.sameSpot.join("・")}と同じ地点です`
        + "（移動は要りません。収録では別の名前で入っていますが、"
        + "同じものかどうかはこちらでは分かりません）")));
  }
  if (item.kind === "spot" && (item.reason || item.fit)) {
    extra.append(el("p", { class: "reason" }, item.fit?.summary ?? item.reason));
    // なぜここが選ばれたのか。軸ごとに出すと、納得も反論もできます。
    if (item.fit?.axes?.length) {
      const box = el("details", { class: "transit-steps" });
      box.append(el("summary", {}, `この場所を選んだ理由（適合 ${item.fit.total}）`));
      const inner = el("div", { style: "padding:8px 14px 14px" },
        axisList(item.fit.axes));
      // その場所がどういう場所か。知名度だけでは分かりません。
      inner.append(el("p", { class: "fine", style: "margin-top:12px" },
        "この場所の性格"));
      inner.append(el("ul", { class: "quality" },
        qualityOf(item.place).map((q) => el("li", {},
          icon(q.icon, { class: "q-ic" }),
          el("span", { class: "q-label" }, q.label),
          el("span", { class: "q-stars", role: "img", "aria-label": `${q.stars} / 5` },
            el("span", {}, "★".repeat(q.stars)),
            el("span", { class: "off" }, "★".repeat(5 - q.stars)))))));
      box.append(inner);
      extra.append(box);
    }
  }
  if (sunNote) {
    info.append(el("p", { class: `sun ${sunNote.kind}` },
      icon(sunNote.kind === "dark" ? "moon" : "sunset"),
      " ", sunNote.text));
  }
  // その日の営業時間。閉館だけでなく最終入場も出します。
  // 「17:00まで開いている」と「16:30までに入れば見られる」は別のことです。
  if (item.hoursText) {
    const p = el("p", { class: "hours" },
      icon("wait"),
      el("span", {}, item.hoursText));
    if (item.place) p.append(srcChip(confidenceOf("hours", item.place)));
    if (item.hoursNote) p.title = item.hoursNote;
    info.append(p);
  }

  // 駄目だったときの代わり。
  //
  // 雨も休館も、現地で分かります。そのとき代わりを探すことになるのが
  // いちばん困るので、近くの1か所だけ先に決めておきます
  // （backup.js。候補は旅程を組んだときと同じ集合から取っています）。
  if (item.backup) {
    // 印は、何が心配なのかで変えます。雨と休館は別のことです。
    const mark = item.backup.why === "closed" ? "lock" : "rain";
    const p = el("p", { class: "backup" },
      icon(mark),
      el("span", {}, item.backup.text));
    p.append(el("a", {
      href: mapsSearchUrl(item.backup.name,
        { lat: item.backup.lat, lng: item.backup.lng }),
      target: "_blank", rel: "noreferrer", class: "link",
    }, "地図"));
    info.append(p);
  }

  // 事前予約。行ってから知るのがいちばん困ります。
  if (item.kind === "spot" && item.place) {
    const r = reservationOf(item.place);
    if (r.required || r.likely) {
      const p = el("p", { class: `reserve${r.required ? " need" : ""}` },
        icon(r.required ? "warn" : "info"),
        el("span", {}, r.text));
      if (r.url) {
        p.append(el("a", { href: r.url, target: "_blank", rel: "noreferrer",
                           class: "link" }, "公式サイトで申し込む"));
      }
      info.append(p);
    }
  }

  if (item.costYen > 0) {
    info.append(el("p", { class: "cost" },
      `¥${item.costYen.toLocaleString()}${item.estimated === false ? "" : "（目安）"}`));
  }

  if (extra !== info && extra.childElementCount) {
    const fold = el("details", { class: "spot-more" },
      el("summary", {}, "この場所のくわしいこと"));
    fold.append(extra);
    info.append(fold);
  }

  // 食事・宿泊・スポットの外部リンク
  const ctx = {
    lat: item.near?.lat ?? item.place?.lat,
    lng: item.near?.lng ?? item.place?.lng,
    regionName: item.near?.regionName ?? itin.regionName,
    place: item.place, wikipedia: item.place?.wikipedia,
    checkIn: item.checkIn, checkOut: item.checkOut,
    from: item.from, to: item.to,
  };
  const links = linksForItem(item, ctx);
  if (links.length) {
    info.append(el("div", { class: "item-links" },
      links.map((l) => el("a", {
        href: l.url, target: "_blank", rel: "noreferrer",
        class: l.primary ? "link primary-link" : "link",
      }, l.label))));
  }

  // この場所を、その場で差し替える・外す。
  //
  // 気に入らない1か所のために、条件の画面まで戻って組み直すのは重すぎます。
  // かといって、ここで旅程を直接いじると、営業時間も移動時間も合わなく
  // なります。押されたら**条件を書き換えて、同じエンジンで組み直す**。
  // 言葉で直すとき（edit.js）とまったく同じ道を通ります。
  if (item.kind === "spot" && item.place && handlers.onSpotEdit) {
    const id = item.spotId ?? item.place.id;
    const row = el("div", { class: "spot-actions" });
    // 読み上げの名前には、**見えている字をそのまま含めます**。
    // 「別の候補」と見えているボタンが「小町通りを別の場所に差し替える」
    // と読まれると、声で操作する人が「別の候補を押して」と言っても
    // 通じません（axe の label-content-name-mismatch）。
    const act = (action, label, name) => {
      const b = el("button", {
        type: "button", class: "spot-action", "data-action": action,
        // 読み上げの名前には、見えている言葉を含めます。音声で操作する
        // 人は「別の候補」と言って押します。名前にその言葉が無いと、
        // 押せません（axe の label-content-name-mismatch）。
        "aria-label": name,
      }, label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        handlers.onSpotEdit({ id, name: item.title, action });
      });
      return b;
    };
    row.append(
      act("replace", "別の候補", `${item.title}の別の候補を出す`),
      act("remove", "外す", `${item.title}を旅程から外す`),
    );
    info.append(row);
  }

  // 順番と、いる時間。
  //
  // 並びは道順と混雑から決めていますが、「先に海へ行きたい」は好みの
  // 問題です。いる時間も、分類ごとの目安（美術館70分）が合わない
  // ことがあります。どちらも旅程の中身そのものなので、その場で
  // 動かせるようにします。
  //
  // **時刻は必ず組み直します。** 並べ替えただけで時刻をそのままに
  // すると、開館前に着く旅程ができます。押されたら条件を書き換えて、
  // 同じエンジンを通します（「別の候補」とまったく同じ道です）。
  if (item.kind === "spot" && item.place
      && (handlers.onSpotOrder || handlers.onSpotDwell)) {
    info.append(tuneRow(item, itin, handlers));
  }

  if (item.kind === "spot" && handlers.onSpot) {
    // カードそのものはボタンにしません。
    //
    // 以前は role="button" と tabindex="0" をカードに付けていました。
    // ところがカードの中には Wikipedia や地図へのリンク、「選んだ理由」の
    // 折りたたみが入っています。**ボタンの中に押せるものは置けません。**
    // 読み上げでは中身がボタンの名前として1つに読まれ、中のリンクへは
    // 行けなくなります。
    //
    // 開く操作は、右下の「›」を本物の <button> にして受け持たせます。
    // 見た目は同じで、キーボードでも順に辿れます。マウスでカードの
    // どこを押しても開くのは、これまでどおりです。
    const open = (e) => {
      if (e.target.closest("a, button, summary")) return;
      handlers.onSpot(item);
    };
    body.addEventListener("click", open);
    const more = el("button", {
      type: "button", class: "chev",
      "aria-label": `${item.title}をくわしく見る`,
    }, el("span", { "aria-hidden": "true" }, "›"));
    more.addEventListener("click", () => handlers.onSpot(item));
    if (handlers.onHover) {
      li.addEventListener("mouseenter", () => handlers.onHover(item, true));
      li.addEventListener("mouseleave", () => handlers.onHover(item, false));
      more.addEventListener("focus", () => handlers.onHover(item, true));
      more.addEventListener("blur", () => handlers.onHover(item, false));
    }
    body.append(more);
  }

  li.append(body);
  return li;
}

export function openSheet(item, { onClose, describe }) {
  const spot = item.place;
  const prof = profileOf(spot);
  const bg = el("div", { class: "md-sheet-scrim" });
  const sheet = el("div", { class: "md-sheet", role: "dialog",
                            "aria-modal": "true", "aria-label": spot.name });

  const at = item.start ?? new Date();
  const day = hoursFor(spot, at);
  const hours = describeHours(spot, at);

  sheet.append(el("div", { class: "md-sheet-handle" }, el("i", {})));
  sheet.append(el("button", {
    class: "md-icon-btn md-state close", type: "button",
    "aria-label": "閉じる", onClick: () => close(),
  }, icon("close")));

  // 写真ヘッダー。スクロールに合わせて遅れて動きます。
  const art = cardArt(spot, { tall: true });
  sheet.append(art);
  sheet.addEventListener("scroll", () => {
    // 視差（絵が本文よりゆっくり動く）は、動きを減らす設定では
    // やめます。画面の中で2つの速さが動くのが、いちばん酔う形です。
    art.style.backgroundPositionY = prefersReducedMotion()
      ? "0px" : `${sheet.scrollTop * 0.35}px`;
  }, { passive: true });

  const body = el("div", { class: "sheet-body" });
  body.append(
    el("h3", {}, spot.name),
    el("p", { class: "sub" },
      [spot.category, spot.prefecture, spot.region].filter(Boolean).join("・")),
  );

  const desc = el("p", { class: "desc" }, spot.description ?? "");
  body.append(desc);

  // なぜこの場所が選ばれたのか。地の文と混ぜず、引用として見せます。
  if (item.fit?.summary || item.reason) {
    body.append(el("p", { class: "why-quote" },
      item.fit?.summary ?? item.reason));
  }
  if (item.fit?.axes?.length) {
    body.append(el("div", { class: "card", style: "padding:16px" },
      axisList(item.fit.axes)));
  }

  body.append(el("div", { class: "card" },
    row("目安の滞在時間", fmtDuration(prof.dwell)),
    row(day.closed ? "この日は" : "見学できる時間", hours),
    row("入場料", prof.fee === 0 ? "無料" : `¥${prof.fee.toLocaleString()}`),
    // いつの情報か。出どころ（下の印）と鮮度は別のことなので、並べて出します。
    // 収録の日付は「取り込んだ日」です（js/kb.js の FETCHED_ON）。
    row("情報の日付", freshnessOf(spot.fetchedAt).text)));

  // 情報の出どころ。営業時間と料金で違うことがあるので、分けて出します。
  body.append(el("div", { class: "links", style: "margin-top:12px" },
    srcChip(confidenceOf("hours", spot), "営業時間"),
    srcChip(confidenceOf("fee", spot), "料金")));

  const reserve = reservationOf(spot);
  if (reserve.required || reserve.likely) {
    const p = el("p", {
      class: reserve.required ? "hint warn-hint" : "hint",
    }, reserve.text);
    if (reserve.url) {
      p.append(" ", el("a", { href: reserve.url, target: "_blank",
                              rel: "noreferrer" }, "公式サイトで申し込む"));
    }
    body.append(p);
  }

  body.append(el("ul", { class: "quality", style: "margin-top:16px" },
    qualityOf(spot).map((q) => el("li", {},
      icon(q.icon, { class: "q-ic" }),
      el("span", { class: "q-label" }, q.label),
      el("span", { class: "q-stars", role: "img", "aria-label": `${q.stars} / 5` },
        el("span", {}, "★".repeat(q.stars)),
        el("span", { class: "off" }, "★".repeat(5 - q.stars)))))));

  if (day.riskyNote) {
    body.append(el("p", { class: "hint warn-hint" }, day.riskyNote));
  }
  if (day.note) body.append(el("p", { class: "hint" }, day.note));

  const links = linksForItem({ kind: "spot" },
    { place: spot, wikipedia: spot.wikipedia });
  body.append(el("div", { class: "links" },
    links.map((l) => el("a", {
      href: l.url, target: "_blank", rel: "noreferrer",
      class: l.primary ? "primary" : "",
    }, l.label))));

  sheet.append(body);
  bg.append(sheet);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  document.body.append(bg);

  // 携帯では、半分の高さで開きます。
  //
  // 全画面で開くと、地図が隠れます。地図で場所を確かめたくて押したのに
  // 場所が見えない、という順番になっていました。上半分を地図に残し、
  // 摘みを上へ引けば全部、下へ引けば閉じる、という形にします。
  // 広い画面では地図が横に出ているので、これまでどおり全部開きます。
  const draggable = isNarrowScreen();
  if (draggable) dragSheet(sheet, bg, close);

  // aria-modal="true" は、支援技術に「これは前面のものです」と伝えるだけで、
  // Tab の行き先までは変えません。実装しないと、Tab を押しつづけたときに
  // 後ろの旅程やフォームへ抜けていきます。見えているのはシートだけなので、
  // 使う側からは、フォーカスが行方不明になったように見えます。
  const opener = document.activeElement;
  const focusables = () => [...sheet.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]),'
    + ' textarea:not([disabled]), select:not([disabled]),'
    + ' details > summary, [tabindex]:not([tabindex="-1"])')]
    .filter((e) => e.offsetParent !== null);

  // 開いたら、シートの中へ入れます。入れないと、閉じるボタンへ
  // たどり着くまでに、後ろの要素を全部通ることになります。
  (focusables()[0] ?? sheet).focus?.();

  const onKey = (e) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list.at(-1);
    // 端まで来たら、反対の端へ回します（外へは出しません）。
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    } else if (!sheet.contains(document.activeElement)) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener("keydown", onKey);

  describe?.(spot).then((text) => {
    if (text && text !== spot.description) desc.textContent = text;
  }).catch(() => { /* 説明が取れなくても表示は保つ */ });

  function close() {
    document.removeEventListener("keydown", onKey);
    bg.remove();
    // 閉じたら、開いたところへ戻します。戻さないと、フォーカスが
    // <body> に落ち、次の Tab がページの先頭から始まります。
    // どこを読んでいたのかが分からなくなります。
    if (opener instanceof HTMLElement && document.contains(opener)) {
      opener.focus();
    }
    onClose?.();
  }
  return close;
}

function row(label, value) {
  return el("div", { class: "row" },
    el("span", {}, label), el("b", {}, value));
}

/** 見学（スポット滞在）に使った時間の合計。 */
function sightseeingMinutes(itin) {
  let m = 0;
  for (const day of itin.days) {
    for (const item of day.items) {
      if (item.kind === "spot") m += (item.end - item.start) / 60000;
    }
  }
  return Math.round(m);
}

/** 「こうすれば行けます」のボタン。押すと条件を書き換えて組み直します。 */
export function suggestionButton(s, onSuggest) {
  return el("button", {
    class: "relax-btn md-state", type: "button",
    onClick: () => onSuggest(s),
  }, el("b", {}, s.label), el("span", {}, s.detail));
}
