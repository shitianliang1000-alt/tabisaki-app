// 組んだ旅程を、文字にする（Markdown・ふつうの文・JSON）。
// 時刻はすべて日本時間で出します（走らせる端末の時間帯によらず）。
// 決まった文は locales/*.json から引きます（{ lang: "en" } で英語。docs/i18n.md）。
// スポットの名前など、収録データの文は原文のままです。

import { i18nFor } from "./locales.mjs";

const ja = i18nFor("ja");
export const hm = ja.time;

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

export function toMarkdown({ request, itinerary }, { lang } = {}) {
  const i = i18nFor(lang);
  const out = [];
  out.push(`# ${itinerary.title ?? i.t("plan.title")}`, "");
  out.push(`- ${i.t("plan.wish", { wish: request.wish })}`);
  out.push(`- ${i.t("plan.depart", { from: request.origin.name, date: i.date(request.departAt), time: i.time(request.departAt) })}`);
  out.push(`- ${i.t("plan.days", { n: request.days })}`);
  if (Number.isFinite(itinerary.totalCostYen)) out.push(`- ${i.t("plan.cost", { cost: i.yen(itinerary.totalCostYen) })}`);
  out.push("");
  if (itinerary.headline) out.push(`> ${itinerary.headline}`, "");
  for (const day of rows(itinerary)) {
    out.push(`## ${day.date ? i.t("plan.dayWithDate", { n: day.n, date: i.date(day.date) }) : i.t("plan.day", { n: day.n })}`, "");
    out.push(i.t("plan.tableHead"), "| --- | --- | --- | --- |");
    for (const it of day.items) {
      const memo = [it.hours, it.km !== null ? i.km(it.km) : ""].filter(Boolean).join("・");
      const cell = (s) => String(s).replace(/\|/g, "｜").replace(/\n/g, " ");
      const when = i.t("plan.timeRange", { start: i.time(it.start), end: i.time(it.end) });
      out.push(`| ${when} | ${mark[it.kind] ?? ""} | ${cell(it.title)} | ${cell(memo)} |`);
    }
    out.push("");
  }
  const warn = [...(itinerary.warnings ?? []), ...(itinerary.hoursWarnings ?? [])].map((w) => (typeof w === "string" ? w : w?.message)).filter(Boolean);
  if (warn.length) out.push(`## ${i.t("plan.warnings")}`, "", ...warn.map((w) => `- ${w}`), "");
  out.push("---", "", i.t("plan.footer"));
  return out.join("\n") + "\n";
}

export function toPlainText({ request, itinerary }, { lang } = {}) {
  const i = i18nFor(lang);
  const out = [i.t("plan.plainTitle", { title: itinerary.title ?? i.t("plan.title"), from: request.origin.name, n: request.days })];
  for (const day of rows(itinerary)) {
    out.push("", day.date ? i.t("plan.dayPlain", { n: day.n, date: i.date(day.date) }) : i.t("plan.day", { n: day.n }));
    for (const it of day.items) out.push(`  ${i.time(it.start)}  ${it.title}`);
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
