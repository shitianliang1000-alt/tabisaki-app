// 旅程ファイル（trip.yaml）を読む・書くための、小さな YAML。
//
// 依存パッケージを増やさないため、旅程ファイルに要る分だけを読みます。
//
//   ・字下げで入れ子にする対応づけ（key: value）と並び（- item）
//   ・"…" と '…' の文字列、[a, b] の短い並び、| と > の複数行の文
//   ・数（整数・小数）、true / false、null / ~
//   ・# からの注釈
//
// 次のものは読みません（書いてあれば、行の番号つきでエラーにします）。
// アンカー（&a）と別名（*a）、型の指定（!!str）、1つのファイルに複数の文書（---）、
// { a: 1 } の形の対応づけ。旅程を書くのに要らず、読みまちがいの元になるからです。
//
// 時刻（08:00）や日付（2026-11-07）は、文字列のまま返します。

export class YamlError extends Error {
  /** @param {string} message @param {number} line 1から数えた行 */
  constructor(message, line) {
    super(line ? `${line}行目: ${message}` : message);
    this.name = "YamlError";
    this.line = line;
    this.reason = message;
  }
}

/** 引用の外にある「 #」から後ろを落とします。 */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[,-]/.test(s[i - 1])) q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function lex(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) throw new YamlError("字下げにタブは使えません（空白で下げてください）", line);
    lines.push({ raw, line, indent: raw.length - raw.trimStart().length, text: stripComment(raw).trim() });
  });
  return lines;
}

const NUM = /^[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9]+)?$/;

function scalar(s, line) {
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s[0] === '"') return doubleQuoted(s, line);
  if (s[0] === "'") {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new YamlError(`' の閉じがありません: ${s}`, line);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === "[") return flowList(s, line);
  if (s[0] === "{") throw new YamlError("{ … } の形は使えません。字下げで書いてください", line);
  if (s[0] === "&" || s[0] === "*") throw new YamlError("アンカー（&）と別名（*）は使えません", line);
  if (s[0] === "!") throw new YamlError("型の指定（!）は使えません", line);
  if (s[0] === "@" || s[0] === "`") throw new YamlError(`${s[0]} で始まる値は引用符で囲んでください`, line);
  if (NUM.test(s)) return Number(s.replace(/_/g, ""));
  return s;
}

function doubleQuoted(s, line) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) throw new YamlError(`" の閉じがありません: ${s}`, line);
  const map = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", "0": "\0", r: "\r" };
  return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) => {
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (!(e in map)) throw new YamlError(`知らない書きかたです: \\${e}`, line);
    return map[e];
  });
}

function flowList(s, line) {
  if (!s.endsWith("]")) throw new YamlError("[ の閉じ ] がありません（[ … ] は1行に書いてください）", line);
  const body = s.slice(1, -1).trim();
  if (!body) return [];
  const items = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') { cur += body[++i] ?? ""; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "[" || c === "{") throw new YamlError("[ … ] の中に入れ子は書けません", line);
    if (c === ",") { items.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (q) throw new YamlError(`${q} の閉じがありません`, line);
  items.push(cur.trim());
  if (items.some((x) => x === "")) throw new YamlError("[ … ] の中に空の項目があります", line);
  return items.map((x) => scalar(x, line));
}

/** "key: value" を分けます。key が無ければ null。 */
function splitKey(text, line) {
  let key;
  let rest;
  if (text[0] === '"' || text[0] === "'") {
    const m = text[0] === '"' ? /^"(?:[^"\\]|\\.)*"/.exec(text) : /^'(?:[^']|'')*'/.exec(text);
    if (!m) return null;
    const after = text.slice(m[0].length);
    if (!/^:(\s|$)/.test(after)) return null;
    key = scalar(m[0], line);
    rest = after.slice(1).trim();
  } else {
    const m = /^([^\s:#[\]{},][^:]*?):(?:\s+|$)(.*)$/.exec(text);
    if (!m) return null;
    key = m[1].trim();
    rest = m[2].trim();
  }
  return { key: String(key), rest };
}

class Parser {
  constructor(text) {
    this.lines = lex(text);
    this.i = 0;
  }
  /** 中身のある次の行（空行と注釈だけの行は飛ばす）。 */
  peek() {
    while (this.i < this.lines.length && this.lines[this.i].text === "") this.i++;
    return this.lines[this.i] ?? null;
  }
  parseDocument() {
    const first = this.peek();
    if (!first) return null;
    if (first.text === "---") { this.i++; }
    const start = this.peek();
    if (!start) return null;
    if (start.indent !== 0) throw new YamlError("最初の行は字下げしないで書いてください", start.line);
    const value = this.parseBlock(0);
    const extra = this.peek();
    if (extra) {
      if (extra.text === "---" || extra.text === "...") throw new YamlError("1つのファイルには旅程を1つだけ書いてください（--- で分けられません）", extra.line);
      throw new YamlError("字下げがそろっていません", extra.line);
    }
    return value;
  }
  parseBlock(indent) {
    const ln = this.peek();
    if (ln.text.startsWith("- ") || ln.text === "-") return this.parseSeq(ln.indent);
    return this.parseMap(indent);
  }
  parseMap(indent) {
    const out = {};
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent === 0 && (ln.text === "---" || ln.text === "...")) break;
      if (ln.indent > indent) throw new YamlError("字下げがそろっていません", ln.line);
      if (ln.text.startsWith("- ") || ln.text === "-") throw new YamlError("ここに並び（- …）は書けません。上の行を「名前:」にしてください", ln.line);
      const kv = splitKey(ln.text, ln.line);
      if (!kv) throw new YamlError(`「名前: 値」の形になっていません: ${ln.text}`, ln.line);
      if (Object.hasOwn(out, kv.key)) throw new YamlError(`「${kv.key}」が2回書いてあります`, ln.line);
      this.i++;
      out[kv.key] = this.parseValue(kv.rest, indent, ln.line);
    }
    return out;
  }
  parseSeq(indent) {
    const out = [];
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError("字下げがそろっていません", ln.line);
      if (!(ln.text.startsWith("- ") || ln.text === "-")) break;
      const rest = ln.text.slice(1).trim();
      this.i++;
      const kv = rest ? splitKey(rest, ln.line) : null;
      if (kv) {
        // 「- name: 箱根」のように、並びの中に対応づけを書いたとき。
        // 続きの行は、「name」の位置にそろえて書きます。
        const inner = indent + (ln.raw.slice(ln.indent).length - ln.raw.slice(ln.indent).replace(/^-\s*/, "").length);
        const obj = {};
        obj[kv.key] = this.parseValue(kv.rest, inner, ln.line);
        const next = this.peek();
        if (next && next.indent === inner) Object.assign(obj, this.mergeMap(obj, this.parseMap(inner), next.line));
        out.push(obj);
      } else {
        out.push(this.parseValue(rest, indent, ln.line));
      }
    }
    return out;
  }
  mergeMap(a, b, line) {
    for (const k of Object.keys(b)) if (Object.hasOwn(a, k)) throw new YamlError(`「${k}」が2回書いてあります`, line);
    return b;
  }
  parseValue(rest, indent, line) {
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") return this.parseBlockText(rest, indent, line);
    if (rest !== "") return scalar(rest, line);
    const next = this.peek();
    if (!next || next.indent <= indent) {
      // 「- 」の並びは、親と同じ字下げでも書けます（key:\n- a）。
      if (next && next.indent === indent && (next.text.startsWith("- ") || next.text === "-")) return this.parseSeq(indent);
      return null;
    }
    return this.parseBlock(next.indent);
  }
  parseBlockText(mark, indent, line) {
    const parts = [];
    let base = null;
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i];
      if (ln.raw.trim() === "") { parts.push(""); this.i++; continue; }
      if (ln.indent <= indent) break;
      base ??= ln.indent;
      if (ln.indent < base) throw new YamlError("複数行の文の字下げがそろっていません", ln.line);
      parts.push(ln.raw.slice(base).trimEnd());
      this.i++;
    }
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    if (!parts.length) throw new YamlError(`${mark} の下に文がありません`, line);
    const body = mark[0] === "|" ? parts.join("\n")
      : parts.reduce((acc, p) => (acc === "" ? p : p === "" ? `${acc}\n` : acc.endsWith("\n") ? acc + p : `${acc} ${p}`), "");
    return mark.endsWith("-") ? body : `${body}\n`;
  }
}

/** YAML の文字列を読みます。読めなければ YamlError（行の番号つき）。 */
export function parseYaml(text) {
  return new Parser(String(text)).parseDocument();
}

// ---- 書く（tabisaki fmt で使う、決まった形） ----

const PLAIN = /^[^\s\-?:,[\]{}#&*!|>'"%@`0-9+.~][^#]*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n)$/i;

/** 文字列を、読み戻して同じになる形で書きます（引用は要るときだけ）。 */
export function quote(s) {
  if (s === "" || !PLAIN.test(s) || RESERVED.test(s) || /:(\s|$)|\s#|\s$/.test(s) || /[\n\t\\"]/.test(s)) {
    return JSON.stringify(s).replace(/\\u([0-9a-f]{4})/g, (m, h) => (parseInt(h, 16) < 0x20 ? m : String.fromCharCode(parseInt(h, 16))));
  }
  return s;
}

function scalarOut(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  return quote(String(v));
}

const isScalar = (v) => v === null || typeof v !== "object";

/**
 * 値を YAML にします。字下げは空白2つ、短い文字・数の並びは [a, b] で1行に。
 * @param {unknown} value
 * @param {{order?: (path: string[], keys: string[]) => string[]}} [opts] 名前の並べかた
 */
export function stringifyYaml(value, opts = {}) {
  const order = opts.order ?? ((_, keys) => keys);
  const out = [];
  const emit = (v, indent, path) => {
    const pad = " ".repeat(indent);
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isScalar(item)) out.push(`${pad}- ${scalarOut(item)}`);
        else if (Array.isArray(item)) { out.push(`${pad}-`); emit(item, indent + 2, path); }
        else {
          const keys = order(path, Object.keys(item));
          keys.forEach((k, j) => {
            const lead = j === 0 ? `${pad}- ` : `${pad}  `;
            line(lead, k, item[k], indent + 2, [...path, k]);
          });
        }
      }
      return;
    }
    for (const k of order(path, Object.keys(v))) line(pad, k, v[k], indent, [...path, k]);
  };
  const line = (lead, k, v, indent, path) => {
    const key = quote(k);
    if (isScalar(v)) {
      if (typeof v === "string" && v.includes("\n")) {
        const keep = v.endsWith("\n");
        const body = keep ? v.slice(0, -1) : v;
        out.push(`${lead}${key}: ${keep ? "|" : "|-"}`);
        for (const l of body.split("\n")) out.push(l ? `${" ".repeat(indent + 2)}${l}` : "");
        return;
      }
      out.push(`${lead}${key}: ${scalarOut(v)}`);
    } else if (Array.isArray(v) && v.every(isScalar) && v.length <= 8) {
      const flat = `[${v.map(scalarOut).join(", ")}]`;
      if (lead.length + key.length + flat.length <= 100) { out.push(`${lead}${key}: ${flat}`); return; }
      out.push(`${lead}${key}:`);
      emit(v, indent + 2, path);
    } else if (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0) {
      out.push(`${lead}${key}: ${Array.isArray(v) ? "[]" : "null"}`);
    } else {
      out.push(`${lead}${key}:`);
      emit(v, indent + 2, path);
    }
  };
  if (isScalar(value)) return `${scalarOut(value)}\n`;
  emit(value, 0, []);
  return out.join("\n") + "\n";
}
