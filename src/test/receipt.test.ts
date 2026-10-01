import { describe, it, expect } from "vitest";
import { summarizeMarketing, channelOf, CHANNELS, type MarketingExpense } from "../lib/marketing";
import { breakdown, quickTotals, donutSlices, colorFor, categoryEmoji, PALETTE, OTHER_COLOR } from "../lib/categoryBreakdown";
import type { ExpenseTaxRow } from "../lib/types";
import { fileProblem, receiptStatus, safeName, sha256Hex } from "../lib/receiptUpload";
import { buildSystemPrompt, parseModelJson, normalizeParsed, totalsAddUp, friendlyApiError } from "../../supabase/functions/_shared/receiptSchema";

const CATS = ["Ingredients", "Packaging", "Kitchen supplies", "Other"];

describe("receipt reading helpers", () => {
  it("tells the model the exact categories and the store hints", () => {
    const p = buildSystemPrompt(CATS);
    expect(p).toContain("Ingredients | Packaging | Kitchen supplies | Other");
    expect(p).toMatch(/Costco/); expect(p).toMatch(/Walmart/); expect(p).toMatch(/WebstaurantStore/);
  });

  it("extracts JSON even with a code fence or a sentence around it", () => {
    expect(parseModelJson('```json\n{"total": 5}\n```')).toEqual({ total: 5 });
    expect(parseModelJson('Here you go: {"total": 7} thanks')).toEqual({ total: 7 });
    expect(() => parseModelJson("no json here")).toThrow();
  });

  it("forces the reply into the shape the database expects", () => {
    const p = normalizeParsed({
      vendor: "  Costco  ", date: "2026-10-01", total: "$99.05", tax: "7.55", payment_method: "VISA",
      items: [{ name: "KS flour", qty: 2, unit_price: 5, category: "ingredients" }, { name: "", total: 3 }, { name: "Foil", total: 12, category: "Not a real one", personal: true }],
    }, CATS);
    expect(p.vendor).toBe("Costco"); expect(p.total).toBe(99.05); expect(p.tax).toBe(7.55);
    expect(p.payment_method).toBe("other");
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ name: "KS flour", total: 10, category: "Ingredients" });
    expect(p.items[1]).toMatchObject({ category: "Other", personal: true });
  });

  it("rejects bad dates and keeps refunds positive", () => {
    expect(normalizeParsed({ date: "October 1st", total: -20, is_refund: true }, CATS)).toMatchObject({ date: null, total: 20, is_refund: true });
  });

  it("survives garbage without throwing", () => {
    expect(normalizeParsed(null, CATS)).toMatchObject({ vendor: "", total: 0, items: [] });
    expect(normalizeParsed({ items: "nope", total: "abc" }, CATS).total).toBe(0);
  });

  it("checks that items plus tax equal the total", () => {
    const base = normalizeParsed({ total: 35, tax: 0, items: [{ name: "a", total: 20 }, { name: "b", total: 10 }, { name: "c", total: 5 }] }, CATS);
    expect(totalsAddUp(base)).toBe(true);
    expect(totalsAddUp({ ...base, total: 40 })).toBe(false);
    expect(totalsAddUp({ ...base, total: 37.5, tax: 2.5 })).toBe(true);
    expect(totalsAddUp({ ...base, items: [] })).toBe(true);
  });

  it("explains API problems in plain words", () => {
    expect(friendlyApiError(401, "")).toMatch(/key was rejected/);
    expect(friendlyApiError(400, "Your credit balance is too low")).toMatch(/no credit/);
    expect(friendlyApiError(429, "")).toMatch(/busy/);
    expect(friendlyApiError(529, "")).toMatch(/temporary/);
  });
});

describe("receipt upload helpers", () => {
  it("refuses files that cannot be read, with a reason in plain words", () => {
    expect(fileProblem({ type: "image/jpeg", size: 2_000_000, name: "a.jpg" })).toBeNull();
    expect(fileProblem({ type: "application/pdf", size: 1_000, name: "a.pdf" })).toBeNull();
    expect(fileProblem({ type: "image/heic", size: 1_000, name: "a.heic" })).toMatch(/HEIC/);
    expect(fileProblem({ type: "", size: 1_000, name: "IMG_1.HEIC" })).toMatch(/HEIC/);
    expect(fileProblem({ type: "application/zip", size: 1_000, name: "a.zip" })).toMatch(/photo/);
    expect(fileProblem({ type: "image/png", size: 80_000_000, name: "huge.png" })).toMatch(/too large/);
  });
  it("makes safe storage names", () => {
    expect(safeName("My Receipt (1).jpg")).toBe("My-Receipt-1-.jpg");
    expect(safeName("///")).toBe("receipt");
  });
  it("gives the same fingerprint for the same bytes and a different one otherwise", async () => {
    const a = await sha256Hex(new Blob(["same photo"])), b = await sha256Hex(new Blob(["same photo"])), c = await sha256Hex(new Blob(["other photo"]));
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a).toHaveLength(64);
  });
  it("labels every receipt state for the owner", () => {
    expect(receiptStatus({ status: "waiting_key", outcome: "", totals_ok: null }).text).toMatch(/key/);
    expect(receiptStatus({ status: "failed", outcome: "", totals_ok: null }).tone).toBe("bad");
    expect(receiptStatus({ status: "parsed", outcome: "linked", totals_ok: true }).text).toMatch(/Matched/);
    expect(receiptStatus({ status: "parsed", outcome: "created", totals_ok: false }).text).toMatch(/Check items/);
    expect(receiptStatus({ status: "parsed", outcome: "possible_duplicate", totals_ok: true }).tone).toBe("bad");
  });
});

const row = (category_name: string, total_amount: number, vendor = "V"): ExpenseTaxRow => ({ expense_id: "e", expense_date: "2026-10-01", vendor, description: "", category_id: null, category_name, total_amount, business_pct: 100, receipt_path: "", review_status: "ok", auto_source: null, is_startup: false, line_key: "x", treatment: "deductible", gas_excluded: false, asset_candidate: false, deductible_amount: total_amount, ask_reason: null, line_no: 1 });

describe("category breakdown", () => {
  it("adds each category in cents, biggest first, with its share", () => {
    const b = breakdown([row("Ingredients", 60.1), row("Ingredients", 39.9), row("Gas / mileage", 25), row("Marketing", 75)]);
    expect(b.totalCents).toBe(20000);
    expect(b.categories.map((c) => c.name)).toEqual(["Ingredients", "Marketing", "Gas / mileage"]);
    expect(b.categories[0]).toMatchObject({ cents: 10000, count: 2, share: 0.5 });
  });
  it("sets personal items aside instead of counting them", () => {
    const b = breakdown([row("Ingredients", 30), row("Personal (not business)", 5)]);
    expect(b.totalCents).toBe(3000); expect(b.personalCents).toBe(500);
    expect(b.categories.find((c) => c.name.startsWith("Personal"))).toBeUndefined();
  });
  it("compares with the previous period", () => {
    const b = breakdown([row("Gas / mileage", 60), row("Marketing", 10)], [row("Gas / mileage", 40), row("Marketing", 10)]);
    expect(b.categories.find((c) => c.name === "Gas / mileage")?.change).toBeCloseTo(0.5);
    expect(b.categories.find((c) => c.name === "Marketing")?.change).toBe(0);
    expect(breakdown([row("New thing", 5)], []).categories[0].change).toBeNull();
  });
  it("lists the vendors behind a category", () => {
    const v = breakdown([row("Ingredients", 10, "Costco"), row("Ingredients", 30, "Walmart"), row("Ingredients", 5, "Costco")]).categories[0].vendors;
    expect(v.map((x) => x.vendor)).toEqual(["Walmart", "Costco"]); expect(v[1]).toMatchObject({ cents: 1500, count: 2 });
  });
  it("answers the headline questions: ingredients, packaging, gas, software, fees", () => {
    const q = Object.fromEntries(quickTotals(breakdown([row("Ingredients", 50), row("Packaging", 20), row("Pizza boxes", 10), row("Gas / mileage", 15), row("Website / technology", 100), row("Payment processing fees", 3), row("Bank / payment fees", 2)])).map((g) => [g.key, g.cents]));
    expect(q).toEqual({ ingredients: 5000, packaging: 3000, gas: 1500, software: 10000, fees: 500 });
  });
  it("folds the small categories into one donut slice and keeps the total", () => {
    const cats = breakdown(Array.from({ length: 10 }, (_, i) => row(`Cat ${i}`, 100 - i * 5))).categories;
    const s = donutSlices(cats, 7);
    expect(s).toHaveLength(7); expect(s[6].name).toBe("Everything else");
    expect(s.reduce((t, x) => t + x.cents, 0)).toBe(cats.reduce((t, x) => t + x.cents, 0));
    expect(donutSlices(cats.slice(0, 3), 7)).toHaveLength(3);
  });
  it("gives a category the same colour everywhere, and a grey to the leftovers", () => {
    const order = ["Ingredients", "Packaging"];
    expect(colorFor("Packaging", order)).toBe(PALETTE[1]); expect(colorFor("Packaging", order)).toBe(colorFor("Packaging", order));
    expect(colorFor("Everything else", order)).toBe(OTHER_COLOR);
    expect(categoryEmoji("Gas / mileage")).toBe("⛽"); expect(categoryEmoji("Something new")).toBe("🧾");
  });
  it("copes with no spending", () => { const b = breakdown([]); expect(b.totalCents).toBe(0); expect(b.categories).toEqual([]); });
});

const mk = (marketing_channel: string | null, total_amount: number, vendor = "V", expense_date = "2026-10-05"): MarketingExpense => ({ id: vendor + total_amount, expense_date, vendor, description: "", total_amount, marketing_channel, receipt_path: "" });
describe("marketing by channel", () => {
  it("adds each channel in cents, biggest first, with its share", () => {
    const m = summarizeMarketing([mk("social", 40.1), mk("social", 9.9), mk("flyers_print", 25), mk("online_ads", 25)], [], 0, 0);
    expect(m.totalCents).toBe(10000);
    expect(m.channels[0]).toMatchObject({ key: "social", cents: 5000, count: 2, share: 0.5 });
    expect(m.channels.map((c) => c.key)).toEqual(["social", "flyers_print", "online_ads"]);
  });
  it("puts an unknown or empty channel under Other marketing", () => {
    const m = summarizeMarketing([mk(null, 10), mk("nonsense", 5)], [], 0, 0);
    expect(m.channels).toHaveLength(1); expect(m.channels[0]).toMatchObject({ key: "other", cents: 1500 });
    expect(channelOf("social").label).toBe("Social media"); expect(channelOf(undefined).key).toBe("other");
  });
  it("shows share of sales and marketing cost per order, never dividing by zero", () => {
    const m = summarizeMarketing([mk("social", 50)], [], 50000, 20);
    expect(m.pctOfSales).toBeCloseTo(0.1); expect(m.costPerOrderCents).toBe(250);
    const none = summarizeMarketing([mk("social", 50)], [], 0, 0);
    expect(none.pctOfSales).toBeNull(); expect(none.costPerOrderCents).toBeNull();
  });
  it("compares with the previous period, overall and per channel", () => {
    const m = summarizeMarketing([mk("social", 60), mk("events", 10)], [mk("social", 40), mk("events", 10)], 0, 0);
    expect(m.change).toBeCloseTo(0.4); expect(m.channels.find((c) => c.key === "social")?.change).toBeCloseTo(0.5);
    expect(summarizeMarketing([mk("social", 5)], [], 0, 0).change).toBeNull();
  });
  it("lists the channels you did not use, newest charges first", () => {
    const m = summarizeMarketing([mk("social", 10, "A", "2026-10-01"), mk("social", 10, "B", "2026-10-09")], [], 0, 0);
    expect(m.unused).not.toContain("Social media"); expect(m.unused).toContain("Flyers & print"); expect(m.unused).not.toContain("Other marketing");
    expect(m.channels[0].entries.map((e) => e.vendor)).toEqual(["B", "A"]);
    expect(CHANNELS.map((c) => c.key)).toContain("influencers");
  });
  it("copes with no spend", () => { const m = summarizeMarketing([], [], 0, 0); expect(m.totalCents).toBe(0); expect(m.channels).toEqual([]); });
});
