import { useMemo } from "react";
import { Link } from "react-router-dom";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Skeleton, ErrorBox, KpiCard, Badge } from "../components/ui";
import { useDeliveries } from "../hooks/queries";
import { DELIVERY_PROVIDERS, DELIVERY_STATUSES, label } from "../lib/status";
import { fmt, toCents, sum } from "../lib/money";
import { fmtDate, inRange } from "../lib/dates";
import type { DeliveryRecord } from "../lib/types";

type Row = DeliveryRecord & { revenue: number; profit: number; [k: string]: unknown };

export function DeliveriesPage() {
  const [range, setRange] = useDateRange("this_month");
  const q = useDeliveries();
  const rows = useMemo<Row[]>(() => (q.data ?? []).filter((d) => d.orders && inRange(d.orders.created_at, range) && d.orders.status !== "cancelled").map((d) => {
    const revenue = d.orders!.delivery_fee_customer_paid ? toCents(d.orders!.delivery_fee) : 0;
    return { ...d, revenue, profit: revenue - toCents(d.actual_cost) };
  }), [q.data, range]);
  const rev = sum(rows.map((r) => r.revenue)), cost = sum(rows.map((r) => toCents(r.actual_cost)));
  const miles = rows.reduce((s, r) => s + Number(r.distance_miles), 0);
  const losses = rows.filter((r) => r.profit < 0);
  const cols: Column<Row>[] = [
    { key: "order", header: "Order", primary: true, render: (r) => <Link to={`/orders/${r.order_id}`} className="font-mono text-xs text-teal-800 hover:underline">{r.orders?.order_number}</Link>, sortValue: (r) => r.orders?.order_number ?? "" },
    { key: "date", header: "Date", render: (r) => fmtDate(r.orders?.created_at), sortValue: (r) => r.orders?.created_at ?? "" },
    { key: "customer", header: "Customer", render: (r) => <span>{r.orders?.customer_name}<span className="block text-xs text-charcoal/50">{r.orders?.address_street}, {r.orders?.address_city}</span></span> },
    { key: "distance_miles", header: "Miles", numeric: true, render: (r) => Number(r.distance_miles).toFixed(1), sortValue: (r) => Number(r.distance_miles) },
    { key: "revenue", header: "Fee charged", numeric: true, render: (r) => fmt(r.revenue) },
    { key: "actual_cost", header: "Actual cost", numeric: true, render: (r) => fmt(toCents(r.actual_cost)), sortValue: (r) => toCents(r.actual_cost) },
    { key: "profit", header: "Profit / loss", numeric: true, render: (r) => <span className={r.profit < 0 ? "font-medium text-negative" : "text-positive"}>{fmt(r.profit)}</span> },
    { key: "provider", header: "Provider", render: (r) => label(DELIVERY_PROVIDERS, r.provider) },
    { key: "driver", header: "Driver", mobile: false },
    { key: "status", header: "Status", render: (r) => <Badge className="bg-teal-50 text-teal-900">{label(DELIVERY_STATUSES, r.status)}</Badge> },
    { key: "tracking_ref", header: "Tracking", mobile: false },
  ];
  return (
    <div>
      <PageHeader title="Deliveries" crumbs={["Home", "Deliveries"]} />
      <DateRangeBar range={range} onChange={setRange} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Delivery revenue" value={rev} />
        <KpiCard label="Delivery cost" value={cost} invert />
        <KpiCard label="Delivery profit" value={rev - cost} />
        <KpiCard label="Avg cost / mile" value={miles ? Math.round(cost / miles) : null} invert />
        <KpiCard label="Loss-making deliveries" value={losses.length} kind="int" invert />
      </div>
      {losses.length > 0 && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{losses.length} delivery{losses.length > 1 ? "ies" : ""} lost money this period. Consider a higher fee for long distances or a minimum order for delivery.</p>}
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading ? <Skeleton rows={6} className="card p-5" /> : <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} initialSort={{ key: "date", dir: "desc" }} />}
      <p className="mt-3 text-xs text-charcoal/50">Distance, cost, provider and status are edited on each order's page.</p>
    </div>
  );
}
