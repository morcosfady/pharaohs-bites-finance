// Turns the weekly_summary() JSON from the database into the Monday Telegram message (HTML).
// Pure: no network, no Deno APIs, so it is unit-tested from the dashboard test suite.

export interface WeeklySummary {
  from: string; to: string; spent: number; prev_spent: number; sales: number; profit: number;
  top_categories: { name: string; amount: number }[]; biggest: { vendor: string; amount: number; date: string } | null;
  budgets: { category: string; spent: number; limit: number; pct: number }[];
  bills: { vendor: string; amount: number; due: string }[];
  price_jumps: { item: string; store: string; old: number; new: number; pct: number }[];
  possible_duplicates: number; needs_receipt: number; waiting_receipts: number;
}

const money = (n: number) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const day = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function formatWeeklySummary(s: WeeklySummary): string {
  const out: string[] = [];
  out.push(`📊 <b>Weekly money summary</b>`, `<i>${day(s.from)} to ${day(s.to)}</i>`, "");

  if (s.spent === 0 && s.sales === 0) {
    out.push("A quiet week: no sales and nothing spent.");
  } else {
    let vs = "";
    if (s.prev_spent > 0) {
      const ch = Math.round(((s.spent - s.prev_spent) / s.prev_spent) * 100);
      vs = ch === 0 ? " (same as last week)" : ` (${ch > 0 ? "up" : "down"} ${Math.abs(ch)}% vs last week)`;
    }
    out.push(`💸 Spent: <b>${money(s.spent)}</b>${vs}`, `💵 Sales: <b>${money(s.sales)}</b>`, `${s.profit >= 0 ? "💰" : "🔻"} Left after spending: <b>${s.profit < 0 ? "-" : ""}${money(Math.abs(s.profit))}</b>`);
    if (s.top_categories.length) out.push("", "Where it went:", ...s.top_categories.map((c, i) => `  ${i + 1}. ${esc(c.name)}: ${money(c.amount)}`));
    if (s.biggest) out.push("", `Biggest charge: ${esc(s.biggest.vendor || "unknown")} ${money(s.biggest.amount)} (${day(s.biggest.date)})`);
  }

  const alerts: string[] = [];
  for (const b of s.budgets) alerts.push(`${b.pct >= 100 ? "🚨" : "⚠️"} Budget ${esc(b.category)}: ${Math.round(b.pct)}% used (${money(b.spent)} of ${money(b.limit)})`);
  for (const j of s.price_jumps) alerts.push(`📈 ${esc(j.item)} is up ${Math.round(j.pct * 100)}% at ${esc(j.store)} (${money(j.old)} to ${money(j.new)})`);
  if (s.possible_duplicates > 0) alerts.push(`🔍 ${s.possible_duplicates} possible duplicate${s.possible_duplicates === 1 ? "" : "s"} to check in Review`);
  if (s.needs_receipt > 0) alerts.push(`🧾 ${s.needs_receipt} store charge${s.needs_receipt === 1 ? "" : "s"} still without a receipt`);
  if (s.waiting_receipts > 0) alerts.push(`⏳ ${s.waiting_receipts} receipt${s.waiting_receipts === 1 ? "" : "s"} waiting to be read`);
  if (alerts.length) out.push("", "<b>Needs a look</b>", ...alerts);

  if (s.bills.length) out.push("", "<b>Bills in the next 7 days</b>", ...s.bills.map((b) => `  • ${esc(b.vendor)} ${money(b.amount)} on ${day(b.due)}`));
  else out.push("", "No bills due in the next 7 days.");
  return out.join("\n");
}
