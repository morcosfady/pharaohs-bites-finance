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
    expect(text).toContain("best seller by units"); expect(text).toContain("1 pending WhatsApp order has not been confirmed"); expect(text).toContain("2 orders remain unpaid"); expect(text).toMatch(/due in [45] days/);
    expect(out.every((i) => !/NaN|undefined/.test(i.text))).toBe(true);
  });
});
