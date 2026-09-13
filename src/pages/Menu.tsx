import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Cell } from "recharts";
import { AlertTriangle, Trophy, Eye, EyeOff, Plus } from "lucide-react";
import { PageHeader, Skeleton, ErrorBox } from "../components/ui";
import { GROUPS, groupFor, band, BAND, Stat, GroupHeader, Num, DishThumb, type GroupKey } from "../components/menuViz";
import { ProductModal } from "./Products";
import { useProducts, useSettings, useCategories } from "../hooks/queries";
import { productUnitCost, REVENUE_STATUSES } from "../lib/metrics";
import { fmt, toCents, pct, ratio, fromCents } from "../lib/money";
import { supabase, unwrap } from "../lib/supabase";
import type { Product, ProductSale } from "../lib/types";

type Row = Product & { group: GroupKey; price: number; cost: number; profit: number; margin: number | null; hasCost: boolean; sold: number; soldProfit: number };

export function MenuPage() {
  const nav = useNavigate();
  const products = useProducts();
  const cats = useCategories();
  const settings = useSettings();
  const sales = useQuery({ queryKey: ["product_sales", "all"], queryFn: async () => unwrap(await supabase.from("product_sales").select("*").limit(20000)) as ProductSale[] });
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const laborRate = settings.data?.default_labor_rate_per_hour ?? 0;
  const low = Number(settings.data?.low_margin_warning_pct ?? 0.3);

  const rows = useMemo<Row[]>(() => (products.data ?? [])
    .filter((p) => showInactive || p.is_active)
    .map((p) => {
      const price = toCents(p.selling_price);
      const cost = productUnitCost(p, laborRate, includeLabor);
      const mine = (sales.data ?? []).filter((s) => s.product_id === p.id && REVENUE_STATUSES.includes(s.status));
      const sold = mine.reduce((s, x) => s + x.quantity, 0);
      const rev = mine.reduce((s, x) => s + toCents(x.line_total) - toCents(x.line_discount), 0);
      const soldCost = mine.reduce((s, x) => s + toCents(x.line_cost) + (includeLabor ? toCents(x.line_labor_cost) : 0), 0);
      return { ...p, group: groupFor(p.product_categories?.name), price, cost, profit: price - cost, margin: cost > 0 ? ratio(price - cost, price) : null, hasCost: cost > 0, sold, soldProfit: rev - soldCost };
    }), [products.data, sales.data, laborRate, includeLabor, showInactive]);

  const costed = rows.filter((r) => r.hasCost);
  const totals = { cost: costed.reduce((s, r) => s + r.cost, 0), sale: costed.reduce((s, r) => s + r.price, 0) };
  const avgMargin = ratio(totals.sale - totals.cost, totals.sale);
  const best = [...costed].sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0))[0];
  const worst = [...costed].sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0))[0];
  const missing = rows.filter((r) => !r.hasCost);

  const groups = GROUPS.map((g) => {
    const items = rows.filter((r) => r.group === g.key).sort((a, b) => (b.margin ?? -1) - (a.margin ?? -1));
    const c = items.filter((r) => r.hasCost);
    const cost = c.reduce((s, r) => s + r.cost, 0), sale = c.reduce((s, r) => s + r.price, 0);
    return { ...g, items, cost, sale, profit: sale - cost, margin: ratio(sale - cost, sale) };
  }).filter((g) => g.items.length > 0);

  const chart = groups.filter((g) => g.sale > 0).map((g) => ({ name: `${g.emoji} ${g.label}`, cost: fromCents(g.cost), profit: fromCents(g.profit), margin: g.margin }));

  if (products.error) return <ErrorBox error={products.error} />;

  return (
    <div>
      <PageHeader title="Menu & Profit" crumbs={["Home", "Menu & Profit"]} actions={<>
        <button className="btn-ghost btn-sm" onClick={() => setShowInactive((v) => !v)}>{showInactive ? <EyeOff size={14} /> : <Eye size={14} />} {showInactive ? "Hide inactive" : "Show inactive"}</button>
        <button className="btn-gold btn-sm" onClick={() => setAdding(true)}><Plus size={16} /> New product</button>
      </>} />
      <p className="mb-4 text-sm text-charcoal/60">What each dish costs you, what it sells for, and what you keep. Margin = profit ÷ sale price. Tap a dish to edit its price or cost.</p>

      {products.isLoading ? <Skeleton rows={8} className="card p-5" /> : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Menu items" value={String(rows.length)} sub={`${costed.length} with a cost, ${missing.length} without`} />
            <Stat label="Average margin" value={pct(avgMargin, 0)} sub={`${fmt(totals.sale - totals.cost)} profit if you sold one of each`} tone={band(avgMargin, low)} formula="Total profit ÷ total sale price, one of every costed item." />
            <Stat label="Best margin" value={best ? pct(best.margin, 0) : "—"} sub={best?.name ?? "add costs to see"} tone="good" icon={<Trophy size={14} />} />
            <Stat label="Lowest margin" value={worst ? pct(worst.margin, 0) : "—"} sub={worst?.name ?? "add costs to see"} tone={worst ? band(worst.margin, low) : "none"} icon={<AlertTriangle size={14} />} />
          </div>

          {chart.length > 0 && (
            <div className="card mb-6 px-5 pb-4 pt-4">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h2 className="card-title">Where the money goes, by group</h2>
                <div className="flex gap-4 text-xs text-charcoal/60">
                  <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-gold" /> Cost</span>
                  <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-teal-800" /> Profit</span>
                </div>
              </div>
              <p className="mb-2 text-xs text-charcoal/50">One of every item in the group. Bar length is the total sale price; the longer the coloured part, the more you keep.</p>
              <ResponsiveContainer width="100%" height={chart.length * 44 + 16}>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 56, top: 4, bottom: 4 }} barCategoryGap={10}>
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
              <GroupHeader g={g} count={g.items.length} low={low} totals={g.sale > 0 ? g : null} />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {g.items.map((r) => <DishCard key={r.id} r={r} low={low} onClick={() => nav(`/products/${r.id}`)} />)}
              </div>
            </section>
          ))}

          {missing.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-gold-100 px-4 py-3 text-sm text-charcoal/80">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
              <span><b>{missing.length} item{missing.length === 1 ? "" : "s"} without a cost:</b> {missing.map((m) => m.name).join(", ")}. Tap one and fill in what it costs you to make, and it joins the numbers above.</span>
            </div>
          )}
        </>
      )}
      <ProductModal open={adding} onClose={() => setAdding(false)} categories={cats.data ?? []} />
    </div>
  );
}

function DishCard({ r, low, onClick }: { r: Row; low: number; onClick: () => void }) {
  const b = band(r.margin, low);
  const share = r.hasCost ? Math.max(0, Math.min(1, r.cost / r.price)) : 0;
  return (
    <button type="button" onClick={onClick} className="card group flex overflow-hidden text-left transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
      <DishThumb image_url={r.image_url} badge={r.hasCost ? pct(r.margin, 0) : "no cost"} badgeTone={b} inactive={!r.is_active} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          <div className="truncate font-medium leading-tight text-charcoal">{r.name}</div>
          {r.name_ar && <div className="truncate text-xs text-charcoal/50" dir="rtl">{r.name_ar}</div>}
        </div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <Num label="Cost" value={r.hasCost ? fmt(r.cost) : "—"} />
          <Num label="Sale" value={fmt(r.price)} />
          <Num label="Profit" value={r.hasCost ? fmt(r.profit) : "—"} cls={r.hasCost ? (r.profit < 0 ? "text-negative" : "text-positive") : ""} />
        </div>
        <div className="mt-auto">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-ivory-200" role="img" aria-label={r.hasCost ? `${pct(share, 0)} of the price is cost` : "cost not set"}>
            {r.hasCost && <div className="bg-gold" style={{ width: `${share * 100}%` }} />}
            {r.hasCost && <div className={BAND[b].bar} style={{ width: `${(1 - share) * 100}%` }} />}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-charcoal/50">
            <span>{r.hasCost ? `${pct(share, 0)} cost · ${pct(r.margin, 0)} profit` : "tap to add a cost"}</span>
            {r.sold > 0 && <span>{r.sold} sold · {fmt(r.soldProfit)}</span>}
          </div>
        </div>
      </div>
    </button>
  );
}
