// 旅さき TUI: 端末の中で、組んだ旅程をキーボードだけで見る。
//
//     ./tabisaki tui "温泉と海をゆっくり" --days=2
//
// 部品の本（blessed・Ink）は使っていません。SSH の先や古い端末でも動くよう、
// 決まった少しの制御文字（画面を消す・色）だけで描きます。依存が増えないのも
// 理由です（本体はビルドも npm install も要らない作りです）。
//
// キー（vim 風）:
//   j / ↓   次の予定      k / ↑   前の予定
//   l / →   次の日        h / ←   前の日
//   g / G   その日の最初・最後
//   Enter   詳しく（もう一度で戻る）
//   ?       キーの一覧    q / Ctrl+C  終わる
//
// NO_COLOR を付けると色を使いません。幅が狭い端末（40桁ほど）でも、長い名前は切って並べます。

import { hm, rows } from "../core/format.mjs";

const ESC = "\x1b[";

/** 表示の幅（全角は2桁）。 */
export function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}

/** 幅 n に収まるよう切る（切ったら … を付ける）。 */
export function fit(s, n) {
  if (n <= 0) return "";
  if (width(s) <= n) return s;
  let out = "";
  for (const ch of String(s)) {
    if (width(out + ch) > n - 1) break;
    out += ch;
  }
  return out + "…";
}

const KIND = { spot: "見る", meal: "食事", transit: "移動", lodging: "宿", rest: "休む" };

export function initialState(result) {
  return { result, days: rows(result.itinerary), day: 0, item: 0, detail: false, help: false, quit: false };
}

/** キー1つぶん、状態を進める（画面には触らない）。 */
export function reduce(state, key) {
  const s = { ...state };
  const items = s.days[s.day]?.items ?? [];
  if (s.help) { s.help = false; return s; }
  switch (key) {
    case "q": case "\u0003": s.quit = true; break;
    case "?": s.help = true; break;
    case "j": case "down": s.item = Math.min(items.length - 1, s.item + 1); s.detail = false; break;
    case "k": case "up": s.item = Math.max(0, s.item - 1); s.detail = false; break;
    case "l": case "right": if (s.day < s.days.length - 1) { s.day++; s.item = 0; s.detail = false; } break;
    case "h": case "left": if (s.day > 0) { s.day--; s.item = 0; s.detail = false; } break;
    case "g": s.item = 0; s.detail = false; break;
    case "G": s.item = Math.max(0, items.length - 1); s.detail = false; break;
    case "enter": s.detail = !s.detail; break;
    default: break;
  }
  return s;
}

/** 状態を、画面の行（文字列の配列）にする。 */
export function render(state, { cols = 80, rows: lines = 24, color = true } = {}) {
  const c = (code, s) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
  const { result, days, day, item } = state;
  const out = [];
  const title = `${result.itinerary.title ?? "旅程"}（${result.request.origin.name}から・${result.request.days}日）`;
  out.push(c("1", fit(title, cols)));
  const tabs = days.map((d, i) => (i === day ? c("7", ` ${d.n}日目 `) : ` ${d.n}日目 `)).join("");
  out.push(days.length * 7 <= cols ? tabs : fit(`${day + 1}/${days.length}日目（h・l で移る）`, cols));
  out.push("");

  if (state.help) {
    for (const l of ["j・↓ 次の予定　　k・↑ 前の予定", "l・→ 次の日　　　h・← 前の日",
      "g・G その日の最初・最後", "Enter 詳しく　　q 終わる", "", "（何かキーを押すと戻ります）"]) out.push(fit(l, cols));
    return out;
  }

  const list = days[day]?.items ?? [];
  if (state.detail && list[item]) {
    const it = list[item];
    out.push(c("1", fit(it.title, cols)));
    out.push(`${hm(it.start)}〜${hm(it.end)}　${KIND[it.kind] ?? it.kind}`);
    if (it.hours) out.push(fit(`営業: ${it.hours}${it.estimated ? "（目安）" : ""}`, cols));
    if (it.km !== null) out.push(`距離: ${it.km.toFixed(1)}km（移動時間は距離からの目安）`);
    if (it.detail) {
      // 長い説明は幅で折り返します
      let line = "";
      for (const ch of String(it.detail).replace(/\s+/g, " ")) {
        if (width(line + ch) > cols) { out.push(line); line = ""; }
        line += ch;
      }
      if (line) out.push(line);
    }
    out.push("", c("2", "Enter で戻る"));
    return out.slice(0, lines);
  }

  const room = Math.max(3, lines - out.length - 2);
  const top = Math.max(0, Math.min(item - Math.floor(room / 2), list.length - room));
  for (let i = top; i < Math.min(list.length, top + room); i++) {
    const it = list[i];
    const time = hm(it.start);
    const kind = KIND[it.kind] ?? "";
    const head = `${i === item ? "›" : " "} ${time} ${kind.padEnd(2, "　")} `;
    const line = head + fit(it.title, cols - width(head));
    out.push(i === item ? c("7", line) : it.kind === "transit" ? c("2", line) : line);
  }
  out.push("", c("2", fit("j/k 予定  h/l 日  Enter 詳しく  ? キー  q 終わる", cols)));
  return out;
}

/** 端末で動かす。 */
export async function run(result, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error("tui は端末の中で動かしてください（パイプのときは tabisaki plan を使います）");
  let state = initialState(result);
  const color = !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const draw = () => {
    const lines = render(state, { cols: output.columns ?? 80, rows: output.rows ?? 24, color });
    output.write(`${ESC}H${ESC}2J` + lines.join("\n"));
  };
  const keyOf = (b) => ({ "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\r": "enter", "\n": "enter" }[b] ?? b);
  output.write(`${ESC}?1049h${ESC}?25l`); // 別の画面に切り替え、カーソルを隠す
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  draw();
  await new Promise((resolve) => {
    const onKey = (b) => {
      state = reduce(state, keyOf(b));
      if (state.quit) { input.off("data", onKey); resolve(); return; }
      draw();
    };
    input.on("data", onKey);
    output.on("resize", draw);
  });
  input.setRawMode(false);
  input.pause();
  output.write(`${ESC}?25h${ESC}?1049l`);
}
