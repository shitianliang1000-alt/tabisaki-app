// 旅程ファイル（trip.yaml）の形と、その確かめかた。
//
// 版（version）は、書きかたが変わったときに上げます。読めるのは今の版だけで、
// 古い版を読むときは、ここで今の版の形に直してから使います（docs/journey-as-code.md）。

export const SCHEMA_VERSION = 1;

const TRANSPORTS = ["any", "transit", "car", "walk", "local"];
export const FORMATS = ["markdown", "text", "json"];
export const STYLES = ["blog", "diary", "guide", "haiku"];

/**
 * 書ける項目。type と、無いときの値（default）、説明（docs と lint で使う）。
 * 並びの順は tabisaki fmt で書き出す順です。
 */
export const FIELDS = {
  version: { type: "int", required: true, doc: "書きかたの版。今は 1" },
  title: { type: "string", required: true, max: 80, doc: "旅程の名前" },
  wish: { type: "string", required: true, max: 500, doc: "希望の文（チャットに書くのと同じ）" },
  from: { type: "string", default: "東京駅", doc: "出発地（収録の駅・空港の名前）" },
  date: { type: "date", doc: "出発日 YYYY-MM-DD（無ければ明日）" },
  days: { type: "int", default: 1, min: 1, max: 14, doc: "日数" },
  start: { type: "time", default: "08:00", doc: "出発の時刻" },
  back: { type: "time", default: "20:00", doc: "最終日に出発地へ帰り着く時刻" },
  transport: { type: "enum", values: TRANSPORTS, default: "any", doc: "移動の手段" },
  constraints: {
    type: "map",
    doc: "守ってほしい条件（tabisaki test で確かめます）",
    fields: {
      must_visit: { type: "list", of: "string", doc: "必ず立ち寄るスポットの名前" },
      avoid: { type: "list", of: "string", doc: "使わないスポットの名前" },
      budget_yen: { type: "int", min: 0, doc: "費用の上限（円）" },
      max_leg_minutes: { type: "int", min: 1, doc: "1回の移動の長さの上限（分）" },
      max_spots_per_day: { type: "int", min: 1, max: 20, doc: "1日に立ち寄る数の上限" },
      respect_hours: { type: "bool", default: true, doc: "営業時間の外に立ち寄らない" },
    },
  },
  output: {
    type: "map",
    doc: "tabisaki build の出しかた",
    fields: {
      format: { type: "enum", values: FORMATS, default: "markdown", doc: "markdown / text / json" },
      file: { type: "string", doc: "書き出すファイル（trip.yaml からの相対）。無ければ端末に出します" },
      narrate: { type: "enum", values: STYLES, default: "blog", doc: "tabisaki narrate の文体" },
    },
  },
};

/** ふたつの語の近さ（「もしかして」に使う）。 */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

export function suggest(name, choices) {
  let best = null;
  for (const c of choices) {
    const s = distance(name.toLowerCase(), c);
    if (s <= Math.max(1, Math.floor(c.length / 3)) && (!best || s < best.s)) best = { c, s };
  }
  return best?.c ?? null;
}

const typeName = { int: "整数", string: "文字列", date: "日付（YYYY-MM-DD）", time: "時刻（HH:MM）", bool: "true か false", list: "並び", map: "項目のまとまり", enum: "決まった値" };

function checkValue(spec, v, at, problems) {
  const bad = (msg) => problems.push({ path: at, message: msg });
  switch (spec.type) {
    case "int":
      if (!Number.isInteger(v)) return bad(`${typeName.int}で書いてください（今は ${JSON.stringify(v)}）`);
      if (spec.min !== undefined && v < spec.min) return bad(`${spec.min}以上にしてください`);
      if (spec.max !== undefined && v > spec.max) return bad(`${spec.max}以下にしてください`);
      return;
    case "string":
      if (typeof v !== "string" || !v.trim()) return bad(`${typeName.string}で書いてください`);
      if (spec.max && v.length > spec.max) return bad(`${spec.max}字までにしてください`);
      return;
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad(`${typeName.date}で書いてください`);
      const d = new Date(`${v}T00:00:00+09:00`);
      if (Number.isNaN(d.getTime()) || new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10) !== v) return bad(`無い日付です: ${v}`);
      return;
    }
    case "time": {
      const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v) : null;
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return bad(`${typeName.time}で書いてください（"08:00" のように引用符で囲むと確かです）`);
      return;
    }
    case "bool":
      if (typeof v !== "boolean") return bad(typeName.bool);
      return;
    case "enum":
      if (!spec.values.includes(v)) {
        const hint = typeof v === "string" ? suggest(v, spec.values) : null;
        return bad(`${spec.values.join(" / ")} のどれかにしてください${hint ? `（もしかして ${hint}）` : ""}`);
      }
      return;
    case "list":
      if (!Array.isArray(v)) return bad(`${typeName.list}（- … か [ … ]）で書いてください`);
      v.forEach((x, i) => checkValue({ type: spec.of }, x, `${at}[${i}]`, problems));
      return;
    case "map":
      if (v === null || typeof v !== "object" || Array.isArray(v)) return bad(`${typeName.map}で書いてください`);
      checkFields(spec.fields, v, at, problems);
      return;
  }
}

function checkFields(fields, obj, prefix, problems) {
  const at = (k) => (prefix ? `${prefix}.${k}` : k);
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(fields, k)) {
      const hint = suggest(k, Object.keys(fields));
      problems.push({ path: at(k), message: `知らない項目です${hint ? `（もしかして ${hint}）` : ""}` });
    }
  }
  for (const [k, spec] of Object.entries(fields)) {
    const v = obj[k];
    if (v === undefined || v === null) {
      if (spec.required) problems.push({ path: at(k), message: `${spec.doc}を書いてください` });
      continue;
    }
    checkValue(spec, v, at(k), problems);
  }
}

/**
 * 読んだ旅程ファイルを確かめます。
 * @returns {{path: string, message: string}[]} 問題の一覧（空なら良い）
 */
export function validate(doc) {
  const problems = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return [{ path: "", message: "旅程ファイルは「名前: 値」の並びで書いてください（version・title・wish が要ります）" }];
  }
  if (doc.version !== undefined && doc.version !== SCHEMA_VERSION && Number.isInteger(doc.version)) {
    return [{ path: "version", message: doc.version > SCHEMA_VERSION
      ? `版 ${doc.version} はこの tabisaki では読めません（読めるのは ${SCHEMA_VERSION} まで。新しい tabisaki にしてください）`
      : `版 ${doc.version} はありません（今は ${SCHEMA_VERSION}）` }];
  }
  checkFields(FIELDS, doc, "", problems);
  const c = doc.constraints;
  if (c && Array.isArray(c.must_visit) && Array.isArray(c.avoid)) {
    for (const n of c.must_visit) if (c.avoid.includes(n)) problems.push({ path: "constraints", message: `「${n}」が must_visit と avoid の両方にあります` });
  }
  return problems;
}

/** 無い項目を既定の値で埋めた、確かめ済みの旅程の定義。 */
export function withDefaults(doc) {
  const fill = (fields, obj = {}) => {
    const out = {};
    for (const [k, spec] of Object.entries(fields)) {
      if (spec.type === "map") out[k] = fill(spec.fields, obj[k] ?? {});
      else out[k] = obj[k] ?? spec.default ?? (spec.type === "list" ? [] : null);
    }
    return out;
  };
  return fill(FIELDS, doc);
}

/** fmt で書き出すときの、名前の並べかた（FIELDS の順。知らない名前は後ろに、名前の順で）。 */
export function fieldOrder(path, keys) {
  let fields = FIELDS;
  for (const p of path) fields = fields?.[p]?.fields;
  const known = fields ? Object.keys(fields) : [];
  return [...known.filter((k) => keys.includes(k)), ...keys.filter((k) => !known.includes(k)).sort()];
}
