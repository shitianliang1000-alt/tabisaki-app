// TUI（packages/tui/tui.mjs）の試験。描く中身とキーの動きを、端末なしで見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fit, initialState, reduce, render, width } from "../packages/tui/tui.mjs";

const t = (h, m) => new Date(`2026-11-07T${h}:${m}:00+09:00`).toISOString();
const result = {
  request: { origin: { name: "東京駅" }, days: 2 },
  itinerary: {
    title: "熱海",
    days: [
      { date: t("08", "00"), items: [
        { kind: "transit", start: t("08", "00"), end: t("10", "27"), title: "東京駅 → 熱海駅", km: 89.6 },
        { kind: "spot", start: t("10", "40"), end: t("11", "36"), title: "來宮神社", hoursText: "09:00〜17:00", detail: "大楠で知られる神社。" },
        { kind: "meal", start: t("11", "36"), end: t("12", "36"), title: "昼食" },
      ] },
      { date: t("09", "00"), items: [{ kind: "spot", start: t("09", "15"), end: t("10", "18"), title: "熱海城" }] },
    ],
  },
};

test("全角は2桁で数え、幅に収まるよう切る", () => {
  assert.equal(width("熱海a"), 5);
  assert.equal(fit("とても長いスポットの名前", 10), "とても長…");
  assert.ok(width(fit("とても長いスポットの名前", 10)) <= 10);
});

test("一覧に時刻と予定が出て、選んだ行に印が付く", () => {
  const lines = render(initialState(result), { color: false });
  assert.match(lines[0], /熱海（東京駅から・2日）/);
  assert.ok(lines.some((l) => /^› 08:00 移動 東京駅 → 熱海駅/.test(l)));
  assert.ok(lines.some((l) => /10:40 見る 來宮神社/.test(l)));
});

test("vim 風のキーで予定と日を移り、Enter で詳しく見る", () => {
  let s = initialState(result);
  s = reduce(s, "j");
  assert.equal(s.item, 1);
  s = reduce(s, "enter");
  const detail = render(s, { color: false }).join("\n");
  assert.match(detail, /來宮神社/);
  assert.match(detail, /営業: 09:00〜17:00/);
  assert.match(detail, /大楠/);
  s = reduce(s, "G");
  assert.equal(s.item, 2);
  s = reduce(s, "l");
  assert.deepEqual([s.day, s.item], [1, 0]);
  s = reduce(s, "l");
  assert.equal(s.day, 1, "最後の日より先へは行かない");
  s = reduce(s, "k");
  assert.equal(s.item, 0, "最初より前へは行かない");
  assert.equal(reduce(s, "q").quit, true);
});

test("色なし（NO_COLOR）では制御文字を出さない。狭い幅でもはみ出さない", () => {
  const lines = render(initialState(result), { cols: 30, color: false });
  for (const l of lines) {
    assert.doesNotMatch(l, /\x1b/);
    assert.ok(width(l) <= 30, l);
  }
  assert.match(render(initialState(result), { color: true })[0], /\x1b\[1m/);
});

test("端末でないところで tui を呼ぶと、理由を言って終了コード 2", () => {
  const bin = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [bin, "tui", "温泉"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /tui は端末の中で/);
});
