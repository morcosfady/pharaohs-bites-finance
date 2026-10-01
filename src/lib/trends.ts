/* Month-by-month spending and top vendors for the Trends tab. Money in cents. Rows come from
   expense_tax_view (one per category line), personal items are set aside. */
import type { ExpenseTaxRow } from "./types";
import { toCents } from "./money";
import { PERSONAL } from "./categoryBreakdown";

export interface MonthBucket { key: string; label: string; totalCents: number; parts: Record<string, number> }
export interface Trend { months: MonthBucket[]; categories: string[]; maxCents: number }

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The last `months` calendar months ending with the month of `now`, oldest first. The biggest `topN`
 *  categories over the whole span keep their own colour; the rest are folded into "Everything else". */
export function trendData(rows: Pick<ExpenseTaxRow, "expense_date" | "category_name" | "total_amount">[], now: Date, months = 12, topN = 5): Trend {
  const buckets: MonthBucket[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ key: monthKey(d), label: LABELS[d.getMonth()], totalCents: 0, parts: {} });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const totals = new Map<string, number>();
  const used = rows.filter((r) => r.category_name !== PERSONAL && byKey.has(r.expense_date.slice(0, 7)));
  for (const r of used) totals.set(r.category_name, (totals.get(r.category_name) ?? 0) + toCents(r.total_amount));
  const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([n]) => n);
  const hasRest = totals.size > top.length;
  for (const r of used) {
    const b = byKey.get(r.expense_date.slice(0, 7))!;
    const name = top.includes(r.category_name) ? r.category_name : "Everything else";
    const c = toCents(r.total_amount);
    b.parts[name] = (b.parts[name] ?? 0) + c; b.totalCents += c;
  }
  return { months: buckets, categories: hasRest ? [...top, "Everything else"] : top, maxCents: Math.max(0, ...buckets.map((b) => b.totalCents)) };
}

export interface VendorRow { vendor: string; cents: number; count: number; share: number; avgCents: number; avgChange: number | null }

/** Who gets the money. `avgChange` compares the average charge with the previous period (needs 2+ charges in both)
 *  so a vendor quietly charging more per order shows up. */
export function topVendors(rows: Pick<ExpenseTaxRow, "vendor" | "category_name" | "total_amount">[], prevRows: Pick<ExpenseTaxRow, "vendor" | "category_name" | "total_amount">[] = [], limit = 8): VendorRow[] {
  const group = (list: typeof rows) => {
    const m = new Map<string, { name: string; cents: number; count: number }>();
    for (const r of list) {
      if (r.category_name === PERSONAL) continue;
      const name = (r.vendor || "Unknown").trim() || "Unknown", k = name.toLowerCase();
      const e = m.get(k) ?? { name, cents: 0, count: 0 };
      e.cents += toCents(r.total_amount); e.count += 1; m.set(k, e);
    }
    return m;
  };
  const cur = group(rows), prev = group(prevRows);
  const total = [...cur.values()].reduce((s, e) => s + e.cents, 0);
  return [...cur.entries()].map(([k, e]) => {
    const p = prev.get(k);
    const avg = e.cents / e.count;
    return { vendor: e.name, cents: e.cents, count: e.count, share: total > 0 ? e.cents / total : 0, avgCents: Math.round(avg),
      avgChange: p && p.count >= 2 && e.count >= 2 && p.cents > 0 ? avg / (p.cents / p.count) - 1 : null };
  }).sort((a, b) => b.cents - a.cents).slice(0, limit);
}
