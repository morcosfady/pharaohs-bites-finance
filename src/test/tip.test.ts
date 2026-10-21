// Driver tip rules (supabase/functions/_shared/tip.ts) and the Stripe line split (create-checkout).
import { describe, expect, it } from "vitest";
import { computeTip, percentTipCents, tipCapCents, TIP_MAX_CENTS, TIP_PERCENTS } from "../../supabase/functions/_shared/tip";

describe("percent tips", () => {
  it("offers 10, 15 and 20 percent", () => expect([...TIP_PERCENTS]).toEqual([10, 15, 20]));
  it("is a percent of the food subtotal, rounded half-up", () => {
    expect(percentTipCents(4000, 15)).toBe(600);    // $40 -> $6.00
    expect(percentTipCents(3333, 10)).toBe(333);    // 333.3 -> 333
    expect(percentTipCents(3335, 10)).toBe(334);    // 333.5 -> 334
    expect(percentTipCents(0, 20)).toBe(0);
  });
  it("recomputes from the server subtotal and rejects unknown percents", () => {
    expect(computeTip({ type: "percent", percent: 15 }, 4000, true)).toEqual({ ok: true, tip: { type: "percent", percent: 15, cents: 600 } });
    expect(computeTip({ type: "percent", percent: 25 }, 4000, true).ok).toBe(false);
    expect(computeTip({ type: "percent", percent: "15" }, 4000, true).ok).toBe(false);
    expect(computeTip({ type: "percent" }, 4000, true).ok).toBe(false);
  });
});

describe("custom tips", () => {
  it("caps at the smaller of $100 and the food subtotal", () => {
    expect(TIP_MAX_CENTS).toBe(10000);
    expect(tipCapCents(4000)).toBe(4000);
    expect(tipCapCents(25000)).toBe(10000);
    expect(tipCapCents(0)).toBe(0);
  });
  it("accepts whole cents inside the range", () => {
    expect(computeTip({ type: "custom", amount_cents: 750 }, 4000, true)).toEqual({ ok: true, tip: { type: "custom", percent: null, cents: 750 } });
    expect(computeTip({ type: "custom", amount_cents: 4000 }, 4000, true).ok).toBe(true);
  });
  it("rejects more than the cap, negatives and fractions", () => {
    expect(computeTip({ type: "custom", amount_cents: 4001 }, 4000, true)).toEqual({ ok: false, error: "the tip can be at most $40.00" });
    expect(computeTip({ type: "custom", amount_cents: 10001 }, 50000, true).ok).toBe(false);
    expect(computeTip({ type: "custom", amount_cents: -1 }, 4000, true).ok).toBe(false);
    expect(computeTip({ type: "custom", amount_cents: 7.5 }, 4000, true).ok).toBe(false);
    expect(computeTip({ type: "custom", amount_cents: "7" }, 4000, true).ok).toBe(false);
  });
  it("a custom $0 is the same as no tip", () => {
    expect(computeTip({ type: "custom", amount_cents: 0 }, 4000, true)).toEqual({ ok: true, tip: { type: "none", percent: null, cents: 0 } });
  });
});

describe("no tip, pickup and bad shapes", () => {
  it("missing or none means no tip", () => {
    expect(computeTip(undefined, 4000, true).ok).toBe(true);
    expect(computeTip(null, 4000, false).ok).toBe(true);
    expect(computeTip({ type: "none" }, 4000, true)).toEqual({ ok: true, tip: { type: "none", percent: null, cents: 0 } });
    expect(computeTip({}, 4000, true).ok).toBe(true);
  });
  it("refuses a tip on a pickup order", () => {
    expect(computeTip({ type: "percent", percent: 15 }, 4000, false)).toEqual({ ok: false, error: "a driver tip is only for delivery orders" });
    expect(computeTip({ type: "custom", amount_cents: 100 }, 4000, false).ok).toBe(false);
    expect(computeTip({ type: "none" }, 4000, false).ok).toBe(true);
  });
  it("refuses unknown types and non-objects", () => {
    expect(computeTip({ type: "gift" }, 4000, true).ok).toBe(false);
    expect(computeTip("15" as never, 4000, true).ok).toBe(false);
    expect(computeTip([15] as never, 4000, true).ok).toBe(false);
  });
});
