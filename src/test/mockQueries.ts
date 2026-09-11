/** Drop-in replacement for hooks/queries used by tests and `npm run demo`.
 *  Returns fixture data synchronously; writes are no-ops that resolve. */
import { useMutation } from "@tanstack/react-query";
import * as F from "./fixtures";
import { inRange, type DateRange } from "../lib/dates";

const ok = <T,>(data: T) => ({ data, isLoading: false, error: null, isError: false, refetch: async () => ({ data }) });
export function useSettings() { return ok(F.SETTINGS); }
export function useTaxSettings() { return ok(F.TAX); }
export function useProducts() { return ok(F.PRODUCTS); }
export function useProduct(id?: string) { return ok(F.PRODUCTS.find((p) => p.id === id) ?? F.PRODUCTS[0]); }
export function useCategories() { return ok(F.CATS); }
export function useIngredients() { return ok([]); }
export function useRecipes() { return ok([]); }
export function useOrderFinancials(range: DateRange) { return ok(F.FIN.filter((o) => inRange(o.created_at, range))); }
export function useAllOrderFinancials() { return ok(F.FIN); }
export function useProductSales(range: DateRange) { return ok(F.SALES.filter((o) => inRange(o.created_at, range))); }
export function useProductSalesFor(id?: string) { return ok(F.SALES.filter((s) => s.product_id === id)); }
export function useOrders() { return ok(F.ORDERS); }
export function useOrder(id?: string) { return ok(F.ORDERS.find((o) => o.id === id) ?? F.ORDERS[0]); }
export function useAudit() { return ok([]); }
export function useCustomers() { return ok(F.CUSTOMERS); }
export function useCustomer(id?: string) { return ok(F.CUSTOMERS.find((c) => c.id === id) ?? F.CUSTOMERS[0]); }
export function usePayments(range?: DateRange) { return ok(range ? F.PAYMENTS.filter((p) => inRange(p.paid_at, range)) : F.PAYMENTS); }
export function useRefunds(range?: DateRange) { return ok(range ? F.REFUNDS.filter((p) => inRange(p.refunded_at, range)) : F.REFUNDS); }
export function useExpenses(range?: DateRange) { return ok(range ? F.EXPENSES.filter((e) => inRange(e.expense_date + "T12:00:00", range)) : F.EXPENSES); }
export function useExpenseCategories() { return ok([{ id: "x1", name: "Ingredients", cost_type: "direct_product", sort_order: 1 }, { id: "x2", name: "Marketing", cost_type: "operating", sort_order: 2 }, { id: "x3", name: "Bank / payment fees", cost_type: "operating", sort_order: 3 }]); }
export function useDeliveries() { return ok(F.DELIVERIES); }
export function useTaxAdjustments() { return ok([]); }
export function useTaxSummaries() { return ok([]); }
export function useWrite() { return useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn() }); }
export function subscribeOrders() { return () => {}; }
