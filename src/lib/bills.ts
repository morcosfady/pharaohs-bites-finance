/* Bills coming up and monthly budgets: small pure helpers for the Expenses page. Money in cents. */
import { toCents } from "./money";
import type { Num } from "./types";

export interface Bill { vendor: string; description: string; amount: Num; due: string; recurrence: string; expense_id: string }

/** "today", "tomorrow", "in 5 days", or "3 days ago" (a charge the nightly job has not created yet). */
export function dueLabel(due: string, today: Date): string {
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = due.split("-").map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - t) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} ago`;
  return `in ${days} days`;
}

/** What to keep aside: the sum of every bill due inside the window. */
export function totalDue(bills: Pick<Bill, "amount" | "due">[], withinDays: number, today: Date): number {
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return bills.reduce((s, b) => {
    const [y, m, d] = b.due.split("-").map(Number);
    return (Date.UTC(y, m - 1, d) - t) / 86400000 <= withinDays ? s + toCents(b.amount) : s;
  }, 0);
}

export type BudgetTone = "ok" | "near" | "over";
/** Green under 80%, amber from 80%, red from 100%. */
export const budgetTone = (pct: number): BudgetTone => (pct >= 100 ? "over" : pct >= 80 ? "near" : "ok");

export interface BudgetRow { category_id: string; category: string; spent: Num; monthly_limit: Num; pct: Num }

/** How the budget bar should read: percent used (capped at the track for drawing) and what is left or over. */
export function budgetView(b: Pick<BudgetRow, "spent" | "monthly_limit">) {
  const spent = toCents(b.spent), limit = toCents(b.monthly_limit);
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  return { spent, limit, pct, drawPct: Math.min(pct, 100), leftCents: limit - spent, tone: budgetTone(pct) };
}
