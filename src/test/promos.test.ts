import { describe, expect, it } from "vitest";
import { attentionList, buildPromoStats, describeOffer, promoStatus, refusalReasons, ruleTags, shareText, type PromoCode, type PromoOrder, type Redemption } from "../lib/promos";

const NOW = new Date("2026-10-10T12:00:00Z");
const code = (over: Partial<PromoCode> = {}): PromoCode => ({
  code: "TEST", kind: "free_delivery", active: true, label: "", notes: "", single_use: false, max_uses: null, max_miles: null, vegan_only: false,
  max_subtotal: null, percent_off: null, first_order_only: false, welcome_message: null, starts_at: null, expires_at: null, created_at: "2026-10-01T00:00:00Z", ...over,
});
const red = (id: string, c: string, order: string, used: string | null, created = "2026-10-09T00:00:00Z", fee = 0): Redemption => ({ id, code: c, order_id: order, fee_waived: fee, used_at: used, created_at: created });
const order = (id: string, over: Partial<PromoOrder> = {}): PromoOrder => ({ id, order_number: `PB-${id}`, customer_name: "Maya", status: "confirmed", subtotal: 80, discount: 0, delivery_fee: 0, total: 80, ...over });

describe("promo status", () => {
  it("is active by default", () => expect(promoStatus(code(), 0, NOW)).toBe("active"));
  it("is paused when switched off", () => expect(promoStatus(code({ active: false }), 0, NOW)).toBe("paused"));
  it("is scheduled before the start date", () => expect(promoStatus(code({ starts_at: "2026-10-20T00:00:00Z" }), 0, NOW)).toBe("scheduled"));
  it("is expired after the end date, even when paused", () => expect(promoStatus(code({ expires_at: "2026-10-01T00:00:00Z", active: false }), 0, NOW)).toBe("expired"));
  it("is used up after a one-time code is used", () => expect(promoStatus(code({ single_use: true }), 1, NOW)).toBe("used_up"));
  it("is used up when the total-uses limit is reached", () => {
    expect(promoStatus(code({ max_uses: 3 }), 2, NOW)).toBe("active");
    expect(promoStatus(code({ max_uses: 3 }), 3, NOW)).toBe("used_up");
  });
});

describe("promo wording", () => {
  it("describes each kind", () => {
    expect(describeOffer(code({ max_miles: 5 }))).toBe("Free delivery within 5 miles");
    expect(describeOffer(code({ kind: "percent_off", percent_off: 50 }))).toBe("50% off the dishes");
    expect(describeOffer(code({ kind: "free_order" }))).toBe("The whole order is free");
  });
  it("lists the rules", () => {
    const tags = ruleTags(code({ kind: "percent_off", percent_off: 50, first_order_only: true, max_uses: 20, vegan_only: true, max_subtotal: 100 }));
    expect(tags).toEqual(expect.arrayContaining(["First order only", "Max 20 uses in total", "Vegan dishes only", "Up to $100 of food"]));
  });
  it("writes a message to send to a customer", () => {
    expect(shareText(code({ code: "FIRSTBITE", max_miles: 5 }))).toContain("Use code FIRSTBITE");
  });
});

describe("promo numbers", () => {
  const codes = [code({ code: "A", kind: "percent_off", percent_off: 50 }), code({ code: "B" })];
  const reds = [
    red("1", "A", "o1", "2026-10-08T10:00:00Z"),
    red("2", "A", "o2", "2026-10-09T10:00:00Z", undefined, 9.73),
    red("3", "A", "o3", null, "2026-10-09T00:00:00Z"),            // waiting for payment, older than 6 hours
    red("4", "A", "o4", "2026-10-09T11:00:00Z"),                   // cancelled order: not counted
  ];
  const orders = new Map([
    ["o1", order("o1", { discount: 40, total: 49.73 })],
    ["o2", order("o2", { discount: 20, total: 30, delivery_fee: 9.73 })],
    ["o3", order("o3", { status: "pending_whatsapp_confirmation" })],
    ["o4", order("o4", { status: "cancelled", discount: 40 })],
  ]);
  const stats = buildPromoStats(codes, reds, orders, [], NOW);
  const a = stats.find((s) => s.code.code === "A")!;
  it("counts only paid, not-cancelled uses", () => expect(a.used.map((r) => r.id)).toEqual(["2", "1"]));
  it("adds up what was given away and what customers paid", () => {
    expect(a.givenAway).toBeCloseTo(69.73, 2);
    expect(a.revenue).toBeCloseTo(79.73, 2);
  });
  it("keeps unpaid orders apart", () => expect(a.waiting.map((r) => r.id)).toEqual(["3"]));
  it("finds the last use", () => expect(a.lastUsed).toBe("2026-10-09T10:00:00Z"));
  it("warns about a code nobody used for two weeks", () => {
    const b = stats.find((s) => s.code.code === "B")!;
    expect(b.quiet).toBe(false);
    const old = buildPromoStats([code({ code: "B", created_at: "2026-09-01T00:00:00Z" })], [], new Map(), [], NOW)[0];
    expect(old.quiet).toBe(true);
  });
  it("lists what needs attention", () => {
    const list = attentionList(stats, NOW);
    expect(list.some((x) => x.key === "wait-A")).toBe(true);
    const ending = buildPromoStats([code({ code: "E", expires_at: "2026-10-12T23:59:59Z" })], [], new Map(), [], NOW);
    expect(attentionList(ending, NOW).some((x) => x.key === "end-E")).toBe(true);
  });
  it("groups refusals by reason", () => {
    const r = refusalReasons([{ code: "A", message: "x", at: "" }, { code: "A", message: "y", at: "" }, { code: "A", message: "x", at: "" }]);
    expect(r).toEqual([{ message: "x", count: 2 }, { message: "y", count: 1 }]);
  });
});
