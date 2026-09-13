import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Cell } from "recharts";
import { Trophy, ShoppingBag, Sparkles, Coins } from "lucide-react";
import { PageHeader, Skeleton, ErrorBox } from "../components/ui";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { GROUPS, groupFor, band, BAND, Stat, GroupHeader, Num, DishThumb, type GroupKey } from "../components/menuViz";
import { useProducts, useSettings, useProductSales } from "../hooks/queries";
import { REVENUE_STATUSES } from "../lib/metrics";
import { fmt, toCents, pct, ratio, fromCents } from "../lib/money";
import type { Product } from "../lib/types";

/* Sales by Dish: what actually sold in the period, per item, grouped the
   same way as Menu & Profit. Numbers come from the product_sales view, so
   they match the P&L (revenue-status orders only, discounts allocated,
   cost snapshot from the order line). */

type Row = Product & { group: GroupKey; units: number; refunded: number; orders: number; revenue: number; cost: number; profit: number; margin: number | null };

export function SalesPage() {
  const nav = useNavigate();
  const [range, setRange] = useDateRange("this_month");
  const products = useProducts(false);
  const sales = useProductSales(range);
  const settings = useSettings();
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const low = Number(settings.data?.low_margin_warning_pct ?? 0.3);

  const rows = useMemo<Row[]>(() => (products.data ?? []).map((p) => {
    const mine = (sales.data ?? []).filter((s) => s.product_id === p.id && REVENUE_STATUSES.includes(s.status));
    const units = mine.reduce((s, x) => s + x.quantity, 0);
    const refunded = mine.reduce((s, x) => s + x.refunded_qty, 0);
    const revenue = mine.reduce((s, x) => s + toCents(x.line_total) - toCents(x.line_discount), 0);
    const cost = mine.reduce((s, x) => s + toCents(x.line_cost) + (includeLabor ? toCents(x.line_labor_cost) : 0), 0);
    return { ...p, group: groupFor(p.product_categories?.name), units, refunded, orders: new Set(mine.map((x) => x.order_id)).size, revenue, cost, profit: revenue - cost, margin: ratio(revenue - cost, revenue) };
  }), [products.data, sales.data, includeLabor]);

  const tot = { units: rows.reduce((s, r) => s + r.units, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0), cost: rows.reduce((s, r) => s + r.cost, 0) };
  const profit = tot.revenue - tot.cost;
  const sold = rows.filter((r) => r.units > 0);
  const topSeller = [...sold].sort((a, b) => b.units - a.units)[0];
  const topEarner = [...sold].sort((a, b) => b.profit - a.profit)[0];
  const orders = new Set((sales.data ?? []).filter((s) => REVENUE_STATUSES.includes(s.status)).map((s) => s.order_id)).size;

  const groups = GROUPS.map((g) => {
    const items = rows.filter((r) => r.group === g.key).sort((a, b) => b.profit - a.profit || b.units - a.units || a.name.localeCompare(b.name));
    const revenue = items.reduce((s, r) => s + r.revenue, 0), cost = items.reduce((s, r) => s + r.cost, 0);
    return { ...g, items, revenue, cost, profit: revenue - cost, margin: ratio(revenue - cost, revenue), units: items.reduce((s, r) => s + r.units, 0) };
  }).filter((g) => g.items.length > 0);

  const chart = groups.filter((g) => g.revenue > 0).map((g) => ({ name: `${g.emoji} ${g.label}`, cost: fromCents(g.cost), profit: fromCents(g.profit), margin: g.margin }));
  const maxRevenue = Math.max(0, ...rows.map((r) => r.revenue));
  const loading = products.isLoading || sales.isLoading;

  if (products.error) return <ErrorBox error={products.error} />;
  if (sales.error) return <ErrorBox error={sales.error} />;

  return (
    <div>
      <PageHeader title="Sales by Dish" crumbs={["Home", "Sales by Dish"]} />
      <p className="mb-3 text-sm text-charcoal/60">What actually sold in the period, dish by dish: units, money in, what it cost you, and what you kept. Test orders never count.</p>
      <DateRangeBar range={range} onChange={setRange} />

      {loading ? <Skeleton rows={8} className="card p-5" /> : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Revenue" value={fmt(tot.revenue)} sub={`${tot.units} item${tot.units === 1 ? "" : "s"} across ${orders} order${orders === 1 ? "" : "s"}`} icon={<Coins size={14} />} />
            <Stat label="Profit" value={fmt(profit)} sub={tot.revenue > 0 ? `${pct(ratio(profit, tot.revenue), 0)} margin after ${fmt(tot.cost)} of ingredients` : "after ingredients & packaging"} tone={tot.revenue > 0 ? band(ratio(profit, tot.revenue), low) : "none"} formula="Revenue minus the ingredient, packaging and other direct cost snapshotted on each order line." />
            <Stat label="Top seller" value={topSeller ? `${topSeller.units}×` : "—"} sub={topSeller?.name ?? "no sales yet"} icon={<ShoppingBag size={14} />} />
            <Stat label="Top earner" value={topEarner ? fmt(topEarner.profit) : "—"} sub={topEarner?.name ?? "no sales yet"} tone={topEarner ? "good" : "none"} icon={<Trophy size={14} />} />
          </div>

          {tot.units === 0 && (
            <div className="card mb-6 flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="rounded-full bg-gold-100 p-3 text-gold"><Sparkles size={24} /></span>
              <p className="font-display text-xl font-semibold text-teal-900">Nothing sold in this period yet</p>
              <p className="max-w-md text-sm text-charcoal/60">Every dish below sits at zero until the first real order comes in. From then on this page fills itself in — orders from customers named "test" are ignored.</p>
            </div>
          )}

          {chart.length > 0 && (
            <div className="card mb-6 px-5 pb-4 pt-4">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h2 className="card-title">Revenue by group</h2>
                <div className="flex gap-4 text-xs text-charcoal/60">
                  <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-gold" /> Cost</span>
                  <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-teal-800" /> Profit</span>
                </div>
              </div>
              <p className="mb-2 text-xs text-charcoal/50">Bar length is revenue; the coloured part is what you kept.</p>
              <ResponsiveContainer width="100%" height={chart.length * 44 + 16}>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 64, top: 4, bottom: 4 }} barCategoryGap={10}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={104} tick={{ fontSize: 13, fill: "#242424" }} axisLine={false} tickLine={false} />
                  <RTooltip cursor={{ fill: "rgba(15,76,76,.06)" }} formatter={(v: unknown, name: unknown) => [fmt(Math.round(Number(v) * 100)), name === "cost" ? "Cost" : "Profit"]} />
                  <Bar dataKey="cost" stackId="a" fill="#D4A72C" radius={[6, 0, 0, 6]} />
                  <Bar dataKey="profit" stackId="a" fill="#0F4C4C" radius={[0, 6, 6, 0]} label={{ position: "right", fontSize: 12, fill: "#083838", formatter: (v: unknown) => fmt(Math.round(Number(v) * 100)) }}>
                    {chart.map((c) => <Cell key={c.name} fill={BAND[band(c.margin, low)].hex} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {groups.map((g) => (
            <section key={g.key} className="mb-8">
              <GroupHeader g={g} count={g.items.length} low={low} totals={g.revenue > 0 ? { cost: g.cost, sale: g.revenue, profit: g.profit, margin: g.margin, saleLabel: "Revenue" } : null} />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {g.items.map((r) => <SaleCard key={r.id} r={r} low={low} max={maxRevenue} onClick={() => nav(`/products/${r.id}`)} />)}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function SaleCard({ r, low, max, onClick }: { r: Row; low: number; max: number; onClick: () => void }) {
  const b = r.units > 0 ? band(r.margin, low) : "none";
  const width = max > 0 ? (r.revenue / max) * 100 : 0;
  return (
    <button type="button" onClick={onClick} className={`card group flex overflow-hidden text-left transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${r.units === 0 ? "opacity-70" : ""}`}>
      <DishThumb image_url={r.image_url} badge={r.units > 0 ? `${r.units} sold` : "0 sold"} badgeTone={r.units > 0 ? "good" : "none"} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          <div className="truncate font-medium leading-tight text-charcoal">{r.name}</div>
          {r.name_ar && <div className="truncate text-xs text-charcoal/50" dir="rtl">{r.name_ar}</div>}
        </div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <Num label="Revenue" value={fmt(r.revenue)} />
          <Num label="Cost" value={fmt(r.cost)} />
          <Num label="Profit" value={fmt(r.profit)} cls={r.units === 0 ? "text-charcoal/40" : r.profit < 0 ? "text-negative" : "text-positive"} />
        </div>
        <div className="mt-auto">
          <div className="h-2 w-full overflow-hidden rounded-full bg-ivory-200" role="img" aria-label={`revenue ${fmt(r.revenue)}`}>
            <div className={`h-full rounded-full ${BAND[b].bar}`} style={{ width: `${width}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-charcoal/50">
            <span>{r.units > 0 ? `${pct(r.margin, 0)} margin · ${r.orders} order${r.orders === 1 ? "" : "s"}` : "waiting for the first order"}</span>
            {r.refunded > 0 && <span className="text-negative">{r.refunded} refunded</span>}
          </div>
        </div>
      </div>
    </button>
  );
}
