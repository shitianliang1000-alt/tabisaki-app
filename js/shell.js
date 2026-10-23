// 画面の枠。旅の一覧（左）・入力欄の「＋」と、そこから開く小さな欄・
// 入力欄の下の札・はじめの画面の挨拶。
//
// 旅程づくりそのものには関わりません。条件の値は、これまでどおり
// 各入力欄（#depart-place など）が持っています。ここはそれを読んで
// 短い札にし、押されたら**その1つだけ**を開きます。
//
// 以前は、出発地の札を押しても日時の札を押しても、同じ大きな
// シート（出発地・日時・移動手段がまとめて並ぶ）が開いていました。
// 押したものと違う欄まで出てくるので、どこを触ればいいのか迷います。
// いまは、出発地なら駅名の欄だけ、日時なら日付と時刻だけが出ます。

/** 旅の一覧を、引き出しにする幅か（css/app.css の同じ値と揃えます）。 */
function isDrawer() {
  return Boolean(globalThis.matchMedia?.("(max-width: 1099px)")?.matches);
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;

/** その日を「今日」「明日」「10月12日（日）」のどれかで言います。 */
export function dayWord(d, now = new Date()) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}

/**
 * 出発と帰着を、札に収まる長さの一言にします。
 *
 *   同じ日   … 「今日 9:00 – 19:00」
 *   泊まる   … 「10月12日（日）から 1泊2日」
 */
export function whenText(depValue, arrValue, now = new Date()) {
  const dep = new Date(depValue);
  const arr = new Date(arrValue);
  if (!Number.isFinite(dep.getTime())) return "日時";
  const nights = nightsBetween(dep, arr);
  if (nights === null || nights === 0) {
    return Number.isFinite(arr.getTime())
      ? `${dayWord(dep, now)} ${hm(dep)} – ${hm(arr)}`
      : `${dayWord(dep, now)} ${hm(dep)}`;
  }
  return `${dayWord(dep, now)}から ${nights}泊${nights + 1}日`;
}

/** 何泊か。帰着が出発より前なら null。 */
export function nightsBetween(dep, arr) {
  if (!Number.isFinite(dep?.getTime?.()) || !Number.isFinite(arr?.getTime?.())) return null;
  if (arr <= dep) return null;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.max(0, Math.round((day(arr) - day(dep)) / 86400000));
}

/**
 * 上の「日帰り・電車」。旅のかたちを2語で言います。
 * 移動手段が「おまかせ」のときは、日数だけです。
 */
export function modeText(nights, transportLabel) {
  const span = !nights ? "日帰り" : `${nights}泊${nights + 1}日`;
  return transportLabel && transportLabel !== "おまかせ"
    ? `${span}・${transportLabel}` : span;
}

/**
 * 時刻に合わせた挨拶（はじめの画面の見出し）。
 *
 *    4〜10時 … おはようございます
 *   10〜17時 … こんにちは
 *   それ以外 … こんばんは
 */
export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h >= 4 && h < 10) return "おはようございます";
  if (h >= 10 && h < 17) return "こんにちは";
  return "こんばんは";
}

/** 挨拶を書き直します。開いたまま時間がたっても合うように、ときどき呼びます。 */
export function updateGreeting(now = new Date()) {
  const node = $("#hero-greet");
  const word = greeting(now);
  if (node && node.textContent !== word) node.textContent = word;
}

/** まぜかたのつまみ（0〜100）を、3段のどれに当たるかに直します。 */
export function mixStep(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 40;
  if (v < 28) return 15;
  if (v < 58) return 40;
  return 75;
}

const $ = (s) => document.querySelector(s);
const SIDE_KEY = "tabisaki.side";

/** 札の字を、いまの条件に合わせて書き直します。 */
export function updatePills() {
  const place = $("#depart-place")?.value.trim();
  const from = $("#pill-from-tx");
  if (from) from.textContent = place ? `${place}から` : "出発地";
  const when = $("#pill-when-tx");
  if (when) when.textContent = whenText($("#depart-at")?.value, $("#arrive-by")?.value);
  const bias = $("#hidden-bias");
  if (bias) syncMix(bias.value);
}

function syncMix(value) {
  const step = String(mixStep(value));
  for (const b of document.querySelectorAll("#mix-quick [data-mix]")) {
    b.setAttribute("aria-checked", String(b.dataset.mix === step));
    b.classList.toggle("is-selected", b.dataset.mix === step);
  }
}

/** 開いた欄で、最初に触ってほしいところ。 */
const FIRST = {
  from: "#depart-place",
  when: "#depart-at",
  mix: '#mix-quick [aria-checked="true"]',
  "tune-time": "#purpose-choice [data-purpose]",
  "tune-move": "#people-choice",
  "tune-stay": '#companions-choice [data-companion]',
  "tune-food": "#food-choice",
  menu: "#plus-menu .plus-item",
};

let openedBy = null;

/**
 * 「＋」の欄を開きます。what は menu・from・when・mix と、
 * 「＋」の一覧に並ぶこだわりの4つの欄（tune-time など）のどれか。
 * 開いているのは、いつも1つだけです。
 */
export function openPop(what = "menu", { focus = true } = {}) {
  const pop = $("#pop");
  if (!pop) return;
  pop.hidden = false;
  for (const p of pop.querySelectorAll(".pop-panel")) {
    p.hidden = p.dataset.panel !== what;
  }
  pop.dataset.panel = what;
  pop.scrollTop = 0;
  fitPop(pop);
  $("#plus")?.setAttribute("aria-expanded", "true");
  if (focus) $(FIRST[what] ?? FIRST.menu)?.focus();
}

/**
 * 欄が画面の外へはみ出さないよう、高さを画面に収めます。はじめの画面
 * では入力欄の下に、旅程の画面では上に開くので、使える高さが違います。
 */
function fitPop(pop) {
  pop.style.maxHeight = "";
  const r = pop.getBoundingClientRect?.();
  const H = globalThis.innerHeight;
  if (!r || !H) return;
  const below = r.top > (pop.parentElement?.getBoundingClientRect?.().top ?? 0);
  const room = below ? H - r.top - 12 : r.bottom - 12;
  const css = parseFloat(getComputedStyle(pop).maxHeight);
  if (room > 120 && (!Number.isFinite(css) || room < css)) pop.style.maxHeight = `${Math.floor(room)}px`;
}

/** 閉じます。フォーカスは、開いたボタン（無ければ入力欄）へ返します。 */
export function closePop({ restore = true } = {}) {
  const pop = $("#pop");
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  delete pop.dataset.panel;
  $("#plus")?.setAttribute("aria-expanded", "false");
  if (restore) {
    const back = openedBy?.isConnected && openedBy.getClientRects().length
      ? openedBy : $("#note");
    back?.focus();
  }
  openedBy = null;
}

/** こだわりの欄を開きます（既定は人数・予算・移動）。 */
export function openTune(section = "tune-move") {
  openPop(section);
}

/**
 * 枠の操作をつなぎます。
 *
 * @param {object} h
 * @param {() => void} h.onNewTrip 「新しい旅」
 */
export function wireShell({ onNewTrip }) {
  // --- 旅の一覧（狭い画面では引き出し） ---
  const side = $("#side");
  const scrim = $("#side-scrim");
  const opener = $("#side-open");
  const setSide = (open) => {
    document.body.dataset.side = open ? "open" : "";
    if (scrim) scrim.hidden = !open;
    opener?.setAttribute("aria-expanded", String(open));
    if (open) side?.querySelector("button, a")?.focus();
    else if (isDrawer() && side?.contains(document.activeElement)) opener?.focus();
  };
  opener?.addEventListener("click", () => setSide(true));
  // 広い画面では、同じボタンで一覧を畳みます（細い帯になります）。
  const closer = $("#side-close");
  const setMini = (mini) => {
    document.body.dataset.side = mini ? "mini" : "";
    closer?.setAttribute("aria-expanded", String(!mini));
    const word = mini ? "旅の一覧を広げる" : "旅の一覧を畳む";
    closer?.setAttribute("aria-label", word);
    closer?.setAttribute("title", word);
    try { localStorage.setItem(SIDE_KEY, mini ? "mini" : ""); } catch { /* 覚えなくても動きます */ }
  };
  closer?.addEventListener("click", () => {
    if (isDrawer()) { setSide(false); return; }
    setMini(document.body.dataset.side !== "mini");
  });
  try {
    if (!isDrawer() && localStorage.getItem(SIDE_KEY) === "mini") setMini(true);
  } catch { /* 読めなくても広げたまま */ }
  scrim?.addEventListener("click", () => setSide(false));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#pop")?.hidden) { e.preventDefault(); closePop(); return; }
    if (document.body.dataset.side === "open") setSide(false);
  });
  // 一覧の中の操作を押したら、引き出しは閉じます（押した先の画面を見せる）。
  side?.addEventListener("click", (e) => {
    // 畳んだ帯の「最近の旅」などは見えないので、しるしを押したら広げます。
    if (!isDrawer() && document.body.dataset.side === "mini"
        && e.target.closest(".brand-line")) { setMini(false); return; }
    if (!isDrawer()) return;
    if (e.target.closest("#side-close")) return;
    if (e.target.closest(".side-item, .recent-row")) setSide(false);
  });
  $("#new-trip")?.addEventListener("click", () => onNewTrip?.());

  // --- 「＋」と、そこから開く欄 ---
  const pop = $("#pop");
  $("#plus")?.addEventListener("click", (e) => {
    if (pop && !pop.hidden) { closePop(); return; }
    openedBy = e.currentTarget;
    openPop("menu");
  });
  for (const btn of document.querySelectorAll("[data-open-cond]")) {
    btn.addEventListener("click", (e) => {
      const what = btn.dataset.openCond;
      // 一覧の中から選んだときは、戻る先を「＋」にします。
      if (!btn.closest("#pop")) openedBy = e.currentTarget;
      openPop(what);
    });
  }
  for (const b of document.querySelectorAll("#pop .pop-close, #pop .pop-done")) {
    b.addEventListener("click", () => closePop());
  }
  // 欄の外を押したら閉じます。入力欄の中の「＋」と札は、自分で開け閉めします。
  document.addEventListener("pointerdown", (e) => {
    if (!pop || pop.hidden) return;
    if (e.target.closest("#pop, #plus, [data-open-cond]")) return;
    closePop({ restore: false });
  });
  // 駅名の欄で Enter を押したら、決めたことにします。
  $("#depart-place")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      closePop();
    }
  });
  // 一覧の中は、上下の矢印で動けるようにします（menu の作法）。
  for (const box of document.querySelectorAll("#plus-menu")) {
    box.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      const all = [...box.querySelectorAll(".plus-item")];
      const i = all.indexOf(document.activeElement);
      e.preventDefault();
      const n = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1
        : (i + (e.key === "ArrowUp" ? -1 : 1) + all.length) % all.length;
      all[n]?.focus();
    });
  }

  // --- 定番と穴場（3段） ---
  const bias = $("#hidden-bias");
  for (const b of document.querySelectorAll("#mix-quick [data-mix]")) {
    b.addEventListener("click", () => {
      if (!bias) return;
      bias.value = b.dataset.mix;
      bias.dispatchEvent(new Event("input", { bubbles: true }));
      bias.dispatchEvent(new Event("change", { bubbles: true }));
      syncMix(bias.value);
    });
  }
  // 3段の切り替えは、矢印キーでも動かせるようにします（radiogroup の作法）。
  $("#mix-quick")?.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const all = [...document.querySelectorAll("#mix-quick [data-mix]")];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = all[(i + step + all.length) % all.length];
    next.focus();
    next.click();
  });
  bias?.addEventListener("input", () => syncMix(bias.value));

  // 札は、どこで何が変わっても追いかけます。条件の欄は「＋」の中に
  // いくつもあり、値を入れる道（チャット・現在地・前につくった旅）が
  // 多いので、1つずつ繋ぐより取りこぼしがありません。
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; updatePills(); });
  };
  for (const ev of ["input", "change", "click"]) {
    document.addEventListener(ev, later, true);
  }
  updatePills();
  updateGreeting();
  setInterval(() => updateGreeting(), 60_000);
}
