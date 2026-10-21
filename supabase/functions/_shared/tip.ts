// Driver tip (delivery orders only, chosen before payment). Pure, integer cents, unit tested
// from src/test/tip.test.ts. 100% of the tip goes to the driver: it is never taxed, never
// counted as food sales, never part of the promo logic, and the dashboard shows it apart.
export const TIP_PERCENTS = [10, 15, 20] as const;
/** a custom tip is at most $100, and never more than the food itself */
export const TIP_MAX_CENTS = 10000;
export type TipType = "none" | "percent" | "custom";
export type TipRequest = { type?: unknown; percent?: unknown; amount_cents?: unknown } | null | undefined;
export type Tip = { type: TipType; percent: number | null; cents: number };
export type TipCheck = { ok: true; tip: Tip } | { ok: false; error: string };

export const NO_TIP: Tip = { type: "none", percent: null, cents: 0 };

/** the biggest custom tip allowed on this food subtotal */
export function tipCapCents(subtotalCents: number): number {
  return Math.max(0, Math.min(TIP_MAX_CENTS, Math.round(subtotalCents)));
}

/** percent of the food subtotal (before tax, before delivery), rounded half-up to the cent */
export function percentTipCents(subtotalCents: number, percent: number): number {
  const sub = Math.max(0, Math.round(subtotalCents));
  return Math.floor((sub * percent * 2 + 100) / 200);
}

/** Checks the untrusted `tip` object from the browser against the server's own subtotal. */
export function computeTip(raw: TipRequest, subtotalCents: number, isDelivery: boolean): TipCheck {
  if (raw == null) return { ok: true, tip: NO_TIP };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid tip" };
  const type = raw.type;
  if (type === undefined || type === "none") return { ok: true, tip: NO_TIP };
  if (type !== "percent" && type !== "custom") return { ok: false, error: "invalid tip" };
  if (!isDelivery) return { ok: false, error: "a driver tip is only for delivery orders" };
  if (type === "percent") {
    const pct = raw.percent;
    if (typeof pct !== "number" || !(TIP_PERCENTS as readonly number[]).includes(pct)) return { ok: false, error: "tip percent must be 10, 15 or 20" };
    return { ok: true, tip: { type: "percent", percent: pct, cents: percentTipCents(subtotalCents, pct) } };
  }
  const amt = raw.amount_cents;
  if (typeof amt !== "number" || !Number.isInteger(amt) || amt < 0) return { ok: false, error: "invalid tip amount" };
  const cap = tipCapCents(subtotalCents);
  if (amt > cap) return { ok: false, error: `the tip can be at most $${(cap / 100).toFixed(2)}` };
  if (amt === 0) return { ok: true, tip: NO_TIP };
  return { ok: true, tip: { type: "custom", percent: null, cents: amt } };
}
