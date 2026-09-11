import type { OrderStatus, PaymentStatus, PaymentMethod, DeliveryProvider, DeliveryStatus, TaxStatus, CustomerStatus } from "./types";

export const ORDER_STATUSES: { value: OrderStatus; label: string; cls: string }[] = [
  { value: "pending_whatsapp_confirmation", label: "Pending WhatsApp Confirmation", cls: "bg-amber-100 text-amber-900 ring-1 ring-amber-300" },
  { value: "contacted", label: "Contacted", cls: "bg-sky-100 text-sky-900" },
  { value: "delivery_fee_pending", label: "Delivery Fee Pending", cls: "bg-orange-100 text-orange-900" },
  { value: "awaiting_customer_approval", label: "Awaiting Customer Approval", cls: "bg-violet-100 text-violet-900" },
  { value: "confirmed", label: "Confirmed", cls: "bg-teal-100 text-teal-900" },
  { value: "preparing", label: "Preparing", cls: "bg-yellow-100 text-yellow-900" },
  { value: "ready", label: "Ready", cls: "bg-lime-100 text-lime-900" },
  { value: "out_for_delivery", label: "Out for Delivery", cls: "bg-blue-100 text-blue-900" },
  { value: "completed", label: "Completed", cls: "bg-emerald-100 text-emerald-900" },
  { value: "cancelled", label: "Cancelled", cls: "bg-neutral-200 text-neutral-700" },
  { value: "refunded", label: "Refunded", cls: "bg-rose-100 text-rose-900" },
];

export const PAYMENT_STATUSES: { value: PaymentStatus; label: string; cls: string }[] = [
  { value: "unpaid", label: "Unpaid", cls: "bg-rose-100 text-rose-900" },
  { value: "deposit_received", label: "Deposit received", cls: "bg-amber-100 text-amber-900" },
  { value: "partially_paid", label: "Partially paid", cls: "bg-amber-100 text-amber-900" },
  { value: "paid", label: "Paid", cls: "bg-emerald-100 text-emerald-900" },
  { value: "refunded", label: "Refunded", cls: "bg-neutral-200 text-neutral-700" },
  { value: "partially_refunded", label: "Partially refunded", cls: "bg-orange-100 text-orange-900" },
  { value: "disputed", label: "Disputed", cls: "bg-red-200 text-red-900" },
];

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "zelle", label: "Zelle" }, { value: "venmo", label: "Venmo" }, { value: "cash", label: "Cash" },
  { value: "card", label: "Card" }, { value: "other", label: "Other" },
];

export const DELIVERY_PROVIDERS: { value: DeliveryProvider; label: string }[] = [
  { value: "owner", label: "Owner delivery" }, { value: "uber", label: "Uber courier / package" },
  { value: "third_party", label: "Third-party courier" }, { value: "customer_pickup", label: "Customer pickup" }, { value: "other", label: "Other" },
];

export const DELIVERY_STATUSES: { value: DeliveryStatus; label: string }[] = [
  { value: "not_started", label: "Not started" }, { value: "scheduled", label: "Scheduled" }, { value: "out_for_delivery", label: "Out for delivery" },
  { value: "delivered", label: "Delivered" }, { value: "failed", label: "Failed" }, { value: "picked_up", label: "Picked up" },
];

export const TAX_STATUSES: { value: TaxStatus; label: string; cls: string }[] = [
  { value: "taxable", label: "Taxable", cls: "bg-teal-100 text-teal-900" },
  { value: "nontaxable", label: "Nontaxable", cls: "bg-emerald-100 text-emerald-900" },
  { value: "review", label: "Needs review", cls: "bg-amber-100 text-amber-900" },
];

export const CUSTOMER_STATUSES: { value: CustomerStatus; label: string; cls: string }[] = [
  { value: "active", label: "Active", cls: "bg-teal-100 text-teal-900" },
  { value: "vip", label: "VIP", cls: "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-400" },
  { value: "trouble_maker", label: "Trouble maker", cls: "bg-red-100 text-red-800 ring-1 ring-red-400" },
  { value: "blocked", label: "Blocked", cls: "bg-neutral-800 text-white" },
];

export const UNITS = ["lb", "oz", "kg", "g", "gallon", "quart", "pint", "cup", "tbsp", "tsp", "ml", "l", "piece", "package"];

export function label<T extends string>(list: { value: T; label: string }[], v: T | null | undefined): string {
  return list.find((x) => x.value === v)?.label ?? (v ?? "—");
}
export function cls<T extends string>(list: { value: T; label: string; cls: string }[], v: T | null | undefined): string {
  return list.find((x) => x.value === v)?.cls ?? "bg-neutral-100 text-neutral-700";
}
