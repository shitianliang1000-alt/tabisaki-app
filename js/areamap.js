// エリアを地図で探す。
//
// 「どんな旅にしたい？」の欄は、行き先を書ける人には速いのですが、
// 「どこへ行けるのか」をまだ知らない人には手がかりがありません。
// 収録の主なエリアを地図に並べて、押したらその名前が欄に入るように
// します。**押しても勝手に組み始めません**（札と同じで、欄を埋めるだけ）。
//
// 地図だけにはしません。指で細かいピンを押せない人、画面を読み上げで
// 使う人のために、同じエリアを地方ごとの一覧でも並べます。
// 地図（Leaflet とタイル）は、この画面を開いたときに初めて作ります。

import { blockOf } from "../packages/core/src/areas.js";
import { japaneseControls } from "./map.js";

/** 一覧の並び（北から）。packages/core/src/areas.js の地方の分けかたと同じです。 */
const BLOCK_ORDER = ["北海道", "東北", "関東", "中部", "近畿", "中国地方",
                     "四国", "九州", "沖縄"];

/**
 * 地図に出すエリア。説明と最寄り駅を持つもの（名所として紹介できるもの）
 * だけです。機械で作ったエリア（「〇〇村」）まで出すと、1,000本を超える
 * ピンで地図が埋まります（tools/build_area_pages.mjs と同じ選びかたです）。
 */
export function curatedAreas(regions) {
  return (regions ?? []).filter((r) => r?.tagline && r?.description && r?.station
    && Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

/** 地方ごとに分けます。地方は北から、中は北にあるものから。 */
export function groupByBlock(areas) {
  const groups = new Map();
  for (const a of areas ?? []) {
    const b = blockOf(a) || "その他";
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(a);
  }
  const rank = (b) => {
    const i = BLOCK_ORDER.indexOf(b);
    return i < 0 ? BLOCK_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort((x, y) => rank(x[0]) - rank(y[0]))
    .map(([block, list]) => ({
      block,
      areas: [...list].sort((p, q) => q.lat - p.lat),
    }));
}

/**
 * 欄にエリアを入れたあとの文。
 *
 *   空                    → 「箱根をめぐる」
 *   「温泉でゆっくり」    → 「箱根で、温泉でゆっくり」
 *   もう「箱根」が入っている → そのまま
 *
 * 地図で選び直したとき（prev）は、前に入れた分を外してから入れます。
 * 「鎌倉で、箱根で、温泉でゆっくり」にはしません。
 *
 * @param {string} note いまの欄
 * @param {string} name 選んだエリア
 * @param {string} [prev] この画面で前に入れたエリア
 */
export function noteWithArea(note, name, prev = "") {
  let text = String(note ?? "").trim();
  if (prev) {
    if (text === `${prev}をめぐる`) text = "";
    else if (text.startsWith(`${prev}で、`)) text = text.slice(prev.length + 2).trim();
  }
  if (!text) return `${name}をめぐる`;
  if (text.includes(name)) return text;
  return `${name}で、${text}`;
}

const PIN_HTML = '<span class="area-pin-dot"></span>';

/**
 * エリアの画面を用意します（一覧は1度だけ作ります）。
 *
 * @param {HTMLDialogElement} dialog
 * @param {{regions: object[], onPick: (area: object) => void,
 *          tileUrl: string, attribution: string}} opts
 * @returns {{open: () => void}}
 */
/**
 * エリアのピンを地図に立てます。押すと名前と一言が出て、
 * 「このエリアにする」で onPick が呼ばれます。
 *
 * エリアを地図で探す画面と、はじめの画面の地図の両方で使います。
 * ピンはキーボードの順路に入れません（47本を Tab で渡ることになる
 * ため）。キーボードと読み上げでは、一覧から選べます。
 *
 * @returns {object[]} 立てたピン（Leaflet の marker）
 */
export function pinAreas(map, areas, onPick) {
  const L = globalThis.L;
  if (!L || !map) return [];
  const icon = L.divIcon({ className: "area-pin", html: PIN_HTML,
                           iconSize: [44, 44], iconAnchor: [22, 22] });
  const pins = [];
  for (const a of areas) {
    const m = L.marker([a.lat, a.lng], { icon, keyboard: false, title: a.name });
    const card = document.createElement("div");
    card.className = "area-pop";
    const name = document.createElement("b");
    name.textContent = a.name;
    const sub = document.createElement("span");
    sub.textContent = `${a.prefecture}・${a.tagline}`;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "md-btn md-btn--tonal md-state";
    go.dataset.pick = a.id;
    go.textContent = "このエリアにする";
    go.addEventListener("click", () => { map.closePopup(); onPick(a); });
    card.append(name, sub, go);
    m.bindPopup(card, { closeButton: true, maxWidth: 220, minWidth: 180,
                        autoPanPadding: [16, 16] });
    m.addTo(map);
    pins.push(m);
  }
  return pins;
}

export function setupAreaMap(dialog, { regions, onPick, tileUrl, attribution }) {
  const areas = curatedAreas(regions);
  const list = dialog.querySelector(".area-list");
  const mapBox = dialog.querySelector(".area-map");
  let map = null;

  const pick = (area) => {
    dialog.close();
    onPick(area);
  };

  // 一覧（読み上げ・キーボードでも選べる道）
  list.replaceChildren();
  for (const { block, areas: group } of groupByBlock(areas)) {
    const sec = document.createElement("section");
    sec.className = "area-block";
    const h = document.createElement("h3");
    h.className = "area-block-title";
    h.textContent = block;
    const set = document.createElement("div");
    set.className = "chip-set";
    set.setAttribute("role", "group");
    set.setAttribute("aria-label", block);
    for (const a of group) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-chip md-chip--assist md-state";
      btn.dataset.area = a.id;
      btn.textContent = a.name;
      btn.title = a.tagline;
      btn.addEventListener("click", () => pick(a));
      set.append(btn);
    }
    sec.append(h, set);
    list.append(sec);
  }

  const buildMap = () => {
    const L = globalThis.L;
    if (!L) {
      mapBox.classList.add("map-fallback");
      mapBox.textContent = "地図を読み込めませんでした。下の一覧から選べます。";
      return;
    }
    // 地図の中のピンは、キーボードの順路に入れません（47本を Tab で
    // 渡ることになるため）。キーボードと読み上げは下の一覧で選べます。
    map = L.map(mapBox, {
      zoomControl: false, scrollWheelZoom: true, keyboard: false,
      attributionControl: true,
    }).setView([36.6, 137.6], 5);
    japaneseControls(map);
    L.tileLayer(tileUrl, { attribution, maxZoom: 18 }).addTo(map);
    pinAreas(map, areas, pick);
  };

  return {
    open() {
      dialog.showModal();
      if (!map && !mapBox.classList.contains("map-fallback")) buildMap();
      // 閉じた画面の中で作った地図は、大きさを 0 と測っています。
      // 開いたあとに測り直させます。
      requestAnimationFrame(() => map?.invalidateSize());
    },
  };
}
