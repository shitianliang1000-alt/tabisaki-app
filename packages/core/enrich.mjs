// スポットの情報を外から補う（spot enrich）・AI に候補を出させる（spot generate）。
//
// どちらで取った値も **未確認（unverified）** で入ります。人が確かめるまで、
// 旅程の計算には使いません（spotinfo.mjs の決まり）。
//
// 取り口とライセンス
//   ・Wikidata（CC0 1.0）… 日本語の別名（aliases.ja）と、代表写真のファイル名（P18）
//   ・Wikimedia Commons … 写真ごとのライセンス・作者（extmetadata）。写真は URL で指すだけで、
//     ファイルは保存しません。ライセンスが読めない写真は入れません
//   ・Yahoo! のデータ・API は使いません（docs/data-licenses.md）
//   ・営業時間と季節の催しは、信頼できる自由な取り口が無いので、公式を見て手で入れます

import { makeField, todayJst } from "./spotinfo.mjs";

const UA = "tabisaki-cli (https://github.com/shitianliang1000-alt/tabisaki-app)";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";

async function getJson(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${new URL(url).host} から読めませんでした（${r.status}）`);
  return r.json();
}

const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/** Wikipedia の記事名から Wikidata の項目を取ります。無ければ null。 */
export async function wikidataFor(title, { fetchImpl = fetch } = {}) {
  const u = new URL(WIKIDATA);
  u.search = new URLSearchParams({
    action: "wbgetentities", sites: "jawiki", titles: title, props: "aliases|labels|claims",
    languages: "ja", format: "json", origin: "*",
  }).toString();
  const doc = await getJson(fetchImpl, u.toString());
  const ent = Object.values(doc?.entities ?? {}).find((e) => e && !("missing" in e));
  return ent ?? null;
}

/** Commons のファイルの URL・ライセンス・作者。ライセンスが読めなければ null。 */
export async function commonsFile(fileName, { fetchImpl = fetch } = {}) {
  const u = new URL(COMMONS);
  u.search = new URLSearchParams({
    action: "query", titles: `File:${fileName}`, prop: "imageinfo",
    iiprop: "url|extmetadata", iiurlwidth: "1280", format: "json", origin: "*",
  }).toString();
  const doc = await getJson(fetchImpl, u.toString());
  const page = Object.values(doc?.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  const meta = info?.extmetadata ?? {};
  const license = stripHtml(meta.LicenseShortName?.value);
  if (!info || !license) return null;
  return {
    url: info.thumburl ?? info.url,
    page: info.descriptionurl,
    author: stripHtml(meta.Artist?.value) || "不明",
    license,
    licenseUrl: meta.LicenseUrl?.value,
    title: fileName,
  };
}

/**
 * 1か所ぶんの補い。spots.json に足す前の、封筒に入った値を返します。
 * @param {{name:string, wikipedia?:string}} spot
 * @returns {Promise<{aliases:object[], photos:object[], notes:string[]}>}
 */
export async function enrichSpot(spot, { fetchImpl = fetch, today = todayJst() } = {}) {
  const out = { aliases: [], photos: [], notes: [] };
  const title = String(spot?.wikipedia ?? "").trim();
  if (!title) {
    out.notes.push("Wikipedia の記事名が収録に無いので、外からは補えません（spot alias・spot photo で手で足せます）");
    return out;
  }
  const ent = await wikidataFor(title, { fetchImpl });
  if (!ent) {
    out.notes.push(`Wikidata に「${title}」の項目が見つかりませんでした`);
    return out;
  }
  const wdSource = { name: "Wikidata", url: `https://www.wikidata.org/wiki/${ent.id}`, license: "CC0 1.0", retrievedAt: today };
  const names = new Set([spot.name, ...(spot.aliases ?? [])].map((s) => String(s).normalize("NFKC")));
  const aliasValues = [ent.labels?.ja?.value, ...(ent.aliases?.ja ?? []).map((a) => a.value)]
    .filter(Boolean).map((s) => s.normalize("NFKC"));
  for (const a of [...new Set(aliasValues)]) {
    if (names.has(a)) continue;
    out.aliases.push(makeField(a, { origin: "wikidata", source: wdSource, today }));
  }
  const file = ent.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (file) {
    const c = await commonsFile(file, { fetchImpl });
    if (c) {
      out.photos.push(makeField(
        { url: c.url, page: c.page, author: c.author, title: c.title },
        { origin: "commons", source: { name: "Wikimedia Commons", url: c.page, license: c.license, retrievedAt: today }, today },
      ));
    } else out.notes.push(`写真 ${file} はライセンスが読めないので入れませんでした`);
  } else out.notes.push("Wikidata に代表写真（P18）がありません");
  out.notes.push("営業時間・季節の催しは自動では取りません。公式を見て spot hours・spot seasonal で入れてください");
  return out;
}

/**
 * AI（OpenAI 互換の /v1/chat/completions。Ollama・LM Studio など）に、
 * エリアの見どころの候補を出させます。返るのは未確認の候補だけです。
 * @param {{area:string, count?:number, url:string, model:string, apiKey?:string, fetchImpl?:Function, today?:string}} o
 */
export async function generateCandidates({ area, count = 5, url, model, apiKey, fetchImpl = fetch, today = todayJst() }) {
  if (!url || !model) throw new Error("AI の場所と模型の名前が要ります（TABISAKI_LLM_URL・TABISAKI_LLM_MODEL）");
  const endpoint = new URL("v1/chat/completions", url.endsWith("/") ? url : `${url}/`).toString();
  const prompt = `日本の「${area}」で、旅行者が立ち寄る見どころを${count}か所挙げてください。`
    + `実在する場所だけを、JSON の配列で返してください。各要素は {"name": 正式な名前, "category": 種類, "why": 一言の理由}。`
    + `配列のほかは何も書かないでください。`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const r = await fetchImpl(endpoint, {
    method: "POST", headers,
    body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`AI から答えがありませんでした（${r.status}）`);
  const doc = await r.json();
  const text = String(doc?.choices?.[0]?.message?.content ?? "");
  const m = /\[[\s\S]*\]/.exec(text);
  let list;
  try { list = JSON.parse(m?.[0] ?? "null"); } catch { list = null; }
  if (!Array.isArray(list)) throw new Error("AI の答えが JSON の配列として読めませんでした");
  const source = { name: `AI（${model}）`, license: "AI の出力（出典なし）", retrievedAt: today };
  return list.slice(0, count)
    .filter((c) => String(c?.name ?? "").trim())
    .map((c) => makeField(
      { name: String(c.name).trim(), category: String(c.category ?? "").trim(), why: String(c.why ?? "").trim(), area },
      { origin: "llm", source, today },
    ));
}
