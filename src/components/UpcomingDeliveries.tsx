import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Section } from "./ui";
import { useOrders } from "../hooks/queries";
import { deliverySlot } from "../lib/slot";
import { fmt, toCents } from "../lib/money";
import type { OrderStatus } from "../lib/types";

/** Orders that are accepted (paid / confirmed) and still to be delivered, soonest first.
 *  This is the "what do I have to cook, and for when" list. */
const ACTIVE: OrderStatus[] = ["confirmed", "preparing", "ready", "out_for_delivery", "contacted", "delivery_fee_pending", "awaiting_customer_approval"];

export function UpcomingDeliveries() {
  const orders = useOrders();
  const rows = useMemo(() => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    return (orders.data ?? [])
      .filter((o) => !o.deleted_at && ACTIVE.includes(o.status) && o.requested_at && new Date(o.requested_at) >= startOfToday)
      .sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)))
      .slice(0, 6);
  }, [orders.data]);

  return (
    <Section title="🗓️ Upcoming deliveries" right={<Link to="/orders" className="text-xs text-teal-700 hover:underline">All orders</Link>}>
      {orders.isLoading ? <p className="text-sm text-charcoal/50">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-charcoal/60">Nothing to deliver yet. Paid orders appear here, soonest first. 🎉</p>
      ) : (
        <ul className="divide-y divide-ivory-200">
          {rows.map((o) => {
            const sl = deliverySlot(o);
            return (
              <li key={o.id}>
                <Link to={`/orders/${o.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm hover:bg-ivory-50">
                  <span className="min-w-[8.5rem] font-semibold text-teal-900">{sl?.date}<span className="block text-xs font-normal text-charcoal/60">{sl?.window}</span></span>
                  <span className="flex-1">{o.customer_name}<span className="block text-xs text-charcoal/50">{o.delivery_method === "pickup" ? "Pickup" : [o.address_street, o.address_city].filter(Boolean).join(", ")}</span></span>
                  <b className="tabular-nums">{fmt(toCents(o.total))}</b>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
