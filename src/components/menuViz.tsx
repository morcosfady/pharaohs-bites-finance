import type { ReactNode } from "react";
import { Tip } from "./ui";
import { fmt, pct } from "../lib/money";

/* Shared look for the Menu & Profit and Sales by Dish tabs: the kitchen
   groups the owner thinks in, the margin colour bands, and the small cards. */

export const GROUPS = [
  { key: "savory", label: "Savory", ar: "الحادق", emoji: "🥧", cats: ["Feteer", "Feteer & Trays", "Soups"], hint: "Feteer, trays and soups" },
  { key: "sweet", label: "Sweet", ar: "الحلو", emoji: "🍰", cats: ["Cakes", "Desserts", "Pudding"], hint: "Cakes, desserts and puddings" },
  { key: "sides", label: "Sides", ar: "على الجنب", emoji: "🍯", cats: ["Sides"], hint: "Cheese, honey and tahini" },
  { key: "drinks", label: "Drinks", ar: "المشروبات", emoji: "🥤", cats: ["Drinks"], hint: "Shakes and juices" },
  { key: "other", label: "Other", ar: "أخرى", emoji: "🍽️", cats: [], hint: "Seasonal and everything else" },
] as const;
export type GroupKey = (typeof GROUPS)[number]["key"];

export function groupFor(categoryName: string | null | undefined): GroupKey {
  const cat = categoryName ?? "";
  return (GROUPS.find((g) => (g.cats as readonly string[]).includes(cat))?.key ?? "other") as GroupKey;
}

/* Margin bands: green is comfortably profitable, amber is the owner's own
   low-margin threshold from Settings, red is below it. */
export type Band = "none" | "good" | "watch" | "low";
export function band(margin: number | null, low: number): Band {
  if (margin == null) return "none";
  return margin >= 0.5 ? "good" : margin >= low ? "watch" : "low";
}
export const BAND: Record<Band, { bar: string; text: string; hex: string }> = {
  none: { bar: "bg-ivory-200", text: "text-charcoal/40", hex: "#c9bfa5" },
  good: { bar: "bg-positive", text: "text-positive", hex: "#16855B" },
  watch: { bar: "bg-warning", text: "text-warning", hex: "#D88912" },
  low: { bar: "bg-negative", text: "text-negative", hex: "#C64040" },
};

export function Stat({ label, value, sub, tone = "none", icon, formula }: { label: string; value: string; sub: string; tone?: Band; icon?: ReactNode; formula?: string }) {
  return (
    <div className="card flex flex-col gap-0.5 px-4 py-3">
      <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider text-teal-900/70"><span className="inline-flex items-center gap-1">{icon}{label}</span>{formula && <Tip text={formula} />}</div>
      <span className={`font-display text-3xl font-semibold leading-none ${tone === "none" ? "text-teal-900" : BAND[tone].text}`}>{value}</span>
      <span className="truncate text-xs text-charcoal/55">{sub}</span>
    </div>
  );
}

export function GroupHeader({ g, count, totals, low }: { g: (typeof GROUPS)[number]; count: number; totals?: { cost: number; sale: number; profit: number; margin: number | null; saleLabel?: string } | null; low: number }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b-2 border-gold/40 pb-2">
      <div className="flex items-center gap-3">
        <span className="text-3xl leading-none" aria-hidden="true">{g.emoji}</span>
        <div>
          <h2 className="font-display text-2xl font-semibold leading-tight text-teal-900">{g.label} <span className="text-lg text-teal-900/50" dir="rtl">{g.ar}</span></h2>
          <p className="text-xs text-charcoal/50">{count} item{count === 1 ? "" : "s"} · {g.hint}</p>
        </div>
      </div>
      {totals && (
        <div className="flex gap-4 text-right text-xs text-charcoal/60">
          <span>Cost <b className="block text-sm font-semibold text-charcoal">{fmt(totals.cost)}</b></span>
          <span>{totals.saleLabel ?? "Sale"} <b className="block text-sm font-semibold text-charcoal">{fmt(totals.sale)}</b></span>
          <span>Profit <b className={`block text-sm font-semibold ${totals.profit < 0 ? "text-negative" : "text-positive"}`}>{fmt(totals.profit)}</b></span>
          <span>Margin <b className={`block text-sm font-semibold ${BAND[band(totals.margin, low)].text}`}>{pct(totals.margin, 0)}</b></span>
        </div>
      )}
    </div>
  );
}

export function Num({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return <div className="rounded-md bg-ivory-50 px-1 py-1"><div className="text-[10px] uppercase tracking-wider text-charcoal/45">{label}</div><div className={`text-sm font-semibold tabular-nums ${cls}`}>{value}</div></div>;
}

export function DishThumb({ image_url, badge, badgeTone, inactive }: { image_url: string; badge: string; badgeTone: Band; inactive?: boolean }) {
  const tone = badgeTone === "none" ? "text-charcoal/60" : BAND[badgeTone].text;
  return (
    <div className="relative w-28 shrink-0 bg-teal-50 sm:w-32">
      {image_url ? <img src={image_url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-3xl">🍽️</div>}
      <span className={`absolute left-1.5 top-1.5 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold backdrop-blur ${tone}`}>{badge}</span>
      {inactive && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-charcoal/70 px-2 py-0.5 text-[10px] text-white">inactive</span>}
    </div>
  );
}
