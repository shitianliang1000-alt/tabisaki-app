// 希望に本当に応えられたのか、を判定する。
//
// 「富士登山をしたい」と入力して河口湖周遊が出てきたとき、利用者からは
// なぜそうなったのか分かりません。収録データに無かったのか、時間の都合で
// 外れたのか、単に選ばれなかったのか。
//
// 黙って近いものを出すのではなく、
//   ・希望した言葉が結果に含まれているか
//   ・含まれていないなら、収録データに存在するのか
//   ・存在するのに外れたなら、その理由（時間・季節など）
// を判定して、画面にそのまま出せる形で返します。

import { GENRE_TERMS } from "./keywords.js";

// 語 → ジャンル。「歴史」は寺社を含む旅程で満たされているのに、
// 「歴史」という文字を含むスポットが無いという理由だけで
// 「ご希望に応えられませんでした」と出ていました。
const TERM_GENRE = new Map();
for (const [genre, terms] of Object.entries(GENRE_TERMS)) {
  for (const t of terms) TERM_GENRE.set(t, genre);
}

/**
 * 希望の語が、提案された旅程に反映されているかを見ます。
 *
 * @param {string[]} keywords 希望文から取り出した語
 * @param {Array} chosenSpots 提案に含まれるスポット
 * @param {Array} allSpots    収録されている全スポット
 * @returns {{covered: string[], missing: string[],
 *            existsElsewhere: Array<{term:string, spots:Array}>}}
 */
export function analyzeCoverage(keywords, chosenSpots, allSpots) {
  const covered = [];
  const missing = [];
  const existsElsewhere = [];

  const chosenGenres = new Set(chosenSpots.flatMap((s) => s.genres ?? []));
  const inChosen = (term) => {
    const genre = TERM_GENRE.get(term);
    if (genre && chosenGenres.has(genre)) return true;
    return chosenSpots.some((s) => matches(s, term));
  };

  for (const term of keywords) {
    if (inChosen(term)) {
      covered.push(term);
      continue;
    }
    missing.push(term);
    const elsewhere = allSpots.filter((s) => matches(s, term));
    if (elsewhere.length) {
      existsElsewhere.push({ term, spots: elsewhere.slice(0, 5) });
    }
  }
  return { covered, missing, existsElsewhere };
}

function matches(spot, term) {
  if (!term) return false;
  const hay = `${spot.name} ${spot.category} ${spot.region ?? ""} `
    + `${spot.description ?? ""}`;
  return hay.includes(term);
}

/**
 * 利用者に見せる説明文を組み立てます。
 * 「応えられた／応えられなかった」をはっきり書くのが目的なので、
 * 曖昧な言い回しは避けます。
 *
 * @returns {{level: "ok"|"partial"|"miss", text: string, alternatives: Array}}
 */
export function coverageMessage(coverage, regionName, opts = {}) {
  const { missing, existsElsewhere, covered } = coverage;
  const notable = missing.filter((t) => t.length >= 2);

  if (!notable.length) {
    return { level: "ok", text: "", alternatives: [] };
  }

  // 収録はされているが、今回の旅程からは外れた語
  const available = existsElsewhere.filter((e) => notable.includes(e.term));
  if (available.length) {
    const first = available[0];
    const names = first.spots.map((s) => s.name).slice(0, 3);
    const regions = [...new Set(first.spots.map((s) => s.region))]
      .filter(Boolean).slice(0, 3);
    return {
      level: "partial",
      text: `「${first.term}」に関係する場所は収録されています`
        + `（${names.join("、")}${first.spots.length > names.length ? " ほか" : ""}）。`
        + `今回は${regionName}を提案しましたが、`
        + `${regions.length ? regions.join("・") + "を" : "そちらを"}`
        + `目的にする場合は、出発地や日時を変えるか、`
        + `希望文に地名を入れて指定してください。`,
      alternatives: first.spots,
    };
  }

  // 収録そのものが無い語
  return {
    level: "miss",
    text: `「${notable.join("」「")}」に該当する場所は、いまの収録データに`
      + `見つかりませんでした。${regionName}は`
      + (covered.length ? `「${covered.join("」「")}」に基づく提案です。`
                        : "条件に合う範囲での提案です。")
      + (opts.sampleData
          ? "収録は主要エリアに限られているため、地域を広げたい場合は"
            + "知識ベースを差し替えてください。"
          : ""),
    alternatives: [],
  };
}

/**
 * 季節や条件で実施できない可能性が高いものを知らせます。
 * 富士登山のように、時期を外すと成立しない対象が対象です。
 */
const SEASONAL = [
  {
    match: /富士山|吉田ルート|富士登山/,
    when: (date) => {
      const m = date.getMonth() + 1;
      const d = date.getDate();
      const open = (m === 7 && d >= 1) || m === 8 || (m === 9 && d <= 10);
      return open ? null
        : "富士山の登山道が開いているのは概ね7月上旬〜9月上旬です。"
          + "この日程では山頂までは登れません（五合目までは通年アクセスできます）。";
    },
  },
  {
    match: /芝桜/,
    when: (date) => {
      const m = date.getMonth() + 1;
      return (m === 4 || m === 5) ? null
        : "芝桜の見頃は4〜5月です。この時期以外は花は咲いていません。";
    },
  },
  {
    match: /紅葉/,
    when: (date) => {
      const m = date.getMonth() + 1;
      return (m >= 10 && m <= 12) ? null
        : "紅葉の見頃は概ね10〜12月です。";
    },
  },
];

/** 旅程に含まれるスポットについて、季節の注意を返します。 */
export function seasonalNotes(spots, date) {
  const notes = [];
  for (const rule of SEASONAL) {
    const hit = spots.some((s) => rule.match.test(`${s.name} ${s.description ?? ""}`));
    if (!hit) continue;
    const note = rule.when(date);
    if (note) notes.push(note);
  }
  return [...new Set(notes)];
}
