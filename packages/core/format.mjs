// 組んだ旅程を、文字にする（Markdown・ふつうの文・JSON）。
// 時刻はすべて日本時間で出します（走らせる端末の時間帯によらず）。

const fmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });

export const hm = (d) => fmt.format(new Date(d));
const dayLabel = (d) => dayFmt.format(new Date(d));
const yen = (n) => `${Math.round(n).toLocaleString("ja-JP")}円`;

/** 旅程を、行の並びにします（形式によらない中身）。 */
export function rows(itinerary) {
  return (itinerary.days ?? []).map((day, i) => ({
    n: i + 1,
    date: day.date ?? day.items?.[0]?.start,
    items: (day.items ?? []).map((it) => ({
      kind: it.kind,
      start: it.start,
      end: it.end,
      title: it.title,
      detail: it.detail ?? "",
      hours: it.kind === "spot" ? (it.hoursText ?? "") : "",
      estimated: Boolean(it.estimated),
      km: it.kind === "transit" && Number.isFinite(it.km) ? it.km : null,
    })),
  }));
}

const mark = { spot: "📍", meal: "🍴", transit: "🚃", lodging: "🛏", rest: "☕" };

export function toMarkdown({ request, itinerary }) {
  const out = [];
  out.push(`# ${itinerary.title ?? "旅程"}`, "");
  out.push(`- 希望: ${request.wish}`);
  out.push(`- 出発: ${request.origin.name}（${dayLabel(request.departAt)} ${hm(request.departAt)}）`);
  out.push(`- 日数: ${request.days}日`);
  if (Number.isFinite(itinerary.totalCostYen)) out.push(`- 費用の目安: ${yen(itinerary.totalCostYen)}`);
  out.push("");
  if (itinerary.headline) out.push(`> ${itinerary.headline}`, "");
  for (const day of rows(itinerary)) {
    out.push(`## ${day.n}日目${day.date ? `（${dayLabel(day.date)}）` : ""}`, "");
    out.push("| 時刻 | | 予定 | メモ |", "| --- | --- | --- | --- |");
    for (const it of day.items) {
      const memo = [it.hours, it.km !== null ? `${it.km.toFixed(1)}km` : ""].filter(Boolean).join("・");
      const cell = (s) => String(s).replace(/\|/g, "｜").replace(/\n/g, " ");
      out.push(`| ${hm(it.start)}〜${hm(it.end)} | ${mark[it.kind] ?? ""} | ${cell(it.title)} | ${cell(memo)} |`);
    }
    out.push("");
  }
  const warn = [...(itinerary.warnings ?? []), ...(itinerary.hoursWarnings ?? [])].map((w) => (typeof w === "string" ? w : w?.message)).filter(Boolean);
  if (warn.length) out.push("## 注意", "", ...warn.map((w) => `- ${w}`), "");
  out.push("---", "", "移動時間は距離からの目安です（実際の乗換は調べていません）。営業時間は変わることがあります。出かける前に確かめてください。");
  return out.join("\n") + "\n";
}

export function toPlainText({ request, itinerary }) {
  const out = [`${itinerary.title ?? "旅程"}（${request.origin.name}から・${request.days}日）`];
  for (const day of rows(itinerary)) {
    out.push("", `${day.n}日目${day.date ? ` ${dayLabel(day.date)}` : ""}`);
    for (const it of day.items) out.push(`  ${hm(it.start)}  ${it.title}`);
  }
  return out.join("\n") + "\n";
}

export function toJson({ request, itinerary }) {
  return JSON.stringify({
    version: 1,
    request: {
      wish: request.wish, from: request.origin.name, days: request.days,
      departAt: new Date(request.departAt).toISOString(), arriveBy: new Date(request.arriveBy).toISOString(),
      transport: request.transport,
    },
    title: itinerary.title ?? null,
    totalCostYen: itinerary.totalCostYen ?? null,
    days: rows(itinerary),
  }, null, 2) + "\n";
}
