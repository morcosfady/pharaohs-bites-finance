/* Where the money goes: spending grouped by category for the Categories tab. All money is summed in
   cents. Rows come from expense_tax_view, so a mixed receipt (flour + foil + a candy bar) already
   counts under each item's own category, and personal items are set aside instead of counted. */
import type { ExpenseTaxRow } from "./types";
import { toCents } from "./money";

export const PERSONAL = "Personal (not business)";

export interface VendorShare { vendor: string; cents: number; count: number }
export interface CategoryShare {
  name: string; cents: number; count: number; share: number; prevCents: number; change: number | null; vendors: VendorShare[];
}
export interface Breakdown { totalCents: number; prevTotalCents: number; personalCents: number; categories: CategoryShare[] }

const EMOJI: Record<string, string> = {
  "Ingredients": "🥘", "Packaging": "📦", "Pizza boxes": "🍕", "Cake boxes": "🎂", "Dessert cups": "🍮", "Logo stickers": "🏷️",
  "Kitchen supplies": "🧽", "Equipment": "🔪", "Delivery": "🛵", "Gas / mileage": "⛽", "Marketing": "📣", "Website / technology": "💻",
  "Licenses and permits": "📜", "Training": "🎓", "Payment processing fees": "💳", "Bank / payment fees": "🏦", "Refunds": "↩️",
  "Utilities": "💡", "Repairs": "🔧", "Other": "🧾", "Professional services": "👔", "Phone & internet": "📱", "Home office": "🏠",
  "Insurance": "🛡️", "Parking & tolls": "🛣️", "Postage & shipping": "📮", "Rent / commissary": "🏢", "Uncategorized": "❓",
};
export const categoryEmoji = (name: string) => EMOJI[name] ?? "🧾";

/** Percent change; null when there is nothing to compare with. */
function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0;
  return (cur - prev) / prev;
}

export function breakdown(rows: ExpenseTaxRow[], prevRows: ExpenseTaxRow[] = []): Breakdown {
  const sumBy = (list: ExpenseTaxRow[]) => {
    const m = new Map<string, { cents: number; count: number; vendors: Map<string, VendorShare> }>();
    let personal = 0;
    for (const r of list) {
      const c = toCents(r.total_amount);
      if (r.category_name === PERSONAL) { personal += c; continue; }
      const e = m.get(r.category_name) ?? { cents: 0, count: 0, vendors: new Map() };
      e.cents += c; e.count += 1;
      const v = (r.vendor || "Unknown").trim() || "Unknown";
      const vs = e.vendors.get(v) ?? { vendor: v, cents: 0, count: 0 };
      vs.cents += c; vs.count += 1; e.vendors.set(v, vs);
      m.set(r.category_name, e);
    }
    return { m, personal };
  };
  const cur = sumBy(rows), prev = sumBy(prevRows);
  const totalCents = [...cur.m.values()].reduce((s, e) => s + e.cents, 0);
  const prevTotalCents = [...prev.m.values()].reduce((s, e) => s + e.cents, 0);
  const categories = [...cur.m.entries()].map(([name, e]) => ({
    name, cents: e.cents, count: e.count, share: totalCents > 0 ? e.cents / totalCents : 0,
    prevCents: prev.m.get(name)?.cents ?? 0, change: pctChange(e.cents, prev.m.get(name)?.cents ?? 0),
    vendors: [...e.vendors.values()].sort((a, b) => b.cents - a.cents),
  })).sort((a, b) => b.cents - a.cents);
  return { totalCents, prevTotalCents, personalCents: cur.personal, categories };
}

/** The headline answers the owner asks for: ingredients, packaging, gas, software, fees. */
export const QUICK_GROUPS: { key: string; label: string; emoji: string; names: string[] }[] = [
  { key: "ingredients", label: "Ingredients", emoji: "🥘", names: ["Ingredients"] },
  { key: "packaging", label: "Packaging", emoji: "📦", names: ["Packaging", "Pizza boxes", "Cake boxes", "Dessert cups", "Logo stickers"] },
  { key: "gas", label: "Gas", emoji: "⛽", names: ["Gas / mileage"] },
  { key: "software", label: "Software", emoji: "💻", names: ["Website / technology"] },
  { key: "marketing", label: "Marketing", emoji: "📣", names: ["Marketing"] },
  { key: "fees", label: "Card & bank fees", emoji: "💳", names: ["Payment processing fees", "Bank / payment fees"] },
];

export function quickTotals(b: Breakdown) {
  return QUICK_GROUPS.map((g) => {
    const cents = b.categories.filter((c) => g.names.includes(c.name)).reduce((s, c) => s + c.cents, 0);
    return { ...g, cents, share: b.totalCents > 0 ? cents / b.totalCents : 0 };
  });
}

/** Donut slices: the biggest few categories, everything smaller folded into one slice. */
export function donutSlices(cats: CategoryShare[], max = 7) {
  if (cats.length <= max) return cats.map((c) => ({ name: c.name, cents: c.cents }));
  const top = cats.slice(0, max - 1).map((c) => ({ name: c.name, cents: c.cents }));
  return [...top, { name: "Everything else", cents: cats.slice(max - 1).reduce((s, c) => s + c.cents, 0) }];
}

export const PALETTE = ["#0F4C4C", "#D4A72C", "#D85A30", "#1D9E75", "#534AB7", "#D4537E", "#378ADD", "#8c6239", "#7A9E3C", "#B8860B", "#4C7A9E", "#9E4C6F"];
export const OTHER_COLOR = "#B9B2A0";

/** Same category = same colour in the donut and the list. */
export function colorFor(name: string, order: string[]): string {
  if (name === "Everything else") return OTHER_COLOR;
  const i = order.indexOf(name);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}
