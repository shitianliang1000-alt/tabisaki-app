// 旅程を、この端末の外へ出す。
//
// いま、作った旅程が残る場所は**その端末の localStorage だけ**で、
// しかも最大10件です。
//
//   ・機種を変えたら、消えます
//   ・Safari の追跡防止は、しばらく開かないサイトの保存を消します
//   ・容量がいっぱいになれば、消えます
//   ・11件目を作ると、いちばん古いものが落ちます
//
// 共有のリンクは**条件だけ**を運びます。受け取った人が開くと、その場で
// 組み直されるので、時刻が変わります。同行者と同じ時刻で回れません。
// 「旅程を送る/コピー」は文字なので固定ですが、地図もリンクも失われ、
// 読み込み直すこともできません。
//
// ここでは、**凍結した旅程をそのままファイルにします**。
//
//   ・同行者に渡せば、その人の端末で同じ時刻の旅程が開きます
//   ・別の端末へ移せます（機種変更、パソコンと携帯）
//   ・消えても戻せます
//
// どこにも送りません。ブラウザの中でファイルを作って、端末に保存する
// だけです。
//
// 形について
// ----------
// JSON です。中身は history.js が保存しているものと同じ形（凍結済み）
// なので、読み込みは「履歴に足す」だけで済みます。
//
// **version を必ず入れます。** 形が変わったときに、古いファイルを
// 「読めません」と言えるようにするためです。黙って読み違えて、
// 時刻のずれた旅程を出すほうが悪いことです。

export const FORMAT = "tabisaki.trip";
export const VERSION = 1;

/**
 * 1つの旅を、渡せる形にします。
 *
 * @param {{id?:string, title?:string, savedAt?:number, trip?:object,
 *          itin?:object, state?:object}} entry 履歴の1件
 * @returns {object} そのまま JSON.stringify できる形
 */
export function toTripFile(entry) {
  return {
    format: FORMAT,
    version: VERSION,
    kind: "trip",
    // 書き出した時刻。受け取った側が「いつの旅程か」を言えるように。
    exportedAt: new Date().toISOString(),
    trips: [pickTrip(entry)],
  };
}

/**
 * 履歴ぜんぶを、控えの形にします。
 *
 * @param {Array} history loadHistory() の結果
 */
export function toBackupFile(history) {
  return {
    format: FORMAT,
    version: VERSION,
    kind: "backup",
    exportedAt: new Date().toISOString(),
    trips: (Array.isArray(history) ? history : []).map(pickTrip),
  };
}

/** 渡すのは、旅程に要るものだけ。設定やキーは入れません。 */
function pickTrip(entry) {
  return {
    id: entry?.id ?? null,
    title: entry?.title ?? "",
    savedAt: entry?.savedAt ?? null,
    // 入力欄の中身。受け取った人が条件を直して組み直せるようにします。
    state: entry?.state ?? null,
    // 旅の条件（出発地・時刻など）。地図と外部リンクが使います。
    trip: entry?.trip ?? null,
    // 凍結した旅程そのもの。**これが本体です。**
    itin: entry?.itin ?? null,
  };
}

/**
 * 受け取ったファイルを読みます。
 *
 * **黙って読み違えません。** 形が違えば、何が違うのかを返します。
 * 旅程のファイルは、日付・時刻・座標の集まりです。別のものを無理に
 * 読むと、ありもしない時刻の旅程が画面に出ます。
 *
 * @param {string} text ファイルの中身
 * @returns {{ok:true, kind:string, trips:Array}|{ok:false, error:string}}
 */
export function readTripFile(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false,
             error: "ファイルを読めませんでした（JSON ではありません）。" };
  }
  if (!doc || typeof doc !== "object") {
    return { ok: false, error: "ファイルの中身が空です。" };
  }
  if (doc.format !== FORMAT) {
    return { ok: false,
             error: "旅さきのファイルではないようです"
               + `（format: ${JSON.stringify(doc.format ?? null)}）。` };
  }
  if (!Number.isFinite(doc.version) || doc.version > VERSION) {
    return { ok: false,
             error: `新しい形式のファイルです（version ${doc.version}）。`
               + "アプリを最新にしてからお試しください。" };
  }
  const trips = Array.isArray(doc.trips) ? doc.trips.filter(isUsable) : [];
  if (!trips.length) {
    return { ok: false, error: "読める旅程が入っていませんでした。" };
  }
  return { ok: true, kind: doc.kind === "backup" ? "backup" : "trip", trips };
}

/**
 * その1件が、旅程として使えるか。
 *
 * 日付が1つも無いものは、旅程ではありません（空の入れものを履歴に
 * 足すと、開いたときに真っ白になります）。
 */
function isUsable(t) {
  if (!t || typeof t !== "object") return false;
  const days = t.itin?.days;
  if (!Array.isArray(days) || !days.length) return false;
  return days.some((d) => Array.isArray(d?.items) && d.items.length > 0);
}

/**
 * ファイル名。
 *
 * 日本語は使いません。ブラウザの download 属性に日本語を渡すと、
 * 環境によっては**名前ごと捨てられ、拡張子まで失われます**
 * （.ics でも同じことが起きました。js/ical.js の icsFilename）。
 * 中身の title に旅先の名前が入っているので、ファイル名は日付で足ります。
 */
export function tripFilename(doc) {
  const kind = doc?.kind === "backup" ? "backup" : "trip";
  const first = doc?.trips?.[0]?.itin?.days?.[0]?.date;
  const d = first ? new Date(first) : new Date();
  const day = Number.isNaN(d.getTime())
    ? new Date().toISOString().slice(0, 10)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      + `-${String(d.getDate()).padStart(2, "0")}`;
  return `tabisaki-${kind}-${day}.json`;
}

/**
 * 読み込んだものを、いまの履歴に混ぜます。
 *
 * **同じ id は上書きします。** 同じ旅程を2度読み込んだときに、同じ
 * ものが2つ並ぶのは邪魔なだけです。id の無いものは、そのまま足します。
 *
 * 混ぜるだけで、**消しません**。控えを読み込んだら手元の履歴が消えた、
 * というのはいちばん困ります。
 *
 * @param {Array} current いまの履歴
 * @param {Array} incoming 読み込んだ旅程
 * @returns {{list:Array, added:number, replaced:number}}
 */
export function mergeTrips(current, incoming) {
  const list = [...(Array.isArray(current) ? current : [])];
  let added = 0;
  let replaced = 0;
  for (const raw of incoming ?? []) {
    // id と title が無いものは、履歴の側で落とされます（history.js の
    // isValid）。渡されたファイルに無ければ、ここで用意します。
    // 「読み込めました」と言ったのに一覧に出ない、が起きないように。
    const t = {
      ...raw,
      id: typeof raw.id === "string" && raw.id ? raw.id
        : `imported-${raw.savedAt ?? ""}-${String(raw.title ?? "")}`.slice(0, 80)
          || `imported-${crypto.randomUUID()}`,
      // ?? ではなく || です。title が空文字のときも埋めたいので
      // （空文字は null ではないので、?? では素通りします）。
      title: String(raw.title || raw.itin?.title || "読み込んだ旅"),
      savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
    };
    const at = list.findIndex((x) => x.id === t.id);
    if (at >= 0) { list[at] = { ...list[at], ...t }; replaced += 1; }
    else { list.unshift(t); added += 1; }
  }
  // 新しい順に並べ直します（読み込んだものが下に埋もれないように）。
  list.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  return { list, added, replaced };
}
