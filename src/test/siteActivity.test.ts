import { describe, expect, it } from "vitest";
import { buildPulse, describeProblem, type SiteEvent } from "../lib/siteActivity";

let n = 0;
const ev = (visitor_id: string, kind: SiteEvent["kind"], extra: Partial<SiteEvent> = {}): SiteEvent =>
  ({ id: ++n, created_at: `2026-10-03T1${n % 10}:00:00Z`, visitor_id, kind, page: "order", detail: "", meta: { device: "phone" }, ...extra });

describe("Website Pulse", () => {
  const events: SiteEvent[] = [
    ev("aaaa1111", "visit", { meta: { device: "phone", source: "Instagram" } }),
    ev("aaaa1111", "add_to_basket", { meta: { device: "phone", item: "Koshary Tray" } }),
    ev("aaaa1111", "checkout_started"),
    ev("aaaa1111", "order_placed", { detail: "PB-2026-00001" }),
    ev("bbbb2222", "visit"),
    ev("bbbb2222", "add_to_basket", { meta: { device: "computer", item: "Lentil Soup" } }),
    ev("cccc3333", "visit", { page: "index" }),
    ev("dddd4444", "visit"),
    ev("dddd4444", "add_to_basket", { meta: { item: "Hummus" } }),
    ev("dddd4444", "problem", { detail: "could not check the delivery address", meta: { type: "order", name: "Maya", phone4: "4521" } }),
  ];
  const p = buildPulse(events);

  it("counts the journey", () => {
    expect(p.funnel).toEqual({ visited: 4, viewedMenu: 3, addedToBasket: 3, startedCheckout: 1, ordered: 1 });
  });
  it("sorts visitors into outcomes", () => {
    expect(p.outcomes).toEqual({ ordered: 1, stuck: 1, left_basket: 1, browsing: 1 });
  });
  it("lists items people left behind, not ones that were bought", () => {
    expect(p.leftBehind.map((i) => i.name).sort()).toEqual(["Hummus", "Lentil Soup"]);
  });
  it("credits the source with orders", () => {
    expect(p.sources.find((s) => s.name === "Instagram")).toMatchObject({ visitors: 1, ordered: 1 });
  });
  it("explains a failed order in plain words", () => {
    const d = describeProblem(events[9]);
    expect(d.level).toBe("attention");
    expect(d.who).toContain("Maya");
    expect(d.who).toContain("4521");
    expect(d.what).toMatch(/address/i);
  });
});
