import { describe, it, expect } from "vitest";
import { computeKpis, rankProducts, productUnitCost } from "../lib/metrics";
import { toCents, fmt, allocate, taxOn, change } from "../lib/money";
import { FIN, EXPENSES, PAYMENTS, REFUNDS, SALES, PRODUCTS } from "./fixtures";

const base = { orders: FIN, expenses: EXPENSES, payments: PAYMENTS, refunds: REFUNDS, includeLabor: false };

describe("money", () => {
  it("converts to cents without float drift", () => { expect(toCents("19.99")).toBe(1999); expect(toCents(0.1 + 0.2)).toBe(30); expect(toCents(null)).toBe(0); });
  it("formats", () => { expect(fmt(4048)).toBe("$40.48"); expect(fmt(-500)).toBe("-$5.00"); expect(fmt(1234567, { compact: true })).toBe("$12.3k"); });
  it("allocates a discount across lines so cents add up", () => { const a = allocate(500, [2800, 700]); expect(a[0] + a[1]).toBe(500); expect(a[0]).toBe(400); });
  it("estimates tax", () => { expect(taxOn(3000, 0.0825)).toBe(248); expect(taxOn(0, 0.0825)).toBe(0); });
  it("percentage change handles zero previous", () => { expect(change(10, 0)).toBeNull(); expect(change(0, 0)).toBe(0); expect(change(150, 100)).toBeCloseTo(0.5); });
});

describe("computeKpis", () => {
  const k = computeKpis(base);
  it("excludes cancelled and pending orders from sales", () => {
    // revenue orders: o1 (35-5), o2 (24), o5 (24), o6 (42) => gross 125, discounts 5
    expect(k.grossSales).toBe(12500);
    expect(k.discounts).toBe(500);
    expect(k.cancelledOrders).toBe(1);
    expect(k.completedOrders).toBe(2);
    expect(k.pendingOrders).toBe(2); // o3 pending + o6 confirmed (open)
  });
  it("nets refunds out of sales and never counts tax as revenue", () => {
    expect(k.refunds).toBe(1200);
    expect(k.netSales).toBe(12500 - 500 - 1200);
    expect(k.taxCollected).toBe(toCents(2.48) + toCents(3.47));
    expect(k.netSales).not.toContain; // tax not in netSales: 10800
    expect(k.netSales).toBe(10800);
  });
  it("counts only customer-paid delivery fees as revenue", () => { expect(k.deliveryFees).toBe(800 + 500 + 800); });
  it("cash collected ignores voided payments", () => { expect(k.cashCollected).toBe(toCents(40.48) + 2400 + 2900 + 2000); });
  it("computes COGS, gross profit and contribution profit", () => {
    const cogs = toCents(8.2) + 1100 + 1100 + toCents(10.05);
    expect(k.cogs).toBe(cogs);
    expect(k.grossProfit).toBe(10800 - cogs);
    const delivery = toCents(4.35) + 300 + toCents(4.35);
    expect(k.contributionProfit).toBe(10800 + 2100 - cogs - delivery - 300 /* bank fees */);
    expect(k.operatingExpenses).toBe(2500); // marketing only; bank fees are processing fees, ingredients are direct
    expect(k.netProfit).toBe(k.contributionProfit - 2500);
  });
  it("outstanding balance excludes cancelled orders", () => { expect(k.outstandingBalance).toBe(toCents(15.16) + 1200 + toCents(33.47)); });
  it("includes labor when enabled", () => { const l = computeKpis({ ...base, includeLabor: true }); expect(l.grossProfit).toBe(k.grossProfit - (toCents(11.25) + 1250 + 1250 + 1500)); });
  it("tax liability subtracts refunded tax and adds adjustments", () => {
    const withTaxRefund = computeKpis({ ...base, refunds: [{ ...REFUNDS[0], tax_portion: 1 }], taxAdjustments: -50 });
    expect(withTaxRefund.taxLiability).toBe(k.taxCollected - 100 - 50);
  });
  it("margins are null when there are no sales", () => { const e = computeKpis({ orders: [], expenses: [], payments: [], refunds: [], includeLabor: false }); expect(e.grossMargin).toBeNull(); expect(e.avgOrderValue).toBeNull(); });
});

describe("rankProducts", () => {
  const r = rankProducts(SALES, false);
  it("ranks by net revenue and ignores cancelled/pending lines", () => {
    expect(r[0].name).toBe("Feteer Meshaltet");
    expect(r[0].units).toBe(5); // 2 completed + 3 confirmed; cancelled 5 and pending 1 excluded
    expect(r[0].gross).toBe(2800 + 4200);
    expect(r[0].discounts).toBe(400);
    expect(r[0].orders).toBe(2);
  });
  it("computes cost, profit and margin", () => {
    const cake = r.find((x) => x.name === "Small Round Cake")!;
    expect(cake.units).toBe(4); expect(cake.cost).toBe(2200); expect(cake.profit).toBe(4800 - 2200); expect(cake.margin).toBeCloseTo(2600 / 4800); expect(cake.refunds).toBe(1);
  });
});

describe("productUnitCost", () => {
  it("adds ingredient + packaging + other and optional labor", () => {
    expect(productUnitCost(PRODUCTS[0], 15, false)).toBe(210 + 125);
    expect(productUnitCost(PRODUCTS[0], 15, true)).toBe(210 + 125 + 500);
  });
});
