// 旅さき — トップ（/）の動き。PHP 版と Cloudflare 版で同じファイルです。
//
//   ・見出しが1句ずつ出る／読んだ量の帯／上の帯が縮む
//   ・動く見本: 実際に組んだコースを、打つ→考える→答えが流れる→地図に順路が引かれる、の順で再生
//   ・聞く欄の「例」が、ひとりでに打たれていく
//   ・読み進めると、文の字に色が乗る
//   ・使いかた: 右を送ると、左の絵と見出しが切り替わる
//   ・今日のおすすめ: 横に送る・天気をいま取る（Open-Meteo）
//   ・数が増えていく／カードが下から出る
//
// 動きを減らす設定（prefers-reduced-motion）のときは、どれも最後の形を
// すぐに出し、ひとりでに動くものは止めます。
const root = document.documentElement;
root.classList.add("js");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 前のトップ（チャットの画面）あてに送られた旅程のリンク（/#t=…）は、チャットへ渡します。
if (/^#t=/.test(location.hash)) location.replace(`app${location.search}${location.hash}`);

/** 見えたら1回だけ呼びます。 */
function onSeen(nodes, fn, opts = { threshold: 0.15 }) {
  if (!("IntersectionObserver" in window)) { nodes.forEach(fn); return; }
  const io = new IntersectionObserver((list) => {
    for (const e of list) if (e.isIntersecting) { io.unobserve(e.target); fn(e.target); }
  }, opts);
  nodes.forEach((n) => io.observe(n));
}

// --- 見出し ---------------------------------------------------------
$$(".headline .w").forEach((w, i) => {
  if (still) { w.classList.add("in"); return; }
  setTimeout(() => w.classList.add("in"), 120 + i * 110);
});

// --- 読んだ量の帯・上の帯 ------------------------------------------------
const bar = $("#progress");
const nav = $("#nav");
const scrub = $("#scrub");
let scrubChars = [];
if (scrub) {
  const text = scrub.textContent;
  scrub.textContent = "";
  // 読み上げには、1字ずつではなく文のまま渡します。
  const whole = document.createElement("span");
  whole.className = "sr-only";
  whole.textContent = text;
  scrub.append(whole);
  for (const ch of text) {
    const s = document.createElement("span");
    s.className = "c";
    s.setAttribute("aria-hidden", "true");
    s.textContent = ch;
    scrub.append(s);
  }
  scrubChars = $$(".c", scrub);
}
let ticking = false;
function onScroll() {
  ticking = false;
  const max = root.scrollHeight - innerHeight;
  if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
  nav?.classList.toggle("is-scrolled", scrollY > 8);
  if (scrubChars.length && !still) {
    const r = scrub.getBoundingClientRect();
    // 文の上が画面の 85% に来たら色が乗り始め、下が 45% に来たら全部。
    const start = innerHeight * 0.85, end = innerHeight * 0.45;
    const p = Math.max(0, Math.min(1, (start - r.top) / (start - end + r.height)));
    const lit = Math.round(p * scrubChars.length);
    scrubChars.forEach((c, i) => c.classList.toggle("lit", i < lit));
  }
}
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
addEventListener("resize", onScroll);
onScroll();

// --- 出る動き・数 ------------------------------------------------------
onSeen($$(".reveal"), (el) => el.classList.add("in"));
onSeen($$("[data-count]"), (el) => {
  const to = Number(el.dataset.count) || 0;
  const fmt = (n) => n.toLocaleString("ja-JP");
  if (still || to === 0) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 1400;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}, { threshold: 0.6 });

// --- 動く見本 ----------------------------------------------------------
const stage = $("#stage");
if (stage) {
  let demos = [];
  try { demos = JSON.parse(stage.dataset.demo || "[]"); } catch { demos = []; }
  const ai = $(".s-ai", stage);
  const prompt = $("#s-prompt"), lead = $("#s-lead"), list = $("#s-list");
  const route = $("#s-route"), dots = $("#s-dots"), caption = $("#s-caption");
  const pager = $("#s-pager"), pause = $("#s-pause");
  const NS = "http://www.w3.org/2000/svg";
  const HOLD = 4200;
  let paused = still, visible = false, run = 0;

  pager.replaceChildren(...demos.map(() => document.createElement("i")));

  /** 立ち寄る場所の点を、地図の枠の中にゆるい S 字で置きます（距離は正確ではありません）。 */
  function layout(n, seed) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      pts.push([200 + 125 * Math.sin(t * Math.PI * 1.7 + seed), 52 + t * 316]);
    }
    return pts;
  }
  function pathOf(pts) {
    if (!pts.length) return "";
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const my = (y0 + y1) / 2;
      d += ` C${x0.toFixed(1)} ${my.toFixed(1)}, ${x1.toFixed(1)} ${my.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    return d;
  }

  function build(demo, k) {
    const items = demo.items ?? [];
    list.replaceChildren(...items.map((c) => {
      const li = document.createElement("li");
      li.className = `k-${c.kind}`;
      const b = document.createElement("b"); b.textContent = c.time;
      const s = document.createElement("span"); s.textContent = c.title;
      li.append(b, s);
      if (c.min) { const m = document.createElement("small"); m.textContent = c.min; li.append(m); }
      return li;
    }));
    const stops = items.map((c, i) => [c, i]).filter(([c]) => c.kind !== "move");
    const pts = layout(stops.length, k * 1.3 + 0.4);
    route.setAttribute("d", pathOf(pts));
    dots.replaceChildren(...stops.map(([c], i) => {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "stop");
      const [x, y] = pts[i];
      const pulse = document.createElementNS(NS, "circle");
      pulse.setAttribute("class", "pulse"); pulse.setAttribute("cx", x); pulse.setAttribute("cy", y); pulse.setAttribute("r", 7);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", 6);
      const tx = document.createElementNS(NS, "text");
      const right = x > 250;
      tx.setAttribute("x", right ? x - 12 : x + 12); tx.setAttribute("y", y + 4);
      tx.setAttribute("text-anchor", right ? "end" : "start");
      tx.textContent = c.title.length > 12 ? `${c.title.slice(0, 11)}…` : c.title;
      g.append(pulse, dot, tx);
      return g;
    }));
    caption.textContent = `旅さきのエンジンが実際に組んだ、${demo.name}の1日です。`;
    $$("i", pager).forEach((d, i) => d.classList.toggle("on", i === k));
    return stops.map(([, i]) => i);
  }

  /** 線の長さに合わせて、引いた分だけ見せます。 */
  function drawTo(k, total, instant = false) {
    const len = route.getTotalLength?.() || 0;
    route.style.transition = instant ? "none" : "stroke-dashoffset .7s cubic-bezier(.2,.8,.2,1)";
    route.style.strokeDasharray = `${len}`;
    route.style.strokeDashoffset = `${total <= 1 ? (k >= 0 ? 0 : len) : len * (1 - Math.max(0, k) / (total - 1))}`;
  }

  function showAll(demo, k) {
    const stopAt = build(demo, k);
    prompt.textContent = demo.prompt;
    prompt.classList.remove("typing");
    ai.classList.remove("thinking");
    lead.textContent = demo.lead;
    lead.classList.add("in");
    $$("li", list).forEach((li) => li.classList.add("in"));
    $$(".stop", dots).forEach((g) => g.classList.add("on"));
    drawTo(stopAt.length - 1, stopAt.length, true);
  }

  /** 止めているあいだは、ここで待ちます。 */
  async function gate(id) {
    while ((paused || !visible) && id === run) await sleep(200);
    return id === run;
  }

  async function play(k, id) {
    const demo = demos[k];
    const stopAt = build(demo, k);
    const lis = $$("li", list), gs = $$(".stop", dots);
    pager.style.setProperty("--dur", `${(demo.prompt.length * 45 + 1300 + lis.length * 380 + HOLD) / 1000}s`);
    prompt.textContent = ""; prompt.classList.add("typing");
    lead.textContent = ""; lead.classList.remove("in");
    ai.classList.remove("thinking");
    drawTo(-1, stopAt.length, true);
    // 1. 打つ
    for (const ch of demo.prompt) {
      if (!(await gate(id))) return;
      prompt.textContent += ch;
      await sleep(38 + Math.random() * 30);
    }
    prompt.classList.remove("typing");
    // 2. 考える
    ai.classList.add("thinking");
    await sleep(1300);
    if (!(await gate(id))) return;
    ai.classList.remove("thinking");
    // 3. 答えが流れる
    lead.classList.add("in");
    for (const ch of demo.lead) {
      lead.textContent += ch;
      await sleep(16);
    }
    // 4. 1行ずつ。立ち寄る場所に来たら、地図の線をそこまで引きます。
    let seen = -1;
    for (let i = 0; i < lis.length; i++) {
      if (!(await gate(id))) return;
      lis.forEach((li) => li.classList.remove("is-now"));
      lis[i].classList.add("in", "is-now");
      const s = stopAt.indexOf(i);
      if (s >= 0) { seen = s; gs[s]?.classList.add("on"); drawTo(seen, stopAt.length); }
      await sleep(lis[i].classList.contains("k-move") ? 260 : 460);
    }
    lis.forEach((li) => li.classList.remove("is-now"));
    await sleep(HOLD);
  }

  async function loop() {
    const id = ++run;
    for (let k = 0; ; k = (k + 1) % demos.length) {
      if (!(await gate(id))) return;
      await play(k, id);
      if (id !== run) return;
    }
  }

  if (demos.length) {
    if (still) {
      // 動きを減らす設定: 1つ目を組み上がった形で出し、再生は押したときだけ。
      showAll(demos[0], 0);
      visible = true;
      pause.setAttribute("aria-pressed", "true");
      pause.setAttribute("aria-label", "見本を再生する");
    } else {
      // 画面に入ってから再生します（見ていないあいだは止めて、電池を使いません）。
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { threshold: 0.25 }).observe(stage);
      } else visible = true;
      loop();
    }
  }
  pause.addEventListener("click", () => {
    paused = !paused;
    pause.setAttribute("aria-pressed", String(paused));
    pause.setAttribute("aria-label", paused ? "見本を再生する" : "見本の再生を止める");
    pager.classList.toggle("paused", paused);
    // 動きを減らす設定でも、押したら再生します。
    if (!paused && still && demos.length && run === 0) loop();
  });
}

// --- 聞く欄の「例」が打たれていく ---------------------------------------------
const ask = $("#ask-q");
if (ask && !still) {
  let words = [];
  try { words = JSON.parse(ask.dataset.typing || "[]"); } catch { words = []; }
  let busy = false;
  const idle = () => document.activeElement !== ask && !ask.value;
  (async () => {
    if (!words.length) return;
    for (let i = 0; ; i = (i + 1) % words.length) {
      if (busy) return;
      const w = words[i];
      for (let n = 0; n <= w.length; n++) {
        if (!idle()) { await sleep(600); n--; continue; }
        ask.placeholder = w.slice(0, n) + (n < w.length ? "｜" : "");
        await sleep(70);
      }
      await sleep(2200);
      for (let n = w.length; n >= 0; n -= 2) {
        if (!idle()) break;
        ask.placeholder = w.slice(0, n);
        await sleep(24);
      }
    }
  })();
  ask.form?.addEventListener("submit", () => { busy = true; });
}

// --- 使いかた ----------------------------------------------------------------
const steps = $$(".how .step");
if (steps.length && "IntersectionObserver" in window) {
  const navs = $$(".how-nav li"), arts = $$(".how-art .art");
  const pick = (k) => {
    steps.forEach((s, i) => s.classList.toggle("on", i === k));
    navs.forEach((s, i) => s.classList.toggle("on", i === k));
    arts.forEach((s, i) => s.classList.toggle("on", i === k));
  };
  pick(0);
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) pick(Number(e.target.dataset.step) || 0);
  }, { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach((s) => io.observe(s));
}

// --- 今日のおすすめ ------------------------------------------------------------
const rail = $("#rail");
if (rail) {
  $$("[data-scroll]").forEach((b) => b.addEventListener("click", () => {
    const card = $(".pick", rail);
    const w = card ? card.getBoundingClientRect().width + 20 : rail.clientWidth * 0.8;
    rail.scrollBy({ left: Number(b.dataset.scroll) * w, behavior: still ? "auto" : "smooth" });
  }));
  // 天気は、カードが見えたときに1回だけ、全部まとめて取ります。
  const picks = $$(".pick", rail).filter((p) => p.dataset.lat && p.dataset.lng);
  let asked = false;
  onSeen([rail], async () => {
    if (asked || !picks.length) return;
    asked = true;
    const lat = picks.map((p) => p.dataset.lat).join(","), lng = picks.map((p) => p.dataset.lng).join(",");
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
        + "&current=temperature_2m,weather_code&timezone=Asia%2FTokyo");
      if (!res.ok) return;
      const json = await res.json();
      const list = Array.isArray(json) ? json : [json];
      list.forEach((w, i) => {
        const el = $(".wx", picks[i]);
        const c = w?.current;
        if (!el || !c) return;
        el.textContent = `いま ${sky(c.weather_code)} ${Math.round(c.temperature_2m)}℃`;
        el.classList.add("in");
      });
    } catch { /* 天気が取れなくても、カードはそのまま使えます */ }
  });
}

/** WMO の天気の番号を、短いことばに。 */
function sky(code) {
  if (code === 0) return "晴れ";
  if (code <= 2) return "晴れ時々くもり";
  if (code === 3) return "くもり";
  if (code <= 48) return "霧";
  if (code <= 67 || (code >= 80 && code <= 82)) return "雨";
  if (code <= 77 || code === 85 || code === 86) return "雪";
  return "雷雨";
}

// --- 足もと ------------------------------------------------------------
// 広い画面では3列を開いたまま見せます（CSS が開け閉めの印を消します）。
const wide = matchMedia("(min-width: 761px)");
const footOpen = () => $$(".foot-acc details").forEach((d) => { d.open = wide.matches; });
footOpen();
wide.addEventListener?.("change", footOpen);
