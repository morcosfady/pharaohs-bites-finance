import { format, isValid, parseISO } from "date-fns";

/** The website stores the chosen delivery window inside the delivery instructions as
 *  "Delivery window: 9:00 AM-12:00 PM on Fri, Oct 2 | customer note". These helpers read
 *  that back so the dashboard can show WHEN an order has to be delivered. */
const TAG = /^Delivery window: ([^|]+?) on [^|]*\|?\s*/;

export interface Slot { date: string; window: string; dateShort: string; sortKey: string }

export function deliverySlot(o: { requested_at: string | null; delivery_instructions?: string | null }): Slot | null {
  if (!o.requested_at) return null;
  const d = parseISO(o.requested_at);
  if (!isValid(d)) return null;
  const m = /Delivery window: ([^|]+?) on /.exec(o.delivery_instructions ?? "");
  return { date: format(d, "EEE, MMM d"), dateShort: format(d, "MMM d"), window: m ? m[1].trim().replace("-", "–") : format(d, "h:mm a"), sortKey: o.requested_at };
}

/** Customer note without the machine-written window tag. */
export function plainNote(instructions: string | null | undefined): string {
  return (instructions ?? "").replace(TAG, "").trim();
}
