import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as RTooltip, BarChart, Bar, PieChart, Pie, Cell, CartesianGrid, LabelList } from "recharts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { KpiCard, Section, Skeleton, ErrorBox, Badge, EditButton, Tip } from "../components/ui";
import { groupFor, GROUPS } from "../components/menuViz";
import { useOrderFinancials, useExpenses, usePayments, useRefunds, useSettings, useProductSales, useTaxAdjustments, useTaxSettings, useCategories } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { previousRange, bucketKey, bucketLabel } from "../lib/dates";
import { computeKpis, KPI_FORMULAS, rankProducts, REVENUE_STATUSES, OPEN_STATUSES } from "../lib/metrics";
import { fromCents, toCents, fmt, sum, pct, change, ratio } from "../lib/money";
import { buildInsights } from "../lib/insights";
import { ORDER_STATUSES, cls, label } from "../lib/status";
import { fmtDateTime } from "../lib/dates";
import { useAdvanced } from "../hooks/useMode";
import type { OrderStatus } from "../lib/types";

/* Categorical palette for donuts (distinct hues, readable on ivory). */
const PALETTE = ["#0F4C4C", "#D4A72C", "#D85A30", "#1D9E75", "#534AB7", "#D4537E", "#378ADD", "#8c6239"];

const STATUS_EMOJI: Record<OrderStatus, string> = {
  pending_whatsapp_confirmation: "💬", contacted: "📞", delivery_fee_pending: "🚚", awaiting_customer_approval: "⏳",
  confirmed: "✅", preparing: "👩‍🍳", ready: "📦", out_for_delivery: "🛵", completed: "🎉", cancelled: "❌", refunded: "↩️",
};
const GROUP_EMOJI = Object.fromEntries(GROUPS.map((g) => [g.key, g.emoji])) as Record<string, string>;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function DashboardPage() {
  const [range, setRange] = useDateRange("this_month");
  const prev = useMemo(() => previousRange(range), [range]);
  const settings = useSettings();
  const taxS = useTaxSettings();
  const cats = useCategories();
  const advanced = useAdvanced();
  const { adminName } = useAuth();
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
  const catName = (id: string | null) => cats.data?.find((c) => c.id === id)?.name;
  const byGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of products) { const g = groupFor(catName(r.category_id)); m.set(g, (m.get(g) ?? 0) + fromCents(r.net)); }
    return GROUPS.map((g) => ({ name: `${g.emoji} ${g.label}`, value: m.get(g.key) ?? 0 })).filter((x) => x.value > 0);
  }, [products, cats.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const ALWAYS: OrderStatus[] = ["pending_whatsapp_confirmation", "confirmed", "completed"];
  const byStatus = useMemo(() => ORDER_STATUSES
    .map((s) => ({ status: s.value, label: s.label, cls: s.cls, count: (cur.orders.data ?? []).filter((o) => o.status === s.value && !o.deleted_at).length }))
    .filter((s) => s.count > 0 || ALWAYS.includes(s.status)), [cur.orders.data]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const otherExpenses = k ? k.operatingExpenses + k.processingFees + k.deliveryCost : 0;
  const totalIn = k ? k.netSales + k.deliveryFees : 0;
  const pendingCount = (cur.orders.data ?? []).filter((o) => OPEN_STATUSES.includes(o.status)).length;

  // "where the money went" — one stacked bar from money in to money kept
  const flow = k ? [
    { key: "cogs", label: "Food & packaging", emoji: "🥘", value: k.cogs + k.laborCost, color: "#D4A72C" },
    { key: "other", label: "Other expenses", emoji: "🧾", value: otherExpenses, color: "#D85A30" },
    { key: "profit", label: "Profit kept", emoji: "💰", value: Math.max(0, k.netProfit), color: "#16855B" },
  ] : [];
  const flowTotal = flow.reduce((s, f) => s + f.value, 0);

  return (
    <div>
      {/* ---- hero ---- */}
      <div className="mb-4 overflow-hidden rounded-2xl text-ivory shadow-lg" style={{ backgroundImage: "linear-gradient(120deg,#0F4C4C 0%,#083838 60%,#0b2f2f 100%)" }}>
        <div className="flex flex-wrap items-end justify-between gap-4 px-5 py-5 md:px-7">
          <div>
            <p className="text-sm text-ivory/70">{greeting()}{adminName ? `, ${adminName.split(" ")[0]}` : ""} 👋</p>
            <h1 className="font-display text-3xl font-semibold leading-tight md:text-4xl">{advanced ? "Dashboard" : "Home"}</h1>
            <p className="mt-1 text-xs uppercase tracking-[.18em] text-gold-soft">Pharaoh's Bites · Dallas</p>
          </div>
          {k && (
            <div className="flex flex-wrap gap-6">
              <HeroNum emoji="💵" label="Sales" value={fmt(k.netSales)} prev={p?.netSales} cur={k.netSales} />
              <HeroNum emoji="💰" label="Profit" value={fmt(k.netProfit)} prev={p?.netProfit} cur={k.netProfit} tone={k.netProfit > 0 ? "good" : k.netProfit < 0 ? "bad" : "flat"} />
              <HeroNum emoji="🧾" label="Orders" value={String(k.completedOrders)} prev={p?.completedOrders} cur={k.completedOrders} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-white/10 bg-black/10 px-5 py-2.5 md:px-7">
          <Quick to="/orders" emoji="🧾" label="Review orders" badge={pendingCount || undefined} />
          <Quick to="/expenses" emoji="➕" label="Add expense" />
          <Quick to="/menu" emoji="🍽️" label="Menu & Profit" />
          <Quick to="/sales" emoji="📊" label="Sales by Dish" />
        </div>
      </div>

      <DateRangeBar range={range} onChange={setRange} />
      {error && <ErrorBox error={error} />}
      {loading || !k ? <Skeleton rows={6} className="card p-5" /> : (
        <>
          {/* ---- tiles ---- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile emoji="💵" label="Sales" value={fmt(k.netSales)} prev={p?.netSales} cur={k.netSales} accent="#0F4C4C" formula={KPI_FORMULAS.netSales} spark={series.map((s) => s.revenue)} />
            <Tile emoji="💰" label="Profit" value={fmt(k.netProfit)} prev={p?.netProfit} cur={k.netProfit} accent={k.netProfit < 0 ? "#C64040" : "#16855B"} formula={KPI_FORMULAS.netProfit} spark={series.map((s) => s.profit)} />
            <Tile emoji="🎉" label="Orders completed" value={String(k.completedOrders)} prev={p?.completedOrders} cur={k.completedOrders} accent="#D4A72C" spark={series.map((s) => s.orders)} />
            <Tile emoji="💳" label="Money still owed" value={fmt(k.outstandingBalance)} prev={p?.outstandingBalance} cur={k.outstandingBalance} accent="#D85A30" invert formula={KPI_FORMULAS.outstandingBalance} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Tile emoji="🏛️" label="Sales tax to set aside" value={fmt(k.taxCollected)} accent="#534AB7" formula={KPI_FORMULAS.taxCollected} compact />
            <Tile emoji="🥘" label="Food & packaging" value={fmt(k.cogs)} accent="#D4A72C" formula={KPI_FORMULAS.cogs} compact />
            <Tile emoji="🧾" label="Other expenses" value={fmt(otherExpenses)} accent="#D85A30" formula="Operating expenses + payment fees + delivery costs in this period." compact />
          </div>

          {advanced && <details className="group mt-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-teal-900/70 hover:text-teal-900">All metrics <span className="text-xs">(click to expand)</span></summary>
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              <KpiCard label="Pending orders" value={k.pendingOrders} prev={p?.pendingOrders} kind="int" invert />
              <KpiCard label="Avg order value" value={k.avgOrderValue} prev={p?.avgOrderValue} formula={KPI_FORMULAS.avgOrderValue} />
              <KpiCard label="Gross sales" value={k.grossSales} prev={p?.grossSales} formula={KPI_FORMULAS.grossSales} />
              <KpiCard label="Discounts" value={k.discounts} prev={p?.discounts} invert formula={KPI_FORMULAS.discounts} />
              <KpiCard label="Refunds" value={k.refunds} prev={p?.refunds} invert formula={KPI_FORMULAS.refunds} />
              <KpiCard label="Cancelled orders" value={k.cancelledOrders} prev={p?.cancelledOrders} kind="int" invert />
              <KpiCard label="Delivery fees collected" value={k.deliveryFees} prev={p?.deliveryFees} formula={KPI_FORMULAS.deliveryFees} />
              <KpiCard label="Customer payments" value={k.cashCollected} prev={p?.cashCollected} formula={KPI_FORMULAS.cashCollected} />
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

          {/* ---- money flow + order pipeline ---- */}
          <div className="mt-4 grid gap-4 lg:grid-cols-5">
            <Section title="💸 Where the money went" className="lg:col-span-3" right={<span className="text-xs text-charcoal/50">Money in: <b className="text-charcoal">{fmt(totalIn)}</b></span>}>
              {flowTotal === 0 ? <Empty emoji="🌱" title="Nothing moved yet" hint="Once orders and expenses land, this bar shows how every dollar was split between food, other costs and profit." /> : (
                <>
                  <div className="flex h-7 w-full overflow-hidden rounded-full bg-ivory-200">
                    {flow.filter((f) => f.value > 0).map((f) => <div key={f.key} title={`${f.label}: ${fmt(f.value)}`} style={{ width: `${(f.value / flowTotal) * 100}%`, background: f.color }} className="transition-all" />)}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {flow.map((f) => (
                      <div key={f.key} className="rounded-lg px-3 py-2" style={{ background: f.color + "14" }}>
                        <div className="text-[11px] uppercase tracking-wider text-charcoal/55">{f.emoji} {f.label}</div>
                        <div className="font-display text-xl font-semibold" style={{ color: f.color }}>{fmt(f.value)}</div>
                        <div className="text-xs text-charcoal/50">{flowTotal ? pct(f.value / flowTotal, 0) : "—"} of money in</div>
                      </div>
                    ))}
                  </div>
                  {k.netProfit < 0 && <p className="mt-2 text-xs text-negative">Costs were {fmt(-k.netProfit)} more than sales this period, so nothing was kept.</p>}
                </>
              )}
            </Section>
            <Section title="🚦 Orders right now" className="lg:col-span-2" right={<Link to="/orders" className="text-xs text-teal-700 hover:underline">Open orders</Link>}>
              <ul className="space-y-1.5">
                {byStatus.slice(0, 8).map((s) => (
                  <li key={s.status}>
                    <Link to={`/orders?status=${s.status}`} className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${s.cls} ${s.count === 0 ? "opacity-50" : ""}`}>
                      <span>{STATUS_EMOJI[s.status]} {s.label}</span>
                      <b className="tabular-nums">{s.count}</b>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-charcoal/50">{pendingCount === 0 ? "Nothing waiting on you. 🎉" : `${pendingCount} order${pendingCount === 1 ? "" : "s"} still in progress.`}</p>
            </Section>
          </div>

          {/* ---- trend + insights ---- */}
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Section title="📈 Revenue & profit over time" className="lg:col-span-2">
              {series.length === 0 ? <Empty emoji="📈" title="No revenue orders in this period" hint="Confirmed and completed orders draw the line here." /> : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0F4C4C" stopOpacity=".35" /><stop offset="100%" stopColor="#0F4C4C" stopOpacity="0" /></linearGradient>
                      <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#D4A72C" stopOpacity=".45" /><stop offset="100%" stopColor="#D4A72C" stopOpacity="0" /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5ddc7" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v) => "$" + v} />
                    <RTooltip formatter={(v: unknown, n: unknown) => [n === "orders" ? Number(v) : fmt(Math.round(Number(v) * 100)), String(n)]} />
                    <Area type="monotone" dataKey="revenue" stroke="#0F4C4C" fill="url(#g1)" strokeWidth={2.5} name="revenue" dot={{ r: 3, fill: "#0F4C4C" }} />
                    <Area type="monotone" dataKey="profit" stroke="#D4A72C" fill="url(#g2)" strokeWidth={2.5} name="profit" dot={{ r: 3, fill: "#D4A72C" }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              <div className="mt-1 flex gap-4 text-xs text-charcoal/60"><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-teal-800" /> Revenue</span><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-gold" /> Profit</span></div>
            </Section>
            <Section title="💡 What to know" right={advanced ? <Link to="/insights" className="text-xs text-teal-700 hover:underline">All insights</Link> : undefined}>
              {insights.length === 0 ? <Empty emoji="😌" title="All quiet" hint="Nothing to flag for this period." small /> : (
                <ul className="space-y-2 text-sm">
                  {insights.map((i, n) => (
                    <li key={n} className={`rounded-lg border-l-4 bg-ivory-50 px-3 py-2 ${i.tone === "positive" ? "border-positive" : i.tone === "negative" ? "border-negative" : i.tone === "warning" ? "border-warning" : "border-teal-600"}`}>
                      <span className="mr-1">{i.tone === "positive" ? "🟢" : i.tone === "negative" ? "🔴" : i.tone === "warning" ? "🟡" : "🔵"}</span>
                      {i.href ? <a href={i.href} className="hover:underline">{i.text}</a> : i.text}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          {/* ---- breakdowns ---- */}
          <div className={`mt-4 grid gap-4 md:grid-cols-2 ${advanced ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
            <Section title="🏆 Top dishes" right={<Link to="/sales" className="text-xs text-teal-700 hover:underline">All dishes</Link>}>
              {products.length === 0 ? <Empty emoji="🥧" title="No sales yet" hint="Your best sellers show up here." small /> : (
                <ResponsiveContainer width="100%" height={Math.max(160, Math.min(products.length, 6) * 36 + 20)}>
                  <BarChart data={products.slice(0, 6).map((x) => ({ name: `${GROUP_EMOJI[groupFor(catName(x.category_id))]} ${x.name.split(" ").slice(0, 2).join(" ")}`, value: fromCents(x.net) }))} layout="vertical" margin={{ left: 4, right: 48 }} barCategoryGap={8}>
                    <XAxis type="number" hide /><YAxis type="category" dataKey="name" width={118} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <RTooltip formatter={(v: unknown) => fmt(Math.round(Number(v) * 100))} cursor={{ fill: "rgba(15,76,76,.06)" }} />
                    <Bar dataKey="value" radius={6}>
                      {products.slice(0, 6).map((_, i) => <Cell key={i} fill={i === 0 ? "#D4A72C" : "#0F4C4C"} />)}
                      <LabelList dataKey="value" position="right" formatter={(v: unknown) => fmt(Math.round(Number(v) * 100))} style={{ fontSize: 11, fill: "#083838" }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Section>
            <Section title="🍽️ Sales by group">
              {byGroup.length === 0 ? <Empty emoji="🍰" title="No sales yet" hint="Savory vs sweet vs drinks appears here." small /> : <Donut data={byGroup} money />}
            </Section>
            {advanced && <Section title="💳 Payments by method">
              {byMethod.length === 0 ? <Empty emoji="💳" title="No payments" hint="Zelle, cash and card split." small /> : <Donut data={byMethod} money />}
            </Section>}
            <Section title="🧾 Expenses by category" right={<Link to="/expenses" className="text-xs text-teal-700 hover:underline">Expenses</Link>}>
              {expByCat.length === 0 ? <Empty emoji="🧾" title="No expenses" hint="Nothing spent in this period." small /> : <Donut data={expByCat} money />}
            </Section>
          </div>

          <Section title="🕒 Latest orders" className="mt-4" right={<Link to="/orders" className="text-xs text-teal-700 hover:underline">View all</Link>}>
            {recent.length === 0 ? <Empty emoji="📭" title="No orders in this period" hint="New website orders appear here the moment they arrive." small /> : (
              <ul className="divide-y divide-ivory-200">
                {recent.map((o) => (
                  <li key={o.id}><Link to={`/orders/${o.id}`} className="flex flex-wrap items-center gap-2 py-2 text-sm hover:bg-ivory-50">
                    <span>{STATUS_EMOJI[o.status]}</span>
                    <span className="font-mono text-xs text-teal-800">{o.order_number}</span>
                    <span className="font-medium">{o.customer_name}</span>
                    <Badge className={cls(ORDER_STATUSES, o.status)}>{label(ORDER_STATUSES, o.status)}</Badge>
                    <span className="ml-auto tabular-nums">{fmt(toCents(o.total))}</span>
                    <span className="w-full text-xs text-charcoal/50 sm:w-auto">{fmtDateTime(o.created_at)}</span>
                    <EditButton small label={`Edit ${o.order_number}`} onClick={() => { window.location.hash = `#/orders/${o.id}`; }} />
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

/* ---------- pieces ---------- */

function Delta({ cur, prev, invert }: { cur: number; prev?: number | null; invert?: boolean }) {
  if (prev == null || (prev === 0 && cur === 0)) return null;
  const ch = change(cur, prev);
  if (ch == null) return <span className="text-xs text-charcoal/50">first time 🎉</span>;
  const good = invert ? ch <= 0 : ch >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${ch === 0 ? "text-charcoal/50" : good ? "text-positive" : "text-negative"}`}>
      {ch === 0 ? <Minus size={12} /> : ch > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {ch === 0 ? "same as before" : `${pct(Math.abs(ch), 0)} vs prev`}
    </span>
  );
}

function HeroNum({ emoji, label, value, cur, prev, tone = "flat" }: { emoji: string; label: string; value: string; cur: number; prev?: number | null; tone?: "good" | "bad" | "flat" }) {
  return (
    <div className="min-w-[110px]">
      <div className="text-xs uppercase tracking-wider text-ivory/60">{emoji} {label}</div>
      <div className={`font-display text-3xl font-semibold leading-none ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-gold-soft"}`}>{value}</div>
      <div className="mt-1 [&_span]:!text-ivory/70"><Delta cur={cur} prev={prev} /></div>
    </div>
  );
}

function Quick({ to, emoji, label, badge }: { to: string; emoji: string; label: string; badge?: number }) {
  return (
    <Link to={to} className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-ivory transition hover:bg-gold hover:text-teal-900">
      <span>{emoji}</span>{label}
      {badge ? <span className="rounded-full bg-gold px-1.5 text-[10px] font-semibold text-teal-900">{badge}</span> : null}
    </Link>
  );
}

function Tile({ emoji, label, value, cur, prev, accent, invert, formula, spark, compact }: { emoji: string; label: string; value: string; cur?: number; prev?: number | null; accent: string; invert?: boolean; formula?: string; spark?: number[]; compact?: boolean }) {
  return (
    <div className="card relative overflow-hidden px-4 py-3" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium uppercase tracking-wider text-teal-900/70">{emoji} {label}</span>
        {formula && <Tip text={formula} />}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className={`font-display font-semibold leading-none ${compact ? "text-2xl" : "text-3xl"}`} style={{ color: accent }}>{value}</span>
        {spark && spark.length > 1 && <Spark data={spark} color={accent} />}
      </div>
      {cur != null && <div className="mt-1.5 min-h-4"><Delta cur={cur} prev={prev} invert={invert} /></div>}
    </div>
  );
}

function Spark({ data, color }: { data: number[]; color: string }) {
  const w = 72, h = 26;
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 4) - 2}`).join(" ");
  return <svg width={w} height={h} className="shrink-0" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

function Empty({ emoji, title, hint, small }: { emoji: string; title: string; hint?: string; small?: boolean }) {
  return (
    <div className={`flex flex-col items-center gap-1 text-center ${small ? "px-2 py-6" : "px-6 py-10"}`}>
      <span className={small ? "text-3xl" : "text-4xl"} aria-hidden="true">{emoji}</span>
      <p className="font-display text-lg font-semibold text-teal-900">{title}</p>
      {hint && <p className="max-w-sm text-xs text-charcoal/55">{hint}</p>}
    </div>
  );
}

function Donut({ data, money }: { data: { name: string; value: number }[]; money?: boolean }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-[170px] w-[170px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={3} stroke="#fff" strokeWidth={2}>
              {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <RTooltip formatter={(v: unknown) => (money ? fmt(Math.round(Number(v) * 100)) : Number(v))} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="font-display text-lg font-semibold text-teal-900">{money ? fmt(Math.round(total * 100)) : total}</span><span className="text-[10px] uppercase tracking-wider text-charcoal/50">total</span></div>
      </div>
      <ul className="min-w-0 flex-1 space-y-1 text-xs">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2">
            <i className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="truncate text-charcoal/80">{d.name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-charcoal/60">{ratio(d.value, total) != null ? pct(d.value / total, 0) : "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

