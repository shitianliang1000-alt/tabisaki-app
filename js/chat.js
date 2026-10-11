// やりとりの画面。頼んだこと（右の吹き出し）と、その答え（左）を
// 上から順に積みます。
//
// 答えは、まず**読めば分かる短さ**にします。
//
//   どこへ・何日の旅か → 候補（ゆったり／王道／探索） → 1日目の行程
//   → 「詳細を確認する」（地図・天気・確かめたこと・費用…）
//
// 以前は、組み終わると20近い分析の板と地図が一度に出ていました。
// 旅を決めたい人が最初に知りたいのは「どこへ行って、何時に何をするか」
// です。細かい根拠は消さず、ボタンの奥に置きます。
//
// 地図や旅程の部品（#result・#progress・#form-error）は、画面に1組
// しかありません。いちばん新しい答えの中へ移して使い、前の答えには
// 短い文だけを残します。

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
  park();
  current.details.remove();
  for (const n of current.ai.querySelectorAll(".details-toggle, .ai-details-note, .ai-follow-note, .follow-ups, .cands button")) {
    if (n.tagName === "BUTTON" && n.closest(".cands")) {
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
  current.answer.replaceChildren(el("p", {}, text));
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
  answer.replaceChildren();
  const title = itin.title ?? itin.regionName ?? "旅程";
  const nights = nightsOf(itin);
  const span = nights > 0 ? `${nights}泊${nights + 1}日` : "日帰り";
  const where = itin.prefecture && !title.includes(itin.prefecture)
    ? `${title}（${itin.prefecture}）` : title;

  if (itin.editNote) answer.append(el("p", { class: "ai-edit" }, itin.editNote));
  answer.append(el("p", { class: "ai-lead" },
    `${where}への${span}の旅を組みました。`
    + (itin.spotCount ? `立ち寄りは${itin.spotCount}か所です。` : "")));
  if (itin.rationale) answer.append(el("p", {}, itin.rationale));

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

  // 行程（いま選んでいる候補のもの）。
  const days = itin.days ?? [];
  if (days.length) {
    answer.append(el("p", { class: "ai-sub" },
      itin.variants?.length > 1
        ? `「${VARIANTS[itin.variantKey]?.label ?? "この候補"}」の行程です。`
        : "行程です。"));
    days.forEach((d, i) => answer.append(dayList(d, i)));
  }

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
    "天気・地図・確かめたこと・費用は、詳細にまとめています。"), toggle);
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
}
