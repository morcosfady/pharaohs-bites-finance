import { describe, expect, it } from "vitest";
import { parseChoices, resolveChoices, type ComboSlot } from "../../supabase/functions/_shared/combos";

const PUD = ["banana-pudding", "chocolate-pudding", "creme-caramel", "rice-pudding"];
const SIDES = ["white-cheese", "black-honey", "white-honey", "tahini", "baba-ganoush", "hummus"];
const slot = (combo: string, key: string, label: string, n: number, distinct: boolean, allowed: string[], sort: number): ComboSlot => ({ combo_slug: combo, slot_key: key, label, pick_count: n, distinct_items: distinct, allowed, sort_order: sort });
const feast = [slot("family-feast", "main", "Main", 1, false, ["macarona-bechamel", "kofta-tray"], 1), slot("family-feast", "sides", "Sides", 2, true, SIDES, 2), slot("family-feast", "puddings", "Puddings", 2, false, PUD, 3)];
const names = new Map([["kofta-tray", "Kofta Tray"], ["tahini", "Tahini"], ["hummus", "Hummus"], ["banana-pudding", "Banana Pudding"], ["rice-pudding", "Rice Pudding"]]);

describe("combo choices", () => {
  it("builds a readable options line in slot order", () => {
    const r = resolveChoices(feast, { puddings: ["banana-pudding", "banana-pudding"], main: ["kofta-tray"], sides: ["tahini", "hummus"] }, names);
    expect(r).toEqual({ ok: true, options: "Main: Kofta Tray | Sides: Tahini, Hummus | Puddings: Banana Pudding x2" });
  });
  it("rejects a wrong count, a stranger, a repeated side and an unknown slot", () => {
    expect(resolveChoices(feast, { main: ["kofta-tray"], sides: ["tahini"], puddings: ["banana-pudding", "rice-pudding"] }, names).ok).toBe(false);
    expect(resolveChoices(feast, { main: ["feteer-beef"], sides: ["tahini", "hummus"], puddings: ["banana-pudding", "rice-pudding"] }, names).ok).toBe(false);
    expect(resolveChoices(feast, { main: ["kofta-tray"], sides: ["tahini", "tahini"], puddings: ["banana-pudding", "rice-pudding"] }, names).ok).toBe(false);
    expect(resolveChoices(feast, { main: ["kofta-tray"], sides: ["tahini", "hummus"], puddings: ["banana-pudding", "rice-pudding"], extra: ["x"] }, names).ok).toBe(false);
  });
  it("requires every slot", () => {
    expect(resolveChoices(feast, {}, names).ok).toBe(false);
  });
  it("parseChoices refuses odd shapes", () => {
    expect(parseChoices(undefined)).toEqual({});
    expect(parseChoices([])).toBeNull();
    expect(parseChoices({ main: "kofta-tray" })).toBeNull();
    expect(parseChoices({ main: ["Kofta Tray"] })).toBeNull();
    expect(parseChoices({ main: ["kofta-tray"] })).toEqual({ main: ["kofta-tray"] });
  });
});

import { evaluate, priceForMargin, proposePrice, type ComboSpec } from "../lib/comboPricing";
const o = (price: number, cost: number) => ({ price, cost });
const feteer = o(25, 4.39), mac = o(35, 14.53), kofta = o(40, 13), platter = o(19, 5.4);
const sides = [o(3, 0.7), o(3.5, 0.6), o(4, 1), o(4, 1), o(4, 0.9), o(4, 1.2)];
const puds = [o(5, 2.79), o(5, 2.79), o(5, 2.79), o(6, 2.5)];
const single = (p: { price: number; cost: number }) => evaluate({ fixed: [p], slots: [], items: 1, bestSingleProfit: 0 }, p.price).profit;

describe("combo pricing rules", () => {
  const specs: Record<string, [ComboSpec, number, number]> = {
    "Family Feast": [{ fixed: [feteer], slots: [{ options: [mac, kofta], count: 1, distinct: false }, { options: sides, count: 2, distinct: true }, { options: puds, count: 2, distinct: false }], items: 6, bestSingleProfit: Math.max(single(feteer), single(kofta)) }, 76.5, 69],
    "Egyptian Breakfast": [{ fixed: [feteer, o(4, 1), o(3.5, 0.6), o(3, 0.7)], slots: [{ options: [o(9, 3), o(8, 3)], count: 1, distinct: false }], items: 5, bestSingleProfit: single(feteer) }, 43.5, 39.5],
    "Meal for One": [{ fixed: [feteer], slots: [{ options: sides, count: 1, distinct: false }, { options: puds, count: 1, distinct: false }], items: 3, bestSingleProfit: single(feteer) }, 33, 30.5],
    "Party Tray": [{ fixed: [feteer, platter], slots: [{ options: [mac, kofta], count: 1, distinct: false }, { options: puds, count: 4, distinct: false }], items: 7, bestSingleProfit: single(kofta) }, 99, 89.5],
  };
  for (const [name, [spec, full, price]] of Object.entries(specs)) {
    it(`${name} proposes the approved price and passes every guardrail`, () => {
      const r = proposePrice(spec);
      expect(r.full).toBe(full);
      expect(r.price).toBe(price);
      expect(r.passes).toBe(true);
      expect(r.margin).toBeGreaterThanOrEqual(0.5);
      expect(r.price % 0.5).toBe(0);
    });
  }
  it("worst case uses the most expensive choice, full price uses the cheapest", () => {
    const r = proposePrice(specs["Family Feast"][0]);
    expect(r.cost).toBe(26.7);
  });
  it("a combo that cannot reach 50% margin is never discounted below the guardrail", () => {
    const bad: ComboSpec = { fixed: [], slots: [{ options: [o(5, 2.79)], count: 3, distinct: false }], items: 3, bestSingleProfit: 0 };
    const r = proposePrice(bad);
    expect(r.price).toBe(15);
    expect(r.passes).toBe(false);
  });
  it("single pudding price for a 60% margin", () => {
    expect(priceForMargin(2.79, 0.6)).toBe(7);
    expect(priceForMargin(2.79, 0.6, { packaging: 0.5 })).toBe(8.5);
    expect(priceForMargin(2.79, 0.6, { packaging: 0.5, stripe: true })).toBe(10);
  });
});
