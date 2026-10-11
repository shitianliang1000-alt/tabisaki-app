// やりとりの画面。頼んだこと（右の吹き出し）と、その答え（左）を
// 上から順に積みます。
//
// 答えは、まず**読めば分かる短さ**にします。
//
//   どこへ・何日の旅か → 候補（ゆったり／王道／探索） → 地図 → 行程と経路
//   → 「詳細を確認する」（天気・確かめたこと・費用…）
//
// 以前は、組み終わると20近い分析の板と地図が一度に出ていました。
// 旅を決めたい人が最初に知りたいのは「どこへ行って、何時に何をするか」
// です。細かい根拠は消さず、ボタンの奥に置きます。
//
// 地図や旅程の部品（#result・#map・#progress・#form-error）は、画面に
// 1組しかありません。いちばん新しい答えの中へ移して使います。前の
// 答えには、そのときの行程を短い表にして残します（くわしい行程の
// ボタンを押すと、いまの旅程のほうが変わってしまうためです）。
//
// 地図と、行程（時刻・乗る電車・歩く道）は答えの本文に出します
// （2026-10、ご指示）。以前は「詳細を確認する」の中でした。

import { el, fmtDay, fmtTime, scrollBehavior } from "./ui.js";
import { icon } from "./icons.js";
import { VARIANTS } from "./variants.js";

const $ = (s) => document.querySelector(s);

/** いま書き込んでいる答え。 */
let current = null;

/** やりとりが始まっているか。 */
export function hasTurn() {
  return current !== null;
}

/** 部品を、置き場（#stash）へ戻します。 */
function park() {
  const stash = $("#stash");
  if (!stash) return;
  for (const id of ["#form-error", "#progress", "#result"]) {
    const node = $(id);
    if (node && node.parentElement !== stash) stash.append(node);
  }
  // 地図は #result の先頭が元の場所です。
  const map = $("#map");
  const result = $("#result");
  if (map && result && map.parentElement !== result) result.prepend(map);
}

/**
 * 書き直す前に、地図を元の場所（#result の先頭）へ戻します。
 * 答えの中に地図があるまま中身を入れ替えると、地図ごと消えて、
 * 二度と出せなくなります。
 */
function rescueMap(node) {
  const map = $("#map");
  const result = $("#result");
  if (map && result && node?.contains(map)) result.prepend(map);
  // 旅の当日の札（#today）も同じです。元の場所は #result の .itin です。
  const today = $("#today");
  const home = result?.querySelector(":scope > .itin");
  if (today && home && node?.contains(today)) home.prepend(today);
}

/**
 * いまの答えを、読むだけのものにします（次の頼みごとが来たとき）。
 * 失敗の文は、部品と一緒に移ってしまうので、写して残します。
 */
function freeze() {
  if (!current) return;
  const err = $("#form-error");
  if (err && !err.hidden && err.textContent.trim() && current.ai.contains(err)) {
    current.answer.append(el("p", { class: "ai-error" }, err.firstChild?.textContent ?? err.textContent));
  }
  rescueMap(current.ai);
  park();
  current.details.remove();
  current.route?.querySelector(".ai-map")?.remove();
  // 前の答えの行程は、短い表に戻します。くわしい行程（押せるもの・
  // 日のタブ）は、いまの答えにだけ置きます。
  if (current.daySlot && current.mini) current.daySlot.replaceChildren(...current.mini);
  for (const n of current.ai.querySelectorAll(".details-toggle, .ai-details-note, .ai-follow-note, .follow-ups, .ai-today, .ai-share, .cands button")) {
    if (n.closest(".cands")) {
      n.disabled = true;
    } else {
      n.remove();
    }
  }
  current.ai.classList.add("is-past");
  current = null;
}

/**
 * 頼みごとを1つ積み、その答えの場所を用意します。
 *
 * @param {string} text 書いたこと
 * @param {string[]} [labels] 読み取った条件（吹き出しの下に並べます）
 */
export function startTurn(text, labels = []) {
  freeze();
  const thread = $("#thread");
  if (!thread) return;
  const user = el("div", { class: "turn turn-user" },
    el("p", { class: "bubble" }, text || "おまかせで組んでください"),
    labels.length
      ? el("ul", { class: "read-chips", "aria-label": "読み取った条件" },
          ...labels.map((t) => el("li", {}, t)))
      : null);
  const answer = el("div", { class: "ai-answer" });
  const details = el("div", { class: "turn-details", id: "turn-details", hidden: "" });
  const body = el("div", { class: "ai-body" });
  body.append(...[$("#form-error"), $("#progress"), answer, details].filter(Boolean));
  const result = $("#result");
  if (result) details.append(result);
  const ai = el("div", { class: "turn turn-ai" },
    el("span", { class: "ai-mark", "aria-hidden": "true" }, icon("sparkle")),
    body);
  thread.append(user, ai);
  current = { user, ai, answer, details };
  document.body.dataset.view = "result";
  // 頼んだことが上に来るように送ります（Claude と同じ動き）。
  requestAnimationFrame(() => {
    user.scrollIntoView?.({ block: "start", behavior: scrollBehavior() });
  });
}

/**
 * 質問を1つ積みます（旅程は組み直しません）。
 *
 * いまの答え（旅程）は、そのまま触れる形で残します。質問のたびに
 * 旅程が読むだけになると、聞いてから「この候補で」と押せません。
 * 答えは、返したものを書き込む関数で渡します。
 *
 * @param {string} text 聞いたこと
 * @returns {{ answer: (text: string, sources?: {title: string, url: string}[]) => void, node: HTMLElement }}
 */
export function askTurn(text) {
  const thread = $("#thread");
  const user = el("div", { class: "turn turn-user turn-ask" },
    el("p", { class: "bubble" }, text));
  const body = el("div", { class: "ai-answer ai-qa", role: "status", "aria-live": "polite" },
    el("p", { class: "ai-thinking" }, "考えています…"));
  const ai = el("div", { class: "turn turn-ai turn-qa" },
    el("span", { class: "ai-mark", "aria-hidden": "true" }, icon("sparkle")),
    el("div", { class: "ai-body" }, body));
  thread?.append(user, ai);
  document.body.dataset.view = "result";
  requestAnimationFrame(() => {
    user.scrollIntoView?.({ block: "start", behavior: scrollBehavior() });
  });
  return {
    node: ai,
    answer(said, sources = []) {
      body.replaceChildren(...String(said).split(/\n{2,}/).map((t) => el("p", {}, t)));
      if (sources.length) {
        body.append(el("ul", { class: "qa-src", "aria-label": "調べた先" },
          ...sources.map((s) => el("li", {},
            el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, s.title)))));
      }
    },
  };
}

/** やりとりを全部消して、はじめの画面に戻します（「新しい旅」）。 */
export function resetThread() {
  park();
  $("#thread")?.replaceChildren();
  current = null;
  document.body.dataset.view = "form";
}

/** 答えの欄に、ひとこと書きます（やめた・組めなかった など）。 */
export function sayInTurn(text) {
  if (!current) return;
  rescueMap(current.answer);
  current.answer.replaceChildren(el("p", {}, text));
}

/**
 * いまの答えの、行程を書く場所（js/ui.js の renderItinerary が使います）。
 * 答えがまだ無ければ null。
 */
export function routeSlot() {
  return current?.daySlot ?? null;
}

/** 旅の当日の札（#today）を、いまの答えの中へ移します。 */
export function placeToday() {
  const today = $("#today");
  if (!current?.todaySlot?.isConnected || !today) return false;
  if (today.parentElement !== current.todaySlot) current.todaySlot.append(today);
  return true;
}

/**
 * 地図（#map）を、いまの答えの中へ移します。移したら true。
 * 行程が無い答え（組めなかった）には移しません。
 */
export function placeMap() {
  const map = $("#map");
  if (!current?.mapSlot?.isConnected || !map) return false;
  if (map.parentElement !== current.mapSlot) current.mapSlot.append(map);
  return true;
}

/** 移動の行を「電車 40分」のような短い言葉にします。 */
function moveWord(item) {
  const min = Math.round((new Date(item.end) - new Date(item.start)) / 60000);
  const how = item.walk ? "徒歩" : item.taxi ? "タクシー" : item.drive ? "車" : "移動";
  return Number.isFinite(min) && min > 0 ? `${how} ${min}分` : how;
}

function nightsOf(itin) {
  const d = itin.days ?? [];
  return d.length ? Math.round((d.at(-1).key - d[0].key) / 86400000) : 0;
}

/**
 * 1日ぶんの行程を、短い表にします。移動は1行にまとめて小さく。
 */
function dayList(day, index) {
  const rows = [];
  for (const item of day.items ?? []) {
    const start = new Date(item.start);
    if (item.kind === "transit") {
      rows.push(el("li", { class: "mini-move" }, moveWord(item)));
      continue;
    }
    if (item.kind === "free") continue;
    rows.push(el("li", { class: `mini-${item.kind}` },
      el("span", { class: "mini-time" }, Number.isFinite(start.getTime()) ? fmtTime(start) : ""),
      el("span", { class: "mini-name" }, item.title ?? item.place?.name ?? "")));
  }
  return el("section", { class: "mini-day" },
    el("h3", { class: "mini-day-head" }, `${index + 1}日目`,
      el("small", {}, fmtDay(day.date))),
    el("ol", { class: "mini-list" }, ...rows));
}

/**
 * できた旅程を、答えとして書きます。
 *
 * @param {object} itin
 * @param {object} h
 * @param {(key: string) => void} [h.onVariant] 候補を選んだとき
 * @param {(text: string) => void} [h.onFollow] 続けて頼むとき（下の札）
 * @param {() => void} [h.onDetails] 詳細を開いたとき（地図を描き直す）
 * @param {boolean} [h.openDetails] はじめから詳細を開いておく
 */
export function answerTurn(itin, h = {}) {
  if (!current) startTurn(itin.note ?? "");
  const { answer, details } = current;
  rescueMap(answer);
  answer.replaceChildren();
  const title = itin.title ?? itin.regionName ?? "旅程";
  const nights = nightsOf(itin);
  const span = nights > 0 ? `${nights}泊${nights + 1}日` : "日帰り";
  const where = itin.prefecture && !title.includes(itin.prefecture)
    ? `${title}（${itin.prefecture}）` : title;

  // 見出しの段を飛ばさないよう、答えに見えない見出しを1つ置きます
  // （日ごとの「1日目」は h3 です）。読み上げで答えの頭へ飛べます。
  answer.append(el("h2", { class: "sr-only" }, `${where}の旅程`));
  if (itin.editNote) answer.append(el("p", { class: "ai-edit" }, itin.editNote));
  answer.append(el("p", { class: "ai-lead" },
    `${where}への${span}の旅を組みました。`
    + (itin.spotCount ? `立ち寄りは${itin.spotCount}か所です。` : "")));
  if (itin.rationale) answer.append(el("p", {}, itin.rationale));

  // 旅の当日の札（次の予定・出発を知らせる・次の便を調べ直す…）。
  // 詳細の中に置くと、旅の途中でいちばん要るものが畳まれて見えません。
  // 答えの本文に出します（中身は js/app.js の renderTodayBox が書きます）。
  const todaySlot = el("div", { class: "ai-today" });
  answer.append(todaySlot);
  current.todaySlot = todaySlot;

  // 候補。ゆったり・王道・探索の3つを並べ、いま見ている1つに印を付けます。
  if (itin.variants?.length > 1 && h.onVariant) {
    answer.append(el("p", { class: "ai-sub" }, "候補です。"));
    const list = el("ul", { class: "cands" });
    for (const v of itin.variants) {
      const def = VARIANTS[v.key] ?? {};
      const on = v.key === itin.variantKey;
      const btn = el("button", {
        type: "button", class: `cand md-state${on ? " is-selected" : ""}`,
        "aria-pressed": String(on),
        onclick: () => h.onVariant(v.key),
      },
        el("b", {}, def.label ?? v.key),
        v.key === itin.recommendKey ? el("span", { class: "cand-badge" }, "おすすめ") : null,
        el("span", { class: "cand-sum" }, v.summary ?? def.blurb ?? ""));
      list.append(el("li", {}, btn));
    }
    answer.append(list);
  }

  // 地図と行程（いま選んでいる候補のもの）。行程は、組み立て側
  // （js/ui.js の renderItinerary）が時刻・乗る電車・歩く道まで入った
  // 形に差し替えます（routeSlot）。それまでの間と、試験のためには、
  // ここで短い表を書いておきます。
  const days = itin.days ?? [];
  const mapSlot = el("div", { class: "ai-map" });
  const daySlot = el("div", { class: "ai-days" });
  const mini = days.map((d, i) => dayList(d, i));
  daySlot.append(...mini);
  const route = el("div", { class: "ai-route" }, mapSlot, daySlot);
  if (days.length) {
    answer.append(el("p", { class: "ai-sub" },
      itin.variants?.length > 1
        ? `「${VARIANTS[itin.variantKey]?.label ?? "この候補"}」の行程です。`
        : "行程です。"), route);
  }
  current.route = route;
  current.mapSlot = mapSlot;
  current.daySlot = daySlot;
  current.mini = mini;

  // 詳細（地図・天気・確かめたこと・費用・直すボタン）。
  const toggle = el("button", {
    type: "button", class: "md-btn md-btn--tonal md-state details-toggle",
    id: "details-toggle", "aria-controls": "turn-details", "aria-expanded": "false",
  }, icon("chevron-down"), el("span", {}, "詳細を確認する"));
  const setOpen = (open) => {
    // 同じ答えの中で組み直したとき（候補の選び直し・1か所の差し替え）は、
    // 開いていたら開いたままにします。読んでいた所が急に閉じると迷います。
    current.detailsOpen = open;
    details.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector("span").textContent = open ? "詳細を閉じる" : "詳細を確認する";
    if (open) h.onDetails?.();
  };
  toggle.addEventListener("click", () => setOpen(details.hidden));
  answer.append(el("p", { class: "ai-sub ai-details-note" },
    "天気・確かめたこと・費用は、詳細にまとめています。"), toggle);
  setOpen(Boolean(h.openDetails || current.detailsOpen));

  // 続けて頼む札。押すと、そのまま送ります。
  if (h.onFollow) {
    answer.append(el("p", { class: "ai-sub ai-follow-note" },
      "変えたいところは、下の欄にそのまま書いて送ってください。"));
    const chips = el("div", { class: "chip-set follow-ups", role: "group", "aria-label": "続けて頼む" });
    for (const t of ["もっとゆっくりにして", "穴場を多めにして", nights > 0 ? "日帰りにして" : "1泊2日にして"]) {
      chips.append(el("button", {
        type: "button", class: "md-chip md-chip--assist md-state", onclick: () => h.onFollow(t),
      }, t));
    }
    answer.append(chips);
  }

  // 共有。答えのいちばん下に、共有の印を1つ置きます。押すと
  // 「リンク」「カレンダー」「文字で送る」が開きます。
  const shares = [
    h.onShareLink && ["link", "リンクで送る", h.onShareLink],
    h.onShareCalendar && ["calendar", "カレンダーに入れる", h.onShareCalendar],
    h.onShareText && ["message", "文字で送る / コピー", h.onShareText],
  ].filter(Boolean);
  if (shares.length) answer.append(shareBar(shares));
}

/**
 * 共有の印と、その中身。
 * @param {[string, string, () => Promise<string|void>|string|void][]} items
 */
function shareBar(items) {
  const said = el("span", { class: "ai-share-said", role: "status" });
  const menu = el("div", { class: "ai-share-menu", role: "group", "aria-label": "共有のしかた", hidden: "" });
  for (const [ic, label, run] of items) {
    const b = el("button", { type: "button", class: "ai-share-item md-state" },
      icon(ic), el("span", {}, label));
    b.addEventListener("click", async () => {
      said.textContent = "";
      try {
        const out = await run();
        if (out) said.textContent = out;
      } catch {
        said.textContent = "共有できませんでした";
      }
    });
    menu.append(b);
  }
  const btn = el("button", {
    type: "button", class: "ai-share-btn md-state",
    "aria-expanded": "false", "aria-label": "この旅程を共有", title: "共有",
  }, icon("share"), el("span", {}, "共有"));
  btn.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  return el("div", { class: "ai-share" }, btn, menu, said);
}
