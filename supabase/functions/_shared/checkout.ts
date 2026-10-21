// The Stripe Checkout lines of an order: food, delivery, sales tax, driver tip. Pure, unit tested from
// src/test/checkout.test.ts. create-checkout refuses to open a payment page when they do not add up.
export type CheckoutLine = { name: string; cents: number };
export type CheckoutMoney = { order_number: string; subtotal: unknown; discount: unknown; delivery_fee: unknown; tax_cents: unknown; tip_cents: unknown; tip_percent: unknown; tax_rate_applied: unknown; delivery_method: string };

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
export const pctLabel = (rate: number) => (rate * 100).toFixed(2).replace(/\.?0+$/, "") + "%";

/** Returns null when the lines would not equal the balance to the cent (then no session is created).
 *  A partly paid order gets one "balance" line instead of the split. */
export function checkoutLines(o: CheckoutMoney, balanceCents: number, totalCents: number): CheckoutLine[] | null {
  if (balanceCents <= 0) return null;
  const food = Math.max(0, cents(o.subtotal) - cents(o.discount));
  const delivery = cents(o.delivery_fee), tax = Number(o.tax_cents ?? 0), tip = Number(o.tip_cents ?? 0);
  const rate = Number(o.tax_rate_applied ?? 0);
  if (balanceCents !== totalCents) return [{ name: `Pharaoh's Bites order ${o.order_number} (balance)`, cents: balanceCents }];
  const lines: CheckoutLine[] = [
    { name: `Pharaoh's Bites order ${o.order_number}`, cents: food },
    { name: o.delivery_method === "pickup" ? "Pickup" : "Delivery", cents: delivery },
    { name: rate > 0 ? `Sales tax (${pctLabel(rate)})` : "Sales tax", cents: tax },
    { name: o.tip_percent ? `Driver tip (${o.tip_percent}%)` : "Driver tip", cents: tip },
  ].filter((l) => l.cents > 0);
  const sum = lines.reduce((n, l) => n + l.cents, 0);
  return sum === balanceCents ? lines : null;
}
