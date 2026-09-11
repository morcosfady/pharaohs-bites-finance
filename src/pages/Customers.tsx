import { useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { MessageCircle, MapPin } from "lucide-react";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Badge, Section, Skeleton, ErrorBox, Field, Modal, ConfirmDialog, useToast } from "../components/ui";
import { useCustomers, useCustomer, useAllOrderFinancials, useWrite, useOrders } from "../hooks/queries";
import { CUSTOMER_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES, cls, label } from "../lib/status";
import { fmt, toCents } from "../lib/money";
import { fmtDate, fmtDateTime } from "../lib/dates";
import { waLink, mapsLink } from "../lib/whatsapp";
import { supabase, unwrap } from "../lib/supabase";
import { REVENUE_STATUSES } from "../lib/metrics";
import type { Customer, CustomerStatus } from "../lib/types";

type Row = Customer & { first: string | null; last: string | null; completed: number; cancelled: number; spent: number; aov: number | null; balance: number; address: string; search: string; [k: string]: unknown };

export function CustomersPage() {
  const nav = useNavigate();
  const customers = useCustomers();
  const fin = useAllOrderFinancials();
  const [q, setQ] = useState("");
  const rows = useMemo<Row[]>(() => (customers.data ?? []).map((c) => {
    const os = (fin.data ?? []).filter((o) => o.customer_id === c.id);
    const rev = os.filter((o) => REVENUE_STATUSES.includes(o.status));
    const completed = os.filter((o) => o.status === "completed").length;
    const spent = rev.reduce((s, o) => s + toCents(o.net_product_sales) + toCents(o.delivery_revenue), 0);
    const dates = os.map((o) => o.created_at).sort();
    const a = c.customer_addresses?.find((x) => x.is_default) ?? c.customer_addresses?.[0];
    return { ...c, first: dates[0] ?? null, last: dates[dates.length - 1] ?? null, completed, cancelled: os.filter((o) => o.status === "cancelled").length, spent,
      aov: rev.length ? Math.round(spent / rev.length) : null, balance: os.filter((o) => o.status !== "cancelled").reduce((s, o) => s + Math.max(0, toCents(o.balance_due)), 0),
      address: a ? `${a.street}${a.apt ? ", " + a.apt : ""}, ${a.city}` : "", search: [c.name, c.phone, a?.street, a?.city, a?.zip].join(" ").toLowerCase() };
  }), [customers.data, fin.data]);
  const filtered = rows.filter((r) => !q || r.search.includes(q.toLowerCase()));
  const cols: Column<Row>[] = [
    { key: "name", header: "Customer", primary: true, render: (r) => <span><span className="font-medium">{r.name}</span> <Badge className={cls(CUSTOMER_STATUSES, r.status)}>{label(CUSTOMER_STATUSES, r.status)}</Badge><span className="block text-xs text-charcoal/50">{r.phone}</span></span> },
    { key: "address", header: "Address", mobile: false },
    { key: "completed", header: "Completed", numeric: true },
    { key: "spent", header: "Total spent", numeric: true, render: (r) => fmt(r.spent) },
    { key: "aov", header: "Avg order", numeric: true, render: (r) => r.aov == null ? "—" : fmt(r.aov) },
    { key: "balance", header: "Balance", numeric: true, render: (r) => <span className={r.balance > 0 ? "text-negative" : ""}>{fmt(r.balance)}</span> },
    { key: "cancelled", header: "Cancelled", numeric: true, mobile: false },
    { key: "last", header: "Last order", render: (r) => fmtDate(r.last), sortValue: (r) => r.last },
  ];
  return (
    <div>
      <PageHeader title="Customers" crumbs={["Home", "Customers"]} />
      <input className="input mb-3 sm:!w-80" placeholder="Search name, phone, address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
      {customers.error && <ErrorBox error={customers.error} />}
      {customers.isLoading ? <Skeleton rows={8} className="card p-5" /> : <DataTable rows={filtered} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => nav(`/customers/${r.id}`)} initialSort={{ key: "spent", dir: "desc" }} />}
    </div>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const c = useCustomer(id);
  const orders = useOrders();
  const all = useCustomers();
  const write = useWrite(); const toast = useToast();
  const [merge, setMerge] = useState<string>("");
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [edit, setEdit] = useState(false);
  const save = async (fn: () => Promise<unknown>, msg = "Saved") => { try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };
  if (c.isLoading) return <Skeleton rows={8} className="card p-5" />;
  if (c.error || !c.data) return <ErrorBox error={c.error ?? "Not found"} />;
  const cust = c.data;
  const mine = (orders.data ?? []).filter((o) => o.customer_id === cust.id);
  const a = cust.customer_addresses?.find((x) => x.is_default) ?? cust.customer_addresses?.[0];
  const fav = (() => { const m = new Map<string, number>(); for (const o of mine) for (const i of o.order_items ?? []) m.set(i.product_name, (m.get(i.product_name) ?? 0) + i.quantity); return [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]; })();
  const dupes = (all.data ?? []).filter((x) => x.id !== cust.id && (x.phone_normalized && x.phone_normalized === cust.phone_normalized || x.name.trim().toLowerCase() === cust.name.trim().toLowerCase()));

  return (
    <div>
      <PageHeader title={cust.name} crumbs={["Home", "Customers", cust.name]} actions={<>
        {cust.phone && <a className="btn-ghost btn-sm" href={waLink(cust.phone)} target="_blank" rel="noopener"><MessageCircle size={16} /> WhatsApp</a>}
        {a && <a className="btn-ghost btn-sm" href={mapsLink(a)} target="_blank" rel="noopener"><MapPin size={16} /> Maps</a>}
        <button className="btn-ghost btn-sm" onClick={() => setEdit(true)}>Edit</button>
      </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Profile">
          <div className="mb-2 flex items-center gap-2"><Badge className={cls(CUSTOMER_STATUSES, cust.status)}>{label(CUSTOMER_STATUSES, cust.status)}</Badge>
            <select className="input !min-h-9 !w-auto !py-1" value={cust.status} onChange={(e) => save(async () => unwrap(await supabase.from("customers").update({ status: e.target.value as CustomerStatus }).eq("id", cust.id).select("id")), "Status updated")}>{CUSTOMER_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
          <p className="text-sm">{cust.phone}{cust.email ? ` · ${cust.email}` : ""}</p>
          {a && <p className="mt-2 text-sm">{a.street}{a.apt ? `, ${a.apt}` : ""}<br />{a.city}, {a.state} {a.zip}{a.instructions && <span className="block text-xs text-charcoal/60">📝 {a.instructions}</span>}</p>}
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-charcoal/60">Completed orders</dt><dd className="text-right">{mine.filter((o) => o.status === "completed").length}</dd>
            <dt className="text-charcoal/60">Cancelled</dt><dd className="text-right">{mine.filter((o) => o.status === "cancelled").length}</dd>
            <dt className="text-charcoal/60">Favourite product</dt><dd className="text-right">{fav ?? "—"}</dd>
            <dt className="text-charcoal/60">First order</dt><dd className="text-right">{fmtDate(mine.map((o) => o.created_at).sort()[0])}</dd>
          </dl>
          <Field label="Internal notes" className="mt-3"><textarea className="input min-h-20" defaultValue={cust.internal_notes} onBlur={(e) => e.target.value !== cust.internal_notes && save(async () => unwrap(await supabase.from("customers").update({ internal_notes: e.target.value }).eq("id", cust.id).select("id")))} /></Field>
          {dupes.length > 0 && (
            <div className="mt-3 rounded-lg border border-warning/40 bg-amber-50 p-3 text-xs">
              <p className="font-medium text-amber-900">Possible duplicates</p>
              <select className="input !min-h-9 mt-2 !py-1" value={merge} onChange={(e) => setMerge(e.target.value)}><option value="">Choose a record to merge into this one…</option>{dupes.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.phone}</option>)}</select>
              <button className="btn-ghost btn-sm mt-2" disabled={!merge} onClick={() => setConfirmMerge(true)}>Merge selected into {cust.name}</button>
            </div>
          )}
        </Section>
        <Section title="Order history" className="lg:col-span-2">
          {mine.length === 0 ? <p className="text-sm text-charcoal/60">No orders yet.</p> : (
            <ul className="divide-y divide-ivory-200 text-sm">{mine.map((o) => (
              <li key={o.id}><Link to={`/orders/${o.id}`} className="flex flex-wrap items-center gap-2 py-2 hover:bg-ivory-50"><span className="font-mono text-xs text-teal-800">{o.order_number}</span><span className="text-charcoal/60">{fmtDateTime(o.created_at)}</span><Badge className={cls(ORDER_STATUSES, o.status)}>{label(ORDER_STATUSES, o.status)}</Badge><Badge className={cls(PAYMENT_STATUSES, o.payment_status)}>{label(PAYMENT_STATUSES, o.payment_status)}</Badge><span className="ml-auto tabular-nums">{fmt(toCents(o.total))}</span></Link></li>
            ))}</ul>
          )}
        </Section>
      </div>
      <ConfirmDialog open={confirmMerge} title="Merge customer records?" body="Orders and addresses from the selected record move to this customer. The other record is archived. This cannot be undone from the dashboard." danger confirmLabel="Merge" onCancel={() => setConfirmMerge(false)} onConfirm={async () => { setConfirmMerge(false); await save(async () => unwrap(await supabase.rpc("merge_customers", { p_keep: cust.id, p_merge: merge })), "Customers merged"); setMerge(""); }} />
      <EditCustomer open={edit} onClose={() => setEdit(false)} cust={cust} onSave={save} />
    </div>
  );
}

function EditCustomer({ open, onClose, cust, onSave }: { open: boolean; onClose: () => void; cust: Customer; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const a = cust.customer_addresses?.find((x) => x.is_default) ?? cust.customer_addresses?.[0];
  const [f, setF] = useState({ name: cust.name, phone: cust.phone, email: cust.email, street: a?.street ?? "", apt: a?.apt ?? "", city: a?.city ?? "", state: a?.state ?? "TX", zip: a?.zip ?? "", instructions: a?.instructions ?? "" });
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Edit customer" wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={f.name} onChange={u("name")} /></Field><Field label="Phone"><input className="input" value={f.phone} onChange={u("phone")} /></Field>
        <Field label="Email"><input className="input" value={f.email} onChange={u("email")} /></Field><Field label="Street"><input className="input" value={f.street} onChange={u("street")} /></Field>
        <Field label="Apt / unit"><input className="input" value={f.apt} onChange={u("apt")} /></Field><Field label="City"><input className="input" value={f.city} onChange={u("city")} /></Field>
        <Field label="State"><input className="input" maxLength={2} value={f.state} onChange={u("state")} /></Field><Field label="ZIP"><input className="input" value={f.zip} onChange={u("zip")} /></Field>
        <Field label="Delivery instructions" className="sm:col-span-2"><input className="input" value={f.instructions} onChange={u("instructions")} /></Field>
      </div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={async () => {
        await onSave(async () => {
          unwrap(await supabase.from("customers").update({ name: f.name, phone: f.phone, phone_normalized: f.phone.replace(/\D/g, ""), email: f.email }).eq("id", cust.id).select("id"));
          if (f.street) unwrap(await supabase.from("customer_addresses").upsert({ ...(a ? { id: a.id } : {}), customer_id: cust.id, street: f.street, apt: f.apt, city: f.city, state: f.state.toUpperCase(), zip: f.zip, instructions: f.instructions, is_default: true }).select("id"));
        }, "Customer updated"); onClose();
      }}>Save</button></div>
    </Modal>
  );
}
