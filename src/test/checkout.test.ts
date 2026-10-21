// Stripe Checkout dry run: the session lines are built from the order's own numbers, never sent to Stripe
// here, and the function refuses any split that does not equal the balance to the cent.
import { describe, expect, it } from "vitest";
import { checkoutLines } from "../../supabase/functions/_shared/checkout";

const order = (over: Record<string, unknown> = {}) => ({ order_number: "PB-2026-00200", subtotal: "60.00", discount: "0.00", delivery_fee: "8.00", tax_cents: 328, tip_cents: 900, tip_percent: 15, tax_rate_applied: "0.0825", delivery_method: "delivery", ...over });

describe("Stripe line items", () => {
  it("splits food, delivery, sales tax and the driver tip, and they equal the total", () => {
    const total = 6000 + 800 + 328 + 900;
    const lines = checkoutLines(order(), total, total)!;
    expect(lines).toEqual([
      { name: "Pharaoh's Bites order PB-2026-00200", cents: 6000 },
      { name: "Delivery", cents: 800 },
      { name: "Sales tax (8.25%)", cents: 328 },
      { name: "Driver tip (15%)", cents: 900 },
    ]);
    expect(lines.reduce((n, l) => n + l.cents, 0)).toBe(total);
  });
  it("drops $0 lines (free delivery, exempt basket, no tip)", () => {
    const lines = checkoutLines(order({ delivery_fee: "0", tax_cents: 0, tip_cents: 0, tip_percent: null }), 6000, 6000)!;
    expect(lines).toEqual([{ name: "Pharaoh's Bites order PB-2026-00200", cents: 6000 }]);
  });
  it("takes a promo discount off the food line only", () => {
    const total = 3000 + 800 + 144 + 900;
    const lines = checkoutLines(order({ discount: "30.00", tax_cents: 144 }), total, total)!;
    expect(lines[0].cents).toBe(3000);
    expect(lines.reduce((n, l) => n + l.cents, 0)).toBe(total);
  });
  it("refuses a split that does not add up (tampered or stale columns)", () => {
    expect(checkoutLines(order({ tax_cents: 999 }), 8028, 8028)).toBeNull();
    expect(checkoutLines(order(), 0, 8028)).toBeNull();
  });
  it("charges one balance line when the order was partly paid", () => {
    expect(checkoutLines(order(), 5000, 8028)).toEqual([{ name: "Pharaoh's Bites order PB-2026-00200 (balance)", cents: 5000 }]);
  });
  it("labels a custom tip without a percent and pickup without delivery", () => {
    const lines = checkoutLines(order({ delivery_method: "pickup", delivery_fee: "0", tip_cents: 0, tip_percent: null, tax_cents: 495 }), 6495, 6495)!;
    expect(lines.map((l) => l.name)).toEqual(["Pharaoh's Bites order PB-2026-00200", "Sales tax (8.25%)"]);
    const custom = checkoutLines(order({ tip_percent: null, tip_cents: 750 }), 7878, 7878)!;
    expect(custom[3]).toEqual({ name: "Driver tip", cents: 750 });
  });
});
