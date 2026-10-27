// 定番・知る人ぞ知る・穴場を、どの比率で混ぜるか。
//
// 類似度だけに任せると有名どころが必ず勝ち、「穴場も紹介します」が
// 実質的に機能しなくなります。そこで枠を明示的に確保します。

export const TIER_LABEL = { major: "定番", known: "知る人ぞ知る", hidden: "穴場" };

/**
 * @param {number} total 選ぶ数
 * @param {number} hiddenBias 0=定番中心 / 0.5=均衡 / 1=穴場中心
 */
export function mixTargets(total, hiddenBias = 0.5) {
  if (total <= 0) return { major: 0, known: 0, hidden: 0 };
  const b = Math.min(1, Math.max(0, hiddenBias));
  // 端まで動かしたら、端の結果になること。
  //
  // 以前は 0.6→0.2（定番）／0.1→0.4（穴場）の幅しかありませんでした。
  // 「穴場中心」まで振り切っても定番が2割残り、穴場は4割止まりです。
  // 画面には「穴場10」と出るのに定番のほうが多く返ることがあり、
  // スライダーが効いていない（向きが逆だ）ように見えていました。
  const out = {
    major: Math.round(total * (0.75 - 0.70 * b)),
    known: Math.round(total * (0.20 + 0.05 * b)),
    hidden: Math.round(total * (0.05 + 0.65 * b)),
  };

  // 端数調整を先に行う。これを穴場の下限確保より後にすると、
  // 調整処理が穴場から1件引いて下限を無効化してしまう。
  let drift = total - (out.major + out.known + out.hidden);
  const order = drift > 0
    ? ["major", "known", "hidden"]
    : ["hidden", "known", "major"];
  let i = 0;
  while (drift !== 0 && i < 64) {
    const key = order[i % 3];
    const step = drift > 0 ? 1 : -1;
    if (out[key] + step >= 0) { out[key] += step; drift -= step; }
    i++;
  }

  // そのうえで下限を確保し、余裕のある層から1件回す。
  if (total >= 3 && out.hidden === 0) {
    const donor = out.major >= out.known ? "major" : "known";
    if (out[donor] > 0) { out[donor] -= 1; out.hidden = 1; }
  }
  return out;
}

/** 層のバランスを取りながら count 件選ぶ。足りない層は類似度順で埋める。 */
export function balanceByTier(matches, count, hiddenBias = 0.5) {
  const targets = mixTargets(count, hiddenBias);
  const buckets = { major: [], known: [], hidden: [] };
  for (const m of matches) {
    (buckets[m.spot.fame_tier] ?? buckets.known).push(m);
  }
  const chosen = [];
  const taken = new Set();
  for (const tier of ["major", "known", "hidden"]) {
    for (const m of buckets[tier].slice(0, targets[tier])) {
      chosen.push(m);
      taken.add(m.spot.id);
    }
  }
  for (const m of matches) {
    if (chosen.length >= count) break;
    if (!taken.has(m.spot.id)) { chosen.push(m); taken.add(m.spot.id); }
  }
  return chosen.slice(0, count);
}
