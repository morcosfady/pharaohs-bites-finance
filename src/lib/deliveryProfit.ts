/* Delivery profit per order: what the customer paid for delivery minus what the trip cost in gas.
   Gas = round-trip miles x the owner's cost per mile (Settings -> Default mileage cost). If the owner typed an
   actual cost on the order, that real number wins. Orders saved before miles were recorded have no miles, so
   their cost is unknown: they are flagged, never silently counted as free gas. Money is in cents. */
import { toCents } from "./money";
import type { Num } from "./types";

export interface DeliveryOrder {
  id: string; order_number: string; created_at: string; completed_at: string | null; status: string;
  customer_name: string; address_city: string; delivery_fee: Num; delivery_fee_customer_paid: boolean; delivery_miles: Num | null;
  /** one-to-one in the database; PostgREST may hand back an object or a one-item list */
  delivery_records?: { distance_miles: Num; actual_cost: Num } | { distance_miles: Num; actual_cost: Num }[] | null;
}

export type CostKind = "actual" | "estimate" | "unknown";
export interface DeliveryLine {
  id: string; orderNumber: string; date: string; customer: string; city: string; status: string;
  feeCents: number; oneWayMiles: number | null; tripMiles: number | null; costCents: number; profitCents: number; costKind: CostKind;
}

/** Orders that really happened: not cancelled, not refunded, not still waiting for payment/confirmation. */
export const DELIVERY_STATUSES_COUNTED = ["confirmed", "preparing", "ready", "out_for_delivery", "completed"];

const record = (o: DeliveryOrder) => Array.isArray(o.delivery_records) ? o.delivery_records[0] : o.delivery_records ?? undefined;

export function deliveryLine(o: DeliveryOrder, perMile: number, roundTrip: boolean): DeliveryLine {
  const rec = record(o);
  const feeCents = o.delivery_fee_customer_paid ? toCents(o.delivery_fee) : 0;
  const saved = o.delivery_miles != null ? Number(o.delivery_miles) : 0;
  const oneWay = saved > 0 ? saved : rec && Number(rec.distance_miles) > 0 ? Number(rec.distance_miles) : null;
  const tripMiles = oneWay == null ? null : Math.round(oneWay * (roundTrip ? 2 : 1) * 10) / 10;
  const actual = rec ? toCents(rec.actual_cost) : 0;
  let costCents = 0, costKind: CostKind = "unknown";
  if (actual > 0) { costCents = actual; costKind = "actual"; }
  else if (tripMiles != null) { costCents = Math.round(tripMiles * perMile * 100); costKind = "estimate"; }
  return {
    id: o.id, orderNumber: o.order_number, date: o.completed_at ?? o.created_at, customer: o.customer_name, city: o.address_city, status: o.status,
    feeCents, oneWayMiles: oneWay, tripMiles, costCents, profitCents: feeCents - costCents, costKind,
  };
}

export interface DeliverySummary {
  orders: number; paidCents: number; costCents: number; profitCents: number; margin: number | null;
  miles: number; avgProfitCents: number; losing: number; unknownCost: number; estimated: number;
}

export function summarizeDeliveries(lines: DeliveryLine[]): DeliverySummary {
  const paid = lines.reduce((s, l) => s + l.feeCents, 0), cost = lines.reduce((s, l) => s + l.costCents, 0);
  const miles = Math.round(lines.reduce((s, l) => s + (l.tripMiles ?? 0), 0) * 10) / 10;
  return {
    orders: lines.length, paidCents: paid, costCents: cost, profitCents: paid - cost, margin: paid > 0 ? (paid - cost) / paid : null,
    miles, avgProfitCents: lines.length ? Math.round((paid - cost) / lines.length) : 0,
    losing: lines.filter((l) => l.profitCents < 0).length, unknownCost: lines.filter((l) => l.costKind === "unknown").length,
    estimated: lines.filter((l) => l.costKind === "estimate").length,
  };
}

export function buildDeliveryLines(orders: DeliveryOrder[], perMile: number, roundTrip: boolean): DeliveryLine[] {
  return orders.filter((o) => DELIVERY_STATUSES_COUNTED.includes(o.status)).map((o) => deliveryLine(o, perMile, roundTrip));
}
