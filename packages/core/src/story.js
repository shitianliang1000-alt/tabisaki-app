// 旅程に「意味づけ」の一文を付ける。
//
//   09:30 鎌倉大仏 / 11:00 長谷寺 / 13:00 昼食 / 14:30 江ノ島
//
// だけでは、時刻表であって旅の説明ではありません。
//
//   午前は鎌倉の寺社をめぐり、午後は海へ抜けます。
//
// と書けると、この並びに意味があることが伝わります。
//
// **決まった文しか出しません。** 同じ旅程なら、いつ呼んでも同じ文に
// なります。AIに書かせると、聞くたびに違う旅の説明が出てきて、
// 「さっきと言っていることが違う」になります。旅程は変わっていないのに。

/** ジャンルごとの、文に使う言葉。 */
const MOOD = {
  history: { noun: "寺社と城下町", verb: "歴史をたどり" },
  art: { noun: "美術館と建築", verb: "作品を見て" },
  nature: { noun: "山と森", verb: "自然のなかを歩き" },
  sea: { noun: "海辺", verb: "海を見て" },
  onsen: { noun: "湯どころ", verb: "湯につかり" },
  food: { noun: "市場と商店街", verb: "土地のものを食べて" },
  view: { noun: "眺めのよい場所", verb: "景色をながめ" },
  city: { noun: "街なか", verb: "街を歩き" },
};

/** その場所のいちばん強いジャンル。 */
function moodOf(place) {
  const g = (place?.genres ?? [])[0];
  return MOOD[g] ? g : null;
}

/** その時間帯の、いちばん多いジャンル。 */
function dominant(items) {
  const counts = {};
  for (const i of items) {
    const g = moodOf(i.place);
    if (g) counts[g] = (counts[g] ?? 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/**
 * 日ごとの、旅の意味づけ。
 * 立ち寄りが無い日は飛ばします（空の文を作らないこと）。
 *
 * @returns {string[]} 日ごとに1文（立ち寄りのある日だけ）
 */
export function storyFor(itin) {
  const out = [];
  for (const day of itin?.days ?? []) {
    const spots = (day?.items ?? [])
      .filter((i) => i.kind === "spot" && i.place && i.start);
    if (!spots.length) continue;

    if (spots.length === 1) {
      // 1か所しかない日に「午前は…午後は…」と書くのは、話の作りすぎです。
      out.push(`この日は「${spots[0].place.name}」をゆっくり見る一日です。`);
      continue;
    }

    const morning = spots.filter((s) => s.start.getHours() < 13);
    const afternoon = spots.filter((s) => s.start.getHours() >= 13);
    const last = spots.at(-1);
    const closesWithView = last.start.getHours() >= 15
      && ["view", "sea"].includes(moodOf(last.place));

    const a = dominant(morning);
    const b = dominant(afternoon);

    let text;
    if (a && b && a !== b) {
      text = `午前は${MOOD[a].noun}から始まり、`
        + `午後は${MOOD[b].noun}へ移ります。`;
    } else if (a || b) {
      const g = a ?? b;
      text = `${MOOD[g].noun}を中心に、`
        + `${spots.length}か所をつないだ一日です。`;
    } else {
      text = `${spots.length}か所をめぐる一日です。`;
    }

    if (closesWithView) {
      text += `最後は「${last.place.name}」で、夕方の景色を見て締めます。`;
    }
    out.push(text);
  }
  return out;
}
