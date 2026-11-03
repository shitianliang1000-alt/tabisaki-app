// 足りない条件を聞くカード（画面側）。
//
// 判断はすべて packages/core/src/slots.js です。ここは見せるだけです。
//
//   頼んだ文（右の吹き出し）
//   ┌ 読み取った条件（聞き直さないもの）
//   │ 足りない分の質問だけ。選択肢＋「上記以外（自由に書く）」
//   │ 追加の要望（任意）
//   └ [この内容で組む]  □ 次からは聞かずに組む
//
// 札を押すと、その枠は埋まり、まだ足りない質問だけが残ります。チャット欄に
// 返信しても同じです（js/app.js の send が replyDialog に回します）。
// 全部埋まったら、確かめの形（読み取った内容＋追加の要望）になります。

import { el, scrollBehavior } from "./ui.js";
import { icon } from "./icons.js";
import { answerDialog, confirmLines, finishDialog, replyDialog } from "../packages/core/src/slots.js";

const OFF_KEY = "tabisaki.askSlots";

/** 「次からは聞かずに組む」を選んだか。 */
export function slotsOff() {
  try { return globalThis.localStorage?.getItem(OFF_KEY) === "off"; } catch { return false; }
}
function setSlotsOff(off) {
  try {
    if (off) globalThis.localStorage?.setItem(OFF_KEY, "off");
    else globalThis.localStorage?.removeItem(OFF_KEY);
  } catch { /* 保存できなくても、今回は組めます */ }
}

/**
 * カードを出します。
 *
 * @param {string} said 書いたままの文
 * @param {object} dialog startDialog の結果
 * @param {(note: string) => void} onDone 組むとき（足した文を渡します）
 * @returns {{ reply: (text: string) => void, close: () => void, active: () => boolean }}
 */
export function openSlotCard(said, dialog, onDone) {
  const thread = document.querySelector("#thread");
  const user = el("div", { class: "turn turn-user turn-slots-q" }, el("p", { class: "bubble" }, said));
  const body = el("div", { class: "ai-answer slot-card", role: "group", "aria-label": "旅の条件の確認" });
  const ai = el("div", { class: "turn turn-ai turn-slots" },
    el("span", { class: "ai-mark", "aria-hidden": "true" }, icon("sparkle")),
    el("div", { class: "ai-body" }, body));
  thread?.append(user, ai);
  document.body.dataset.view = "result";

  let d = dialog;
  let open = true;
  const extra = el("input", {
    type: "text", class: "slot-extra-input", id: "slot-extra",
    placeholder: "例: 露天風呂のある宿、夜は地元の居酒屋へ",
    "aria-label": "追加の要望（任意）",
  });
  const off = el("input", { type: "checkbox", id: "slot-off" });
  const go = el("button", { type: "button", class: "md-btn md-btn--filled md-state slot-go", id: "slot-go" },
    "この内容で組む");
  go.addEventListener("click", () => finish());
  extra.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(); }
  });

  function finish() {
    if (!open) return;
    open = false;
    if (off.checked) setSlotsOff(true);
    const note = finishDialog(d, extra.value);
    user.remove(); ai.remove();
    onDone(note);
  }

  function render() {
    const known = confirmLines(d.slots).filter((l) => l.filled);
    const asking = d.phase === "asking";
    const lead = asking
      ? (known.length ? "書いてあったことはそのまま使います。あと少しだけ教えてください。"
        : "いくつか教えてください。分からなければ、そのまま組めます。")
      : "この内容で組みます。ほかに希望があれば書いてください（なくても組めます）。";
    const rows = d.questions.map((q) => questionRow(q));
    body.replaceChildren(
      el("p", { class: "slot-lead" }, lead),
      known.length
        ? el("ul", { class: "read-chips slot-known", "aria-label": "読み取った条件" },
            ...known.map((l) => el("li", {}, `${l.label}: ${l.value}`)))
        : null,
      ...rows,
      el("label", { class: "slot-extra", for: "slot-extra" }, "追加の要望（任意）"),
      extra,
      el("div", { class: "slot-actions" }, go,
        el("label", { class: "slot-off", for: "slot-off" }, off, "次からは聞かずに組む")),
    );
  }

  function questionRow(q) {
    const name = `slot-${q.slot}${q.part ? `-${q.part}` : ""}`;
    const free = el("input", {
      type: "text", class: "slot-free", hidden: "",
      "aria-label": `${q.question}（自由に書く）`, placeholder: "自由に書いて Enter",
    });
    free.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      if (free.value.trim()) answer(q, { text: free.value });
    });
    const chips = q.choices.map((c) => {
      const b = el("button", {
        type: "button", class: "md-chip md-chip--assist md-state slot-choice",
        "data-slot": q.slot, "data-part": q.part ?? "", "data-choice": c.id,
      }, c.label);
      b.addEventListener("click", () => {
        if (c.free) { free.hidden = false; free.focus(); return; }
        answer(q, { choice: c.id });
      });
      return b;
    });
    return el("div", { class: "slot-q", id: name },
      el("p", { class: "slot-question" }, q.question),
      el("div", { class: "chip-set slot-choices", role: "group", "aria-label": q.question }, ...chips),
      free);
  }

  function answer(q, a) {
    if (!open) return;
    d = answerDialog(d, q, a);
    render();
    // 全部答えたら、確かめに目を移します（追加の要望の欄）。
    if (d.phase === "ready") extra.focus({ preventScroll: true });
  }

  render();
  requestAnimationFrame(() => {
    user.scrollIntoView?.({ block: "start", behavior: scrollBehavior() });
  });

  return {
    active: () => open,
    /** チャット欄に書いた返信。読み取れた枠の質問は消えます。 */
    reply(text) {
      if (!open) return;
      // 確かめの段で書いたことは、追加の要望です。そのまま組みます。
      if (d.phase === "ready") {
        extra.value = [extra.value.trim(), String(text ?? "").trim()].filter(Boolean).join("。");
        finish();
        return;
      }
      d = replyDialog(d, text);
      render();
    },
    close() {
      if (!open) return;
      open = false;
      user.remove(); ai.remove();
    },
    /** いまの状態（テスト・保存用）。 */
    get dialog() { return d; },
    /** いま組む（チャット欄からの送信を「この内容で組む」とみなすとき）。 */
    finish,
  };
}
