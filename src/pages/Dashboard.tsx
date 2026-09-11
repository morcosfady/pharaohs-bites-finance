import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as RTooltip, BarChart, Bar, PieChart, Pie, Cell, Legend, CartesianGrid } from "recharts";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { KpiCard, Section, Skeleton, ErrorBox, EmptyState, Badge } from "../components/ui";
import { useOrderFinancials, useExpenses, usePayments, useRefunds, useSettings, useProductSales, useTaxAdjustments, useTaxSettings } from "../hooks/queries";
import { previousRange, bucketKey, bucketLabel } from "../lib/dates";
import { computeKpis, KPI_FORMULAS, rankProducts, REVENUE_STATUSES } from "../lib/metrics";
import { fromCents, toCents, fmt, sum } from "../lib/money";
import { buildInsights } from "../lib/insights";
import { ORDER_STATUSES, cls, label } from "../lib/status";
import { fmtDateTime } from "../lib/dates";
import { useAdvanced } from "../hooks/useMode";

const COLORS = ["#0F4C4C", "#D4A72C", "#146060", "#E7C76A", "#1c7575", "#8c6239", "#083838", "#b8912e"];

export function DashboardPage() {
  const [range, setRange] = useDateRange("this_month");
  const prev = useMemo(() => previousRange(range), [range]);
  const settings = useSettings();
  const taxS = useTaxSettings();
  const advanced = useAdvanced();
  const cur = { orders: useOrderFinancials(range), expenses: useExpenses(range), payments: usePayments(range), refunds: useRefunds(range), sales: useProductSales(range) };
  const pre = { orders: useOrderFinancials(prev), expenses: useExpenses(prev), payments: usePayments(prev), refunds: useRefunds(prev), sales: useProductSales(prev) };
  const adj = useTaxAdjustments();
  const includeLabor = settings.data?.include_owner_labor ?? false;

  const loading = [cur.orders, cur.expenses, cur.payments, cur.refunds, pre.orders, pre.expenses, pre.payments, pre.refunds].some((q) => q.isLoading);
  const error = [cur.orders, cur.expenses, cur.payments, cur.refunds].find((q) => q.error)?.error;

  const k = useMemo(() => cur.orders.data && cur.expenses.data && cur.payments.data && cur.refunds.data
    ? computeKpis({ orders: cur.orders.data, expenses: cur.expenses.data, payments: cur.payments.data, refunds: cur.refunds.data, includeLabor, taxAdjustments: sum((adj.data ?? []).map((a) => toCents(a.amount))) })
    : null, [cur.orders.data, cur.expenses.data, cur.payments.data, cur.refunds.data, includeLabor, adj.data]);
  const p = useMemo(() => pre.orders.data && pre.expenses.data && pre.payments.data && pre.refunds.data
    ? computeKpis({ orders: pre.orders.data, expenses: pre.expenses.data, payments: pre.payments.data, refunds: pre.refunds.data, includeLabor })
    : null, [pre.orders.data, pre.expenses.data, pre.payments.data, pre.refunds.data, includeLabor]);

  // time series
  const series = useMemo(() => {
    const m = new Map<string, { revenue: number; profit: number; orders: number }>();
    for (const o of cur.orders.data ?? []) {
      if (!REVENUE_STATUSES.includes(o.status)) continue;
      const key = bucketKey(o.created_at, range);
      const e = m.get(key) ?? { revenue: 0, profit: 0, orders: 0 };
      e.revenue += fromCents(toCents(o.net_product_sales) + toCents(o.delivery_revenue));
      e.profit += fromCents(toCents(o.contribution_profit));
      e.orders += 1;
      m.set(key, e);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ name: bucketLabel(key), ...v }));
  }, [cur.orders.data, range]);

  const products = useMemo(() => rankProducts(cur.sales.data ?? [], includeLabor), [cur.sales.data, includeLabor]);
  const prevProducts = useMemo(() => rankProducts(pre.sales.data ?? [], includeLabor), [pre.sales.data, includeLabor]);
  const byStatus = useMemo(() => ORDER_STATUSES.map((s) => ({ name: s.label, value: (cur.orders.data ?? []).filter((o) => o.status === s.value).length })).filter((x) => x.value > 0), [cur.orders.data]);
  const byMethod = useMemo(() => {
    const m = new Map<string, number>();
    for (const pm of cur.payments.data ?? []) if (!pm.voided_at) m.set(pm.method, (m.get(pm.method) ?? 0) + fromCents(toCents(pm.amount)));
    return [...m.entries()].map(([name, value]) => ({ name, value }));
  }, [cur.payments.data]);
  const expByCat = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of cur.expenses.data ?? []) m.set(e.expense_categories?.name ?? "Other", (m.get(e.expense_categories?.name ?? "Other") ?? 0) + fromCents(toCents(e.total_amount)));
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [cur.expenses.data]);

  const insights = useMemo(() => k && p ? buildInsights({
    current: k, previous: p, products, prevProducts,
    pendingWhatsapp: (cur.orders.data ?? []).filter((o) => o.status === "pending_whatsapp_confirmation").length,
    unpaidCount: (cur.orders.data ?? []).filter((o) => REVENUE_STATUSES.includes(o.status) && toCents(o.balance_due) > 0).length,
    lowMarginPct: Number(settings.data?.low_margin_warning_pct ?? 0.3), taxDueDate: taxS.data?.next_due_date ?? null,
    periodLabel: range.key.replace("this_", "").replace("last_", "").replace("_", " "),
  }).slice(0, 5) : [], [k, p, products, prevProducts, cur.orders.data, settings.data, taxS.data, range.key]);

  const recent = (cur.orders.data ?? []).slice(0, 6);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-teal-900 md:text-3xl">{advanced ? "Dashboard" : "Home"}</h1>
        <Link to="/orders" className="btn-gold btn-sm">Review orders</Link>
      </div>
      <DateRangeBar range={range} onChange={setRange} />
      {error && <ErrorBox error={error} />}
      {loading || !k ? <Skeleton rows={6} className="card p-5" /> : (
        <>
          {/* headline KPIs */}
          <div className={`grid grid-cols-2 gap-3 ${advanced ? "md:grid-cols-4 xl:grid-cols-6" : "md:grid-cols-4"}`}>
            <KpiCard label="Sales" value={k.netSales} prev={p?.netSales} formula={KPI_FORMULAS.netSales} spark={series.map((s) => s.revenue)} />
            <KpiCard label="Profit" value={k.netProfit} prev={p?.netProfit} formula={KPI_FORMULAS.netProfit} spark={series.map((s) => s.profit)} />
            <KpiCard label="Orders completed" value={k.completedOrders} prev={p?.completedOrders} kind="int" spark={series.map((s) => s.orders)} />
            <KpiCard label="Money still owed" value={k.outstandingBalance} prev={p?.outstandingBalance} invert formula={KPI_FORMULAS.outstandingBalance} />
            {advanced && <KpiCard label="Pending orders" value={k.pendingOrders} prev={p?.pendingOrders} kind="int" invert />}
            {advanced && <KpiCard label="Avg order value" value={k.avgOrderValue} prev={p?.avgOrderValue} formula={KPI_FORMULAS.avgOrderValue} />}
          </div>

          {advanced && <details className="group mt-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-teal-900/70 hover:text-teal-900">All metrics <span className="text-xs">(click to collapse)</span></summary>
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              <KpiCard label="Gross sales" value={k.grossSales} prev={p?.grossSales} formula={KPI_FORMULAS.grossSales} />
              <KpiCard label="Discounts" value={k.discounts} prev={p?.discounts} invert formula={KPI_FORMULAS.discounts} />
              <KpiCard label="Refunds" value={k.refunds} prev={p?.refunds} invert formula={KPI_FORMULAS.refunds} />
              <KpiCard label="Cancelled orders" value={k.cancelledOrders} prev={p?.cancelledOrders} kind="int" invert />
              <KpiCard label="Delivery fees collected" value={k.deliveryFees} prev={p?.deliveryFees} formula={KPI_FORMULAS.deliveryFees} />
              <KpiCard label="Sales tax collected" value={k.taxCollected} prev={p?.taxCollected} formula={KPI_FORMULAS.taxCollected} />
              <KpiCard label="Customer payments" value={k.cashCollected} prev={p?.cashCollected} formula={KPI_FORMULAS.cashCollected} />
              <KpiCard label="COGS" value={k.cogs} prev={p?.cogs} invert formula={KPI_FORMULAS.cogs} />
              <KpiCard label="Packaging cost" value={k.packaging} prev={p?.packaging} invert formula={KPI_FORMULAS.packaging} />
              <KpiCard label="Delivery cost" value={k.deliveryCost} prev={p?.deliveryCost} invert formula={KPI_FORMULAS.deliveryCost} />
              <KpiCard label="Payment-processing fees" value={k.processingFees} prev={p?.processingFees} invert formula={KPI_FORMULAS.processingFees} />
              <KpiCard label="Other variable costs" value={k.otherVariable} prev={p?.otherVariable} invert formula={KPI_FORMULAS.otherVariable} />
              <KpiCard label="Operating expenses" value={k.operatingExpenses} prev={p?.operatingExpenses} invert formula={KPI_FORMULAS.operatingExpenses} />
              <KpiCard label="Gross profit" value={k.grossProfit} prev={p?.grossProfit} formula={KPI_FORMULAS.grossProfit} />
              <KpiCard label="Gross margin" value={k.grossMargin} prev={p?.grossMargin} kind="pct" formula={KPI_FORMULAS.grossMargin} />
              <KpiCard label="Net margin" value={k.netMargin} prev={p?.netMargin} kind="pct" formula={KPI_FORMULAS.netMargin} />
              <KpiCard label="Avg profit / order" value={k.avgProfitPerOrder} prev={p?.avgProfitPerOrder} formula={KPI_FORMULAS.avgProfitPerOrder} />
              <KpiCard label="Est. sales-tax liability" value={k.taxLiability} prev={p?.taxLiability} invert formula={KPI_FORMULAS.taxLiability} />
            </div>
          </details>}
          {!advanced && <div className="mt-3 grid grid-cols-3 gap-3">
            <KpiCard label="Sales tax to set aside" value={k.taxCollected} formula={KPI_FORMULAS.taxCollected} />
            <KpiCard label="Cost of food & packaging" value={k.cogs} formula={KPI_FORMULAS.cogs} invert />
            <KpiCard label="Other expenses" value={k.operatingExpenses + k.processingFees + k.deliveryCost} formula="Operating expenses + payment fees + delivery costs in this period." invert />
          </div>}

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Section title="Revenue & profit over time" className="lg:col-span-2">
              {series.length === 0 ? <EmptyState title="No revenue orders in this period" hint="Confirmed and completed orders appear here." /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                    <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0F4C4C" stopOpacity=".35" /><stop offset="100%" stopColor="#0F4C4C" stopOpacity="0" /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5ddc7" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v) => "$" + v} />
                    <RTooltip formatter={(v: unknown, n: unknown) => [n === "orders" ? Number(v) : fmt(Math.round(Number(v) * 100)), String(n)]} />
                    <Area type="monotone" dataKey="revenue" stroke="#0F4C4C" fill="url(#g1)" strokeWidth={2} name="revenue" />
                    <Area type="monotone" dataKey="profit" stroke="#D4A72C" fill="none" strokeWidth={2} name="profit" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </Section>
            <Section title="What to know" right={advanced ? <Link to="/insights" className="text-xs text-teal-700 hover:underline">All insights</Link> : undefined}>
              {insights.length === 0 ? <p className="text-sm text-charcoal/60">Nothing to flag for this period.</p> : (
                <ul className="space-y-2 text-sm">
                  {insights.map((i, n) => (
                    <li key={n} className={`rounded-lg border-l-4 bg-ivory-50 px-3 py-2 ${i.tone === "positive" ? "border-positive" : i.tone === "negative" ? "border-negative" : i.tone === "warning" ? "border-warning" : "border-teal-600"}`}>
                      {i.href ? <a href={i.href} className="hover:underline">{i.text}</a> : i.text}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <div className={`mt-4 grid gap-4 md:grid-cols-2 ${advanced ? "xl:grid-cols-4" : ""}`}>
            <Section title="Top products">
              {products.length === 0 ? <p className="text-sm text-charcoal/60">No sales yet.</p> : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={products.slice(0, 6).map((x) => ({ name: x.name.split(" ").slice(0, 2).join(" "), value: fromCents(x.net) }))} layout="vertical" margin={{ left: 8 }}>
                    <XAxis type="number" hide /><YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
                    <RTooltip formatter={(v: unknown) => fmt(Math.round(Number(v) * 100))} /><Bar dataKey="value" fill="#0F4C4C" radius={4} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Section>
            {advanced && <Section title="Orders by status">
              {byStatus.length === 0 ? <p className="text-sm text-charcoal/60">No orders.</p> : <Donut data={byStatus} />}
            </Section>}
            {advanced && <Section title="Payments by method">
              {byMethod.length === 0 ? <p className="text-sm text-charcoal/60">No payments in this period.</p> : <Donut data={byMethod} money />}
            </Section>}
            <Section title="Expenses by category">
              {expByCat.length === 0 ? <p className="text-sm text-charcoal/60">No expenses in this period.</p> : <Donut data={expByCat} money />}
            </Section>
          </div>

          <Section title="Latest orders" className="mt-4" right={<Link to="/orders" className="text-xs text-teal-700 hover:underline">View all</Link>}>
            {recent.length === 0 ? <p className="text-sm text-charcoal/60">No orders in this period.</p> : (
              <ul className="divide-y divide-ivory-200">
                {recent.map((o) => (
                  <li key={o.id}><Link to={`/orders/${o.id}`} className="flex flex-wrap items-center gap-2 py-2 text-sm hover:bg-ivory-50">
                    <span className="font-mono text-xs text-teal-800">{o.order_number}</span>
                    <span className="font-medium">{o.customer_name}</span>
                    <Badge className={cls(ORDER_STATUSES, o.status)}>{label(ORDER_STATUSES, o.status)}</Badge>
                    <span className="ml-auto tabular-nums">{fmt(toCents(o.total))}</span>
                    <span className="w-full text-xs text-charcoal/50 sm:w-auto">{fmtDateTime(o.created_at)}</span>
                  </Link></li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Donut({ data, money }: { data: { name: string; value: number }[]; money?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        <RTooltip formatter={(v: unknown) => (money ? fmt(Math.round(Number(v) * 100)) : Number(v))} />
      </PieChart>
    </ResponsiveContainer>
  );
}
