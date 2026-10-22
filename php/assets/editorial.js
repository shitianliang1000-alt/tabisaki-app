// 紹介のページ（about.php）の動き。字や中身は PHP が全部書いてあり、
// ここは見せかただけです（JS が無くても、全部読めます）。
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.classList.add("js");

// 1. 下からふわっと出る。画面に入ったら1度だけ。
const io = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
        const n = e.target.querySelector?.("[data-count]");
        if (n) countUp(n);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 })
  : null;
for (const el of document.querySelectorAll(".reveal")) {
  if (io) io.observe(el); else el.classList.add("is-in");
}

// 2. 数が増えていく（47・54,115…）。
function countUp(node) {
  const to = Number(node.dataset.count) || 0;
  if (reduced || to <= 0) return;
  const t0 = performance.now();
  const dur = 1200;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    node.textContent = Math.round(to * eased).toLocaleString("ja-JP");
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// 3. 上の帯に、下へ送ったら細い罫を出す。
const nav = document.getElementById("nav");
const onScroll = () => nav?.classList.toggle("is-scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// 4. 入力欄の見本を、打っているように順に見せる（季節の書きかた）。
const input = document.getElementById("demo-q");
let lines = [];
try { lines = JSON.parse(input?.dataset.typing ?? "[]"); } catch { lines = []; }
if (input && lines.length && !reduced) {
  let i = 0;
  let stop = false;
  input.addEventListener("focus", () => { stop = true; input.placeholder = lines[0]; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (!stop) {
      const text = lines[i % lines.length];
      for (let k = 1; k <= text.length && !stop; k++) {
        input.placeholder = text.slice(0, k);
        await sleep(70);
      }
      await sleep(2200);
      for (let k = text.length; k >= 0 && !stop; k--) {
        input.placeholder = text.slice(0, k);
        await sleep(24);
      }
      i += 1;
      await sleep(300);
    }
  })();
}
