/* Wording and small maths for the year-end Tax Pack. DRAFT mapping to IRS Schedule C: bookkeeping
   support for the accountant, not tax advice. Everything uncertain is flagged "Ask accountant". */
import type { ExpenseTaxRow, TaxQuality } from "./types";

/** Display order and labels for the draft Schedule C lines. Keys match expense_categories.schedule_c_line. */
export const SCHEDULE_C_LINES: { key: string; label: string; form: string }[] = [
  { key: "cogs_purchases", label: "Cost of goods sold: purchases", form: "Part III" },
  { key: "l8_advertising", label: "Advertising", form: "Line 8" },
  { key: "l9_car", label: "Car and truck expenses", form: "Line 9" },
  { key: "l10_commissions", label: "Commissions and fees", form: "Line 10" },
  { key: "l13_depreciation", label: "Depreciation", form: "Line 13" },
  { key: "l17_legal_prof", label: "Legal and professional services", form: "Line 17" },
  { key: "l18_office", label: "Office expense (software)", form: "Line 18" },
  { key: "l21_repairs", label: "Repairs and maintenance", form: "Line 21" },
  { key: "l22_supplies", label: "Supplies", form: "Line 22" },
  { key: "l23_taxes", label: "Taxes and licenses", form: "Line 23" },
  { key: "l25_utilities", label: "Utilities (business share)", form: "Line 25" },
  { key: "l27a_other", label: "Other expenses", form: "Line 27a" },
  { key: "l30_home", label: "Business use of home", form: "Line 30" },
  { key: "refunds", label: "Customer refunds (reduce sales, not an expense)", form: "Line 2" },
  { key: "startup", label: "Startup costs (before the business start date)", form: "Special" },
  { key: "uncategorized", label: "Uncategorized: needs a category", form: "?" },
];

export const lineLabel = (key: string) => SCHEDULE_C_LINES.find((l) => l.key === key)?.label ?? key;
export const lineForm = (key: string) => SCHEDULE_C_LINES.find((l) => l.key === key)?.form ?? "";
const lineOrder = (key: string) => { const i = SCHEDULE_C_LINES.findIndex((l) => l.key === key); return i < 0 ? 999 : i; };
export const sortLines = <T extends { line_key: string }>(rows: T[]) => [...rows].sort((a, b) => lineOrder(a.line_key) - lineOrder(b.line_key));

/** Startup costs against the first-year limit (draft; the accountant confirms the election). */
export function startupStatus(total: number, limit: number) {
  const cents = (n: number) => Math.round(n * 100);
  return {
    total, limit, withinLimit: cents(total) <= cents(limit),
    remaining: Math.max(cents(limit) - cents(total), 0) / 100, over: Math.max(cents(total) - cents(limit), 0) / 100,
  };
}

/** What must be fixed before the pack is "clean". Warnings are listed in the export, not hidden. */
export function qualityIssues(q: TaxQuality | undefined): { key: string; text: string; blocking: boolean }[] {
  if (!q) return [];
  const out: { key: string; text: string; blocking: boolean }[] = [];
  const add = (key: string, n: number, text: (n: number) => string, blocking: boolean) => { if (n > 0) out.push({ key, text: text(n), blocking }); };
  add("dupes", q.possible_duplicates, (n) => `${n} possible duplicate${n === 1 ? "" : "s"} still to decide`, true);
  add("review", q.needs_review, (n) => `${n} expense${n === 1 ? "" : "s"} waiting for a category`, true);
  add("uncat", q.uncategorized, (n) => `${n} expense${n === 1 ? " has" : "s have"} no category`, true);
  add("in", q.money_in_unclassified, (n) => `${n} deposit${n === 1 ? "" : "s"} not classified yet`, true);
  add("rate", q.mileage_without_rate, (n) => `${n} mileage trip${n === 1 ? " has" : "s have"} no IRS rate`, true);
  add("receipts", q.missing_receipts, (n) => `${n} expense${n === 1 ? " has" : "s have"} no receipt on file`, false);
  add("est", q.mileage_estimated, (n) => `${n} mileage trip${n === 1 ? " uses" : "s use"} estimated miles`, false);
  return out;
}

/** Detail rows for the accountant's CSV. */
export function taxCsvRows(rows: ExpenseTaxRow[]) {
  return rows.map((r) => ({
    date: r.expense_date, vendor: r.vendor, description: r.description, category: r.category_name,
    schedule_c: `${lineForm(r.line_key)} ${lineLabel(r.line_key)}`.trim(), total: Number(r.total_amount).toFixed(2),
    business_use_pct: Number(r.business_pct), deductible: Number(r.deductible_amount).toFixed(2),
    startup: r.is_startup ? "yes" : "", possible_asset: r.asset_candidate ? "yes" : "",
    receipt_on_file: r.receipt_path ? "yes" : "no", ask_accountant: r.ask_reason ?? "",
  }));
}
