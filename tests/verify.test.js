// 「AIが案を出す → 検証 → 理由を返して再計画」の、検証側のテスト。
//
// 検証器が甘いと、そのまま実行不能な旅程が世に出ます。逆に厳しすぎると
// 何も提案できなくなります。境界のケースを具体的な時刻で固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { REJECT } from "../packages/core/src/feasibility.js";
import { issuesToPrompt, keepFeasible, trimKeepingPicks, trimToFit, verifyOrder }
  from "../packages/core/src/verify.js";

const d = (s) => new Date(s);
const TOKYO = { name: "東京駅", lat: 35.681236, lng: 139.767125 };
const NEAR = { name: "鎌倉駅", lat: 35.3190, lng: 139.5500 };

function spot(over = {}) {
  return {
    id: over.id ?? "s1",
    name: over.name ?? "テスト美術館",
    category: over.category ?? "美術館",   // 既定 10:00-17:00 / 70分
    lat: over.lat ?? 35.3200,
    lng: over.lng ?? 139.5520,
    ...over,
  };
}

// 近接した3スポット（徒歩数分）
const A = spot({ id: "A", name: "館A", lat: 35.3200, lng: 139.5520 });
const B = spot({ id: "B", name: "館B", lat: 35.3210, lng: 139.5530 });
const SHRINE = spot({ id: "S", name: "神社S", category: "神社",
                      lat: 35.3205, lng: 139.5525 });

test("時間内に収まる順は、問題なしと判定される", () => {
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.visits.length, 2);
  assert.ok(r.slackMin > 0);
});

test("閉館後に着く案は、理由つきで弾かれる", () => {
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.TOO_LATE);
  assert.ok(r.issues[0].detail.includes("館A"));
  assert.ok(/\d/.test(r.issues[0].detail), "時刻が理由に含まれていない");
});

test("最終入場を過ぎてしか着けない案は弾かれる", () => {
  // 美術館は 17:00 閉館・最終入場 16:30。開いてはいても入れません。
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T16:40"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.AFTER_LAST_ENTRY);
});

test("閉館までに見学しきれない案も弾かれる", () => {
  // 最終入場（16:30）には間に合っても、70分の見学が 17:00 に収まりません。
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T16:10"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.TOO_LATE);
});

test("開館まで少し待つ案は通り、待ち時間が記録される", () => {
  // 待ってよいのは20分まで（TUNING.maxWaitMin）。
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T09:45"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.visits[0].wait > 0);
  assert.equal(r.visits[0].arrive.getHours(), 10);
});

test("待ちすぎる案は弾かれる", () => {
  // 昼から開く館に、朝いちで着く案。
  //
  // 以前はここを 6:00 発で書いていました。いまは「1日が始まる前に
  // 着いた」ぶんは待ち時間に数えず、行動開始（9:00）まで進めてから
  // 数えるので、6:00 発でも待ちは1時間です。待ちすぎの判定そのものは
  // 変わっていません。
  const noon = spot({ id: "N", name: "昼から館", open: 12, close: 17 });
  const r = verifyOrder([noon], {
    start: NEAR, startAt: d("2026-09-12T09:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.WAIT_TOO_LONG);
});

test("1日が始まる前に着いても、そこは待ち時間にしない", () => {
  // 神社は「いつでも入れる」ので、素通りすると午前4時の参拝が旅程に
  // 入ります（実際に「4:11 浅草神社」が出ていました）。
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T04:30"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
    // 「朝は4時から」と指定した場合。指定は尊重しますが、見学は
    // 明るくなってからです。
    dayStartHour: 4, dayEndHour: 18.5,
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.ok(r.visits[0].arrive.getHours() >= 7,
    `暗いうちに見学しています: ${r.visits[0].arrive}`);
  // 「3時間の自由時間」として旅程に立てず、助言に回します。
  assert.equal(r.visits[0].wait, 0);
  assert.ok(r.morningIdleMin > 60, `${r.morningIdleMin}`);
});

test("朝のうちに予定が終わった日にも、昼食は入る", () => {
  // 1日目も2日目も昼食が抜けていました（8時に見学が終わり、次は
  // 17:30の夕食）。食事は、予定の詰まり具合とは別に要るものです。
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T07:00"),
    end: NEAR, endBy: d("2026-09-13T18:00"), nights: 1,
    baseByDay: [NEAR, NEAR],
  });
  assert.ok(r.meals.some((m) => m.kind === "lunch"),
    JSON.stringify(r.meals));
});

test("終点に間に合わない案は、超過分を示して弾かれる", () => {
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T14:00"),
    end: TOKYO, endBy: d("2026-09-12T15:00"),
  });
  assert.equal(r.ok, false);
  const issue = r.issues.find((i) => i.reason === REJECT.CANNOT_FINISH);
  assert.ok(issue, JSON.stringify(r.issues));
  assert.ok(issue.detail.includes("超過"), issue.detail);
});

test("常時開放のスポットは時間帯で弾かれない", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T07:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test("定休日は曜日で判定される", () => {
  // 2026-09-12 は土曜
  const closed = spot({ id: "C", name: "館C", closedDays: [6] });
  const r = verifyOrder([closed], {
    start: NEAR, startAt: d("2026-09-12T11:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].reason, REJECT.CLOSED_TODAY);
});

test("問題のあるスポットだけが落ち、他は残る", () => {
  const late = spot({ id: "L", name: "館L", open: 20, close: 22 });
  const r = verifyOrder([SHRINE, late, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, false);
  const names = keepFeasible(r).map((s) => s.name);
  assert.deepEqual(names, ["神社S", "館B"]);
});

test("訪問順に時刻が単調に進む", () => {
  const r = verifyOrder([SHRINE, A, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T19:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  for (let i = 1; i < r.visits.length; i++) {
    assert.ok(r.visits[i].arrive >= r.visits[i - 1].end,
      "訪問が前の見学終了より前に始まっている");
  }
});

test("空の案は、問題なしかつ訪問ゼロ", () => {
  const r = verifyOrder([], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.visits.length, 0);
});

test("独自の移動時間関数を使える（Routes API の実測を差し込む口）", () => {
  let called = 0;
  const travelFn = () => { called++; return 5; };
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
    travelFn,
  });
  assert.ok(called >= 3, `travelFn が使われていない (${called})`);
  assert.equal(r.visits[0].travel, 5);
});

// ------------------------------------------------- 再計画へのフィードバック --

test("問題は、次のプロンプト用の文章にまとまる", () => {
  const r = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-12T22:00"),
  });
  const text = issuesToPrompt(r, new Map());
  assert.ok(text.includes("館A"), text);
  assert.ok(text.includes("使わないでください"), text);
  assert.ok(text.includes("A"), "落選IDが伝わっていない");
});

test("問題がなければフィードバック文は空", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  assert.equal(issuesToPrompt(r, new Map()), "");
});

test("通ったスポットも次のプロンプトに伝える（全部やり直させない）", () => {
  const late = spot({ id: "L", name: "館L", open: 20, close: 22 });
  const r = verifyOrder([SHRINE, late], {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T18:00"),
  });
  const text = issuesToPrompt(r, new Map());
  assert.ok(text.includes("神社S"), text);
});

// ---------------------------------------- 食事の時間確保と、収まるまで削る --

test("昼どきをまたぐ日程には、食事の時間が確保される", () => {
  const r = verifyOrder([A, B], {
    start: NEAR, startAt: d("2026-09-12T11:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.meals.length, 1, "昼食が確保されていない");
  const lunch = r.meals[0];
  const h = lunch.start.getHours() + lunch.start.getMinutes() / 60;
  assert.ok(h >= 11.5 && h <= 14, `昼食の時刻が変: ${h}`);
});

test("食事の時間は、終点への到着判定にも含まれる", () => {
  // 食事を足すと期限を超えるぎりぎりの条件
  const withMeal = verifyOrder([A], {
    start: NEAR, startAt: d("2026-09-12T11:30"),
    end: NEAR, endBy: d("2026-09-12T14:00"),
  });
  const totalUsed = withMeal.meals.reduce(
    (s, m) => s + (m.end - m.start) / 60000, 0);
  assert.ok(totalUsed > 0, "食事が計上されていない");
  if (withMeal.arriveEnd) {
    // 食事ぶんが進んでいるので、到着は見学終了より後
    const lastVisit = withMeal.visits.at(-1);
    if (lastVisit) assert.ok(withMeal.arriveEnd >= lastVisit.end);
  }
});

test("昼どきに掛からない日程では食事を入れない", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T15:00"),
    end: NEAR, endBy: d("2026-09-12T20:00"),
  });
  assert.equal(r.meals.length, 0);
});

test("日帰りでは夕食を入れない（allowDinner 未指定）", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-12T21:00"),
  });
  assert.ok(!r.meals.some((m) => m.kind === "dinner"));
});

test("宿泊ありなら夕食の時間も確保する", () => {
  const r = verifyOrder([SHRINE], {
    start: NEAR, startAt: d("2026-09-12T17:30"),
    end: NEAR, endBy: d("2026-09-13T21:00"),
    allowDinner: true,
  });
  assert.ok(r.meals.some((m) => m.kind === "dinner"), JSON.stringify(r.meals));
});

test("trimToFit は、期限に収まるまで後ろから削る", () => {
  const many = [A, B, SHRINE, spot({ id: "D", name: "館D", category: "神社",
                                     lat: 35.33, lng: 139.56 })];
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T13:00"),
    end: TOKYO, endBy: d("2026-09-12T17:00"),
  };
  const before = verifyOrder(many, ctx);
  assert.equal(before.ok, false, "前提: この条件では収まらないはず");

  const { result, spots: kept, dropped } = trimToFit(many, ctx);
  assert.equal(result.ok, true,
    `削っても収まっていない: ${JSON.stringify(result.issues)}`);
  assert.ok(dropped.length > 0, "何も削っていない");
  assert.ok(kept.length < many.length);
  assert.ok(result.arriveEnd <= ctx.endBy, "期限を超えている");
});

test("入りきらないときは、選んだ場所より先に穴埋めを外す", () => {
  // 「宮島に行きたい」で、案内所（穴埋め）が残って厳島神社が落ちていた形。
  // 後ろの D が選んだ場所、前の A・B は空き時間を埋めるために足した場所です。
  const D = spot({ id: "D", name: "館D", category: "神社", lat: 35.33, lng: 139.56 });
  const many = [A, B, SHRINE, D];
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T13:00"),
    end: TOKYO, endBy: d("2026-09-12T17:00"),
  };
  const plain = trimToFit(many, ctx);
  assert.ok(plain.dropped.some((s) => s.id === "D"),
    "前提: ふつうに削ると、後ろの選んだ場所が落ちるはず");

  const fillers = new Set(["A", "B"]);
  const kept = trimKeepingPicks(many, ctx, fillers);
  assert.equal(kept.result.ok, true, JSON.stringify(kept.result.issues));
  const ids = kept.result.visits.map((v) => v.spot.id);
  assert.ok(ids.includes("D"), `選んだ場所が落ちています: ${ids}`);
  assert.ok(ids.length < many.length);
  // 外した穴埋めは「時間が合わず外した」に数えません。
  assert.ok(!kept.dropped.some((s) => fillers.has(s.id)),
    JSON.stringify(kept.dropped.map((s) => s.id)));
});

test("穴埋めが無ければ、trimToFit と同じ", () => {
  const many = [A, B, SHRINE];
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T13:00"),
    end: TOKYO, endBy: d("2026-09-12T17:00"),
  };
  const a = trimToFit(many, ctx);
  const b = trimKeepingPicks(many, ctx, new Set());
  assert.deepEqual(b.spots.map((s) => s.id), a.spots.map((s) => s.id));
});

test("trimToFit は、収まる日程では何も削らない", () => {
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T10:00"),
    end: NEAR, endBy: d("2026-09-12T19:00"),
  };
  const { result, spots: kept, dropped } = trimToFit([SHRINE, A], ctx);
  assert.equal(result.ok, true);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 2);
});

test("trimToFit は、全部落ちても例外を投げない", () => {
  const ctx = {
    start: NEAR, startAt: d("2026-09-12T18:50"),
    end: TOKYO, endBy: d("2026-09-12T19:00"),
  };
  const { result, spots: kept } = trimToFit([A, B], ctx);
  assert.ok(Array.isArray(kept));
  assert.ok(Array.isArray(result.visits));
});

// --- 移動中に食事を置かない -------------------------------------------------
//
// 旅程にこう出ていました。
//
//   11:22-13:04  北海道駒ヶ岳へ移動（33.9km）
//   12:00-13:00  昼食
//
// 102分の移動の途中で、食事はとれません。日を締めるときの昼食を
// 12:00固定で置いていて、その時刻が空いているか見ていませんでした。

test("移動中の時刻に、食事を置かない", () => {
  const far = { id: "far", name: "遠くの山", category: "山",
                lat: 42.0, lng: 140.6, description: "山です。" };
  const near = { id: "near", name: "近くの館", category: "博物館",
                 lat: 41.77, lng: 140.73, description: "館です。" };
  const r = verifyOrder([near, far], {
    start: { lat: 41.7737, lng: 140.7267 },
    startAt: new Date("2026-09-01T09:00"),
    end: { lat: 41.7737, lng: 140.7267 },
    endBy: new Date("2026-09-01T21:00"),
  });
  const busy = r.visits.map((v) => [
    new Date(v.arrive.getTime() - (v.travel + v.wait) * 60000),
    new Date(v.end),
  ]);
  for (const m of r.meals) {
    for (const [s, e] of busy) {
      assert.ok(!(m.start < e && m.end > s),
        `${m.kind} が ${s.getHours()}時台の予定と重なっています`);
    }
  }
});

test("置いてきた拠点へ、戻らない", () => {
  // 2日目に南へ62km移り、その日に北の場所へ61km戻る、という並び。
  const north = { id: "n", name: "北の館", category: "博物館",
                  lat: 26.655, lng: 127.883, description: "館です。" };
  const south = { id: "s", name: "南の館", category: "博物館",
                  lat: 26.156, lng: 127.650, description: "館です。" };
  const baseN = { name: "北の拠点", lat: 26.681, lng: 127.865 };
  const baseS = { name: "南の拠点", lat: 26.177, lng: 127.579 };
  const r = verifyOrder([south, north], {
    start: baseS,
    startAt: new Date("2026-09-02T09:00"),
    end: baseS, endBy: new Date("2026-09-02T20:00"),
    baseByDay: [baseN, baseS],
    day0: new Date("2026-09-01T09:00"),
    nights: 1,
  });
  // 2日目（index 1）の拠点は南。北の館は、前の拠点のほうが桁違いに近い。
  const names = r.visits.map((v) => v.spot.name);
  assert.ok(!names.includes("北の館"),
    "62km南下したあとに、61km北へ戻っています");
  assert.ok(r.issues.some((i) => i.name === "北の館"),
    "落とした理由が残っていません");
});
