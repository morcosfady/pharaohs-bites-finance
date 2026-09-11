/** Deterministic insights: every sentence is derived from real numbers. */
import { fmt, pct, change } from "./money";
import type { Kpis, ProductRank } from "./metrics";
import { differenceInCalendarDays } from "date-fns";

export interface Insight { tone: "positive" | "negative" | "warning" | "info"; text: string; href?: string }

export function buildInsights(args: {
  current: Kpis; previous: Kpis; products: ProductRank[]; prevProducts: ProductRank[];
  pendingWhatsapp: number; unpaidCount: number; lowMarginPct: number; taxDueDate: string | null; periodLabel: string;
  ingredientCostChange?: number | null;
}): Insight[] {
  const { current: c, previous: p } = args;
  const out: Insight[] = [];
  const rev = change(c.netSales, p.netSales);
  if (rev != null && p.netSales > 0) {
    out.push({ tone: rev >= 0 ? "positive" : "negative", text: `Net sales ${rev >= 0 ? "increased" : "decreased"} ${pct(Math.abs(rev), 0)} compared with the previous ${args.periodLabel} (${fmt(c.netSales)} vs ${fmt(p.netSales)}).` });
  }
  const aov = c.avgOrderValue != null && p.avgOrderValue != null ? change(c.avgOrderValue, p.avgOrderValue) : null;
  if (aov != null && aov < -0.05) out.push({ tone: "warning", text: `Average order value decreased ${pct(Math.abs(aov), 0)} (${fmt(c.avgOrderValue!)} vs ${fmt(p.avgOrderValue!)}).` });
  else if (aov != null && aov > 0.05) out.push({ tone: "positive", text: `Average order value is up ${pct(aov, 0)} to ${fmt(c.avgOrderValue!)}.` });

  const byUnits = [...args.products].sort((a, b) => b.units - a.units)[0];
  if (byUnits) out.push({ tone: "info", text: `${byUnits.name} is your best seller by units (${byUnits.units} sold).`, href: `#/products/${byUnits.product_id}` });
  const byProfit = [...args.products].sort((a, b) => b.profit - a.profit)[0];
  if (byProfit && byProfit.profit > 0) out.push({ tone: "positive", text: `${byProfit.name} generates the highest total profit (${fmt(byProfit.profit)}).`, href: `#/products/${byProfit.product_id}` });
  for (const pr of args.products.filter((x) => x.margin != null && x.margin < args.lowMarginPct && x.units > 0).slice(0, 3)) {
    out.push({ tone: "warning", text: `${pr.name} has a low profit margin (${pct(pr.margin)}). Review its recipe cost or price.`, href: `#/products/${pr.product_id}` });
  }
  for (const pr of args.products) {
    const prev = args.prevProducts.find((x) => x.product_id === pr.product_id);
    if (prev && prev.units >= 3) {
      const ch = change(pr.units, prev.units);
      if (ch != null && ch <= -0.3) out.push({ tone: "warning", text: `${pr.name} sales declined ${pct(Math.abs(ch), 0)} versus the previous ${args.periodLabel}.`, href: `#/products/${pr.product_id}` });
      else if (ch != null && ch >= 0.5) out.push({ tone: "positive", text: `${pr.name} is growing fast: +${pct(ch, 0)} units versus the previous ${args.periodLabel}.`, href: `#/products/${pr.product_id}` });
    }
  }
  if (c.deliveryCost > c.deliveryFees && c.deliveryCost > 0) out.push({ tone: "negative", text: `Delivery costs (${fmt(c.deliveryCost)}) exceeded delivery fees collected (${fmt(c.deliveryFees)}) this ${args.periodLabel}.`, href: "#/deliveries" });
  if (args.unpaidCount > 0) out.push({ tone: "warning", text: `${args.unpaidCount} order${args.unpaidCount === 1 ? " remains" : "s remain"} unpaid (${fmt(c.outstandingBalance)} outstanding).`, href: "#/orders?payment=unpaid" });
  if (args.pendingWhatsapp > 0) out.push({ tone: "warning", text: `${args.pendingWhatsapp} pending WhatsApp order${args.pendingWhatsapp === 1 ? " has" : "s have"} not been confirmed.`, href: "#/orders?status=pending_whatsapp_confirmation" });
  if (args.ingredientCostChange != null && args.ingredientCostChange > 0.05) out.push({ tone: "warning", text: `Ingredient costs increased ${pct(args.ingredientCostChange, 0)} this ${args.periodLabel}.`, href: "#/expenses" });
  if (args.taxDueDate) {
    const days = differenceInCalendarDays(new Date(args.taxDueDate), new Date());
    if (days >= 0 && days <= 21) out.push({ tone: days <= 7 ? "negative" : "warning", text: `Estimated sales-tax return is due in ${days} day${days === 1 ? "" : "s"} (${args.taxDueDate}).`, href: "#/tax" });
    else if (days < 0) out.push({ tone: "negative", text: `The sales-tax due date (${args.taxDueDate}) has passed — update it in Tax settings after filing.`, href: "#/tax" });
  }
  if (c.grossMargin != null && c.grossMargin < args.lowMarginPct && c.netSales > 0) out.push({ tone: "warning", text: `Overall gross margin is ${pct(c.grossMargin)}, below your ${pct(args.lowMarginPct, 0)} warning level.` });
  return out;
}
