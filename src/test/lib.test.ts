import { describe, it, expect } from "vitest";
import { rangeFor, previousRange, inRange, bucketKey } from "../lib/dates";
import { toCsv, parseCsv, isValidDate, isValidMoney, parseMoney } from "../lib/csv";
import { buildCustomerOrderMessage, waLink, mapsLink, fillTemplate, digitsOnly } from "../lib/whatsapp";
import { buildInsights } from "../lib/insights";
import { computeKpis, rankProducts } from "../lib/metrics";
import { FIN, EXPENSES, PAYMENTS, REFUNDS, SALES } from "./fixtures";

describe("date filters", () => {
  const now = new Date("2026-09-11T15:00:00");
  it("today / yesterday", () => {
    const t = rangeFor("today", now); expect(t.from.getDate()).toBe(11); expect(t.to.getHours()).toBe(23);
    const y = rangeFor("yesterday", now); expect(y.from.getDate()).toBe(10);
  });
  it("this week starts Monday", () => { expect(rangeFor("this_week", now).from.getDay()).toBe(1); });
  it("this month / last month / quarter / year", () => {
    expect(rangeFor("this_month", now).from.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(rangeFor("last_month", now).to.getMonth()).toBe(7);
    expect(rangeFor("this_quarter", now).from.getMonth()).toBe(6);
    expect(rangeFor("this_year", now).from.getMonth()).toBe(0);
  });
  it("custom range and previous period of equal length", () => {
    const c = rangeFor("custom", now, { from: new Date("2026-09-01"), to: new Date("2026-09-10") });
    const p = previousRange(c);
    expect(p.to < c.from).toBe(true);
    expect(Math.round((p.to.getTime() - p.from.getTime()) / 86400000)).toBe(Math.round((c.to.getTime() - c.from.getTime()) / 86400000));
    expect(previousRange(rangeFor("this_month", now)).from.getMonth()).toBe(7);
  });
  it("inRange and buckets", () => {
    const m = rangeFor("this_month", now);
    expect(inRange("2026-09-05T10:00:00Z", m)).toBe(true); expect(inRange("2026-08-31T10:00:00Z", m)).toBe(false);
    expect(bucketKey("2026-09-05T10:00:00", m)).toBe("2026-09-05");
    expect(bucketKey("2026-03-05T10:00:00", rangeFor("this_year", now))).toBe("2026-03");
  });
});

describe("csv", () => {
  it("round-trips with quoting", () => {
    const csv = toCsv([{ a: 'He said "hi"', b: "x,y", c: 1.5 }, { a: "plain", b: "", c: null }]);
    const back = parseCsv(csv);
    expect(back.headers).toEqual(["a", "b", "c"]);
    expect(back.rows[0].a).toBe('He said "hi"'); expect(back.rows[0].b).toBe("x,y"); expect(back.rows[1].c).toBe("");
  });
  it("validates dates and money", () => {
    expect(isValidDate("2026-09-01")).toBe(true); expect(isValidDate("09/01/2026")).toBe(false);
    expect(isValidMoney("$1,234.50")).toBe(true); expect(isValidMoney("12.345")).toBe(false); expect(parseMoney("$1,234.50")).toBe(1234.5);
  });
});

describe("whatsapp", () => {
  it("builds wa.me links with country code", () => {
    expect(waLink("(214) 555-0101")).toBe("https://wa.me/12145550101");
    expect(waLink("+1 787 968 4078", "hi there")).toBe("https://wa.me/17879684078?text=hi%20there");
    expect(digitsOnly("+1 (2)")).toBe("12");
  });
  it("maps link", () => { expect(mapsLink({ street: "1 Main St", city: "Dallas", state: "TX", zip: "75201" })).toContain("1%20Main%20St%2C%20Dallas"); });
  it("fills templates", () => { expect(fillTemplate("Hi {name} #{order_number} {unknown}", { name: "A", order_number: "PB-1" })).toBe("Hi A #PB-1 {unknown}"); });
  it("formats the order message and omits empty fields", () => {
    const msg = buildCustomerOrderMessage({ orderNumber: "PB-2026-00001", name: "Fady", phone: "+1 214 555 0101", address: "1 Main St, Dallas, TX 75201", lines: [{ name: "Feteer Meshaltet", quantity: 2, unitPrice: "$14.00", lineTotal: "$28.00" }, { name: "Lentil Soup", quantity: 1, options: "extra lemon", unitPrice: "$7.00", lineTotal: "$7.00" }], subtotal: "$35.00" });
    expect(msg).toContain("Order Number: PB-2026-00001");
    expect(msg).toContain("Phone: +1 214 555 0101");
    expect(msg).not.toContain("Delivery Instructions");
    expect(msg).not.toContain("Requested Date/Time");
    expect(msg).not.toContain("undefined"); expect(msg).not.toContain("null");
    expect(msg).toContain("2. Lentil Soup\n🔢 Quantity: 1\n⚙️ Options: extra lemon");
    expect(msg).toContain("Merchandise Subtotal: $35.00"); expect(msg).toContain("Delivery Fee: To be determined"); expect(msg).toContain("Final Total: To be confirmed");
    expect(msg).toContain("Zelle or Venmo");
    const enc = "https://wa.me/17879684078?text=" + encodeURIComponent(msg);
    expect(decodeURIComponent(enc.split("?text=")[1])).toBe(msg);
  });
  it("includes optional fields when given", () => {
    const msg = buildCustomerOrderMessage({ name: "A", address: "x", instructions: "gate code 1234", requested: "Sat 6pm", lines: [], subtotal: "$0.00" });
    expect(msg).toContain("Delivery Instructions: gate code 1234"); expect(msg).toContain("Requested Date/Time: Sat 6pm"); expect(msg).not.toContain("Order Number");
  });
});

describe("insights", () => {
  it("produces deterministic sentences from the numbers", () => {
    const cur = computeKpis({ orders: FIN, expenses: EXPENSES, payments: PAYMENTS, refunds: REFUNDS, includeLabor: false });
    const prev = computeKpis({ orders: FIN.slice(0, 2), expenses: [], payments: [], refunds: [], includeLabor: false });
    const out = buildInsights({ current: cur, previous: prev, products: rankProducts(SALES, false), prevProducts: [], pendingWhatsapp: 1, unpaidCount: 2, lowMarginPct: 0.3, taxDueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), periodLabel: "month" });
    const text = out.map((i) => i.text).join("\n");
    expect(text).toContain("best seller by units"); expect(text).toContain("1 pending order has not been confirmed"); expect(text).toContain("2 orders remain unpaid"); expect(text).toMatch(/due in [45] days/);
    expect(out.every((i) => !/NaN|undefined/.test(i.text))).toBe(true);
  });
});

/* ---- Expenses review helpers ---------------------------------------------- */
import { ruleText, sourceBadges, ruleActionLabel } from "../lib/expenseReview";
describe("expense review helpers", () => {
  it("turns a messy bank description into a rule text", () => {
    expect(ruleText("WAL-MART #1234 DALLAS TX")).toBe("WAL-MART");
    expect(ruleText("DEPOSIT ID NUMBER 28114")).toBe("DEPOSIT ID NUMBER");
    expect(ruleText("Zelle payment from FADY MORCOS WFCT22N8QTN3")).toBe("ZELLE PAYMENT FROM FADY MORCOS");
    expect(ruleText("COSTCO")).toBe("COSTCO");
    expect(ruleText("  ab ")).toBe("AB");
  });
  it("shows each kind of evidence once, in a stable order", () => {
    const b = sourceBadges([{ source_type: "receipt" }, { source_type: "bank" }, { source_type: "bank" }]);
    expect(b.map((x) => x.key)).toEqual(["bank", "receipt"]);
    expect(sourceBadges(undefined)).toEqual([]);
  });
  it("labels rule actions", () => {
    expect(ruleActionLabel("owner_contribution")).toBe("Owner contribution");
    expect(ruleActionLabel("whatever")).toBe("whatever");
  });
});

/* ---- mileage helpers -------------------------------------------------------- */
import { summarizeMileage, routeCandidates, formatCents } from "../lib/mileage";
import type { MileageLog } from "../lib/types";
const trip = (o: Partial<MileageLog>): MileageLog => ({ id: "t", trip_date: "2026-10-10", kind: "delivery", purpose: "", from_label: "", to_label: "", miles: 10, order_id: null, vehicle: "", notes: "", estimated: false, auto: false, route_id: null, deleted_at: null, cents_per_mile: 76, rate_confirmed: true, deduction: 7.6, counted: true, ...o });
describe("mileage summary", () => {
  it("adds only counted trips and prices them in cents", () => {
    const s = summarizeMileage([trip({ miles: 10.1, deduction: 7.68 }), trip({ miles: 5, deduction: 3.8 }), trip({ miles: 99, deduction: 75.24, counted: false })]);
    expect(s.miles).toBe(15.1); expect(s.deduction).toBe(11.48); expect(s.trips).toBe(2);
  });
  it("flags missing and unconfirmed rates instead of treating them as zero", () => {
    const s = summarizeMileage([trip({ deduction: null, cents_per_mile: null, rate_confirmed: null }), trip({ rate_confirmed: false })]);
    expect(s.missingRate).toBe(1); expect(s.unconfirmed).toBe(true);
  });
  it("tracks how many miles are estimates", () => {
    expect(summarizeMileage([trip({ miles: 4, estimated: true }), trip({ miles: 6 })]).estimatedMiles).toBe(4);
  });
  it("offers only same-day, live, un-routed deliveries for a route", () => {
    const rows = [trip({ id: "a" }), trip({ id: "b", route_id: "r" }), trip({ id: "c", trip_date: "2026-10-11" }), trip({ id: "d", kind: "supply" })];
    expect(routeCandidates(rows, "2026-10-10").map((r) => r.id)).toEqual(["a"]);
  });
  it("formats rates", () => { expect(formatCents(76)).toBe("76¢"); expect(formatCents(72.5)).toBe("72.5¢"); expect(formatCents(null)).toBe("no rate"); });
});

/* ---- tax pack helpers --------------------------------------------------------- */
import { SCHEDULE_C_LINES, lineLabel, sortLines, startupStatus, qualityIssues, taxCsvRows } from "../lib/taxpack";
import type { ExpenseTaxRow, TaxQuality } from "../lib/types";
describe("tax pack helpers", () => {
  it("has unique line keys and labels every known line", () => {
    const keys = SCHEDULE_C_LINES.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(lineLabel("l8_advertising")).toBe("Advertising");
    expect(lineLabel("unknown_line")).toBe("unknown_line");
  });
  it("sorts lines in Schedule C order, unknown last", () => {
    expect(sortLines([{ line_key: "l27a_other" }, { line_key: "zzz" }, { line_key: "cogs_purchases" }]).map((r) => r.line_key)).toEqual(["cogs_purchases", "l27a_other", "zzz"]);
  });
  it("compares startup costs with the limit", () => {
    expect(startupStatus(188.05, 5000)).toMatchObject({ withinLimit: true, remaining: 4811.95, over: 0 });
    expect(startupStatus(5200, 5000)).toMatchObject({ withinLimit: false, remaining: 0, over: 200 });
  });
  it("lists what blocks a clean pack and what is only a warning", () => {
    const q: TaxQuality = { needs_review: 1, possible_duplicates: 0, uncategorized: 1, missing_receipts: 4, money_in_unclassified: 1, mileage_without_rate: 0, mileage_estimated: 3, ask_accountant: 5 };
    const issues = qualityIssues(q);
    expect(issues.filter((i) => i.blocking).map((i) => i.key)).toEqual(["uncat", "in"]);
    expect(qualityIssues({ ...q, needs_review: 3, uncategorized: 1 }).some((i) => i.key === "review")).toBe(true);
    expect(issues.filter((i) => !i.blocking).map((i) => i.key)).toEqual(["receipts", "est"]);
    expect(qualityIssues({ needs_review: 0, possible_duplicates: 0, uncategorized: 0, missing_receipts: 0, money_in_unclassified: 0, mileage_without_rate: 0, mileage_estimated: 0, ask_accountant: 0 })).toEqual([]);
    expect(qualityIssues(undefined)).toEqual([]);
    const rc = (n: number, min?: number) => qualityIssues({ needs_review: 0, possible_duplicates: 0, uncategorized: 0, missing_receipts: n, money_in_unclassified: 0, mileage_without_rate: 0, mileage_estimated: 0, ask_accountant: 0, receipt_min: min })[0]?.text;
    expect(rc(1, 75)).toBe("1 expense of $75 or more has no receipt on file");
    expect(rc(3, 75)).toBe("3 expenses of $75 or more have no receipt on file");
    expect(rc(2, 0)).toBe("2 expenses have no receipt on file");
    expect(rc(0, 75)).toBeUndefined();
  });
  it("builds accountant CSV rows with the line, deduction and flags", () => {
    const r = { expense_id: "e", expense_date: "2027-03-01", vendor: "Verizon", description: "", category_id: "c", category_name: "Phone & internet", total_amount: 100, business_pct: 40, receipt_path: "", review_status: "ok", auto_source: null, is_startup: false, line_key: "l25_utilities", treatment: "deductible", gas_excluded: false, asset_candidate: false, deductible_amount: 40, ask_reason: "Business use 40%." } as ExpenseTaxRow;
    expect(taxCsvRows([r])[0]).toMatchObject({ schedule_c: "Line 25 Utilities (business share)", total: "100.00", deductible: "40.00", receipt_on_file: "no", ask_accountant: "Business use 40%." });
  });
});


/* ---- delivery profit ----------------------------------------------------------- */
import { deliveryLine, summarizeDeliveries, buildDeliveryLines, type DeliveryOrder } from "../lib/deliveryProfit";
const dOrder = (o: Partial<DeliveryOrder> = {}): DeliveryOrder => ({ id: "o", order_number: "PB-1", created_at: "2026-10-05T12:00:00Z", completed_at: null, status: "completed", customer_name: "Sara", address_city: "Plano", delivery_fee: 39.65, delivery_fee_customer_paid: true, delivery_miles: 19.8, delivery_records: null, ...o });
describe("delivery profit", () => {
  it("profit = what the customer paid for delivery minus gas for the round trip", () => {
    const l = deliveryLine(dOrder(), 0.67, true);
    expect(l.feeCents).toBe(3965); expect(l.tripMiles).toBe(39.6);
    expect(l.costCents).toBe(2653); expect(l.profitCents).toBe(1312); expect(l.costKind).toBe("estimate");
  });
  it("counts one way when round trip is off", () => {
    expect(deliveryLine(dOrder({ delivery_miles: 10 }), 0.5, false).costCents).toBe(500);
  });
  it("a real cost typed on the order wins over the estimate", () => {
    const l = deliveryLine(dOrder({ delivery_records: { distance_miles: 19.8, actual_cost: 12 } }), 0.67, true);
    expect(l.costCents).toBe(1200); expect(l.costKind).toBe("actual"); expect(l.profitCents).toBe(2765);
  });
  it("uses the delivery record miles when the order has none, and accepts a one-item list", () => {
    const l = deliveryLine(dOrder({ delivery_miles: null, delivery_records: [{ distance_miles: 5, actual_cost: 0 }] }), 1, true);
    expect(l.tripMiles).toBe(10); expect(l.costCents).toBe(1000);
  });
  it("never invents gas for an order with no miles: cost is unknown and flagged", () => {
    const l = deliveryLine(dOrder({ delivery_miles: null }), 0.67, true);
    expect(l.costKind).toBe("unknown"); expect(l.costCents).toBe(0); expect(l.tripMiles).toBeNull();
  });
  it("a delivery fee the customer did not pay counts as zero paid", () => {
    expect(deliveryLine(dOrder({ delivery_fee_customer_paid: false }), 0.67, true).feeCents).toBe(0);
  });
  it("only real orders count: not cancelled, refunded or still pending", () => {
    const lines = buildDeliveryLines([dOrder({ id: "a" }), dOrder({ id: "b", status: "cancelled" }), dOrder({ id: "c", status: "pending_whatsapp_confirmation" }), dOrder({ id: "d", status: "refunded" }), dOrder({ id: "e", status: "confirmed" })], 0.67, true);
    expect(lines.map((l) => l.id)).toEqual(["a", "e"]);
  });
  it("totals paid, gas and profit and counts the losers", () => {
    const lines = [deliveryLine(dOrder({ id: "1" }), 0.67, true), deliveryLine(dOrder({ id: "2", delivery_fee: 8, delivery_miles: 15 }), 0.67, true), deliveryLine(dOrder({ id: "3", delivery_miles: null }), 0.67, true)];
    const s = summarizeDeliveries(lines);
    expect(s.orders).toBe(3); expect(s.paidCents).toBe(3965 + 800 + 3965);
    expect(s.costCents).toBe(2653 + 2010); expect(s.profitCents).toBe(s.paidCents - s.costCents);
    expect(s.losing).toBe(1); expect(s.unknownCost).toBe(1); expect(s.estimated).toBe(2); expect(s.miles).toBe(69.6);
  });
  it("copes with no deliveries", () => {
    expect(summarizeDeliveries([])).toMatchObject({ orders: 0, paidCents: 0, profitCents: 0, margin: null, avgProfitCents: 0 });
  });
});
