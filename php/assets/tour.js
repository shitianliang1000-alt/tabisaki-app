// 映像で見るページ（tour.html）の動き。
//   ・出てくる動き（.reveal）
//   ・動画は見えている間だけ再生（動きを減らす設定では再生せず、止めた絵のまま）
//   ・見どころ: まん中のカードだけ再生し、終わったら次へ送る。点と止めるボタン
//   ・読み進めると字が明るくなる文（#scrub）
//   ・大きな字が縮んで、映像が画面いっぱいに広がる（#zoom）
//   ・確かめていること: 札で動画を切り替え、終わったら次の札へ
//   ・帯の「いまの節」
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x) => Math.min(1, Math.max(0, x));
const seg = (p, a, b) => clamp((p - a) / (b - a));

if (!still) document.documentElement.classList.add("js");

/** 再生は失敗してもかまいません（自動再生を止めているブラウザなど）。止めた絵が残ります。 */
const play = (v) => { if (!still) v.play()?.catch?.(() => {}); };

// 出てくる動き
const rio = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting) { e.target.classList.add("in"); rio.unobserve(e.target); }
}, { rootMargin: "0px 0px -12% 0px" });
$$(".reveal").forEach((el) => rio.observe(el));

// 見えている間だけ再生する動画（見出し・大きな映像・携帯）
const auto = $$(".hero .tv, .zoom .tv, .phone .tv");
const vio = new IntersectionObserver((es) => {
  for (const e of es) e.isIntersecting ? play(e.target) : e.target.pause();
}, { threshold: 0.25 });
auto.forEach((v) => vio.observe(v));

// --- 見どころ ---
const rail = $("#hl-rail");
const cards = $$(".hl-card", rail);
const dots = $("#hl-dots");
const pauseBtn = $("#hl-play");
let current = 0, paused = still, railSeen = false;
cards.forEach((card, i) => {
  const b = document.createElement("button");
  b.type = "button"; b.setAttribute("aria-label", `${i + 1}つめの見どころ`);
  b.addEventListener("click", () => goTo(i));
  dots.append(b);
  $("video", card).addEventListener("ended", () => { if (!paused) goTo((i + 1) % cards.length); });
});
dots.removeAttribute("aria-hidden");
function goTo(i) {
  rail.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft, behavior: still ? "auto" : "smooth" });
  setCurrent(i);
}
function setCurrent(i) {
  current = i;
  [...dots.children].forEach((d, k) => d.setAttribute("aria-current", String(k === i)));
  cards.forEach((c, k) => {
    const v = $("video", c);
    if (k === i && railSeen && !paused) { v.currentTime = 0; play(v); } else v.pause();
  });
}
// 手で送ったときは、まん中に来たカードを「いま」にします。
let railT;
rail.addEventListener("scroll", () => {
  clearTimeout(railT);
  railT = setTimeout(() => {
    const mid = rail.scrollLeft + rail.clientWidth / 2;
    let best = 0, d = Infinity;
    cards.forEach((c, k) => { const dd = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid); if (dd < d) { d = dd; best = k; } });
    if (best !== current) setCurrent(best);
  }, 120);
}, { passive: true });
new IntersectionObserver(([e]) => {
  railSeen = e.isIntersecting;
  const v = $("video", cards[current]);
  railSeen && !paused ? play(v) : v.pause();
}, { threshold: 0.4 }).observe(rail);
pauseBtn.setAttribute("aria-pressed", String(paused));
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.setAttribute("aria-pressed", String(paused));
  pauseBtn.setAttribute("aria-label", paused ? "見どころを再生する" : "見どころの再生を止める");
  const v = $("video", cards[current]);
  paused ? v.pause() : (v.play()?.catch?.(() => {}));
});
setCurrent(0);

// --- 字が明るくなる文 ---
const scrub = $("#scrub");
let words = [];
if (scrub && !still) {
  const segm = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("ja", { granularity: "word" }) : null;
  const parts = segm ? [...segm.segment(scrub.textContent)].map((s) => s.segment) : [...scrub.textContent];
  scrub.setAttribute("aria-label", scrub.textContent);
  scrub.textContent = "";
  for (const p of parts) {
    const s = document.createElement("span");
    s.className = "w"; s.textContent = p; s.setAttribute("aria-hidden", "true");
    scrub.append(s);
  }
  words = $$(".w", scrub);
}

// --- 大きな字と広がる映像 ---
const zoom = $("#zoom");
const zs = zoom && $(".zoom-sticky", zoom);
const zv = zoom && $(".tv", zoom);

// --- 帯 ---
const navLinks = $$(".lnav-links a");

function frame() {
  const vh = innerHeight;
  if (words.length) {
    const r = scrub.getBoundingClientRect();
    const p = seg(vh - r.top, vh * 0.25, vh * 0.25 + r.height + vh * 0.35);
    const n = Math.round(p * words.length);
    words.forEach((w, i) => w.classList.toggle("lit", i < n));
  }
  if (zoom && !still) {
    const r = zoom.getBoundingClientRect();
    const p = clamp(-r.top / (r.height - vh));
    const grow = seg(p, 0.28, 0.72);
    const s = zs.style;
    s.setProperty("--ws", String(1 - 0.55 * seg(p, 0, 0.4)));
    s.setProperty("--wo", String(1 - seg(p, 0.18, 0.36)));
    s.setProperty("--fo", String(seg(p, 0.16, 0.32)));
    s.setProperty("--fw", String(0.5 + 0.5 * grow));
    s.setProperty("--fh", String(0.5 + 0.5 * grow));
    s.setProperty("--fr", String(1 - grow));
    s.setProperty("--fy", String((1 - seg(p, 0.16, 0.32)) * 60));
    s.setProperty("--co", String(seg(p, 0.74, 0.88)));
  }
  let cur = null;
  for (const a of navLinks) {
    const sec = document.getElementById(a.hash.slice(1));
    if (sec && sec.getBoundingClientRect().top < vh * 0.5) cur = a;
  }
  navLinks.forEach((a) => (a === cur ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
}
let ticking = false;
const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; frame(); }); } };
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
frame();

// --- 確かめていること（札で切り替える） ---
const tabs = $$(".tab");
const tv = $("#tab-video");
let tabSeen = false, tabAt = 0;
function selectTab(i, user = false) {
  tabAt = i;
  tabs.forEach((t, k) => { t.setAttribute("aria-selected", String(k === i)); t.tabIndex = k === i ? 0 : -1; t.style.setProperty("--p", "0"); });
  const t = tabs[i];
  tv.classList.add("fade");
  setTimeout(() => {
    tv.poster = `${t.dataset.src}.webp`;
    tv.src = `${t.dataset.src}.mp4`;
    tv.setAttribute("aria-label", t.dataset.label);
    tv.classList.remove("fade");
    if (tabSeen || user) play(tv);
  }, still ? 0 : 300);
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectTab(i, true));
  t.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    const n = (i + d + tabs.length) % tabs.length;
    tabs[n].focus(); selectTab(n, true);
  });
});
tv.addEventListener("timeupdate", () => {
  if (tv.duration) tabs[tabAt].style.setProperty("--p", String(tv.currentTime / tv.duration));
});
tv.addEventListener("ended", () => selectTab((tabAt + 1) % tabs.length));
new IntersectionObserver(([e]) => {
  tabSeen = e.isIntersecting;
  tabSeen ? play(tv) : tv.pause();
}, { threshold: 0.4 }).observe(tv);
