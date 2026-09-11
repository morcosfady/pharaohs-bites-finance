/** Data access. Every query goes through Supabase with the signed-in user's
 *  JWT, so Row Level Security decides what comes back. */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase, unwrap } from "../lib/supabase";
import type {
  BusinessSettings, TaxSettings, Product, ProductCategory, Ingredient, Recipe, Customer, Order, OrderFinancial,
  ProductSale, Payment, Refund, Expense, ExpenseCategory, DeliveryRecord, TaxAdjustment, TaxPeriodSummary, AuditLog,
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
    let q = supabase.from("payments").select("*, orders(order_number, customer_name)").order("paid_at", { ascending: false });
    if (range) q = q.gte("paid_at", iso(range.from)).lte("paid_at", iso(range.to));
    return unwrap(await q) as Payment[];
  }});
}
export function useRefunds(range?: DateRange) {
  return useQuery({ queryKey: ["refunds", range ? iso(range.from) : "all", range ? iso(range.to) : ""], queryFn: async () => {
    let q = supabase.from("refunds").select("*").order("refunded_at", { ascending: false });
    if (range) q = q.gte("refunded_at", iso(range.from)).lte("refunded_at", iso(range.to));
    return unwrap(await q) as Refund[];
  }});
}

export function useExpenses(range?: DateRange) {
  return useQuery({ queryKey: ["expenses", range ? iso(range.from) : "all", range ? iso(range.to) : ""], queryFn: async () => {
    let q = supabase.from("expenses").select("*, expense_categories(name)").is("deleted_at", null).order("expense_date", { ascending: false });
    if (range) q = q.gte("expense_date", range.from.toISOString().slice(0, 10)).lte("expense_date", range.to.toISOString().slice(0, 10));
    return unwrap(await q) as Expense[];
  }});
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
