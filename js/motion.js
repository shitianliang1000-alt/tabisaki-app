// 答えの「動き」（2026-10-22 のご依頼: AIの画面を動的に）。
//
// 字が流れるように出る・部品が下からふわっと順に出る、の2つだけです。
// どちらも**字そのものは最初から全部 DOM にあります**。見た目だけを
// CSS のアニメーションで遅らせるので、読み上げ・コピー・検索・試験は
// 動きの有無に関係なく同じものを読めます。
//
// 「動きを減らす」設定の人には、何もしません（CSS 側でも止めます）。

/** 動きを減らす設定か。 */
function reduced() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** 1文字ずつにすると長い答えで重くなるので、数文字ずつの塊にします。 */
const CHUNK = 2;
/** 1塊あたりの遅れ（ミリ秒）。 */
const STEP = 14;
/** これより長い文は、最後のほうを一気に出します（待たせすぎない）。 */
const MAX_MS = 1400;

/**
 * 段落の字を、流れるように出します。
 * @param {HTMLElement} p 字だけが入った要素
 * @param {number} [startMs] 始めるまでの遅れ
 * @returns {number} 出し終わるまでのミリ秒
 */
export function streamText(p, startMs = 0) {
  if (!p || reduced()) return 0;
  const text = p.textContent ?? "";
  if (!text) return 0;
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  const step = Math.min(STEP, MAX_MS / Math.max(1, parts.length));
  p.replaceChildren(...parts.map((t, i) => {
    const s = document.createElement("span");
    s.className = "stream-ch";
    s.style.animationDelay = `${Math.round(startMs + i * step)}ms`;
    s.textContent = t;
    return s;
  }));
  p.classList.add("is-streaming");
  return startMs + parts.length * step;
}

/**
 * 子どもを、上から順にふわっと出します。
 * @param {Element[]} nodes
 * @param {number} [startMs]
 * @param {number} [gap] 1つごとの遅れ
 */
export function riseIn(nodes, startMs = 0, gap = 70) {
  if (reduced()) return;
  let i = 0;
  for (const n of nodes) {
    if (!n?.classList) continue;
    n.classList.add("rise");
    n.style.animationDelay = `${Math.round(startMs + i * gap)}ms`;
    i += 1;
  }
}
