// Combo pricing rules (owner-approved 2026-10-01, see docs/COMBO-PRICING.md).
// Prices are in dollars to match the menu; every result is rounded to cents.
export interface Opt { price: number; cost: number }
export interface Slot { options: Opt[]; count: number; distinct: boolean }
export interface ComboSpec { fixed: Opt[]; slots: Slot[]; items: number; bestSingleProfit: number }

export const PACKAGING_PER_ITEM = 0.5; // placeholder until real receipts are entered
export const stripeFee = (price: number) => Math.round((0.029 * price + 0.3) * 100) / 100;
const c2 = (n: number) => Math.round(n * 100) / 100;

export const fullPrice = (s: ComboSpec) =>
  c2(s.fixed.reduce((n, o) => n + o.price, 0) + s.slots.reduce((n, sl) => {
    const p = sl.options.map((o) => o.price).sort((a, b) => a - b);
    return n + (sl.distinct ? p.slice(0, sl.count).reduce((a, b) => a + b, 0) : p[0] * sl.count);
  }, 0));

export const worstCost = (s: ComboSpec) =>
  c2(s.fixed.reduce((n, o) => n + o.cost, 0) + s.slots.reduce((n, sl) => {
    const k = sl.options.map((o) => o.cost).sort((a, b) => b - a);
    return n + (sl.distinct ? k.slice(0, sl.count).reduce((a, b) => a + b, 0) : k[0] * sl.count);
  }, 0));

export function evaluate(s: ComboSpec, price: number, packagingPerItem = PACKAGING_PER_ITEM) {
  const cost = worstCost(s), pkg = c2(s.items * packagingPerItem), fee = stripeFee(price);
  const profit = c2(price - cost - pkg - fee), margin = profit / price;
  const passes = margin >= 0.5 && profit >= s.bestSingleProfit && price >= cost + pkg;
  return { cost, pkg, fee, profit, margin, passes };
}

// Proposed price: discount = min(10% of full price, 25% of profit before discount), rounded UP to $0.50,
// at least $1 off, then raised in $0.50 steps until every guardrail passes (never above the full price).
export function proposePrice(s: ComboSpec, packagingPerItem = PACKAGING_PER_ITEM) {
  const full = fullPrice(s);
  const base = full - worstCost(s) - s.items * packagingPerItem;
  const discount = Math.min(0.1 * full, 0.25 * base);
  let price = Math.ceil((full - discount) * 2 - 1e-9) / 2;
  if (full - price < 1) price = full - 1;
  while (!evaluate(s, price, packagingPerItem).passes && price < full) price += 0.5;
  return { full, price, save: c2(full - price), ...evaluate(s, price, packagingPerItem) };
}

// Lowest single price (rounded up to $0.50) that gives a target margin on one item.
// withPackaging also counts the packaging cost; withStripe also counts the card fee of a one-item order.
export function priceForMargin(cost: number, target: number, opts: { packaging?: number; stripe?: boolean } = {}) {
  const fixed = cost + (opts.packaging ?? 0) + (opts.stripe ? 0.3 : 0);
  const keep = 1 - target - (opts.stripe ? 0.029 : 0);
  return Math.ceil((fixed / keep) * 2 - 1e-9) / 2;
}
