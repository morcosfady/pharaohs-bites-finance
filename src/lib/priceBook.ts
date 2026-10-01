/* Connects receipt prices to the price book (ingredients -> recipes -> dish costs). Everything here only COMPUTES
   a suggestion and its effect; the owner applies it. The unit maths mirrors the database (unit_to_base,
   recipe_line_cost) so a preview equals what the database will calculate after Apply. */

const BASE: Record<string, number> = {
  g: 1, kg: 1000, oz: 28.3495, lb: 453.592, ml: 1, l: 1000, tsp: 4.92892, teaspoon: 4.92892, tbsp: 14.7868, tablespoon: 14.7868,
  cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41, piece: 1, package: 1,
};
export const unitToBase = (u: string) => BASE[u.toLowerCase().trim()] ?? 1;

export type Family = "mass" | "volume" | "count" | "unknown";
const MASS = ["g", "kg", "oz", "lb"], VOLUME = ["ml", "l", "tsp", "teaspoon", "tbsp", "tablespoon", "cup", "pint", "quart", "gallon"], COUNT = ["piece", "package"];
export function familyOf(u: string): Family {
  const k = u.toLowerCase().trim();
  return MASS.includes(k) ? "mass" : VOLUME.includes(k) ? "volume" : COUNT.includes(k) ? "count" : "unknown";
}

/** Units the price book offers when adding an ingredient from a receipt. */
export const PACKAGE_UNITS = ["lb", "oz", "kg", "g", "gallon", "l", "ml", "piece"] as const;

/** A receipt price is per lb, per gal or each. Which family and how many base units is that? */
export function receiptUnit(unit: string): { family: Family; base: number } {
  if (unit === "/lb") return { family: "mass", base: BASE.lb };
  if (unit === "/gal") return { family: "volume", base: BASE.gallon };
  if (unit === "/each") return { family: "count", base: 1 };
  return { family: "unknown", base: 1 };   // "each" item with no readable size: cannot be converted
}

export interface PackageSpec { package_size: number | string; package_unit: string }

/** What one price-book package should cost if it were bought at the latest receipt price. Null when the units
 *  cannot be compared (cups of flour vs pounds of flour need a density we do not have). */
export function suggestedPackagePrice(receiptPrice: number, receiptUnitLabel: string, pkg: PackageSpec): { price: number } | { reason: string } {
  const r = receiptUnit(receiptUnitLabel), f = familyOf(pkg.package_unit);
  if (r.family === "unknown") return { reason: "The receipt has no size, so the price is per item and cannot be compared with a package." };
  if (f === "unknown" || f !== r.family) return { reason: `The receipt price is ${receiptUnitLabel.replace("/", "per ")} but the price book package is in ${pkg.package_unit}. Change the package unit to compare.` };
  const perBase = receiptPrice / r.base;
  return { price: Math.round(perBase * Number(pkg.package_size) * unitToBase(pkg.package_unit) * 100) / 100 };
}

/** Same formula as the database's recipe_line_cost(). */
export function lineCost(qty: number, unit: string, pkgSize: number, pkgUnit: string, pkgPrice: number, waste: number): number {
  const d = pkgSize * unitToBase(pkgUnit);
  return d > 0 ? pkgPrice * ((qty * unitToBase(unit)) / d) * (1 + waste) : 0;
}

export interface RecipeLineIn {
  product_id: string; product: string; quantity: number | string; unit: string; waste_pct: number | string; product_ingredient_cost: number | string; selling_price: number | string;
}
export interface IngredientIn { package_size: number | string; package_unit: string; package_price: number | string; waste_pct: number | string }
export interface DishImpact { product_id: string; product: string; deltaCents: number; oldCostCents: number; newCostCents: number; priceCents: number; marginBefore: number | null; marginAfter: number | null }

/** Which dishes change, and by how much, if this ingredient's package price becomes `newPrice`. */
export function dishImpact(ing: IngredientIn, lines: RecipeLineIn[], newPrice: number): DishImpact[] {
  const out = new Map<string, DishImpact>();
  for (const l of lines) {
    const waste = Math.max(Number(l.waste_pct), Number(ing.waste_pct));
    const args = [Number(l.quantity), l.unit, Number(ing.package_size), ing.package_unit] as const;
    const delta = lineCost(...args, newPrice, waste) - lineCost(...args, Number(ing.package_price), waste);
    const cur = out.get(l.product_id);
    const base = cur ? cur.oldCostCents : Math.round(Number(l.product_ingredient_cost) * 100);
    const deltaCents = (cur?.deltaCents ?? 0) + Math.round(delta * 100);
    const price = Math.round(Number(l.selling_price) * 100);
    out.set(l.product_id, {
      product_id: l.product_id, product: l.product, deltaCents, oldCostCents: base, newCostCents: base + deltaCents, priceCents: price,
      marginBefore: price > 0 ? (price - base) / price : null, marginAfter: price > 0 ? (price - base - deltaCents) / price : null,
    });
  }
  return [...out.values()].sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));
}

/** Change of one price against another, as a fraction (0.2 = +20%). */
export const priceChange = (from: number, to: number) => (from > 0 ? to / from - 1 : null);
