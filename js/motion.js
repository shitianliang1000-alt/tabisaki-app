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

// ---------------------------------------------------------------------------
// はじめの画面と旅程の動き（2026-10-23 のご依頼: アプリにもモーションを）。
// トップ（php/assets/landing.*）と同じ考えかたで、
//   ・挨拶が1文字ずつ浮かび上がる
//   ・入力欄の見本の文が、打ち込まれるように入れ替わる
//   ・旅程の行は、見える位置まで来たときに下からすっと出る
// の3つを足します。どれも「動きを減らす」設定では何もしません。

/** 挨拶を1文字ずつ出します。字はそのまま DOM にあります（読み上げは変わりません）。 */
export function introGreeting(node) {
  if (!node || reduced()) return;
  const text = node.textContent ?? "";
  if (!text || node.querySelector(".greet-ch")) return;
  node.replaceChildren(...[...text].map((t, i) => {
    const s = document.createElement("span");
    s.className = "greet-ch";
    s.style.animationDelay = `${120 + i * 55}ms`;
    s.textContent = t;
    return s;
  }));
}

/** 1文字を打つ間（ミリ秒）・消す間・読み終わるまで置いておく間。 */
const TYPE_MS = 70;
const ERASE_MS = 28;
const HOLD_MS = 2400;

/**
 * 入力欄の見本の文（placeholder）を、打ち込まれるように入れ替えます。
 * 見本は、欄の下の札（data-example。PHP 版・Worker 版とも季節で変わる）と同じです。
 *
 * 欄を押した・何か書いた・旅程の画面に移ったときは止めて、もとの見本の文に
 * 戻します（書いている人の目の前で字が動かないように）。
 * @param {HTMLTextAreaElement} area
 * @param {string[]} samples
 * @returns {() => void} 止める関数
 */
export function typePlaceholder(area, samples) {
  const list = (samples ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (!area || list.length === 0 || reduced()) return () => {};
  const base = area.getAttribute("placeholder") ?? "";
  const prefix = "例）";
  let timer = 0;
  let stopped = false;
  let k = 0;

  const idle = () => !stopped && document.activeElement !== area && area.value === ""
    && document.body?.dataset.view === "form" && !document.hidden;

  function rest() {
    clearTimeout(timer);
    area.setAttribute("placeholder", base);
    timer = setTimeout(tick, 1500);
  }
  function show(text, n) {
    area.setAttribute("placeholder", prefix + text.slice(0, n) + (n < text.length ? "｜" : ""));
  }
  function run(text, n, dir) {
    if (!idle()) { rest(); return; }
    show(text, n);
    if (dir > 0 && n < text.length) { timer = setTimeout(() => run(text, n + 1, 1), TYPE_MS); return; }
    if (dir > 0) { timer = setTimeout(() => run(text, n, -1), HOLD_MS); return; }
    if (n > 0) { timer = setTimeout(() => run(text, n - 1, -1), ERASE_MS); return; }
    k = (k + 1) % list.length;
    timer = setTimeout(tick, 350);
  }
  function tick() {
    if (!idle()) { rest(); return; }
    run(list[k], 0, 1);
  }
  const pause = () => { clearTimeout(timer); area.setAttribute("placeholder", base); timer = setTimeout(tick, 1500); };
  area.addEventListener("focus", pause);
  area.addEventListener("input", pause);
  // はじめの見本の文を少し読んでもらってから動き出します。
  timer = setTimeout(tick, 2600);
  return () => {
    stopped = true;
    clearTimeout(timer);
    area.removeEventListener("focus", pause);
    area.removeEventListener("input", pause);
    area.setAttribute("placeholder", base);
  };
}

/**
 * 旅程の行（.tl）などを、見える位置まで来たときに出します（トップの .reveal と同じ）。
 * 新しく足された行も追いかけます。IntersectionObserver が無い所では何もしません
 * （その場合は、これまでどおり出たときにすぐ動きます）。
 * @param {Element} root 見張る範囲
 * @param {string} [selector]
 */
export function watchReveal(root, selector = ".tl") {
  if (!root || reduced() || typeof IntersectionObserver !== "function"
      || typeof MutationObserver !== "function") return;
  const io = new IntersectionObserver((entries) => {
    let j = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      // 同時に見えてきた行は、上から順に少しずつずらします。
      e.target.style.animationDelay = `${Math.min(j, 8) * 55}ms`;
      j += 1;
      e.target.classList.remove("reveal-wait");
      e.target.classList.add("reveal-in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -6% 0px" });
  const take = (n) => {
    if (!(n instanceof Element)) return;
    const found = n.matches(selector) ? [n] : [...n.querySelectorAll(selector)];
    for (const t of found) {
      if (t.classList.contains("reveal-in") || t.classList.contains("reveal-wait")) continue;
      t.classList.add("reveal-wait");
      io.observe(t);
    }
  };
  take(root);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) take(n);
  }).observe(root, { childList: true, subtree: true });
}
