/** Row types mirroring supabase/migrations. Money columns arrive as strings
 *  (numeric) or numbers depending on the client; always pass them through
 *  toCents() before doing arithmetic. */

export type OrderStatus =
  | "pending_whatsapp_confirmation" | "contacted" | "delivery_fee_pending" | "awaiting_customer_approval"
  | "confirmed" | "preparing" | "ready" | "out_for_delivery" | "completed" | "cancelled" | "refunded";

export type PaymentStatus = "unpaid" | "deposit_received" | "partially_paid" | "paid" | "refunded" | "partially_refunded" | "disputed";
export type PaymentMethod = "zelle" | "venmo" | "cash" | "card" | "other";
export type DeliveryMethod = "delivery" | "pickup";
export type DeliveryProvider = "owner" | "uber" | "third_party" | "customer_pickup" | "other";
export type DeliveryStatus = "not_started" | "scheduled" | "out_for_delivery" | "delivered" | "failed" | "picked_up";
export type TaxStatus = "taxable" | "nontaxable" | "review";
export type CustomerStatus = "active" | "vip" | "trouble_maker" | "blocked";
export type CostType = "direct_product" | "operating";
export type Num = number | string;

export interface AdminProfile { user_id: string; full_name: string; role: string; is_active: boolean }

export interface BusinessSettings {
  id: number; business_name: string; owner_name: string; address: string; phone: string; whatsapp_number: string;
  email: string; logo_url: string; currency: string; timezone: string; order_number_prefix: string;
  default_delivery_rate_per_mile: Num; default_mileage_cost_per_mile: Num; default_labor_rate_per_hour: Num;
  include_owner_labor: boolean; advanced_mode: boolean; low_margin_warning_pct: Num; minimum_order_amount: Num;
  default_whatsapp_message: string; cancellation_rules: string; updated_at: string;
}

export interface TaxSettings {
  id: number; default_tax_rate: Num; prices_include_tax: boolean; filing_frequency: "monthly" | "quarterly" | "annual";
  next_due_date: string | null; reminder_days_before: number; jurisdiction_note: string; updated_at: string;
}

export interface ProductCategory { id: string; name: string; sort_order: number }

export interface Product {
  id: string; slug: string; name: string; name_ar: string; category_id: string | null; description: string; image_url: string;
  selling_price: Num; is_active: boolean; tax_status: TaxStatus; packaging_cost: Num; labor_minutes: Num;
  other_direct_cost: Num; ingredient_cost: Num; created_at: string; updated_at: string; deleted_at: string | null;
  product_categories?: { name: string } | null;
}

export interface Ingredient {
  id: string; name: string; supplier: string; package_size: Num; package_unit: string; package_price: Num;
  waste_pct: Num; notes: string; updated_at: string; deleted_at: string | null;
}

export interface Recipe { id: string; product_id: string; ingredient_id: string; quantity: Num; unit: string; waste_pct: Num; ingredients?: Ingredient }

export interface Customer {
  id: string; name: string; phone: string; phone_normalized: string; email: string; status: CustomerStatus;
  internal_notes: string; merged_into_id: string | null; created_at: string; updated_at: string; deleted_at: string | null;
  customer_addresses?: CustomerAddress[];
}

export interface CustomerAddress {
  id: string; customer_id: string; street: string; apt: string; city: string; state: string; zip: string; instructions: string; is_default: boolean;
}

export interface Order {
  id: string; order_number: string; checkout_token: string | null; source: "website" | "manual" | "import";
  customer_id: string | null; customer_name: string; customer_phone: string; delivery_method: DeliveryMethod;
  address_street: string; address_apt: string; address_city: string; address_state: string; address_zip: string;
  delivery_instructions: string; requested_at: string | null; status: OrderStatus; payment_status: PaymentStatus;
  payment_method: PaymentMethod | null; subtotal: Num; discount: Num; discount_reason: string; delivery_fee: Num;
  delivery_fee_customer_paid: boolean; delivery_subsidy: Num; tax_rate_applied: Num; tax_amount: Num;
  tax_manually_set: boolean; prices_include_tax: boolean; total: Num; amount_paid: Num; amount_refunded: Num;
  internal_notes: string; customer_notes: string; created_at: string; updated_at: string; confirmed_at: string | null;
  completed_at: string | null; cancelled_at: string | null; deleted_at: string | null;
  order_items?: OrderItem[]; payments?: Payment[]; refunds?: Refund[]; delivery_records?: DeliveryRecord | DeliveryRecord[] | null;
  order_status_history?: OrderStatusHistory[];
}

export interface OrderItem {
  id: string; order_id: string; product_id: string | null; product_name: string; options: string; quantity: number;
  unit_price: Num; line_total: Num; is_taxable: boolean; unit_ingredient_cost: Num; unit_packaging_cost: Num;
  unit_labor_cost: Num; unit_other_cost: Num; refunded_qty: number;
}

export interface OrderStatusHistory { id: string; order_id: string; from_status: OrderStatus | null; to_status: OrderStatus; changed_by: string | null; note: string; created_at: string }

export interface Payment { id: string; order_id: string; paid_at: string; amount: Num; method: PaymentMethod; reference: string; notes: string; created_at: string; voided_at: string | null; orders?: { order_number: string; customer_name: string } }
export interface Refund { id: string; order_id: string; payment_id: string | null; refunded_at: string; amount: Num; tax_portion: Num; method: PaymentMethod; reason: string; voided_at: string | null }

export interface DeliveryRecord {
  id: string; order_id: string; distance_miles: Num; fee_charged: Num; actual_cost: Num; provider: DeliveryProvider;
  driver: string; tracking_ref: string; status: DeliveryStatus; notes: string; updated_at: string;
  orders?: { order_number: string; customer_name: string; address_street: string; address_city: string; created_at: string; delivery_fee: Num; delivery_fee_customer_paid: boolean; status: OrderStatus };
}

export interface ExpenseCategory { id: string; name: string; cost_type: CostType; sort_order: number }

export interface Expense {
  id: string; expense_date: string; vendor: string; category_id: string | null; description: string;
  amount_before_tax: Num; sales_tax_paid: Num; total_amount: Num; payment_method: PaymentMethod | null;
  receipt_path: string; cost_type: CostType; product_id: string | null; order_id: string | null; notes: string;
  recurrence: "none" | "weekly" | "monthly" | "quarterly" | "annual"; recurring_parent_id: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; expense_categories?: { name: string } | null;
}

export interface TaxAdjustment { id: string; adjusted_on: string; amount: Num; reason: string; created_at: string }
export interface TaxPeriodSummary { id: string; period_start: string; period_end: string; total_sales: Num; taxable_sales: Num; nontaxable_sales: Num; tax_collected: Num; adjustments: Num; estimated_due: Num; filed_at: string | null; notes: string }

/** Row of the order_financials view */
export interface OrderFinancial {
  id: string; order_number: string; created_at: string; completed_at: string | null; status: OrderStatus;
  payment_status: PaymentStatus; payment_method: PaymentMethod | null; delivery_method: DeliveryMethod;
  customer_id: string | null; customer_name: string; customer_phone: string;
  gross_product_revenue: Num; discount: Num; net_product_sales: Num; delivery_revenue: Num; tax_amount: Num;
  total: Num; amount_paid: Num; amount_refunded: Num; balance_due: Num; cogs: Num; packaging_cost: Num;
  labor_cost: Num; delivery_cost: Num; items_count: Num; gross_profit: Num; contribution_profit: Num; deleted_at: string | null;
}

/** Row of the product_sales view */
export interface ProductSale {
  product_id: string | null; product_name: string | null; category_id: string | null; created_at: string;
  completed_at: string | null; status: OrderStatus; quantity: number; refunded_qty: number; line_total: Num;
  line_cost: Num; line_labor_cost: Num; line_discount: Num; order_id: string;
}

export interface AuditLog { id: number; table_name: string; record_id: string; action: string; changed_by: string | null; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null; created_at: string }
