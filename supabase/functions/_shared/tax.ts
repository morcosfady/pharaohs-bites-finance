// Texas sales tax for one order (Dallas: 8.25% = 6.25% state + 1% city + 1% DART).
// Pure functions in INTEGER CENTS, no Deno and no network, so they are unit tested from
// src/test/tax.test.ts. The database function calc_order_tax (migration 0080) mirrors these
// formulas line for line: create-order checks that both sides agree before an order is confirmed.
//
// Rules (owner to confirm with the Texas Comptroller, 800-252-5555):
//  * a product is taxable, exempt (bakery sold without utensils) or review.
//    "review" is charged as TAXABLE (safe side) until the owner decides.
//  * item tax = round(taxable subtotal after its share of any discount x rate)
//  * delivery tax depends on the mode: none / proportional (share of the fee that
//    matches the taxable share of the food) / all (whole fee once any item is taxable)
//  * a free delivery (FIRSTBITE) has no delivery tax, tips are never taxed
//  * every rounding is half-up at the line where it happens
export type TaxStatus = "taxable" | "exempt" | "review";
export type DeliveryTaxMode = "none" | "proportional" | "all";
export type TaxLine = { cents: number; status: TaxStatus };
export type TaxInput = {
  lines: TaxLine[];
  /** discount on the dishes (promo). Shared across lines in proportion to their price. */
  discountCents?: number;
  /** delivery fee actually charged (0 for pickup or free delivery) */
  deliveryCents: number;
  /** 0.0825 for 8.25% */
  rate: number;
  mode: DeliveryTaxMode;
  enabled?: boolean;
};
export type TaxResult = {
  subtotalCents: number;
  /** taxable dishes after their share of the discount: the base the item tax was charged on */
  taxableSubtotalCents: number;
  itemTaxCents: number;
  deliveryTaxCents: number;
  taxCents: number;
  /** tax per line, same order as the input; adds up to itemTaxCents */
  lineTaxCents: number[];
};

export const DELIVERY_TAX_MODES: DeliveryTaxMode[] = ["none", "proportional", "all"];

/** review counts as taxable (safe side) until the owner sets it */
export function isTaxable(status: TaxStatus | null | undefined): boolean {
  return status !== "exempt";
}

/** rate 0.0825 -> 825 basis points, so every product below is exact integer arithmetic */
export function rateToBp(rate: number): number {
  return Math.max(0, Math.round(rate * 10000));
}

/** num / den rounded half-up, for non-negative integers (exact, no floating point) */
export function divHalfUp(num: number, den: number): number {
  if (den <= 0 || num <= 0) return 0;
  return Math.floor((num * 2 + den) / (den * 2));
}

export function computeTax(input: TaxInput): TaxResult {
  const lines = input.lines.map((l) => ({ cents: Math.max(0, Math.round(l.cents)), status: l.status }));
  const subtotalCents = lines.reduce((n, l) => n + l.cents, 0);
  const taxableCents = lines.reduce((n, l) => n + (isTaxable(l.status) ? l.cents : 0), 0);
  const discountCents = Math.min(Math.max(0, Math.round(input.discountCents ?? 0)), subtotalCents);
  const deliveryCents = Math.max(0, Math.round(input.deliveryCents));
  const bp = rateToBp(input.rate);
  const off = input.enabled === false || bp === 0;
  const zero: TaxResult = { subtotalCents, taxableSubtotalCents: 0, itemTaxCents: 0, deliveryTaxCents: 0, taxCents: 0, lineTaxCents: lines.map(() => 0) };
  if (off || taxableCents === 0) return zero;

  // the taxable dishes carry their share of the discount
  const discountOnTaxable = subtotalCents > 0 ? divHalfUp(discountCents * taxableCents, subtotalCents) : 0;
  const netTaxable = Math.max(0, taxableCents - discountOnTaxable);
  const netSubtotal = Math.max(0, subtotalCents - discountCents);
  const itemTaxCents = divHalfUp(netTaxable * bp, 10000);

  let deliveryTaxCents = 0;
  if (deliveryCents > 0 && netTaxable > 0) {
    if (input.mode === "all") deliveryTaxCents = divHalfUp(deliveryCents * bp, 10000);
    else if (input.mode === "proportional" && netSubtotal > 0) deliveryTaxCents = divHalfUp(deliveryCents * bp * netTaxable, 10000 * netSubtotal);
  }

  // per-line split of the item tax (records only): proportional, rounding difference on the largest taxable line
  const lineTaxCents = lines.map((l) => (isTaxable(l.status) && taxableCents > 0 ? divHalfUp(itemTaxCents * l.cents, taxableCents) : 0));
  const diff = itemTaxCents - lineTaxCents.reduce((n, c) => n + c, 0);
  if (diff !== 0) {
    let big = -1;
    lines.forEach((l, i) => { if (isTaxable(l.status) && (big < 0 || l.cents > lines[big].cents)) big = i; });
    if (big >= 0) lineTaxCents[big] += diff;
  }
  return { subtotalCents, taxableSubtotalCents: netTaxable, itemTaxCents, deliveryTaxCents, taxCents: itemTaxCents + deliveryTaxCents, lineTaxCents };
}
