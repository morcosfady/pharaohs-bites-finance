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
  customer_id: string | null; customer_name: string; customer_phone: string; customer_email?: string; delivery_method: DeliveryMethod;
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

export interface ExpenseCategory {
  id: string; name: string; cost_type: CostType; sort_order: number;
  /** draft Schedule C line key (see lib/taxpack.ts) and how the category is treated for tax */
  schedule_c_line?: string | null; treatment?: "cogs" | "deductible" | "excluded"; always_ask?: boolean; ask_note?: string;
}
/** Row of the expense_tax_view */
export interface ExpenseTaxRow {
  expense_id: string; expense_date: string; vendor: string; description: string; category_id: string | null; category_name: string;
  total_amount: Num; business_pct: Num; receipt_path: string; review_status: string; auto_source: string | null;
  is_startup: boolean; line_key: string; treatment: string; gas_excluded: boolean | null; asset_candidate: boolean; deductible_amount: Num; ask_reason: string | null;
  /** an expense split across categories has one row per category line */
  line_no: number;
}
export interface TaxSummaryRow { line_key: string; entries: Num; total: Num; deductible: Num }
export interface TaxQuality { receipt_min?: number; needs_review: number; possible_duplicates: number; uncategorized: number; missing_receipts: number; money_in_unclassified: number; mileage_without_rate: number; mileage_estimated: number; ask_accountant: number }
export interface TaxExtras { personal_total: number; personal_count: number; owner_contributions: number; stripe_payouts: number; transfers: number }
export interface ExpenseSettings { id: boolean; match_window_days: number; amount_tolerance: Num; business_start_date: string; asset_threshold: Num; startup_limit: Num; stripe_fee_pct: Num; stripe_fee_fixed: Num; receipt_min_amount?: Num }

export interface Expense {
  id: string; expense_date: string; vendor: string; category_id: string | null; description: string;
  amount_before_tax: Num; sales_tax_paid: Num; total_amount: Num; payment_method: PaymentMethod | null;
  receipt_path: string; cost_type: CostType; product_id: string | null; order_id: string | null; notes: string;
  recurrence: "none" | "weekly" | "monthly" | "quarterly" | "annual"; recurring_parent_id: string | null;
  /** 'order_cost' = written automatically from an order's cost snapshot; null = entered by hand. */
  auto_source: string | null;
  bank_transaction_id: string | null;
  /** ok | needs_review (no category yet) | possible_duplicate (see duplicate_of) */
  review_status: "ok" | "needs_review" | "possible_duplicate"; duplicate_of: string | null; merged_into: string | null;
  business_pct: Num; ask_accountant: boolean; ask_note: string;
  /** part of the purchase that was personal (e.g. the owner's own groceries): not counted, but part of the bank charge */
  personal_amount?: Num;
  /** only for category Marketing: social | flyers_print | online_ads | email_web | events | influencers | other */
  marketing_channel?: string | null;
  created_at: string; updated_at: string; deleted_at: string | null; expense_categories?: { name: string } | null;
  expense_sources?: { source_type: string }[] | null;
}

export interface BankAccount {
  id: string; item_id: string; plaid_account_id: string; name: string; official_name: string;
  mask: string; type: string; subtype: string; current_balance: Num | null; available_balance: Num | null;
  is_tracked: boolean; created_at: string; updated_at: string;
  bank_items?: { institution_name: string; status: string; last_synced_at: string | null; last_error: string } | null;
}

export interface BankTransaction {
  id: string; account_id: string; plaid_transaction_id: string; posted_on: string; name: string;
  merchant_name: string; /** Plaid convention: positive = money out. */ amount: Num;
  iso_currency_code: string; pending: boolean; plaid_category: string; payment_channel: string;
  expense_id: string | null; ignored: boolean; created_at: string; updated_at: string;
  /** what the transaction was classified as; only 'expense' is ever counted as a cost */
  kind: "unclassified" | "expense" | "transfer" | "owner_contribution" | "personal" | "payout" | "money_in" | "deposit" | "pending" | "ignored";
  bank_accounts?: { name: string; mask: string } | null;
}

export interface BankRule {
  id: string; match_text: string; vendor: string; category_id: string | null;
  cost_type: CostType; skip: boolean; sort_order: number; created_at: string;
  action: "expense" | "transfer" | "owner_contribution" | "personal" | "payout"; direction: "any" | "out" | "in";
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

/* ---- mileage (migration 0049) ---- */
/** Row of the mileage_log_view: a trip priced with the IRS rate in force on its date. */
export interface MileageLog {
  id: string; trip_date: string; kind: "delivery" | "supply" | "other"; purpose: string; from_label: string; to_label: string;
  miles: Num; order_id: string | null; vehicle: string; notes: string; estimated: boolean; auto: boolean; route_id: string | null;
  deleted_at: string | null; cents_per_mile: Num | null; rate_confirmed: boolean | null; deduction: Num | null; counted: boolean;
}
export interface MileageSettings { id: boolean; method: "standard" | "actual"; method_confirmed: boolean; delivery_round_trip: boolean; vehicle: string }
export interface IrsMileageRate { id: string; effective_from: string; effective_to: string; cents_per_mile: Num; confirmed: boolean; source: string }
export interface MileagePlace { id: string; name: string; address: string; one_way_miles: Num; created_at: string }

/* ---- receipts (migration 0053) ---- */
export interface ReceiptFile {
  id: string; sha256: string; storage_path: string; /** more pictures of the same receipt (extra pages) */ extra_paths: string[]; original_name: string; mime: string; size_bytes: number;
  source: "upload" | "email"; email_subject: string; status: "uploaded" | "parsing" | "parsed" | "failed" | "waiting_key";
  outcome: string; expense_id: string | null; parsed: { vendor?: string; date?: string | null; total?: number; tax?: number; items?: { name: string }[] } & Record<string, unknown>;
  totals_ok: boolean | null; error: string; created_at: string;
}
export interface ExpenseItem {
  id: string; expense_id: string; source_id: string | null; description: string; quantity: Num; unit_price: Num; line_total: Num;
  tax_amount: Num; category_id: string | null; is_business: boolean;
}
export interface NeedsReceiptRow { expense_id: string; expense_date: string; vendor: string; total_amount: Num; description: string; days_waiting: number }
