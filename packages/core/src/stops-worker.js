// 停留所の探しかたを、別のスレッドで受け持ちます。
//
// なぜ別のスレッドなのか
// ----------------------
// 停留所のデータは 2.6MB（駅 0.3MB ＋ バス停 2.3MB）あります。
// 読んで解くだけで、手元の機械で 50ms、低スペックの携帯なら
// 400ms ほど**画面が止まります**。旅程を組む計算そのものは
// 130ms ほどで、そちらより読み解きのほうが重いという状態でした。
//
// ここに追い出せば、2.6MB は本体側の記憶にも載りません。返すのは
// 「最寄りの停留所3件」のような小さな答えだけです。
//
// 何をしないか
// ------------
// 計算は packages/core/src/stops-data.js のままです。ここは受け渡しだけを書きます。
// 同じ計算を2か所に書くと、片方だけ直したときに**答えが場所によって
// 変わります**（本体側で動かしたときと、こちらで動かしたときで）。

import {
  findStop, nearbyStops, preloadStops, searchStops,
} from "./stops-data.js";

const OPS = {
  preload: async () => { preloadStops(); return true; },
  find: ({ name }) => findStop(name),
  search: ({ query, limit }) => searchStops(query, limit),
  near: ({ point, maxKm, limit }) => nearbyStops(point, maxKm, limit),
};

self.addEventListener("message", async (e) => {
  const { id, op, args } = e.data ?? {};
  if (!id) return;
  try {
    const fn = OPS[op];
    if (!fn) throw new Error(`知らない依頼です: ${op}`);
    self.postMessage({ id, ok: true, value: await fn(args ?? {}) });
  } catch (err) {
    // 失敗しても、呼んだ側は直線距離の目安に戻れます。
    // 理由を添えて返し、こちら側では黙って落とします。
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
});
