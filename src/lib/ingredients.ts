/* Ingredient price tracker, built from the line items of read receipts (expense_items). Prices are compared per
   pound / gallon / each, so "25 lb flour" and "5 lb flour" can be compared. When the size cannot be read from the
   name the price per item is used, and only against the same unit. Nothing here changes a dish cost: it only informs. */

export type UnitKind = "lb" | "gal" | "each";

export interface ItemInput { description: string; quantity: number | string; unit_price: number | string; line_total: number | string; store: string; date: string }
export interface Size { amount: number; kind: UnitKind }

/** Mirrors the database item_key(): the first three letter-words, so the same product matches across receipts. */
export function itemKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");
}

const UNITS: [RegExp, UnitKind, number][] = [
  [/(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/i, "lb", 1], [/(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/i, "lb", 1 / 16],
  [/(\d+(?:\.\d+)?)\s*(?:kg|kilos?)\b/i, "lb", 2.20462], [/(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/i, "lb", 0.00220462],
  [/(\d+(?:\.\d+)?)\s*(?:gal|gallons?)\b/i, "gal", 1], [/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz)\b/i, "gal", 1 / 128],
  [/(\d+(?:\.\d+)?)\s*(?:l|lt|liters?|litres?)\b/i, "gal", 0.264172], [/(\d+(?:\.\d+)?)\s*ml\b/i, "gal", 0.000264172],
  [/(\d+(?:\.\d+)?)\s*(?:ct|count|pk|pack|pcs?|pieces?)\b/i, "each", 1], [/(\d+(?:\.\d+)?)\s*(?:dozen|dz)\b/i, "each", 12],
];

/** "Kerrygold butter 8 oz" -> half a pound. Fluid ounces are tried before plain ounces. */
export function parseSize(name: string): Size | null {
  const ordered = [UNITS[5], ...UNITS.filter((_, i) => i !== 5)];
  for (const [re, kind, mult] of ordered) {
    const m = name.match(re);
    if (m) { const n = parseFloat(m[1]); if (n > 0) return { amount: n * mult, kind }; }
  }
  return null;
}

export const UNIT_LABEL: Record<UnitKind | "item", string> = { lb: "/lb", gal: "/gal", each: "/each", item: "each" };

export interface Purchase { store: string; date: string; price: number; label: string }
export interface IngredientPrice {
  key: string; name: string; unit: string; normalized: boolean; latest: Purchase; previous: Purchase | null;
  change: number | null; cheapest: Purchase | null; savingVsLatest: number | null; stores: number; purchases: number;
}

const n = (v: number | string) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** Price per normalized unit, or per item when the size is unknown. */
export function unitPrice(it: ItemInput): { price: number; unit: string; normalized: boolean } | null {
  const qty = n(it.quantity) || 1, total = n(it.line_total), unit = n(it.unit_price);
  const size = parseSize(it.description);
  if (size && total > 0) return { price: total / (qty * size.amount), unit: UNIT_LABEL[size.kind], normalized: true };
  if (unit > 0) return { price: unit, unit: UNIT_LABEL.item, normalized: false };
  if (total > 0) return { price: total / qty, unit: UNIT_LABEL.item, normalized: false };
  return null;
}

export function buildIngredientPrices(items: ItemInput[], now: Date, recentDays = 90): IngredientPrice[] {
  const groups = new Map<string, { name: string; unit: string; normalized: boolean; rows: Purchase[] }>();
  for (const it of items) {
    const k = itemKey(it.description), up = unitPrice(it);
    if (!k || !up) continue;
    const gk = `${k}|${up.unit}`;                      // never compare $/lb with $/each
    const g = groups.get(gk) ?? { name: it.description.trim(), unit: up.unit, normalized: up.normalized, rows: [] };
    g.rows.push({ store: it.store || "Unknown", date: it.date, price: up.price, label: it.description });
    groups.set(gk, g);
  }
  const cutoff = new Date(now.getTime() - recentDays * 86400000).toISOString().slice(0, 10);
  const out: IngredientPrice[] = [];
  for (const [gk, g] of groups) {
    const rows = [...g.rows].sort((a, b) => b.date.localeCompare(a.date));
    const latest = rows[0];
    const sameStorePrev = rows.slice(1).find((r) => r.store.toLowerCase() === latest.store.toLowerCase()) ?? null;
    // cheapest recent price per store (latest purchase of each store)
    const perStore = new Map<string, Purchase>();
    for (const r of rows) if (r.date >= cutoff && !perStore.has(r.store.toLowerCase())) perStore.set(r.store.toLowerCase(), r);
    const recent = [...perStore.values()].sort((a, b) => a.price - b.price);
    const cheapest = recent.length > 1 ? recent[0] : null;
    out.push({
      key: gk, name: g.name, unit: g.unit, normalized: g.normalized, latest, previous: sameStorePrev,
      change: sameStorePrev && sameStorePrev.price > 0 ? latest.price / sameStorePrev.price - 1 : null,
      cheapest, savingVsLatest: cheapest && cheapest.store.toLowerCase() !== latest.store.toLowerCase() && latest.price > 0 ? 1 - cheapest.price / latest.price : null,
      stores: new Set(rows.map((r) => r.store.toLowerCase())).size, purchases: rows.length,
    });
  }
  // what matters first: price jumps, then where you could save, then everything else by name
  return out.sort((a, b) => (b.change ?? -1) - (a.change ?? -1) || (b.savingVsLatest ?? 0) - (a.savingVsLatest ?? 0) || a.name.localeCompare(b.name));
}
