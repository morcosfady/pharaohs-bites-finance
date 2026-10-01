import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { ArrowUpRight, ArrowDownRight, Store, Wheat } from "lucide-react";
import { Skeleton, EmptyState } from "./ui";
import { DateRangeBar } from "./DateRangeBar";
import { useCategoryRows, useIngredientItems } from "../hooks/queries";
import { trendData, topVendors } from "../lib/trends";
import { buildIngredientPrices } from "../lib/ingredients";
import { colorFor } from "../lib/categoryBreakdown";
import { fmt } from "../lib/money";
import { fmtDate, previousRange, type DateRange } from "../lib/dates";

/* Trends: spending month by month, who gets the money, and what ingredients cost over time. */

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

export function TrendsTab({ range, onRange }: { range: DateRange; onRange: (r: DateRange) => void }) {
  const span = useMemo<DateRange>(() => { const n = new Date(); return { key: "custom", from: new Date(n.getFullYear(), n.getMonth() - 11, 1), to: new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59) }; }, []);
  const all = useCategoryRows(span);
  const cur = useCategoryRows(range);
  const prev = useCategoryRows(useMemo(() => previousRange(range), [range]));

  const trend = useMemo(() => trendData(all.data ?? [], new Date(), 12, 5), [all.data]);
  const vendors = useMemo(() => topVendors(cur.data ?? [], prev.data ?? [], 8), [cur.data, prev.data]);
  const data = trend.months.map((m) => ({ label: m.label, total: m.totalCents, ...Object.fromEntries(trend.categories.map((c) => [c, (m.parts[c] ?? 0) / 100])) }));

  return (
    <div className="space-y-5">
      <section className="card">
        <div className="card-head"><div><h2 className="card-title">Spending by month</h2><p className="text-xs text-charcoal/50">The last 12 months. Each colour is a category.</p></div></div>
        <div className="px-3 pb-4 sm:px-5">
          {all.isLoading ? <Skeleton rows={4} /> : trend.maxCents === 0 ? <EmptyState title="No spending yet" hint="The chart fills in as expenses arrive." /> : (
            <>
              <div className="h-64 w-full" role="img" aria-label="Stacked bars of monthly spending by category">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} margin={{ top: 8, right: 4, left: -8, bottom: 0 }} barCategoryGap="22%">
                    <CartesianGrid vertical={false} stroke="#eadfc6" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#242424" }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis tick={{ fontSize: 11, fill: "#7a7466" }} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => `$${v >= 1000 ? `${Math.round(v / 100) / 10}k` : v}`} />
                    <Tooltip cursor={{ fill: "rgba(15,76,76,.06)" }} formatter={(v, n) => [fmt(Math.round(Number(v) * 100)), String(n)]} contentStyle={{ borderRadius: 10, border: "1px solid #eadfc6", fontSize: 12 }} />
                    {trend.categories.map((c, i) => <Bar key={c} dataKey={c} stackId="m" fill={colorFor(c, trend.categories)} radius={i === trend.categories.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-charcoal/65">
                {trend.categories.map((c) => <li key={c} className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: colorFor(c, trend.categories) }} />{c}</li>)}
              </ul>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><div><h2 className="card-title inline-flex items-center gap-2"><Store size={16} className="text-gold" /> Top vendors</h2><p className="text-xs text-charcoal/50">Who gets most of your money in the period you pick. A flag means they charge more per order than before.</p></div></div>
        <div className="px-5 pb-1"><DateRangeBar range={range} onChange={onRange} /></div>
        <div className="px-5 pb-5">
          {cur.isLoading ? <Skeleton rows={3} /> : vendors.length === 0 ? <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">No spending in this period.</p> : (
            <ul className="divide-y divide-ivory-200">
              {vendors.map((v, i) => (
                <li key={v.vendor} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <span className="w-5 shrink-0 text-center text-xs text-charcoal/40">{i + 1}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{v.vendor}</span><span className="block text-xs text-charcoal/50">{v.count} charge{v.count === 1 ? "" : "s"} · {fmt(v.avgCents)} each on average</span></span>
                    {v.avgChange != null && Math.abs(v.avgChange) >= 0.1 && <span className={`inline-flex items-center text-xs ${v.avgChange > 0 ? "text-negative" : "text-positive"}`} title="Average charge compared with the previous period">{v.avgChange > 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(Math.round(v.avgChange * 100))}%</span>}
                    <span className="w-24 shrink-0 text-right"><b className="block tabular-nums">{fmt(v.cents)}</b><span className="text-xs text-charcoal/50">{pct(v.share)}</span></span>
                  </div>
                  <div className="ml-8 mt-1.5 h-1.5 overflow-hidden rounded-full bg-ivory-100"><div className="h-full rounded-full bg-gold" style={{ width: `${Math.max(v.share / (vendors[0].share || 1) * 100, 2)}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <IngredientPrices />
    </div>
  );
}

function IngredientPrices() {
  const items = useIngredientItems();
  const list = useMemo(() => buildIngredientPrices((items.data ?? []).map((i) => ({
    description: i.description, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total, store: i.expenses?.vendor ?? "", date: i.expenses?.expense_date ?? "",
  })), new Date()), [items.data]);
  return (
    <section className="card">
      <div className="card-head"><div><h2 className="card-title inline-flex items-center gap-2"><Wheat size={16} className="text-gold" /> Ingredient prices</h2><p className="text-xs text-charcoal/50">What each ingredient costs per pound, gallon or item, which store is cheapest, and what went up. It only informs: it never changes a dish cost by itself.</p></div></div>
      <div className="px-5 pb-5">
        {items.isLoading ? <Skeleton rows={3} /> : list.length === 0
          ? <EmptyState title="No ingredient prices yet" hint="Prices appear once receipts are read: upload a receipt on the Receipts tab (it needs the Claude key to be added)." />
          : <ul className="divide-y divide-ivory-200">{list.slice(0, 20).map((p) => {
            const up = p.change != null && p.change >= 0.05, down = p.change != null && p.change <= -0.05;
            return (
              <li key={p.key} className="py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-charcoal/50">{p.latest.store} · {fmtDate(p.latest.date)} · {p.purchases} purchase{p.purchases === 1 ? "" : "s"}</div></div>
                  <div className="shrink-0 text-right"><b className="tabular-nums">{fmt(Math.round(p.latest.price * 100))}<span className="text-xs font-normal text-charcoal/50">{p.unit === "each" ? " each" : p.unit}</span></b>
                    {(up || down) && <div className={`inline-flex items-center text-xs ${up ? "text-negative" : "text-positive"}`}>{up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(Math.round((p.change ?? 0) * 100))}% vs last time</div>}</div>
                </div>
                {p.savingVsLatest != null && p.savingVsLatest >= 0.05 && p.cheapest && <div className="mt-1 rounded-lg bg-teal-50 px-3 py-1.5 text-xs text-teal-900">💡 Cheaper at <b>{p.cheapest.store}</b>: {fmt(Math.round(p.cheapest.price * 100))}{p.unit === "each" ? " each" : p.unit}, {Math.round(p.savingVsLatest * 100)}% less.</div>}
              </li>
            );
          })}</ul>}
      </div>
    </section>
  );
}
