// エリアのページ（areas/）のモデルコースを読み取ります（tools/build_php_data.mjs が使います）。

/**
 * エリアのページに載せた「1日のモデルコース」（旅さきのエンジンが組んだ本物）を
 * 読み取ります。トップの「動く見本」は、これをそのまま順に見せます。
 */
export function parseCourse(html) {
  const ol = /<ol class="course">([\s\S]*?)<\/ol>/.exec(html)?.[1];
  if (!ol) return [];
  // 字だけを取り出します。タグを外し、残った < > は字として捨て、
  // 文字参照は1回だけ戻します（&amp;lt; を < にしてしまわないように）。
  // 取り出した字は、ひな形に入れるときに改めて HTML として安全にします。
  const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#039;": "'" };
  const strip = (t) => textOnly(t).replace(/&(?:amp|lt|gt|quot|#0?39);/g, (e) => ENT[e]).trim();
  const items = [];
  for (const m of ol.matchAll(/<li class="c-([a-z]+)">([\s\S]*?)<\/li>/g)) {
    const kind = m[1];
    const time = strip(/<b class="c-time">([\s\S]*?)<\/b>/.exec(m[2])?.[1] ?? "");
    const titleHtml = /<span class="c-title">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? "";
    const min = strip(/<small>([\s\S]*?)<\/small>/.exec(titleHtml)?.[1] ?? "");
    const title = strip(titleHtml.replace(/<small>[\s\S]*?<\/small>/, ""));
    const text = strip(/<span class="c-text">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? "");
    if (time && title) items.push({ kind, time, title, min, text });
  }
  return items;
}

/** タグの中（< から > まで）を1字ずつ読み飛ばし、外の字だけを残します。< や > そのものは残しません。 */
function textOnly(html) {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}
