// 画面の枠。旅の一覧（左）・入力欄の下の札・旅の条件のシート・
// 頼んだことの吹き出し。
//
// 旅程づくりそのものには関わりません。条件の値は、これまでどおり
// 各入力欄（#depart-place など）が持っています。ここはそれを読んで
// 短い札にし、押されたらシートを開くだけです。

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

/** まぜかたのつまみ（0〜100）を、3段のどれに当たるかに直します。 */
export function mixStep(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 40;
  if (v < 28) return 15;
  if (v < 58) return 40;
  return 75;
}

const $ = (s) => document.querySelector(s);

/** 札の字を、いまの条件に合わせて書き直します。 */
export function updatePills() {
  const place = $("#depart-place")?.value.trim();
  const from = $("#pill-from-tx");
  if (from) from.textContent = place ? `${place}から` : "出発地";
  const when = $("#pill-when-tx");
  const depV = $("#depart-at")?.value;
  const arrV = $("#arrive-by")?.value;
  if (when) when.textContent = whenText(depV, arrV);
  const mode = $("#mode-pill-tx");
  if (mode) {
    const picked = $('#transport-choice button[aria-pressed="true"]')
      ?? $("#transport-choice .is-selected");
    const label = picked?.textContent.trim() ?? "";
    mode.textContent = modeText(nightsBetween(new Date(depV), new Date(arrV)), label);
  }
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

/** 頼んだことの吹き出しを、旅程の上に出します。 */
export function renderAsk() {
  const box = $("#ask");
  if (!box) return;
  const note = $("#note")?.value.trim();
  $("#ask-text").textContent = note || "おまかせで組んでください";
  const chips = $("#ask-chips");
  chips.replaceChildren();
  const mix = $('#mix-quick [aria-checked="true"]')?.textContent.trim();
  for (const t of [$("#pill-from-tx")?.textContent, $("#pill-when-tx")?.textContent,
                   $("#mode-pill-tx")?.textContent, mix]) {
    if (!t) continue;
    const li = document.createElement("li");
    li.textContent = t;
    chips.append(li);
  }
  box.hidden = false;
}

/**
 * 枠の操作をつなぎます。
 *
 * @param {object} h
 * @param {() => void} h.onNewTrip 「新しい旅」
 * @param {() => void} h.onMake    シートの「この条件で旅程をつくる」
 */
export function wireShell({ onNewTrip, onMake }) {
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
  $("#side-close")?.addEventListener("click", () => setSide(false));
  scrim?.addEventListener("click", () => setSide(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.side === "open") setSide(false);
  });
  // 一覧の中の操作を押したら、引き出しは閉じます（押した先の画面を見せる）。
  side?.addEventListener("click", (e) => {
    if (!isDrawer()) return;
    if (e.target.closest("#side-close")) return;
    if (e.target.closest(".side-item, .recent-row")) setSide(false);
  });
  $("#new-trip")?.addEventListener("click", () => onNewTrip?.());

  // --- 旅の条件のシート ---
  const dlg = $("#cond-dialog");
  const focusFor = {
    from: "#depart-place",
    when: "#depart-at",
    tune: "#tune > summary",
  };
  const open = (what) => {
    if (!dlg?.showModal) return;
    if (!dlg.open) dlg.showModal();
    if (what === "tune") {
      const tune = $("#tune");
      if (tune) tune.open = true;
    }
    const to = $(focusFor[what] ?? "#depart-place");
    to?.focus();
    to?.scrollIntoView?.({ block: "center" });
  };
  for (const btn of document.querySelectorAll("[data-open-cond]")) {
    btn.addEventListener("click", () => open(btn.dataset.openCond));
  }
  $("#cond-done")?.addEventListener("click", () => dlg.close());
  dlg?.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("#cond-make")?.addEventListener("click", () => {
    dlg.close();
    onMake?.();
  });

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

  // 札は、どこで何が変わっても追いかけます。条件の欄はシートの中にも
  // 外にもあり、値を入れる道（近道の札・現在地・前につくった旅）が
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
}
