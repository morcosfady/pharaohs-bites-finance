import { useMemo, useState } from "react";
import { Printer, Download } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Legend, CartesianGrid, LineChart, Line } from "recharts";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { PageHeader, Section, Skeleton, ErrorBox } from "../components/ui";
import { useOrderFinancials, useExpenses, usePayments, useRefunds, useSettings, useProductSales, useCategories, useDeliveries, useTaxAdjustments } from "../hooks/queries";
import { previousRange, bucketKey, bucketLabel, toInputDate, inRange } from "../lib/dates";
import { computeKpis, rankProducts, REVENUE_STATUSES, type Kpis } from "../lib/metrics";
import { fmt, fromCents, toCents, pct, change, sum } from "../lib/money";
import { downloadText, toCsv } from "../lib/csv";
import { PAYMENT_METHODS, label } from "../lib/status";

const REPORTS = [
  ["sales", "Sales summary (daily / weekly / monthly / quarterly / annual)"], ["pnl", "Profit & loss"], ["products", "Product profitability & best sellers"],
  ["expenses", "Expenses"], ["payments", "Payments"], ["outstanding", "Outstanding balances"], ["delivery", "Delivery profitability"], ["tax", "Sales-tax estimate"], ["customers", "Customer sales"],
] as const;
type Key = typeof REPORTS[number][0];

export function ReportsPage() {
  const [range, setRange] = useDateRange("this_month");
  const prev = useMemo(() => previousRange(range), [range]);
  const [key, setKey] = useState<Key>("sales");
  const settings = useSettings();
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const cur = { orders: useOrderFinancials(range), expenses: useExpenses(range), payments: usePayments(range), refunds: useRefunds(range), sales: useProductSales(range) };
  const pre = { orders: useOrderFinancials(prev), expenses: useExpenses(prev), payments: usePayments(prev), refunds: useRefunds(prev) };
  const cats = useCategories(); const deliveries = useDeliveries(); const adj = useTaxAdjustments();
  const loading = Object.values(cur).some((q) => q.isLoading) || Object.values(pre).some((q) => q.isLoading);
  const error = Object.values(cur).find((q) => q.error)?.error;
  const k = useMemo(() => !loading && cur.orders.data ? computeKpis({ orders: cur.orders.data, expenses: cur.expenses.data ?? [], payments: cur.payments.data ?? [], refunds: cur.refunds.data ?? [], includeLabor, taxAdjustments: sum((adj.data ?? []).filter((a) => inRange(a.adjusted_on, range)).map((a) => toCents(a.amount))) }) : null, [loading, cur.orders.data, cur.expenses.data, cur.payments.data, cur.refunds.data, includeLabor, adj.data, range]);
  const p = useMemo(() => !loading && pre.orders.data ? computeKpis({ orders: pre.orders.data, expenses: pre.expenses.data ?? [], payments: pre.payments.data ?? [], refunds: pre.refunds.data ?? [], includeLabor }) : null, [loading, pre.orders.data, pre.expenses.data, pre.payments.data, pre.refunds.data, includeLabor]);
  const rev = (cur.orders.data ?? []).filter((o) => REVENUE_STATUSES.includes(o.status));

  const series = useMemo(() => {
    const m = new Map<string, { revenue: number; cost: number; profit: number; orders: number; aov: number; margin: number }>();
    for (const o of rev) {
      const kk = bucketKey(o.created_at, range); const e = m.get(kk) ?? { revenue: 0, cost: 0, profit: 0, orders: 0, aov: 0, margin: 0 };
      e.revenue += fromCents(toCents(o.net_product_sales) + toCents(o.delivery_revenue)); e.cost += fromCents(toCents(o.cogs) + toCents(o.delivery_cost)); e.profit += fromCents(toCents(o.contribution_profit)); e.orders++; m.set(kk, e);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kk, v]) => ({ name: bucketLabel(kk), ...v, aov: v.orders ? v.revenue / v.orders : 0, margin: v.revenue ? Math.round((v.profit / v.revenue) * 1000) / 10 : 0 }));
  }, [rev, range]);
  const ranks = useMemo(() => rankProducts(cur.sales.data ?? [], includeLabor), [cur.sales.data, includeLabor]);

  const exportCurrent = () => {
    const name = `${key}-report-${toInputDate(range.from)}-${toInputDate(range.to)}.csv`;
    if (key === "sales" || key === "pnl") { if (k && p) downloadText(name, toCsv(kpiRows(k, p))); return; }
    if (key === "products") { downloadText(name, toCsv(ranks.map((r, i) => ({ rank: i + 1, product: r.name, units: r.units, orders: r.orders, gross: fromCents(r.gross), discounts: fromCents(r.discounts), net: fromCents(r.net), cost: fromCents(r.cost), profit: fromCents(r.profit), margin: r.margin == null ? "" : (r.margin * 100).toFixed(1) + "%" })))); return; }
    if (key === "expenses") { downloadText(name, toCsv((cur.expenses.data ?? []).map((e) => ({ date: e.expense_date, vendor: e.vendor, category: e.expense_categories?.name, description: e.description, amount_before_tax: e.amount_before_tax, tax_paid: e.sales_tax_paid, total: e.total_amount, method: e.payment_method, type: e.cost_type })))); return; }
    if (key === "payments") { downloadText(name, toCsv((cur.payments.data ?? []).filter((x) => !x.voided_at).map((x) => ({ date: x.paid_at, order: x.orders?.order_number, customer: x.orders?.customer_name, amount: x.amount, method: x.method, reference: x.reference })))); return; }
    if (key === "outstanding") { downloadText(name, toCsv((cur.orders.data ?? []).filter((o) => o.status !== "cancelled" && toCents(o.balance_due) > 0).map((o) => ({ order: o.order_number, date: o.created_at, customer: o.customer_name, phone: o.customer_phone, total: o.total, paid: o.amount_paid, balance: o.balance_due })))); return; }
    if (key === "delivery") { downloadText(name, toCsv(deliveryRows().map((d) => ({ order: d.order, date: d.date, miles: d.miles, fee: fromCents(d.fee), cost: fromCents(d.cost), profit: fromCents(d.profit), provider: d.provider })))); return; }
    if (key === "tax") { if (k) downloadText(name, toCsv([{ period_start: toInputDate(range.from), period_end: toInputDate(range.to), total_sales: fromCents(k.netSales), taxable_sales: fromCents(k.taxableSales), nontaxable_sales: fromCents(k.nontaxableSales), tax_collected: fromCents(k.taxCollected), adjustments: fromCents(k.taxLiability - k.taxCollected), estimated_due: fromCents(k.taxLiability) }])); return; }
    if (key === "customers") { downloadText(name, toCsv(customerRows().map((c) => ({ customer: c.name, phone: c.phone, orders: c.orders, revenue: fromCents(c.revenue), profit: fromCents(c.profit) })))); }
  };
  const deliveryRows = () => (deliveries.data ?? []).filter((d) => d.orders && inRange(d.orders.created_at, range) && d.orders.status !== "cancelled").map((d) => { const fee = d.orders!.delivery_fee_customer_paid ? toCents(d.orders!.delivery_fee) : 0; return { id: d.id, order: d.orders!.order_number, date: d.orders!.created_at.slice(0, 10), miles: Number(d.distance_miles), fee, cost: toCents(d.actual_cost), profit: fee - toCents(d.actual_cost), provider: d.provider }; });
  const customerRows = () => { const m = new Map<string, { name: string; phone: string; orders: number; revenue: number; profit: number }>(); for (const o of rev) { const e = m.get(o.customer_id ?? o.customer_name) ?? { name: o.customer_name, phone: o.customer_phone, orders: 0, revenue: 0, profit: 0 }; e.orders++; e.revenue += toCents(o.net_product_sales) + toCents(o.delivery_revenue); e.profit += toCents(o.contribution_profit); m.set(o.customer_id ?? o.customer_name, e); } return [...m.values()].sort((a, b) => b.revenue - a.revenue); };

  return (
    <div>
      <PageHeader title="Reports" crumbs={["Home", "Reports"]} actions={<><button className="btn-ghost btn-sm no-print" onClick={exportCurrent}><Download size={16} /> CSV</button><button className="btn-ghost btn-sm no-print" onClick={() => window.print()}><Printer size={16} /> Print / PDF</button></>} />
      <div className="no-print"><DateRangeBar range={range} onChange={setRange} /></div>
      <div className="no-print mb-4 flex flex-wrap gap-1">{REPORTS.map(([kk, l]) => <button key={kk} onClick={() => setKey(kk)} className={`rounded-full px-3 py-1.5 text-xs font-medium ${key === kk ? "bg-teal-800 text-ivory" : "bg-white text-teal-900 ring-1 ring-ivory-200"}`}>{l.split(" (")[0]}</button>)}</div>
      <p className="mb-3 hidden print:block">Period: {range.from.toLocaleDateString()} – {range.to.toLocaleDateString()}</p>
      {error && <ErrorBox error={error} />}
      {loading || !k || !p ? <Skeleton rows={8} className="card p-5" /> : (
        <>
          {(key === "sales" || key === "pnl") && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title={key === "sales" ? "Sales summary" : "Profit & loss"}>
                <div className="table-wrap"><table className="table !min-w-0"><thead><tr><th>Line</th><th className="num">This period</th><th className="num">Previous</th><th className="num">Change</th></tr></thead>
                  <tbody>{kpiRows(k, p, key === "pnl").map((r) => <tr key={r.line} className={r.bold ? "font-semibold" : ""}><td>{r.line}</td><td className="num">{r.fmt(r.current)}</td><td className="num">{r.fmt(r.previous)}</td><td className="num">{r.change}</td></tr>)}</tbody></table></div>
              </Section>
              <Section title={key === "sales" ? "Revenue, orders & average order value" : "Revenue vs costs & margin trend"}>
                <ResponsiveContainer width="100%" height={280}>
                  {key === "sales" ? (
                    <LineChart data={series}><CartesianGrid strokeDasharray="3 3" stroke="#e5ddc7" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis yAxisId="l" tick={{ fontSize: 11 }} width={46} /><YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} width={30} /><RTooltip formatter={(v: unknown, n: unknown) => n === "orders" ? Number(v) : fmt(Math.round(Number(v) * 100))} /><Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line yAxisId="l" type="monotone" dataKey="revenue" stroke="#0F4C4C" strokeWidth={2} dot={false} /><Line yAxisId="l" type="monotone" dataKey="aov" stroke="#D4A72C" strokeWidth={2} dot={false} /><Line yAxisId="r" type="monotone" dataKey="orders" stroke="#8c6239" strokeDasharray="4 2" dot={false} /></LineChart>
                  ) : (
                    <BarChart data={series}><CartesianGrid strokeDasharray="3 3" stroke="#e5ddc7" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={46} /><RTooltip formatter={(v: unknown, n: unknown) => n === "margin" ? Number(v) + "%" : fmt(Math.round(Number(v) * 100))} /><Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="revenue" fill="#0F4C4C" radius={3} /><Bar dataKey="cost" fill="#C64040" radius={3} /><Bar dataKey="profit" fill="#D4A72C" radius={3} /></BarChart>
                  )}
                </ResponsiveContainer>
              </Section>
            </div>
          )}
          {key === "products" && <Section title="Product profitability"><div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>Product</th><th className="num">Units</th><th className="num">Net revenue</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">% of sales</th></tr></thead>
            <tbody>{ranks.map((r, i) => <tr key={r.product_id}><td>{i + 1}</td><td>{r.name} <span className="text-xs text-charcoal/50">{cats.data?.find((c) => c.id === r.category_id)?.name}</span></td><td className="num">{r.units}</td><td className="num">{fmt(r.net)}</td><td className="num">{fmt(r.cost)}</td><td className="num">{fmt(r.profit)}</td><td className="num">{pct(r.margin)}</td><td className="num">{pct(k.netSales ? r.net / k.netSales : null)}</td></tr>)}</tbody></table></div></Section>}
          {key === "expenses" && <Section title="Expenses"><div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Description</th><th className="num">Before tax</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
            <tbody>{(cur.expenses.data ?? []).map((e) => <tr key={e.id}><td>{e.expense_date}</td><td>{e.vendor}</td><td>{e.expense_categories?.name}</td><td>{e.description}</td><td className="num">{fmt(toCents(e.amount_before_tax))}</td><td className="num">{fmt(toCents(e.sales_tax_paid))}</td><td className="num">{fmt(toCents(e.total_amount))}</td></tr>)}<tr className="font-semibold"><td colSpan={6}>Total</td><td className="num">{fmt(sum((cur.expenses.data ?? []).map((e) => toCents(e.total_amount))))}</td></tr></tbody></table></div></Section>}
          {key === "payments" && <Section title="Payments received"><div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Order</th><th>Customer</th><th>Method</th><th className="num">Amount</th></tr></thead>
            <tbody>{(cur.payments.data ?? []).filter((x) => !x.voided_at).map((x) => <tr key={x.id}><td>{x.paid_at.slice(0, 10)}</td><td>{x.orders?.order_number}</td><td>{x.orders?.customer_name}</td><td>{label(PAYMENT_METHODS, x.method)}</td><td className="num">{fmt(toCents(x.amount))}</td></tr>)}<tr className="font-semibold"><td colSpan={4}>Total collected</td><td className="num">{fmt(k.cashCollected)}</td></tr></tbody></table></div></Section>}
          {key === "outstanding" && <Section title="Outstanding balances"><div className="table-wrap"><table className="table"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Phone</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th></tr></thead>
            <tbody>{(cur.orders.data ?? []).filter((o) => o.status !== "cancelled" && toCents(o.balance_due) > 0).map((o) => <tr key={o.id}><td>{o.order_number}</td><td>{o.created_at.slice(0, 10)}</td><td>{o.customer_name}</td><td>{o.customer_phone}</td><td className="num">{fmt(toCents(o.total))}</td><td className="num">{fmt(toCents(o.amount_paid))}</td><td className="num text-negative">{fmt(toCents(o.balance_due))}</td></tr>)}</tbody></table></div></Section>}
          {key === "delivery" && <Section title="Delivery profitability"><div className="table-wrap"><table className="table"><thead><tr><th>Order</th><th>Date</th><th className="num">Miles</th><th className="num">Fee</th><th className="num">Cost</th><th className="num">Profit</th><th>Provider</th></tr></thead>
            <tbody>{deliveryRows().map((d) => <tr key={d.id}><td>{d.order}</td><td>{d.date}</td><td className="num">{d.miles.toFixed(1)}</td><td className="num">{fmt(d.fee)}</td><td className="num">{fmt(d.cost)}</td><td className={`num ${d.profit < 0 ? "text-negative" : ""}`}>{fmt(d.profit)}</td><td>{d.provider}</td></tr>)}</tbody></table></div></Section>}
          {key === "tax" && (
            <Section title="Estimated sales-tax summary">
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Estimates only. Confirm rates, taxability and due dates with the Texas Comptroller or a tax professional.</p>
              <div className="table-wrap"><table className="table !min-w-0"><tbody>
                {[["Total net sales", k.netSales], ["Taxable sales (est.)", k.taxableSales], ["Nontaxable sales (est.)", k.nontaxableSales], ["Sales tax collected", k.taxCollected], ["Adjustments & refunded tax", k.taxLiability - k.taxCollected], ["Estimated amount due", k.taxLiability]].map(([l, v], i, a) => <tr key={String(l)} className={i === a.length - 1 ? "font-semibold" : ""}><td>{l}</td><td className="num">{fmt(v as number)}</td></tr>)}
              </tbody></table></div>
            </Section>
          )}
          {key === "customers" && <Section title="Customer sales"><div className="table-wrap"><table className="table"><thead><tr><th>Customer</th><th>Phone</th><th className="num">Orders</th><th className="num">Revenue</th><th className="num">Contribution profit</th></tr></thead>
            <tbody>{customerRows().map((c) => <tr key={c.name + c.phone}><td>{c.name}</td><td>{c.phone}</td><td className="num">{c.orders}</td><td className="num">{fmt(c.revenue)}</td><td className="num">{fmt(c.profit)}</td></tr>)}</tbody></table></div></Section>}
        </>
      )}
    </div>
  );
}

function kpiRows(k: Kpis, p: Kpis, pnl = false) {
  const m = (v: number) => fmt(v); const n = (v: number) => String(v); const pc = (v: number | null) => pct(v);
  const rows: { line: string; current: number; previous: number; fmt: (v: number) => string; bold?: boolean }[] = pnl ? [
    { line: "Gross product sales", current: k.grossSales, previous: p.grossSales, fmt: m }, { line: "− Discounts", current: k.discounts, previous: p.discounts, fmt: m }, { line: "− Refunds", current: k.refunds, previous: p.refunds, fmt: m },
    { line: "Net product sales", current: k.netSales, previous: p.netSales, fmt: m, bold: true }, { line: "+ Delivery fees retained", current: k.deliveryFees, previous: p.deliveryFees, fmt: m },
    { line: "− Cost of goods sold", current: k.cogs, previous: p.cogs, fmt: m }, { line: "− Owner labor (if enabled)", current: k.laborCost, previous: p.laborCost, fmt: m }, { line: "Gross profit", current: k.grossProfit, previous: p.grossProfit, fmt: m, bold: true },
    { line: "− Delivery cost", current: k.deliveryCost, previous: p.deliveryCost, fmt: m }, { line: "− Payment-processing fees", current: k.processingFees, previous: p.processingFees, fmt: m }, { line: "− Order-linked costs", current: k.otherVariable, previous: p.otherVariable, fmt: m },
    { line: "Contribution profit", current: k.contributionProfit, previous: p.contributionProfit, fmt: m, bold: true }, { line: "− Operating expenses", current: k.operatingExpenses, previous: p.operatingExpenses, fmt: m },
    { line: "Estimated net profit", current: k.netProfit, previous: p.netProfit, fmt: m, bold: true }, { line: "Net margin", current: k.netMargin ?? 0, previous: p.netMargin ?? 0, fmt: pc as (v: number) => string },
    { line: "Sales tax collected (not income)", current: k.taxCollected, previous: p.taxCollected, fmt: m },
  ] : [
    { line: "Revenue orders", current: k.revenueOrders, previous: p.revenueOrders, fmt: n }, { line: "Completed orders", current: k.completedOrders, previous: p.completedOrders, fmt: n }, { line: "Cancelled orders", current: k.cancelledOrders, previous: p.cancelledOrders, fmt: n },
    { line: "Gross sales", current: k.grossSales, previous: p.grossSales, fmt: m }, { line: "Discounts", current: k.discounts, previous: p.discounts, fmt: m }, { line: "Refunds", current: k.refunds, previous: p.refunds, fmt: m },
    { line: "Net sales", current: k.netSales, previous: p.netSales, fmt: m, bold: true }, { line: "Delivery fees", current: k.deliveryFees, previous: p.deliveryFees, fmt: m }, { line: "Sales tax collected", current: k.taxCollected, previous: p.taxCollected, fmt: m },
    { line: "Cash collected", current: k.cashCollected, previous: p.cashCollected, fmt: m }, { line: "Average order value", current: k.avgOrderValue ?? 0, previous: p.avgOrderValue ?? 0, fmt: m }, { line: "Gross margin", current: k.grossMargin ?? 0, previous: p.grossMargin ?? 0, fmt: pc as (v: number) => string },
  ];
  return rows.map((r) => { const c = change(r.current, r.previous); return { ...r, change: c == null ? "—" : (c > 0 ? "+" : "") + pct(c, 0) }; });
}
