/**
 * Financial formulas. Pure functions over view rows so they are testable and
 * the same numbers appear on the dashboard, the reports and the exports.
 *
 * Gross product revenue  = Σ line totals (before discount, tax, delivery)
 * Net product sales      = gross − discounts − product refunds
 * Total revenue          = net product sales + delivery fees retained
 * COGS                   = ingredient + packaging + other direct (+ labor when enabled)
 * Gross profit           = net product sales − COGS
 * Contribution profit    = total revenue − COGS − delivery cost − processing fees − other variable
 * Est. net profit        = contribution − operating expenses
 * Cash collected         = payments received (includes tax + delivery)
 * Sales-tax liability    = tax collected − adjustments/refunded tax
 * Sales tax is NEVER counted in revenue or profit.
 */
import { toCents, sum, ratio, type Cents } from "./money";
import type { OrderFinancial, Expense, Payment, Refund, OrderStatus } from "./types";

export const REVENUE_STATUSES: OrderStatus[] = ["confirmed", "preparing", "ready", "out_for_delivery", "completed", "refunded"];
export const OPEN_STATUSES: OrderStatus[] = ["pending_whatsapp_confirmation", "contacted", "delivery_fee_pending", "awaiting_customer_approval", "confirmed", "preparing", "ready", "out_for_delivery"];

export interface Kpis {
  completedOrders: number; pendingOrders: number; cancelledOrders: number; revenueOrders: number;
  grossSales: Cents; discounts: Cents; refunds: Cents; netSales: Cents; deliveryFees: Cents; taxCollected: Cents;
  cashCollected: Cents; cogs: Cents; packaging: Cents; deliveryCost: Cents; processingFees: Cents; otherVariable: Cents;
  laborCost: Cents; operatingExpenses: Cents; grossProfit: Cents; contributionProfit: Cents; netProfit: Cents;
  grossMargin: number | null; netMargin: number | null; avgOrderValue: Cents | null; avgProfitPerOrder: Cents | null;
  outstandingBalance: Cents; taxLiability: Cents; taxableSales: Cents; nontaxableSales: Cents;
}

export interface MetricInputs {
  orders: OrderFinancial[];          // already filtered to the period (by created_at)
  expenses: Expense[];               // filtered to the period
  payments: Payment[];               // received in period
  refunds: Refund[];                 // issued in period
  includeLabor: boolean;
  taxAdjustments?: Cents;
}

export function computeKpis(i: MetricInputs): Kpis {
  const live = i.orders.filter((o) => !o.deleted_at);
  const rev = live.filter((o) => REVENUE_STATUSES.includes(o.status));
  const completed = live.filter((o) => o.status === "completed");
  const cancelled = live.filter((o) => o.status === "cancelled");
  const pending = live.filter((o) => OPEN_STATUSES.includes(o.status));

  const grossSales = sum(rev.map((o) => toCents(o.gross_product_revenue)));
  const discounts = sum(rev.map((o) => toCents(o.discount)));
  const refunds = sum(i.refunds.filter((r) => !r.voided_at).map((r) => toCents(r.amount) - toCents(r.tax_portion)));
  const refundTax = sum(i.refunds.filter((r) => !r.voided_at).map((r) => toCents(r.tax_portion)));
  const netSales = grossSales - discounts - refunds;
  const deliveryFees = sum(rev.map((o) => toCents(o.delivery_revenue)));
  const taxCollected = sum(rev.map((o) => toCents(o.tax_amount)));
  const cashCollected = sum(i.payments.filter((p) => !p.voided_at).map((p) => toCents(p.amount)));
  const cogs = sum(rev.map((o) => toCents(o.cogs)));
  const packaging = sum(rev.map((o) => toCents(o.packaging_cost)));
  const laborCost = i.includeLabor ? sum(rev.map((o) => toCents(o.labor_cost))) : 0;
  const deliveryCost = sum(rev.map((o) => toCents(o.delivery_cost)));

  const liveExp = i.expenses.filter((e) => !e.deleted_at);
  const catName = (e: Expense) => (e.expense_categories?.name ?? "").toLowerCase();
  const processingFees = sum(liveExp.filter((e) => catName(e).includes("payment fee") || catName(e).includes("bank")).map((e) => toCents(e.total_amount)));
  // Auto-generated order-cost rows mirror the COGS snapshot above, so they are shown in Expenses but not added again here.
  const otherVariable = sum(liveExp.filter((e) => e.cost_type === "direct_product" && !!e.order_id && e.auto_source !== "order_cost").map((e) => toCents(e.total_amount)));
  // Operating expenses exclude direct product purchases (those are in COGS via recipes) and refunds (already netted).
  const operatingExpenses = sum(liveExp.filter((e) => e.cost_type === "operating" && !catName(e).includes("refund") && !catName(e).includes("payment fee") && !catName(e).includes("bank")).map((e) => toCents(e.total_amount)));

  const grossProfit = netSales - cogs - laborCost;
  const totalRevenue = netSales + deliveryFees;
  const contributionProfit = totalRevenue - cogs - laborCost - deliveryCost - processingFees - otherVariable;
  const netProfit = contributionProfit - operatingExpenses;
  const outstandingBalance = sum(live.filter((o) => !["cancelled"].includes(o.status)).map((o) => Math.max(0, toCents(o.balance_due))));

  const taxableSales = taxCollected > 0 ? Math.round(sum(rev.filter((o) => toCents(o.tax_amount) > 0).map((o) => toCents(o.net_product_sales)))) : 0;
  const nontaxableSales = netSales - taxableSales;

  return {
    completedOrders: completed.length, pendingOrders: pending.length, cancelledOrders: cancelled.length, revenueOrders: rev.length,
    grossSales, discounts, refunds, netSales, deliveryFees, taxCollected, cashCollected, cogs, packaging, deliveryCost,
    processingFees, otherVariable, laborCost, operatingExpenses, grossProfit, contributionProfit, netProfit,
    grossMargin: ratio(grossProfit, netSales), netMargin: ratio(netProfit, totalRevenue),
    avgOrderValue: rev.length ? Math.round(netSales / rev.length) : null,
    avgProfitPerOrder: rev.length ? Math.round(contributionProfit / rev.length) : null,
    outstandingBalance, taxLiability: taxCollected - refundTax + (i.taxAdjustments ?? 0),
    taxableSales, nontaxableSales,
  };
}

export const KPI_FORMULAS: Record<string, string> = {
  grossSales: "Sum of product line totals on revenue orders, before discounts, tax and delivery.",
  discounts: "Sum of order discounts on revenue orders.",
  refunds: "Refunds issued in the period, excluding any tax portion.",
  netSales: "Gross sales − discounts − refunds. Sales tax is never included.",
  deliveryFees: "Delivery fees charged to customers (only when the customer pays them).",
  taxCollected: "Estimated sales tax charged on orders. Held for the Comptroller — not income.",
  cashCollected: "Customer payments actually received (includes tax and delivery).",
  cogs: "Ingredient + packaging + other direct costs, using the cost snapshot stored on each order line.",
  packaging: "Packaging portion of COGS.",
  deliveryCost: "Actual delivery cost recorded on delivery records (fuel, courier).",
  processingFees: "Expenses in the Bank / payment fees category.",
  otherVariable: "Direct-cost expenses linked to a specific order.",
  operatingExpenses: "Operating expenses in the period (rent, marketing, supplies, licences…).",
  grossProfit: "Net sales − COGS (− owner labor when enabled in Settings).",
  contributionProfit: "Net sales + delivery fees − COGS − delivery cost − processing fees − order-linked costs.",
  netProfit: "Contribution profit − operating expenses. An estimate, not a tax figure.",
  grossMargin: "Gross profit ÷ net sales.",
  netMargin: "Estimated net profit ÷ (net sales + delivery fees).",
  avgOrderValue: "Net sales ÷ number of revenue orders.",
  avgProfitPerOrder: "Contribution profit ÷ number of revenue orders.",
  outstandingBalance: "Unpaid balance across open and completed orders.",
  taxLiability: "Tax collected − tax refunded ± manual adjustments.",
};

/** Product ranking rows from the product_sales view. */
export interface ProductRank {
  product_id: string; name: string; category_id: string | null; units: number; orders: number; gross: Cents; discounts: Cents;
  net: Cents; cost: Cents; profit: Cents; margin: number | null; avgPrice: Cents | null; refunds: number; unitCost: Cents | null;
}

export function rankProducts(rows: { product_id: string | null; product_name: string | null; category_id: string | null; status: OrderStatus; quantity: number; refunded_qty: number; line_total: number | string; line_cost: number | string; line_labor_cost: number | string; line_discount: number | string; order_id: string }[], includeLabor: boolean): ProductRank[] {
  const map = new Map<string, ProductRank & { orderIds: Set<string> }>();
  for (const r of rows) {
    if (!REVENUE_STATUSES.includes(r.status) || !r.product_id) continue;
    const k = r.product_id;
    const e = map.get(k) ?? { product_id: k, name: r.product_name ?? "Unknown", category_id: r.category_id, units: 0, orders: 0, gross: 0, discounts: 0, net: 0, cost: 0, profit: 0, margin: null, avgPrice: null, refunds: 0, unitCost: null, orderIds: new Set() };
    e.units += r.quantity;
    e.orderIds.add(r.order_id);
    e.gross += toCents(r.line_total);
    e.discounts += toCents(r.line_discount);
    e.cost += toCents(r.line_cost) + (includeLabor ? toCents(r.line_labor_cost) : 0);
    e.refunds += r.refunded_qty > 0 ? 1 : 0;
    map.set(k, e);
  }
  return [...map.values()].map((e) => {
    e.orders = e.orderIds.size;
    e.net = e.gross - e.discounts;
    e.profit = e.net - e.cost;
    e.margin = ratio(e.profit, e.net);
    e.avgPrice = e.units ? Math.round(e.gross / e.units) : null;
    e.unitCost = e.units ? Math.round(e.cost / e.units) : null;
    const { orderIds: _drop, ...rest } = e; void _drop;
    return rest;
  }).sort((a, b) => b.net - a.net);
}

/** Estimated unit cost of a product from its cached figures. */
export function productUnitCost(p: { ingredient_cost: number | string; packaging_cost: number | string; other_direct_cost: number | string; labor_minutes: number | string }, laborRate: number | string, includeLabor: boolean): Cents {
  const labor = includeLabor ? Math.round((Number(p.labor_minutes) / 60) * Number(laborRate) * 100) : 0;
  return toCents(p.ingredient_cost) + toCents(p.packaging_cost) + toCents(p.other_direct_cost) + labor;
}
