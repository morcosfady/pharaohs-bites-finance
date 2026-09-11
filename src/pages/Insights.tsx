import { useMemo } from "react";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { PageHeader, Skeleton, ErrorBox } from "../components/ui";
import { useOrderFinancials, useExpenses, usePayments, useRefunds, useSettings, useProductSales, useTaxSettings } from "../hooks/queries";
import { previousRange } from "../lib/dates";
import { computeKpis, rankProducts, REVENUE_STATUSES } from "../lib/metrics";
import { buildInsights } from "../lib/insights";
import { toCents, sum, change } from "../lib/money";

export function InsightsPage() {
  const [range, setRange] = useDateRange("this_month");
  const prev = useMemo(() => previousRange(range), [range]);
  const settings = useSettings(); const tax = useTaxSettings();
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const cur = { orders: useOrderFinancials(range), expenses: useExpenses(range), payments: usePayments(range), refunds: useRefunds(range), sales: useProductSales(range) };
  const pre = { orders: useOrderFinancials(prev), expenses: useExpenses(prev), payments: usePayments(prev), refunds: useRefunds(prev), sales: useProductSales(prev) };
  const loading = [...Object.values(cur), ...Object.values(pre)].some((q) => q.isLoading);
  const error = Object.values(cur).find((q) => q.error)?.error;
  const insights = useMemo(() => {
    if (loading || !cur.orders.data || !pre.orders.data) return [];
    const k = computeKpis({ orders: cur.orders.data, expenses: cur.expenses.data ?? [], payments: cur.payments.data ?? [], refunds: cur.refunds.data ?? [], includeLabor });
    const p = computeKpis({ orders: pre.orders.data, expenses: pre.expenses.data ?? [], payments: pre.payments.data ?? [], refunds: pre.refunds.data ?? [], includeLabor });
    const ing = (e: typeof cur.expenses.data) => sum((e ?? []).filter((x) => (x.expense_categories?.name ?? "").toLowerCase() === "ingredients").map((x) => toCents(x.total_amount)));
    return buildInsights({
      current: k, previous: p, products: rankProducts(cur.sales.data ?? [], includeLabor), prevProducts: rankProducts(pre.sales.data ?? [], includeLabor),
      pendingWhatsapp: cur.orders.data.filter((o) => o.status === "pending_whatsapp_confirmation").length,
      unpaidCount: cur.orders.data.filter((o) => REVENUE_STATUSES.includes(o.status) && toCents(o.balance_due) > 0).length,
      lowMarginPct: Number(settings.data?.low_margin_warning_pct ?? 0.3), taxDueDate: tax.data?.next_due_date ?? null,
      periodLabel: range.key.replace("this_", "").replace("last_", "").replace("_", " "), ingredientCostChange: change(ing(cur.expenses.data), ing(pre.expenses.data)),
    });
  }, [loading, cur.orders.data, cur.expenses.data, cur.payments.data, cur.refunds.data, cur.sales.data, pre.orders.data, pre.expenses.data, pre.payments.data, pre.refunds.data, pre.sales.data, includeLabor, settings.data, tax.data, range.key]);

  const tone = { positive: "border-positive bg-emerald-50", negative: "border-negative bg-red-50", warning: "border-warning bg-amber-50", info: "border-teal-600 bg-teal-50" };
  return (
    <div>
      <PageHeader title="Insights" crumbs={["Home", "Insights"]} />
      <DateRangeBar range={range} onChange={setRange} />
      <p className="mb-4 text-sm text-charcoal/60">Every statement below is computed from your actual orders, payments and expenses for the selected period versus the previous one. Nothing is estimated or guessed.</p>
      {error && <ErrorBox error={error} />}
      {loading ? <Skeleton rows={6} className="card p-5" /> : insights.length === 0 ? <div className="card p-8 text-center text-sm text-charcoal/60">Nothing notable for this period yet.</div> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {insights.map((i, n) => <li key={n} className={`rounded-xl border-l-4 px-4 py-3 text-sm shadow-sm ${tone[i.tone]}`}>{i.href ? <a href={i.href} className="hover:underline">{i.text}</a> : i.text}</li>)}
        </ul>
      )}
    </div>
  );
}
