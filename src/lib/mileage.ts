/* Mileage maths and wording. The database prices each trip (mileage_log_view); this file only
   adds up what the view marks as `counted` and explains it. */
import type { MileageLog } from "./types";

export interface MileageSummary { miles: number; deduction: number; trips: number; missingRate: number; unconfirmed: boolean; estimatedMiles: number }

/** Counts live trips that are not folded into a combined route. Money is summed in cents. */
export function summarizeMileage(rows: MileageLog[]): MileageSummary {
  let milesTenths = 0, cents = 0, trips = 0, missingRate = 0, estTenths = 0, unconfirmed = false;
  for (const r of rows) {
    if (!r.counted) continue;
    trips += 1;
    const tenths = Math.round(Number(r.miles) * 10);
    milesTenths += tenths;
    if (r.estimated) estTenths += tenths;
    if (r.deduction == null) missingRate += 1; else cents += Math.round(Number(r.deduction) * 100);
    if (r.deduction != null && !r.rate_confirmed) unconfirmed = true;
  }
  return { miles: milesTenths / 10, deduction: cents / 100, trips, missingRate, unconfirmed, estimatedMiles: estTenths / 10 };
}

export const KIND_LABEL: Record<MileageLog["kind"], string> = { delivery: "Delivery", supply: "Supply run", other: "Other" };

/** Delivery trips that can be folded into one route: live, same day, not already in a route. */
export function routeCandidates(rows: MileageLog[], day: string) {
  return rows.filter((r) => r.kind === "delivery" && r.counted && r.trip_date === day && !r.route_id);
}

export function formatCents(c: number | string | null | undefined): string {
  if (c == null) return "no rate";
  const n = Number(c);
  return `${Number.isInteger(n) ? n : n.toFixed(1)}¢`;
}
