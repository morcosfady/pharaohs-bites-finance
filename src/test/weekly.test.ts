import { describe, it, expect } from "vitest";
import { toGalleryItems, groupByMonth, filterGallery, monthsOf, monthLabel } from "../lib/gallery";
import { dueLabel, totalDue, budgetTone, budgetView } from "../lib/bills";
import { trendData, topVendors } from "../lib/trends";
import { parseSize, itemKey, unitPrice, buildIngredientPrices } from "../lib/ingredients";
import { suggestedPackagePrice, lineCost, dishImpact, priceChange, familyOf } from "../lib/priceBook";
import { formatWeeklySummary, type WeeklySummary } from "../../supabase/functions/_shared/weeklySummary";

const base: WeeklySummary = { from: "2026-09-21", to: "2026-09-27", spent: 250.5, prev_spent: 200, sales: 400, profit: 149.5, top_categories: [{ name: "Ingredients", amount: 120 }, { name: "Marketing", amount: 60 }], biggest: { vendor: "Costco", amount: 98.2, date: "2026-09-23" }, budgets: [], bills: [], price_jumps: [], possible_duplicates: 0, needs_receipt: 0, waiting_receipts: 0 };

describe("weekly Telegram summary", () => {
  it("says what was spent, the change, sales and what is left", () => {
    const t = formatWeeklySummary(base);
    expect(t).toContain("Sep 21 to Sep 27"); expect(t).toContain("$250.50"); expect(t).toContain("up 25% vs last week");
    expect(t).toContain("$400.00"); expect(t).toContain("$149.50"); expect(t).toContain("1. Ingredients: $120.00"); expect(t).toContain("Costco $98.20");
  });
  it("shows a loss with a minus sign and no raw negative formatting", () => {
    const t = formatWeeklySummary({ ...base, sales: 100, profit: -150.5 });
    expect(t).toContain("-$150.50"); expect(t).toContain("🔻");
  });
  it("flags budgets, price jumps, duplicates and missing receipts under 'Needs a look'", () => {
    const t = formatWeeklySummary({ ...base, budgets: [{ category: "Marketing", spent: 92, limit: 100, pct: 92 }, { category: "Gas", spent: 130, limit: 100, pct: 130 }], price_jumps: [{ item: "Butter 8oz", store: "Costco", old: 5, new: 6, pct: 0.2 }], possible_duplicates: 2, needs_receipt: 1, waiting_receipts: 3 });
    expect(t).toContain("Needs a look"); expect(t).toContain("⚠️ Budget Marketing: 92% used"); expect(t).toContain("🚨 Budget Gas: 130% used");
    expect(t).toContain("Butter 8oz is up 20% at Costco ($5.00 to $6.00)"); expect(t).toContain("2 possible duplicates"); expect(t).toContain("1 store charge still without a receipt"); expect(t).toContain("3 receipts waiting");
  });
  it("lists bills due in the next 7 days, or says there are none", () => {
    expect(formatWeeklySummary({ ...base, bills: [{ vendor: "Anthropic", amount: 100, due: "2026-09-30" }] })).toContain("Anthropic $100.00 on Sep 30");
    expect(formatWeeklySummary(base)).toContain("No bills due in the next 7 days");
  });
  it("handles a quiet week and does not break Telegram HTML", () => {
    expect(formatWeeklySummary({ ...base, spent: 0, sales: 0, profit: 0, top_categories: [], biggest: null })).toContain("A quiet week");
    const t = formatWeeklySummary({ ...base, top_categories: [{ name: "R&D <b>", amount: 1 }] });
    expect(t).toContain("R&amp;D &lt;b&gt;"); expect(t).not.toContain("R&D <b>");
  });
});


describe("bills coming up and budgets", () => {
  const today = new Date(2026, 9, 1); // Oct 1 2026
  it("words the due date", () => {
    expect(dueLabel("2026-10-01", today)).toBe("today"); expect(dueLabel("2026-10-02", today)).toBe("tomorrow");
    expect(dueLabel("2026-10-06", today)).toBe("in 5 days"); expect(dueLabel("2026-09-28", today)).toBe("3 days ago");
  });
  it("adds only the bills inside the window", () => {
    const bills = [{ amount: 100, due: "2026-10-05" }, { amount: 49.99, due: "2026-10-30" }, { amount: 300, due: "2026-12-01" }];
    expect(totalDue(bills, 30, today)).toBe(14999); expect(totalDue(bills, 7, today)).toBe(10000);
  });
  it("colours a budget green, amber from 80% and red from 100%", () => {
    expect(budgetTone(40)).toBe("ok"); expect(budgetTone(79.9)).toBe("ok"); expect(budgetTone(80)).toBe("near"); expect(budgetTone(100)).toBe("over");
  });
  it("shows what is left, or how far over", () => {
    expect(budgetView({ spent: 85, monthly_limit: 100 })).toMatchObject({ pct: 85, leftCents: 1500, tone: "near", drawPct: 85 });
    expect(budgetView({ spent: 130, monthly_limit: 100 })).toMatchObject({ drawPct: 100, leftCents: -3000, tone: "over" });
  });
});

describe("monthly trend and top vendors", () => {
  const r = (expense_date: string, category_name: string, total_amount: number, vendor = "V") => ({ expense_date, category_name, total_amount, vendor });
  it("buckets the last 12 months, oldest first, with a label per month", () => {
    const t = trendData([r("2026-10-05", "Ingredients", 50)], new Date(2026, 9, 15), 12, 5);
    expect(t.months).toHaveLength(12); expect(t.months[11]).toMatchObject({ key: "2026-10", label: "Oct", totalCents: 5000 }); expect(t.months[0].key).toBe("2025-11");
  });
  it("keeps the top categories and folds the rest into Everything else", () => {
    const rows = ["A", "B", "C", "D", "E", "F", "G"].map((c, i) => r("2026-10-05", c, 100 - i * 10));
    const t = trendData(rows, new Date(2026, 9, 15), 3, 5);
    expect(t.categories).toEqual(["A", "B", "C", "D", "E", "Everything else"]);
    expect(t.months[2].parts["Everything else"]).toBe(5000 + 4000); expect(t.maxCents).toBe(t.months[2].totalCents);
  });
  it("ignores personal items and months outside the window", () => {
    const t = trendData([r("2026-10-05", "Personal (not business)", 9), r("2020-01-01", "Ingredients", 9)], new Date(2026, 9, 15));
    expect(t.maxCents).toBe(0);
  });
  it("ranks vendors and spots a vendor charging more per order", () => {
    const cur = [r("2026-10-01", "x", 50, "Costco"), r("2026-10-02", "x", 70, "costco"), r("2026-10-03", "x", 10, "Aldi")];
    const prev = [r("2026-09-01", "x", 40, "Costco"), r("2026-09-02", "x", 40, "Costco")];
    const v = topVendors(cur, prev);
    expect(v[0]).toMatchObject({ vendor: "Costco", cents: 12000, count: 2, avgCents: 6000 }); expect(v[0].avgChange).toBeCloseTo(0.5);
    expect(v[1].vendor).toBe("Aldi"); expect(v[1].avgChange).toBeNull();
  });
});

describe("ingredient prices", () => {
  it("reads sizes and converts to pounds, gallons or each", () => {
    expect(parseSize("King Arthur flour 25 lb")).toEqual({ amount: 25, kind: "lb" });
    expect(parseSize("Butter 8oz")?.amount).toBeCloseTo(0.5); expect(parseSize("Whole milk 1 gal")).toEqual({ amount: 1, kind: "gal" });
    expect(parseSize("Cream 16 fl oz")?.kind).toBe("gal"); expect(parseSize("Eggs 18 ct")).toEqual({ amount: 18, kind: "each" });
    expect(parseSize("Olive oil 1 L")?.amount).toBeCloseTo(0.264, 2); expect(parseSize("Mystery item")).toBeNull();
  });
  it("matches the same product across receipts like the database does", () => {
    expect(itemKey("KERRYGOLD BUTTER 8 OZ")).toBe(itemKey("Kerrygold butter 8oz"));
    expect(itemKey("Kerrygold butter 8oz")).toBe("kerrygold butter oz");
  });
  it("prices per pound when it can, per item when it cannot", () => {
    expect(unitPrice({ description: "Flour 25 lb", quantity: 1, unit_price: 20, line_total: 20, store: "S", date: "d" })).toMatchObject({ unit: "/lb", normalized: true });
    expect(unitPrice({ description: "Flour 25 lb", quantity: 2, unit_price: 20, line_total: 40, store: "S", date: "d" })?.price).toBeCloseTo(0.8);
    expect(unitPrice({ description: "Mystery", quantity: 1, unit_price: 3, line_total: 3, store: "S", date: "d" })).toMatchObject({ unit: "each", normalized: false });
  });
  it("flags a price rise at the same store and the cheaper store, newest first", () => {
    const it = (description: string, store: string, date: string, total: number) => ({ description, quantity: 1, unit_price: total, line_total: total, store, date });
    const now = new Date("2026-10-10T12:00:00Z");
    const list = buildIngredientPrices([
      it("Butter 8 oz", "Costco", "2026-09-01", 5), it("Butter 8 oz", "Costco", "2026-10-05", 6), it("Butter 8 oz", "Aldi", "2026-10-02", 4),
      it("Rice 10 lb", "Walmart", "2026-10-01", 8),
    ], now);
    const butter = list.find((x) => x.name.startsWith("Butter"))!;
    expect(butter.change).toBeCloseTo(0.2); expect(butter.cheapest?.store).toBe("Aldi"); expect(butter.savingVsLatest).toBeCloseTo(1 - 8 / 12, 2);
    expect(list[0].name).toMatch(/Butter/);
    expect(list.find((x) => x.name.startsWith("Rice"))!.change).toBeNull();
  });
  it("never compares per-pound with per-item prices", () => {
    const list = buildIngredientPrices([{ description: "Rice 10 lb", quantity: 1, unit_price: 8, line_total: 8, store: "A", date: "2026-10-01" }, { description: "Rice", quantity: 1, unit_price: 3, line_total: 3, store: "B", date: "2026-10-02" }], new Date("2026-10-10"));
    expect(list.length).toBe(2);
  });
});


describe("price book: receipts to dish costs", () => {
  it("costs a recipe line exactly like the database (a $10, 10 lb package, 1 lb used = $1.00)", () => {
    expect(lineCost(1, "lb", 10, "lb", 10, 0)).toBeCloseTo(1, 4);
    expect(lineCost(8, "oz", 1, "lb", 4, 0)).toBeCloseTo(2, 2);            // half a pound of a $4/lb ingredient
    expect(lineCost(1, "lb", 10, "lb", 10, 0.1)).toBeCloseTo(1.1, 4);       // 10% waste
    expect(lineCost(1, "lb", 0, "lb", 10, 0)).toBe(0);                      // no package size: no division by zero
  });
  it("turns a receipt price per pound into a price for your package", () => {
    expect(suggestedPackagePrice(0.8, "/lb", { package_size: 25, package_unit: "lb" })).toEqual({ price: 20 });
    expect(suggestedPackagePrice(4, "/lb", { package_size: 8, package_unit: "oz" })).toEqual({ price: 2 });
    expect(suggestedPackagePrice(3.5, "/gal", { package_size: 1, package_unit: "gallon" })).toEqual({ price: 3.5 });
    expect(suggestedPackagePrice(0.25, "/each", { package_size: 12, package_unit: "piece" })).toEqual({ price: 3 });
  });
  it("refuses to compare things it cannot compare, and says why", () => {
    expect("reason" in suggestedPackagePrice(0.8, "/lb", { package_size: 2, package_unit: "cup" })).toBe(true);     // pounds vs cups needs a density
    expect("reason" in suggestedPackagePrice(3, "each", { package_size: 1, package_unit: "lb" })).toBe(true);        // receipt had no size
    expect(familyOf("Gallon")).toBe("volume"); expect(familyOf("sack")).toBe("unknown");
  });
  const flour = { package_size: 25, package_unit: "lb", package_price: 20, waste_pct: 0 };
  it("previews which dishes move and what happens to their margin", () => {
    const lines = [{ product_id: "a", product: "Feteer", quantity: 2, unit: "lb", waste_pct: 0, product_ingredient_cost: 5, selling_price: 12 }, { product_id: "b", product: "Pita", quantity: 0.5, unit: "lb", waste_pct: 0, product_ingredient_cost: 1, selling_price: 4 }];
    const d = dishImpact(flour, lines, 25);
    expect(d.map((x) => x.product)).toEqual(["Feteer", "Pita"]);
    expect(d[0]).toMatchObject({ deltaCents: 40, oldCostCents: 500, newCostCents: 540 });
    expect(d[0].marginBefore).toBeCloseTo(7 / 12, 3); expect(d[0].marginAfter).toBeCloseTo(6.6 / 12, 3);
    expect(d[1].deltaCents).toBe(10);
  });
  it("adds two lines of the same ingredient in one dish, and a lower price shrinks the cost", () => {
    const two = [{ product_id: "a", product: "Mix", quantity: 1, unit: "lb", waste_pct: 0, product_ingredient_cost: 3, selling_price: 10 }, { product_id: "a", product: "Mix", quantity: 1, unit: "lb", waste_pct: 0, product_ingredient_cost: 3, selling_price: 10 }];
    expect(dishImpact(flour, two, 15)[0]).toMatchObject({ deltaCents: -40, newCostCents: 260 });
  });
  it("uses the higher of the recipe waste and the ingredient waste, like the database", () => {
    const d = dishImpact({ ...flour, waste_pct: 0.1 }, [{ product_id: "a", product: "X", quantity: 2, unit: "lb", waste_pct: 0, product_ingredient_cost: 2, selling_price: 10 }], 25);
    expect(d[0].deltaCents).toBe(44);   // (2.0 - 1.6) * 1.1
  });
  it("measures the price change", () => { expect(priceChange(20, 25)).toBeCloseTo(0.25); expect(priceChange(0, 5)).toBeNull(); });
});


describe("receipt gallery", () => {
  const f = (id: string, storage_path: string, vendor: string, date: string, total: number, mime = "image/jpeg", extra: string[] = []) => ({ id, storage_path, extra_paths: extra, mime, parsed: { vendor, date, total }, email_subject: "", original_name: "file", created_at: "2026-10-01T10:00:00Z", expense_id: "e" + id, source: "upload" as const });
  const files = [f("1", "a.jpg", "Costco", "2026-09-12", 23.48), f("2", "b.pdf", "Walmart", "2026-09-30", 94.69, "application/pdf"), f("3", "", "No picture", "2026-09-30", 5), f("4", "c.jpg", "Ace Mart", "2026-09-12", 241.51, "image/jpeg", ["c2.jpg"]), f("5", "d.png", "Walgreens", "2026-10-01", 12.96, "image/png")];
  it("lists only receipts that have a picture, newest first", () => {
    const g = toGalleryItems(files);
    expect(g.map((i) => i.title)).toEqual(["Walgreens", "Walmart", "Ace Mart", "Costco"]);
    expect(g.find((i) => i.title === "Ace Mart")?.paths).toEqual(["c.jpg", "c2.jpg"]);
  });
  it("groups by month with a label and a total", () => {
    const groups = groupByMonth(toGalleryItems(files));
    expect(groups.map((x) => x.label)).toEqual(["October 2026", "September 2026"]);
    expect(groups[1].items).toHaveLength(3); expect(groups[1].totalCents).toBe(2348 + 9469 + 24151);
    expect(monthLabel("2026-09")).toBe("September 2026");
  });
  it("filters by store name, month and type", () => {
    const all = toGalleryItems(files);
    expect(filterGallery(all, { q: "cost", month: "", kind: "all" }).map((i) => i.title)).toEqual(["Costco"]);
    expect(filterGallery(all, { q: "", month: "2026-10", kind: "all" }).map((i) => i.title)).toEqual(["Walgreens"]);
    expect(filterGallery(all, { q: "", month: "", kind: "pdf" }).map((i) => i.title)).toEqual(["Walmart"]);
    expect(filterGallery(all, { q: "", month: "", kind: "photos" })).toHaveLength(3);
    expect(monthsOf(all)).toEqual(["2026-10", "2026-09"]);
  });
  it("falls back to the file name when the vendor is unknown", () => {
    const g = toGalleryItems([{ ...f("9", "x.jpg", "", "2026-09-01", 0), parsed: {} }]);
    expect(g[0].title).toBe("file"); expect(g[0].totalCents).toBeNull();
  });
});
