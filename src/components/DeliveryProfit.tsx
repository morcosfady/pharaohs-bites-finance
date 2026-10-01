import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Fuel, Truck, HandCoins, PiggyBank, AlertTriangle } from "lucide-react";
import { DateRangeBar, useDateRange } from "./DateRangeBar";
import { Skeleton, ErrorBox, EmptyState } from "./ui";
import { Stat, band, BAND } from "./menuViz";
import { useDeliveryOrders, useMileageSettings, useSettings } from "../hooks/queries";
import { buildDeliveryLines, summarizeDeliveries, type DeliveryLine } from "../lib/deliveryProfit";
import { fmt, pct } from "../lib/money";
import { fmtDate } from "../lib/dates";

/* Delivery tab of Menu & Profit: what customers paid for delivery, what the trips cost in gas, and the profit
   per delivery order. Gas = round-trip miles x the cost per mile in Settings. */

export function DeliveryProfit() {
  const [range, setRange] = useDateRange("this_year");
  const orders = useDeliveryOrders(range);
  const settings = useSettings();
  const mileage = useMileageSettings();
  const perMile = Number(settings.data?.default_mileage_cost_per_mile ?? 0);
  const roundTrip = mileage.data?.delivery_round_trip ?? true;
  const low = Number(settings.data?.low_margin_warning_pct ?? 0.3);

  const lines = useMemo(() => buildDeliveryLines(orders.data ?? [], perMile, roundTrip), [orders.data, perMile, roundTrip]);
  const sum = useMemo(() => summarizeDeliveries(lines), [lines]);
  const scale = useMemo(() => Math.max(1, ...lines.map((l) => Math.max(l.feeCents, l.costCents))), [lines]);
  const tone = sum.orders === 0 ? "none" : sum.profitCents < 0 ? "low" : band(sum.margin, low);

  return (
    <div>
      <p className="mb-3 text-sm text-charcoal/60">What customers paid for delivery, what the driving cost you in gas, and what you kept. Delivery profit = delivery paid − gas.</p>
      <DateRangeBar range={range} onChange={setRange} />

      {orders.error && <ErrorBox error={orders.error} />}
      {orders.isLoading ? <Skeleton rows={6} className="card p-5" /> : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Delivery orders" value={String(sum.orders)} sub={sum.orders ? `${sum.miles.toFixed(1)} miles driven` : "none this period"} icon={<Truck size={14} />} />
            <Stat label="Customers paid" value={fmt(sum.paidCents)} sub="delivery fees" tone="none" icon={<HandCoins size={14} />} />
            <Stat label="Delivery cost (gas)" value={fmt(sum.costCents)} sub={`$${perMile.toFixed(2)} × ${sum.miles.toFixed(1)} mi`} tone="none" icon={<Fuel size={14} />} formula="Round-trip miles of each delivery × your cost per mile (Settings → Default mileage cost). A real cost typed on the order replaces it." />
            <Stat label="Delivery profit" value={fmt(sum.profitCents)} sub={sum.orders ? `${sum.margin == null ? "—" : pct(sum.margin, 0)} kept` : "paid − gas"} tone={tone} icon={<PiggyBank size={14} />} formula="Delivery paid minus gas, for every delivery order in the period." />
          </div>

          {(sum.unknownCost > 0 || sum.losing > 0) && (
            <div className="mb-5 space-y-1.5 rounded-xl border border-warning/40 bg-gold-100 px-4 py-3 text-sm">
              {sum.losing > 0 && <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" /><span><b>{sum.losing} deliver{sum.losing === 1 ? "y" : "ies"} lost money:</b> the gas cost more than the customer paid. Look at the distance and the delivery fee formula.</span></p>}
              {sum.unknownCost > 0 && <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" /><span><b>{sum.unknownCost} deliver{sum.unknownCost === 1 ? "y has" : "ies have"} no miles saved</b> (older orders), so their gas is not counted yet and their profit looks higher than it is.</span></p>}
            </div>
          )}

          <div className="card px-5 pb-4 pt-4">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 className="card-title">Profit per delivery</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-charcoal/60">
                <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-gold" /> Gas</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-positive" /> Profit kept</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-negative" /> Loss</span>
              </div>
            </div>
            <p className="mb-3 text-xs text-charcoal/50">Each bar is one delivery order: the gas, plus what was left over.{sum.orders > 0 ? ` On average you keep ${fmt(sum.avgProfitCents)} per delivery.` : ""}{roundTrip ? " Miles count there and back." : ""}</p>
            {lines.length === 0
              ? <EmptyState title="No delivery orders in this period" hint="Delivery orders show up here as soon as customers order and pay. Try a longer period above." />
              : <ul className="divide-y divide-ivory-200">{lines.map((l) => <Line key={l.id} l={l} scale={scale} perMile={perMile} />)}</ul>}
          </div>
          <p className="mt-3 text-xs text-charcoal/50">Gas uses ${perMile.toFixed(2)} per mile. Change it in <Link to="/settings" className="text-teal-700 hover:underline">Settings</Link> (Default mileage cost). It is separate from the IRS mileage deduction on the Expenses tab.</p>
        </>
      )}
    </div>
  );
}

function Line({ l, scale, perMile }: { l: DeliveryLine; scale: number; perMile: number }) {
  const gas = Math.min(l.feeCents, l.costCents), left = Math.max(l.feeCents - l.costCents, 0), loss = Math.max(l.costCents - l.feeCents, 0);
  const w = (c: number) => `${(c / scale) * 100}%`;
  const profitClass = l.profitCents < 0 ? "text-negative" : l.costKind === "unknown" ? "text-charcoal/50" : "text-positive";
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/orders/${l.id}`} className="font-mono text-xs text-teal-800 hover:underline">{l.orderNumber}</Link>
          <div className="truncate font-medium">{l.customer}{l.city ? <span className="font-normal text-charcoal/50"> · {l.city}</span> : null}</div>
          <div className="text-xs text-charcoal/50">{fmtDate(l.date)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-display text-xl font-semibold leading-none ${profitClass}`}>{l.profitCents < 0 ? "−" : ""}{fmt(Math.abs(l.profitCents))}</div>
          <div className="mt-0.5 text-xs text-charcoal/50">profit</div>
        </div>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-ivory-100" role="img" aria-label={`Paid ${fmt(l.feeCents)}, gas ${fmt(l.costCents)}, profit ${fmt(l.profitCents)}`}>
        <div className="bg-gold" style={{ width: w(gas) }} />
        {left > 0 && <div style={{ width: w(left), background: BAND.good.hex }} />}
        {loss > 0 && <div className="bg-negative" style={{ width: w(loss) }} />}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-charcoal/60">
        <span>Paid <b className="text-charcoal">{fmt(l.feeCents)}</b></span>
        <span>Gas <b className="text-charcoal">{l.costKind === "unknown" ? "unknown" : fmt(l.costCents)}</b>{l.tripMiles != null && l.costKind === "estimate" ? ` (${l.tripMiles.toFixed(1)} mi × ${perMile.toFixed(2)})` : l.costKind === "actual" ? " (real cost)" : ""}</span>
        {l.costKind === "unknown" && <span className="text-warning">no miles saved for this order</span>}
      </div>
    </li>
  );
}
