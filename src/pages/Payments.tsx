import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Section, Skeleton, ErrorBox, KpiCard, Badge, useToast } from "../components/ui";
import { PaymentModal } from "./OrderDetail";
import { waLink } from "../lib/whatsapp";
import { usePayments, useRefunds, useAllOrderFinancials, useWrite } from "../hooks/queries";
import { PAYMENT_METHODS, PAYMENT_STATUSES, label, cls } from "../lib/status";
import { fmt, toCents, sum } from "../lib/money";
import { fmtDateTime, toInputDate } from "../lib/dates";
import { downloadText, toCsv } from "../lib/csv";
import type { Payment, OrderFinancial } from "../lib/types";

export function PaymentsPage() {
  const [range, setRange] = useDateRange("this_month");
  const payments = usePayments(range);
  const refunds = useRefunds(range);
  const fin = useAllOrderFinancials();
  const live = (payments.data ?? []).filter((p) => !p.voided_at);
  const byMethod = useMemo(() => PAYMENT_METHODS.map((m) => ({ ...m, total: sum(live.filter((p) => p.method === m.value).map((p) => toCents(p.amount))), count: live.filter((p) => p.method === m.value).length })).filter((m) => m.count), [live]);
  const outstanding = (fin.data ?? []).filter((o) => o.status !== "cancelled" && toCents(o.balance_due) > 0).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const [collect, setCollect] = useState<OrderFinancial | null>(null);
  const write = useWrite(); const toast = useToast();
  const save = async (fn: () => Promise<unknown>, msg = "Saved") => { try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };
  const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  const reminder = (o: OrderFinancial) => waLink(o.customer_phone, `Hi ${o.customer_name}, a friendly reminder from Pharaoh's Bites: order ${o.order_number} has a balance of ${fmt(toCents(o.balance_due))}. Thank you!`);
  const cols: Column<Payment & { [k: string]: unknown }>[] = [
    { key: "paid_at", header: "Date", render: (p) => fmtDateTime(p.paid_at) },
    { key: "order", header: "Order", primary: true, render: (p) => <Link to={`/orders/${p.order_id}`} className="font-mono text-xs text-teal-800 hover:underline">{p.orders?.order_number}</Link>, sortValue: (p) => p.orders?.order_number ?? "" },
    { key: "customer", header: "Customer", render: (p) => p.orders?.customer_name ?? "", sortValue: (p) => p.orders?.customer_name ?? "" },
    { key: "amount", header: "Amount", numeric: true, render: (p) => <span className={p.voided_at ? "line-through opacity-50" : "font-medium"}>{fmt(toCents(p.amount))}</span>, sortValue: (p) => toCents(p.amount) },
    { key: "method", header: "Method", render: (p) => label(PAYMENT_METHODS, p.method) },
    { key: "reference", header: "Reference", mobile: false },
    { key: "notes", header: "Notes", mobile: false },
  ];
  return (
    <div>
      <PageHeader title="Payments" crumbs={["Home", "Payments"]} actions={<button className="btn-ghost btn-sm" onClick={() => downloadText(`payments-${toInputDate(range.from)}-${toInputDate(range.to)}.csv`, toCsv(live.map((p) => ({ date: p.paid_at, order: p.orders?.order_number, customer: p.orders?.customer_name, amount: p.amount, method: p.method, reference: p.reference, notes: p.notes }))))}>Export CSV</button>} />
      <DateRangeBar range={range} onChange={setRange} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Collected" value={sum(live.map((p) => toCents(p.amount)))} />
        <KpiCard label="Refunded" value={sum((refunds.data ?? []).filter((r) => !r.voided_at).map((r) => toCents(r.amount)))} invert />
        <KpiCard label="Payments" value={live.length} kind="int" />
        <KpiCard label="Outstanding (all time)" value={sum(outstanding.map((o) => toCents(o.balance_due)))} invert />
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Section title="By method">{byMethod.length === 0 ? <p className="text-sm text-charcoal/60">No payments in this period.</p> : <ul className="divide-y divide-ivory-200 text-sm">{byMethod.map((m) => <li key={m.value} className="flex justify-between py-2"><span>{m.label} <span className="text-charcoal/50">· {m.count}</span></span><b>{fmt(m.total)}</b></li>)}</ul>}</Section>
        <Section title="Payment collector">{outstanding.length === 0 ? <p className="text-sm text-charcoal/60">Everything is paid up.</p> : <ul className="max-h-72 divide-y divide-ivory-200 overflow-y-auto text-sm">{outstanding.map((o) => <li key={o.id} className="flex flex-wrap items-center gap-2 py-2"><Link to={`/orders/${o.id}`} className="font-mono text-xs text-teal-800 hover:underline">{o.order_number}</Link><span>{o.customer_name}</span><Badge className={cls(PAYMENT_STATUSES, o.payment_status)}>{label(PAYMENT_STATUSES, o.payment_status)}</Badge><span className="text-xs text-charcoal/50">{ageDays(o.created_at)}d old</span><b className="ml-auto text-negative">{fmt(toCents(o.balance_due))}</b>{o.customer_phone && <a className="btn-ghost btn-sm" href={reminder(o)} target="_blank" rel="noreferrer">Remind</a>}<button className="btn-gold btn-sm" onClick={() => setCollect(o)}>Collect</button></li>)}</ul>}</Section>
      </div>
      {payments.error && <ErrorBox error={payments.error} />}
      {payments.isLoading ? <Skeleton rows={6} className="card p-5" /> : <DataTable rows={(payments.data ?? []) as (Payment & { [k: string]: unknown })[]} columns={cols} rowKey={(p) => p.id} initialSort={{ key: "paid_at", dir: "desc" }} />}
      {collect && <PaymentModal open onClose={() => setCollect(null)} orderId={collect.id} balance={toCents(collect.balance_due)} defaultMethod={collect.payment_method} onSave={save} />}
    </div>
  );
}
