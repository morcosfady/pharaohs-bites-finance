// Texas sales tax formula (supabase/functions/_shared/tax.ts). The SQL function calc_order_tax
// (migration 0080, tested by supabase/tests/tax_tips.sql) mirrors every case here.
import { describe, expect, it } from "vitest";
import { computeTax, divHalfUp, isTaxable, rateToBp, type TaxLine } from "../../supabase/functions/_shared/tax";

const RATE = 0.0825;
const L = (cents: number, status: TaxLine["status"]): TaxLine => ({ cents, status });
const run = (lines: TaxLine[], deliveryCents = 0, mode: "none" | "proportional" | "all" = "proportional", discountCents = 0, enabled = true) =>
  computeTax({ lines, deliveryCents, rate: RATE, mode, discountCents, enabled });

describe("rounding helpers", () => {
  it("rounds half up with exact integer arithmetic", () => {
    expect(divHalfUp(5, 10)).toBe(1);      // 0.5 -> 1
    expect(divHalfUp(4, 10)).toBe(0);      // 0.4 -> 0
    expect(divHalfUp(15, 10)).toBe(2);     // 1.5 -> 2
    expect(divHalfUp(0, 10)).toBe(0);
    expect(divHalfUp(10, 0)).toBe(0);
  });
  it("turns a rate into basis points", () => {
    expect(rateToBp(0.0825)).toBe(825);
    expect(rateToBp(0)).toBe(0);
    expect(rateToBp(0.1)).toBe(1000);
  });
  it("treats review as taxable", () => {
    expect(isTaxable("taxable")).toBe(true);
    expect(isTaxable("review")).toBe(true);
    expect(isTaxable("exempt")).toBe(false);
    expect(isTaxable(null)).toBe(true);
  });
});

describe("item tax", () => {
  it("all-taxable basket: $35 x 8.25% = 2.8875 -> $2.89", () => {
    const r = run([L(3500, "taxable")]);
    expect(r).toMatchObject({ subtotalCents: 3500, taxableSubtotalCents: 3500, itemTaxCents: 289, deliveryTaxCents: 0, taxCents: 289 });
    expect(r.lineTaxCents).toEqual([289]);
  });
  it("all-exempt basket: feteer meshaltet and round cake", () => {
    const r = run([L(2500, "exempt"), L(1200, "exempt")], 800, "all");
    expect(r).toMatchObject({ taxableSubtotalCents: 0, itemTaxCents: 0, deliveryTaxCents: 0, taxCents: 0 });
    expect(r.lineTaxCents).toEqual([0, 0]);
  });
  it("mixed basket taxes only the taxable lines and splits the tax per line", () => {
    const r = run([L(2500, "exempt"), L(4000, "taxable"), L(700, "review")]);
    // taxable 47.00 x 8.25% = 3.8775 -> 3.88
    expect(r.itemTaxCents).toBe(388);
    expect(r.lineTaxCents[0]).toBe(0);
    expect(r.lineTaxCents[1] + r.lineTaxCents[2]).toBe(388);
    // 388 x 40/47 = 330.2 -> 330, 388 x 7/47 = 57.8 -> 58
    expect(r.lineTaxCents).toEqual([0, 330, 58]);
  });
  it("puts the per-line rounding difference on the largest taxable line", () => {
    // three equal taxable lines of $10.01: tax 30.03 x 8.25% = 2.4775 -> 248; per line 82.67 -> 83 each = 249, fix -1 on the first (largest, first)
    const r = run([L(1001, "taxable"), L(1001, "taxable"), L(1001, "taxable")]);
    expect(r.itemTaxCents).toBe(248);
    expect(r.lineTaxCents.reduce((n, c) => n + c, 0)).toBe(248);
    expect(r.lineTaxCents).toEqual([82, 83, 83]);
  });
  it("rounds exactly .005 up: $10.00 x 8.25% = 82.5 cents -> 83", () => {
    expect(run([L(1000, "taxable")]).itemTaxCents).toBe(83);
    // $30.00 x 8.25% = 247.5 -> 248
    expect(run([L(3000, "taxable")]).itemTaxCents).toBe(248);
  });
  it("$0 tax: empty basket, zero rate, or tax switched off", () => {
    expect(run([]).taxCents).toBe(0);
    expect(computeTax({ lines: [L(3500, "taxable")], deliveryCents: 800, rate: 0, mode: "all" }).taxCents).toBe(0);
    expect(run([L(3500, "taxable")], 800, "all", 0, false)).toMatchObject({ taxCents: 0, taxableSubtotalCents: 0 });
  });
  it("combos are one taxable line (bundle with a taxable item inside)", () => {
    const r = run([L(9900, "taxable")]);   // Family Feast $99 -> 816.75 -> 817
    expect(r.itemTaxCents).toBe(817);
  });
});

describe("discounts", () => {
  it("50% off the dishes: the taxable share of the discount comes off before tax", () => {
    const r = run([L(2500, "exempt"), L(3500, "taxable")], 800, "proportional", 3000);
    // discount on taxable = 3000 x 35/60 = 1750 -> net taxable 1750 -> 144.375 -> 144
    expect(r.taxableSubtotalCents).toBe(1750);
    expect(r.itemTaxCents).toBe(144);
    // delivery share: 8 x .0825 x 1750/3000 = 0.385 -> 39
    expect(r.deliveryTaxCents).toBe(39);
  });
  it("a free order (discount = subtotal) has no tax at all", () => {
    const r = run([L(3500, "taxable")], 0, "all", 3500);
    expect(r).toMatchObject({ taxableSubtotalCents: 0, itemTaxCents: 0, deliveryTaxCents: 0, taxCents: 0 });
  });
});

describe("delivery tax by mode", () => {
  const mixed = [L(2500, "exempt"), L(3500, "taxable")];
  it("proportional (default): the taxable share of the fee", () => {
    // 8 x .0825 x 35/60 = 0.385 -> 39
    expect(run(mixed, 800, "proportional").deliveryTaxCents).toBe(39);
    // all taxable: the whole fee -> 66
    expect(run([L(3500, "taxable")], 800, "proportional").deliveryTaxCents).toBe(66);
  });
  it("all: the whole fee once any item is taxable", () => {
    expect(run(mixed, 800, "all").deliveryTaxCents).toBe(66);
    expect(run([L(2500, "exempt")], 800, "all").deliveryTaxCents).toBe(0);
  });
  it("none: never", () => {
    expect(run(mixed, 800, "none").deliveryTaxCents).toBe(0);
    expect(run(mixed, 800, "none").itemTaxCents).toBe(289);
  });
  it("FIRSTBITE free delivery: $0 fee means $0 delivery tax in every mode", () => {
    for (const mode of ["none", "proportional", "all"] as const) expect(run(mixed, 0, mode).deliveryTaxCents).toBe(0);
  });
  it("the far-zone fee is taxed too: $19.50 at 20 miles, all taxable", () => {
    // 19.50 x .0825 = 1.60875 -> 161
    expect(run([L(3500, "taxable")], 1950, "proportional").deliveryTaxCents).toBe(161);
  });
  it("total tax = item tax + delivery tax", () => {
    const r = run(mixed, 800, "proportional");
    expect(r.taxCents).toBe(r.itemTaxCents + r.deliveryTaxCents);
    expect(r.taxCents).toBe(328);
  });
});
