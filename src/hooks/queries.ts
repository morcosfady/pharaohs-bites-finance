/** Data access. Every query goes through Supabase with the signed-in user's
 *  JWT, so Row Level Security decides what comes back. */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase, unwrap } from "../lib/supabase";
import type {
  BusinessSettings, TaxSettings, Product, ProductCategory, Ingredient, Recipe, Customer, Order, OrderFinancial,
  ProductSale, Payment, Refund, Expense, ExpenseCategory, DeliveryRecord, TaxAdjustment, TaxPeriodSummary, AuditLog,
  BankAccount, BankTransaction, BankRule, ReceiptFile, ExpenseItem, NeedsReceiptRow, ExpenseTaxRow, TaxSummaryRow, TaxQuality, TaxExtras, ExpenseSettings, MileageLog, MileageSettings, IrsMileageRate, MileagePlace,
} from "../lib/types";
import type { DateRange } from "../lib/dates";

const iso = (d: Date) => d.toISOString();

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: async () => unwrap(await supabase.from("business_settings").select("*").eq("id", 1).single()) as BusinessSettings, staleTime: 60_000 });
}
export function useTaxSettings() {
  return useQuery({ queryKey: ["tax_settings"], queryFn: async () => unwrap(await supabase.from("tax_settings").select("*").eq("id", 1).single()) as TaxSettings, staleTime: 60_000 });
}

export function useProducts(includeInactive = true) {
  return useQuery({ queryKey: ["products", includeInactive], queryFn: async () => {
    let q = supabase.from("products").select("*, product_categories(name)").is("deleted_at", null).order("name");
    if (!includeInactive) q = q.eq("is_active", true);
    return unwrap(await q) as Product[];
  }});
}
export function useProduct(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ["product", id], queryFn: async () => unwrap(await supabase.from("products").select("*, product_categories(name)").eq("id", id!).single()) as Product });
}
export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: async () => unwrap(await supabase.from("product_categories").select("*").order("sort_order")) as ProductCategory[], staleTime: 300_000 });
}
export function useIngredients() {
  return useQuery({ queryKey: ["ingredients"], queryFn: async () => unwrap(await supabase.from("ingredients").select("*").is("deleted_at", null).order("name")) as Ingredient[] });
}
export function useRecipes(productId: string | undefined) {
  return useQuery({ enabled: !!productId, queryKey: ["recipes", productId], queryFn: async () => unwrap(await supabase.from("recipes").select("*, ingredients(*)").eq("product_id", productId!)) as Recipe[] });
}

/** Orders in a date range (financial view) — the backbone of every KPI. */
export function useOrderFinancials(range: DateRange) {
  return useQuery({ queryKey: ["order_financials", iso(range.from), iso(range.to)], queryFn: async () =>
    unwrap(await supabase.from("order_financials").select("*").is("deleted_at", null).gte("created_at", iso(range.from)).lte("created_at", iso(range.to)).order("created_at", { ascending: false })) as OrderFinancial[] });
}
export function useAllOrderFinancials() {
  return useQuery({ queryKey: ["order_financials", "all"], queryFn: async () =>
    unwrap(await supabase.from("order_financials").select("*").is("deleted_at", null).order("created_at", { ascending: false }).limit(5000)) as OrderFinancial[] });
}
export function useProductSales(range: DateRange) {
  return useQuery({ queryKey: ["product_sales", iso(range.from), iso(range.to)], queryFn: async () =>
    unwrap(await supabase.from("product_sales").select("*").gte("created_at", iso(range.from)).lte("created_at", iso(range.to))) as ProductSale[] });
}
export function useProductSalesFor(productId: string | undefined) {
  return useQuery({ enabled: !!productId, queryKey: ["product_sales", "product", productId], queryFn: async () =>
    unwrap(await supabase.from("product_sales").select("*").eq("product_id", productId!).order("created_at", { ascending: false })) as ProductSale[] });
}

export function useOrders(opts: { limit?: number } = {}) {
  return useQuery({ queryKey: ["orders", opts.limit ?? 2000], queryFn: async () =>
    unwrap(await supabase.from("orders").select("*, order_items(*), delivery_records(*)").is("deleted_at", null).order("created_at", { ascending: false }).limit(opts.limit ?? 2000)) as Order[] });
}
export function useOrder(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ["order", id], queryFn: async () =>
    unwrap(await supabase.from("orders").select("*, order_items(*), payments(*), refunds(*), delivery_records(*), order_status_history(*)").eq("id", id!).single()) as Order });
}
export function useAudit(table: string, recordId: string | undefined) {
  return useQuery({ enabled: !!recordId, queryKey: ["audit", table, recordId], queryFn: async () =>
    unwrap(await supabase.from("audit_logs").select("*").eq("table_name", table).eq("record_id", recordId!).order("created_at", { ascending: false }).limit(200)) as AuditLog[] });
}

export function useCustomers() {
  return useQuery({ queryKey: ["customers"], queryFn: async () => unwrap(await supabase.from("customers").select("*, customer_addresses(*)").is("deleted_at", null).order("name")) as Customer[] });
}
export function useCustomer(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ["customer", id], queryFn: async () => unwrap(await supabase.from("customers").select("*, customer_addresses(*)").eq("id", id!).single()) as Customer });
}

export function usePayments(range?: DateRange) {
  return useQuery({ queryKey: ["payments", range ? iso(range.from) : "all", range ? iso(range.to) : ""], queryFn: async () => {
    // !inner + deleted_at filter: payments of deleted (e.g. test) orders must never show up.
    let q = supabase.from("payments").select("*, orders!inner(order_number, customer_name, deleted_at)").is("orders.deleted_at", null).order("paid_at", { ascending: false });
    if (range) q = q.gte("paid_at", iso(range.from)).lte("paid_at", iso(range.to));
    return unwrap(await q) as Payment[];
  }});
}
export function useRefunds(range?: DateRange) {
  return useQuery({ queryKey: ["refunds", range ? iso(range.from) : "all", range ? iso(range.to) : ""], queryFn: async () => {
    let q = supabase.from("refunds").select("*, orders!inner(deleted_at)").is("orders.deleted_at", null).order("refunded_at", { ascending: false });
    if (range) q = q.gte("refunded_at", iso(range.from)).lte("refunded_at", iso(range.to));
    return unwrap(await q) as Refund[];
  }});
}

export function useExpenses(range?: DateRange) {
  return useQuery({ queryKey: ["expenses", range ? iso(range.from) : "all", range ? iso(range.to) : ""], queryFn: async () => {
    let q = supabase.from("expenses").select("*, expense_categories(name), expense_sources(source_type)").is("deleted_at", null).order("expense_date", { ascending: false });
    if (range) q = q.gte("expense_date", range.from.toISOString().slice(0, 10)).lte("expense_date", range.to.toISOString().slice(0, 10));
    return unwrap(await q) as Expense[];
  }});
}
/** Expenses waiting for the owner: no category yet, or maybe a duplicate. Not date-filtered. */
export function useReviewExpenses() {
  return useQuery({ queryKey: ["expenses", "review"], queryFn: async () =>
    unwrap(await supabase.from("expenses").select("*, expense_categories(name), expense_sources(source_type)").is("deleted_at", null).neq("review_status", "ok").order("expense_date", { ascending: false })) as Expense[] });
}
/** Bank deposits the rules could not classify yet (never counted as income or expense). */
export function useMoneyIn() {
  return useQuery({ queryKey: ["bank_transactions", "money_in"], queryFn: async () =>
    unwrap(await supabase.from("bank_transactions").select("*, bank_accounts(name, mask)").eq("kind", "money_in").order("posted_on", { ascending: false })) as BankTransaction[] });
}
export interface ExpenseIntegrity { possible_duplicates: number; needs_review: number; expenses_without_source: number; bank_amount_mismatch: number; money_in_unclassified: number; duplicate_bank_links: number }
export function useExpenseIntegrity() {
  return useQuery({ queryKey: ["expense_integrity"], queryFn: async () => unwrap(await supabase.rpc("expense_integrity")) as unknown as ExpenseIntegrity });
}
/* ---- receipts ---- */
export function useReceipts() {
  return useQuery({ queryKey: ["receipt_files"], queryFn: async () =>
    unwrap(await supabase.from("receipt_files").select("id, sha256, storage_path, original_name, mime, size_bytes, source, email_subject, status, outcome, expense_id, parsed, totals_ok, error, created_at").order("created_at", { ascending: false }).limit(200)) as ReceiptFile[] });
}
export function useExpenseItems(expenseId: string | null) {
  return useQuery({ queryKey: ["expense_items", expenseId], enabled: !!expenseId, queryFn: async () =>
    unwrap(await supabase.from("expense_items").select("*").eq("expense_id", expenseId!).order("created_at")) as ExpenseItem[] });
}
export function useNeedsReceipt() {
  return useQuery({ queryKey: ["needs_receipt"], queryFn: async () =>
    unwrap(await supabase.from("needs_receipt_view").select("*").order("expense_date", { ascending: false })) as NeedsReceiptRow[] });
}

/** Spending lines for a period, one per category (a mixed receipt is split by item). Feeds the category breakdown. */
export function useCategoryRows(range: DateRange) {
  return useQuery({ queryKey: ["category_rows", iso(range.from), iso(range.to)], queryFn: async () =>
    unwrap(await supabase.from("expense_tax_view").select("expense_id, expense_date, vendor, category_name, total_amount, line_no").gte("expense_date", range.from.toISOString().slice(0, 10)).lte("expense_date", range.to.toISOString().slice(0, 10))) as unknown as ExpenseTaxRow[] });
}

/* ---- tax pack (income-tax side of expenses) ---- */
const yr = (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` });
export function useTaxSummaryYear(y: number) {
  return useQuery({ queryKey: ["tax_pack", "summary", y], queryFn: async () => unwrap(await supabase.rpc("tax_summary", { p_from: yr(y).from, p_to: yr(y).to })) as unknown as TaxSummaryRow[] });
}
export function useTaxQuality(y: number) {
  return useQuery({ queryKey: ["tax_pack", "quality", y], queryFn: async () => unwrap(await supabase.rpc("tax_data_quality", { p_from: yr(y).from, p_to: yr(y).to })) as unknown as TaxQuality });
}
export function useTaxExtras(y: number) {
  return useQuery({ queryKey: ["tax_pack", "extras", y], queryFn: async () => unwrap(await supabase.rpc("tax_extras", { p_from: yr(y).from, p_to: yr(y).to })) as unknown as TaxExtras });
}
export function useTaxRows(y: number) {
  return useQuery({ queryKey: ["tax_pack", "rows", y], queryFn: async () =>
    unwrap(await supabase.from("expense_tax_view").select("*").gte("expense_date", yr(y).from).lte("expense_date", yr(y).to).order("expense_date")) as ExpenseTaxRow[] });
}
export function useExpenseSettings() {
  return useQuery({ queryKey: ["expense_settings"], queryFn: async () => unwrap(await supabase.from("expense_settings").select("*").limit(1).single()) as ExpenseSettings });
}

/* ---- mileage ---- */
export function useMileageLogs(range?: DateRange) {
  return useQuery({ queryKey: ["mileage_logs", range ? iso(range.from) : "all", range ? iso(range.to) : ""], queryFn: async () => {
    let q = supabase.from("mileage_log_view").select("*").is("deleted_at", null).order("trip_date", { ascending: false }).order("created_at", { ascending: false });
    if (range) q = q.gte("trip_date", range.from.toISOString().slice(0, 10)).lte("trip_date", range.to.toISOString().slice(0, 10));
    return unwrap(await q) as MileageLog[];
  }});
}
export function useMileageSettings() {
  return useQuery({ queryKey: ["mileage_settings"], queryFn: async () => unwrap(await supabase.from("mileage_settings").select("*").limit(1).single()) as MileageSettings });
}
export function useIrsRates() {
  return useQuery({ queryKey: ["irs_mileage_rates"], queryFn: async () => unwrap(await supabase.from("irs_mileage_rates").select("*").order("effective_from", { ascending: false })) as IrsMileageRate[] });
}
export function useMileagePlaces() {
  return useQuery({ queryKey: ["mileage_places"], queryFn: async () => unwrap(await supabase.from("mileage_places").select("*").order("name")) as MileagePlace[] });
}

export function useExpenseCategories() {
  return useQuery({ queryKey: ["expense_categories"], queryFn: async () => unwrap(await supabase.from("expense_categories").select("*").order("sort_order")) as ExpenseCategory[], staleTime: 300_000 });
}

export function useDeliveries() {
  return useQuery({ queryKey: ["deliveries"], queryFn: async () =>
    unwrap(await supabase.from("delivery_records").select("*, orders(order_number, customer_name, address_street, address_city, created_at, delivery_fee, delivery_fee_customer_paid, status)").order("updated_at", { ascending: false })) as DeliveryRecord[] });
}

export function useTaxAdjustments() {
  return useQuery({ queryKey: ["tax_adjustments"], queryFn: async () => unwrap(await supabase.from("tax_adjustments").select("*").order("adjusted_on", { ascending: false })) as TaxAdjustment[] });
}
export function useTaxSummaries() {
  return useQuery({ queryKey: ["tax_summaries"], queryFn: async () => unwrap(await supabase.from("tax_period_summaries").select("*").order("period_start", { ascending: false })) as TaxPeriodSummary[] });
}

/* ---------------------------------------------------------------- bank feed */

export function useBankAccounts() {
  return useQuery({ queryKey: ["bank_accounts"], queryFn: async () =>
    unwrap(await supabase.from("bank_accounts").select("*, bank_items(institution_name, status, last_synced_at, last_error)").order("created_at")) as BankAccount[] });
}

export function useBankTransactions(limit = 200) {
  return useQuery({ queryKey: ["bank_transactions", limit], queryFn: async () =>
    unwrap(await supabase.from("bank_transactions").select("*, bank_accounts(name, mask)").order("posted_on", { ascending: false }).limit(limit)) as BankTransaction[] });
}

export function useBankRules() {
  return useQuery({ queryKey: ["bank_rules"], queryFn: async () =>
    unwrap(await supabase.from("bank_rules").select("*").order("sort_order").order("created_at")) as BankRule[] });
}

/** Calls one of the Plaid edge functions with the signed-in admin's JWT. */
export async function callPlaid<T>(fn: "plaid-link-token" | "plaid-exchange" | "plaid-sync", body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    // Supabase wraps non-2xx responses; surface Plaid's own message when present.
    const detail = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(detail?.error ?? error.message);
  }
  const res = data as { ok?: boolean; error?: string };
  if (res?.ok === false) throw new Error(res.error ?? "request failed");
  return data as T;
}

/** Loads Plaid Link once, from Plaid's own CDN. */
export function loadPlaidLink(): Promise<PlaidLinkFactory> {
  const w = window as unknown as { Plaid?: PlaidLinkFactory };
  if (w.Plaid) return Promise.resolve(w.Plaid);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-plaid-link]");
    const done = () => (w.Plaid ? resolve(w.Plaid) : reject(new Error("Plaid Link failed to load")));
    if (existing) { existing.addEventListener("load", done); existing.addEventListener("error", () => reject(new Error("Plaid Link failed to load"))); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.async = true; s.dataset.plaidLink = "1";
    s.onload = done; s.onerror = () => reject(new Error("Plaid Link failed to load"));
    document.head.appendChild(s);
  });
}

export interface PlaidLinkFactory {
  create(opts: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } }) => void;
    onExit?: (err: { display_message?: string; error_message?: string } | null) => void;
  }): { open: () => void; exit: () => void; destroy: () => void };
}

/** Generic write helper: invalidates everything that could be affected. */
export function useWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { qc.invalidateQueries(); },
  });
}

/** Realtime: refresh order queries when the website inserts an order. */
export function subscribeOrders(onChange: () => void) {
  const ch = supabase.channel("orders-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, onChange)
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}
