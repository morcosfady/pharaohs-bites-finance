import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Cell } from "recharts";
import { AlertTriangle, Trophy, Eye, EyeOff } from "lucide-react";
import { PageHeader, Skeleton, ErrorBox, Tip } from "../components/ui";
import { useProducts, useSettings } from "../hooks/queries";
import { productUnitCost, REVENUE_STATUSES } from "../lib/metrics";
import { fmt, toCents, pct, ratio, fromCents } from "../lib/money";
import { supabase, unwrap } from "../lib/supabase";
import type { Product, ProductSale } from "../lib/types";

/* The kitchen groups the owner thinks in, mapped from the finer product
   categories. Anything not listed lands in "Other". */
const GROUPS = [
  { key: "savory", label: "Savory", ar: "الحادق", emoji: "🥧", cats: ["Feteer", "Feteer & Trays", "Soups"], hint: "Feteer, trays and soups" },
  { key: "sweet", label: "Sweet", ar: "الحلو", emoji: "🍰", cats: ["Cakes", "Desserts", "Pudding"], hint: "Cakes, desserts and puddings" },
  { key: "sides", label: "Sides", ar: "على الجنب", emoji: "🍯", cats: ["Sides"], hint: "Cheese, honey and tahini" },
  { key: "drinks", label: "Drinks", ar: "المشروبات", emoji: "🥤", cats: ["Drinks"], hint: "Shakes and juices" },
  { key: "other", label: "Other", ar: "أخرى", emoji: "🍽️", cats: [], hint: "Seasonal and everything else" },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

type Row = Product & { group: GroupKey; price: number; cost: number; profit: number; margin: number | null; hasCost: boolean; sold: number; soldProfit: number };

/* Margin bands: green is comfortably profitable, amber is the owner's own
   low-margin threshold from Settings, red is below it. */
function band(margin: number | null, low: number): "none" | "good" | "watch" | "low" {
  if (margin == null) return "none";
  return margin >= 0.5 ? "good" : margin >= low ? "watch" : "low";
}
const BAND = {
  none: { bar: "bg-ivory-200", text: "text-charcoal/40", badge: "bg-ivory-200 text-charcoal/60", hex: "#c9bfa5" },
  good: { bar: "bg-positive", text: "text-positive", badge: "bg-positive/10 text-positive", hex: "#16855B" },
  watch: { bar: "bg-warning", text: "text-warning", badge: "bg-warning/10 text-warning", hex: "#D88912" },
  low: { bar: "bg-negative", text: "text-negative", badge: "bg-negative/10 text-negative", hex: "#C64040" },
};

export function MenuPage() {
  const nav = useNavigate();
  const products = useProducts();
  const settings = useSettings();
  const sales = useQuery({ queryKey: ["product_sales", "all"], queryFn: async () => unwrap(await supabase.from("product_sales").select("*").limit(20000)) as ProductSale[] });
  const [showInactive, setShowInactive] = useState(false);
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const laborRate = settings.data?.default_labor_rate_per_hour ?? 0;
  const low = Number(settings.data?.low_margin_warning_pct ?? 0.3);

  const rows = useMemo<Row[]>(() => (products.data ?? [])
    .filter((p) => showInactive || p.is_active)
    .map((p) => {
      const cat = p.product_categories?.name ?? "";
      const group = (GROUPS.find((g) => (g.cats as readonly string[]).includes(cat))?.key ?? "other") as GroupKey;
      const price = toCents(p.selling_price);
      const cost = productUnitCost(p, laborRate, includeLabor);
      const mine = (sales.data ?? []).filter((s) => s.product_id === p.id && REVENUE_STATUSES.includes(s.status));
      const sold = mine.reduce((s, x) => s + x.quantity, 0);
      const rev = mine.reduce((s, x) => s + toCents(x.line_total) - toCents(x.line_discount), 0);
      const soldCost = mine.reduce((s, x) => s + toCents(x.line_cost) + (includeLabor ? toCents(x.line_labor_cost) : 0), 0);
      return { ...p, group, price, cost, profit: price - cost, margin: cost > 0 ? ratio(price - cost, price) : null, hasCost: cost > 0, sold, soldProfit: rev - soldCost };
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
      <PageHeader title="Menu & Profit" crumbs={["Home", "Menu & Profit"]} actions={
        <button className="btn-ghost btn-sm" onClick={() => setShowInactive((v) => !v)}>{showInactive ? <EyeOff size={14} /> : <Eye size={14} />} {showInactive ? "Hide inactive" : "Show inactive"}</button>
      } />
      <p className="mb-4 text-sm text-charcoal/60">What each dish costs you, what it sells for, and what you keep. Margin = profit ÷ sale price. Tap a dish to edit its price or cost.</p>

      {products.isLoading ? <Skeleton rows={8} className="card p-5" /> : (
        <>
          {/* ---- headline numbers ---- */}
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Menu items" value={String(rows.length)} sub={`${costed.length} with a cost, ${missing.length} without`} />
            <Stat label="Average margin" value={pct(avgMargin, 0)} sub={`${fmt(totals.sale - totals.cost)} profit if you sold one of each`} tone={band(avgMargin, low)} formula="Total profit ÷ total sale price, one of every costed item." />
            <Stat label="Best margin" value={best ? pct(best.margin, 0) : "—"} sub={best?.name ?? "add costs to see"} tone="good" icon={<Trophy size={14} />} />
            <Stat label="Lowest margin" value={worst ? pct(worst.margin, 0) : "—"} sub={worst?.name ?? "add costs to see"} tone={worst ? band(worst.margin, low) : "none"} icon={<AlertTriangle size={14} />} />
          </div>

          {/* ---- cost vs profit by group ---- */}
          {chart.length > 0 && (
            <div className="card mb-6 px-5 pb-4 pt-4">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h2 className="card-title">Where the money goes, by group</h2>
                <div className="flex gap-4 text-xs text-charcoal/60">
                  <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-gold" /> Cost</span>
                  <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-teal-800" /> Profit</span>
                </div>
              </div>
              <p className="mb-2 text-xs text-charcoal/50">One of every item in the group. The longer the dark part, the more of the sale price you keep.</p>
              <ResponsiveContainer width="100%" height={chart.length * 44 + 16}>
                <BarChart data={chart} layout="vertical" margin={{ left: 8, right: 56, top: 4, bottom: 4 }} barCategoryGap={10}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={104} tick={{ fontSize: 13, fill: "#242424" }} axisLine={false} tickLine={false} />
                  <RTooltip cursor={{ fill: "rgba(15,76,76,.06)" }} formatter={(v: unknown, name: unknown) => [fmt(Math.round(Number(v) * 100)), name === "cost" ? "Cost" : "Profit"]} />
                  <Bar dataKey="cost" stackId="a" fill="#D4A72C" radius={[6, 0, 0, 6]} />
                  <Bar dataKey="profit" stackId="a" fill="#0F4C4C" radius={[0, 6, 6, 0]} label={{ position: "right", fontSize: 12, fill: "#083838", formatter: (v: unknown) => `${fmt(Math.round(Number(v) * 100))}` }}>
                    {chart.map((c) => <Cell key={c.name} fill={BAND[band(c.margin, low)].hex} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ---- one section per group ---- */}
          {groups.map((g) => (
            <section key={g.key} className="mb-8">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b-2 border-gold/40 pb-2">
                <div className="flex items-center gap-3">
                  <span className="text-3xl leading-none" aria-hidden="true">{g.emoji}</span>
                  <div>
                    <h2 className="font-display text-2xl font-semibold leading-tight text-teal-900">{g.label} <span className="text-lg text-teal-900/50" dir="rtl">{g.ar}</span></h2>
                    <p className="text-xs text-charcoal/50">{g.items.length} item{g.items.length === 1 ? "" : "s"} · {g.hint}</p>
                  </div>
                </div>
                {g.sale > 0 && (
                  <div className="flex gap-4 text-right text-xs text-charcoal/60">
                    <span>Cost <b className="block text-sm font-semibold text-charcoal">{fmt(g.cost)}</b></span>
                    <span>Sale <b className="block text-sm font-semibold text-charcoal">{fmt(g.sale)}</b></span>
                    <span>Profit <b className="block text-sm font-semibold text-positive">{fmt(g.profit)}</b></span>
                    <span>Margin <b className={`block text-sm font-semibold ${BAND[band(g.margin, low)].text}`}>{pct(g.margin, 0)}</b></span>
                  </div>
                )}
              </div>
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
    </div>
  );
}

function Stat({ label, value, sub, tone = "none", icon, formula }: { label: string; value: string; sub: string; tone?: keyof typeof BAND; icon?: React.ReactNode; formula?: string }) {
  return (
    <div className="card flex flex-col gap-0.5 px-4 py-3">
      <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider text-teal-900/70"><span className="inline-flex items-center gap-1">{icon}{label}</span>{formula && <Tip text={formula} />}</div>
      <span className={`font-display text-3xl font-semibold leading-none ${tone === "none" ? "text-teal-900" : BAND[tone].text}`}>{value}</span>
      <span className="truncate text-xs text-charcoal/55">{sub}</span>
    </div>
  );
}

function DishCard({ r, low, onClick }: { r: Row; low: number; onClick: () => void }) {
  const b = band(r.margin, low);
  const share = r.hasCost ? Math.max(0, Math.min(1, r.cost / r.price)) : 0;
  return (
    <button type="button" onClick={onClick} className="card group flex overflow-hidden text-left transition hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
      <div className="relative w-28 shrink-0 bg-teal-50 sm:w-32">
        {r.image_url ? <img src={r.image_url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-3xl">🍽️</div>}
        <span className={`absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur ${b === "none" ? "bg-white/85 text-charcoal/60" : b === "good" ? "bg-white/90 text-positive" : b === "watch" ? "bg-white/90 text-warning" : "bg-white/90 text-negative"}`}>{r.hasCost ? pct(r.margin, 0) : "no cost"}</span>
        {!r.is_active && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-charcoal/70 px-2 py-0.5 text-[10px] text-white">inactive</span>}
      </div>
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

function Num({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return <div className="rounded-md bg-ivory-50 px-1 py-1"><div className="text-[10px] uppercase tracking-wider text-charcoal/45">{label}</div><div className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</div></div>;
}
