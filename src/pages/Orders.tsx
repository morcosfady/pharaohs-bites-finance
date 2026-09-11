import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Badge, Skeleton, ErrorBox, Modal, Field, useToast, EmptyState } from "../components/ui";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { useOrders, useProducts, useCategories, useWrite } from "../hooks/queries";
import { ORDER_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS, cls, label } from "../lib/status";
import { fmt, toCents } from "../lib/money";
import { fmtDateTime, inRange } from "../lib/dates";
import type { Order, OrderItem } from "../lib/types";
import { supabase, unwrap } from "../lib/supabase";
import { downloadText, toCsv } from "../lib/csv";

type Row = Order & { cost: number; profit: number; balance: number; search: string };

function lineCost(i: OrderItem) { return i.quantity * (toCents(i.unit_ingredient_cost) + toCents(i.unit_packaging_cost) + toCents(i.unit_other_cost)); }

export function OrdersPage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [range, setRange] = useDateRange("this_month");
  const orders = useOrders();
  const products = useProducts();
  const cats = useCategories();
  const [q, setQ] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const f = {
    status: sp.get("status") ?? "", payment: sp.get("payment") ?? "", method: sp.get("method") ?? "", product: sp.get("product") ?? "",
    category: sp.get("category") ?? "", delivery: sp.get("delivery") ?? "", tax: sp.get("tax") ?? "", profit: sp.get("profit") ?? "", all: sp.get("all") === "1",
  };
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };

  const rows = useMemo<Row[]>(() => (orders.data ?? []).map((o) => {
    const items = o.order_items ?? [];
    const cost = items.reduce((s, i) => s + lineCost(i), 0);
    const d = Array.isArray(o.delivery_records) ? o.delivery_records[0] : o.delivery_records;
    const deliveryRevenue = o.delivery_fee_customer_paid ? toCents(o.delivery_fee) : 0;
    const profit = toCents(o.subtotal) - toCents(o.discount) + deliveryRevenue - cost - toCents(d?.actual_cost ?? 0);
    return { ...o, cost, profit, balance: toCents(o.total) - toCents(o.amount_paid) + toCents(o.amount_refunded),
      search: [o.order_number, o.customer_name, o.customer_phone, o.address_street, o.address_city, o.address_zip].join(" ").toLowerCase() };
  }), [orders.data]);

  const filtered = useMemo(() => rows.filter((o) => {
    if (!f.all && !inRange(o.created_at, range)) return false;
    if (f.status && o.status !== f.status) return false;
    if (f.payment && o.payment_status !== f.payment) return false;
    if (f.method && o.payment_method !== f.method) return false;
    if (f.delivery && o.delivery_method !== f.delivery) return false;
    if (f.product && !(o.order_items ?? []).some((i) => i.product_id === f.product)) return false;
    if (f.category) {
      const ids = new Set((products.data ?? []).filter((p) => p.category_id === f.category).map((p) => p.id));
      if (!(o.order_items ?? []).some((i) => i.product_id && ids.has(i.product_id))) return false;
    }
    if (f.tax === "taxable" && toCents(o.tax_amount) === 0) return false;
    if (f.tax === "nontaxable" && toCents(o.tax_amount) > 0) return false;
    if (f.profit === "profitable" && o.profit <= 0) return false;
    if (f.profit === "unprofitable" && o.profit > 0) return false;
    if (q && !o.search.includes(q.toLowerCase())) return false;
    return true;
  }), [rows, f, range, q, products.data]);

  const cols: Column<Row>[] = [
    { key: "order_number", header: "Order #", primary: true, render: (o) => <span className="font-mono text-xs font-medium text-teal-800">{o.order_number}</span> },
    { key: "created_at", header: "Date", render: (o) => fmtDateTime(o.created_at), sortValue: (o) => o.created_at },
    { key: "customer_name", header: "Customer", render: (o) => <span>{o.customer_name}<span className="block text-xs text-charcoal/50">{o.customer_phone}</span></span> },
    { key: "status", header: "Status", render: (o) => <Badge className={cls(ORDER_STATUSES, o.status)}>{label(ORDER_STATUSES, o.status)}</Badge> },
    { key: "payment_status", header: "Payment", render: (o) => <Badge className={cls(PAYMENT_STATUSES, o.payment_status)}>{label(PAYMENT_STATUSES, o.payment_status)}</Badge> },
    { key: "subtotal", header: "Subtotal", numeric: true, render: (o) => fmt(toCents(o.subtotal)), sortValue: (o) => toCents(o.subtotal) },
    { key: "discount", header: "Discount", numeric: true, mobile: false, render: (o) => fmt(toCents(o.discount)), sortValue: (o) => toCents(o.discount) },
    { key: "delivery_fee", header: "Delivery", numeric: true, mobile: false, render: (o) => fmt(toCents(o.delivery_fee)), sortValue: (o) => toCents(o.delivery_fee) },
    { key: "tax_amount", header: "Tax", numeric: true, mobile: false, render: (o) => fmt(toCents(o.tax_amount)), sortValue: (o) => toCents(o.tax_amount) },
    { key: "total", header: "Total", numeric: true, render: (o) => <b>{fmt(toCents(o.total))}</b>, sortValue: (o) => toCents(o.total) },
    { key: "amount_paid", header: "Paid", numeric: true, render: (o) => fmt(toCents(o.amount_paid)), sortValue: (o) => toCents(o.amount_paid) },
    { key: "balance", header: "Balance", numeric: true, render: (o) => <span className={o.balance > 0 ? "text-negative" : ""}>{fmt(o.balance)}</span> },
    { key: "cost", header: "Cost", numeric: true, mobile: false, render: (o) => fmt(o.cost) },
    { key: "profit", header: "Profit", numeric: true, render: (o) => <span className={o.profit < 0 ? "text-negative" : "text-positive"}>{fmt(o.profit)}</span> },
    { key: "payment_method", header: "Method", mobile: false, render: (o) => label(PAYMENT_METHODS, o.payment_method) },
    { key: "delivery_method", header: "Fulfilment", mobile: false, render: (o) => o.delivery_method === "delivery" ? "Delivery" : "Pickup" },
  ];

  const exportCsv = () => downloadText(`orders-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(filtered.map((o) => ({
    order_number: o.order_number, date: o.created_at, customer: o.customer_name, phone: o.customer_phone, status: o.status, payment_status: o.payment_status,
    payment_method: o.payment_method ?? "", delivery_method: o.delivery_method, subtotal: o.subtotal, discount: o.discount, delivery_fee: o.delivery_fee,
    tax: o.tax_amount, total: o.total, paid: o.amount_paid, refunded: o.amount_refunded, balance: (o.balance / 100).toFixed(2), cost: (o.cost / 100).toFixed(2), profit: (o.profit / 100).toFixed(2),
    address: [o.address_street, o.address_apt, o.address_city, o.address_state, o.address_zip].filter(Boolean).join(", "),
  }))));

  const sel = "input !min-h-9 !py-1 !w-auto";
  return (
    <div>
      <PageHeader title="Orders" crumbs={["Home", "Orders"]} actions={<>
        <button className="btn-ghost btn-sm" onClick={exportCsv}>Export CSV</button>
        <button className="btn-gold btn-sm" onClick={() => setNewOpen(true)}><Plus size={16} /> Manual order</button>
      </>} />
      <DateRangeBar range={range} onChange={setRange} />
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input !min-h-9 !py-1 sm:!w-64" placeholder="Search order #, name, phone, address" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
        <select className={sel} value={f.status} onChange={(e) => set("status", e.target.value)} aria-label="Order status"><option value="">Any status</option>{ORDER_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        <select className={sel} value={f.payment} onChange={(e) => set("payment", e.target.value)} aria-label="Payment status"><option value="">Any payment</option>{PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        <select className={sel} value={f.method} onChange={(e) => set("method", e.target.value)} aria-label="Payment method"><option value="">Any method</option>{PAYMENT_METHODS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
        <select className={sel} value={f.product} onChange={(e) => set("product", e.target.value)} aria-label="Product"><option value="">Any product</option>{(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select className={sel} value={f.category} onChange={(e) => set("category", e.target.value)} aria-label="Category"><option value="">Any category</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className={sel} value={f.delivery} onChange={(e) => set("delivery", e.target.value)} aria-label="Fulfilment"><option value="">Delivery or pickup</option><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select>
        <select className={sel} value={f.tax} onChange={(e) => set("tax", e.target.value)} aria-label="Tax"><option value="">Taxable or not</option><option value="taxable">Taxable</option><option value="nontaxable">Nontaxable</option></select>
        <select className={sel} value={f.profit} onChange={(e) => set("profit", e.target.value)} aria-label="Profitability"><option value="">Any profitability</option><option value="profitable">Profitable</option><option value="unprofitable">Unprofitable</option></select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={f.all} onChange={(e) => set("all", e.target.checked ? "1" : "")} /> ignore date range</label>
      </div>
      {orders.error && <ErrorBox error={orders.error} />}
      {orders.isLoading ? <Skeleton rows={8} className="card p-5" /> : (
        <DataTable rows={filtered} columns={cols} rowKey={(o) => o.id} onRowClick={(o) => nav(`/orders/${o.id}`)} initialSort={{ key: "created_at", dir: "desc" }}
          empty={<EmptyState title="No orders match" hint="Website orders appear here the moment a customer taps the WhatsApp button. Try widening the date range." action={<Link to="/orders?all=1" className="btn-ghost btn-sm">Show all orders</Link>} />} />
      )}
      <NewOrderModal open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function NewOrderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [method, setMethod] = useState<"delivery" | "pickup">("delivery");
  const write = useWrite(); const toast = useToast(); const nav = useNavigate();
  const submit = async () => {
    try {
      const id = (await write.mutateAsync(async () => unwrap(await supabase.rpc("create_manual_order", { p_customer_name: name.trim(), p_customer_phone: phone.trim(), p_delivery_method: method })))) as string;
      toast.push("Order created"); onClose(); nav(`/orders/${id}`);
    } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New manual order">
      <Field label="Customer name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Phone"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <Field label="Fulfilment"><select className="input" value={method} onChange={(e) => setMethod(e.target.value as "delivery" | "pickup")}><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!name.trim() || write.isPending} onClick={submit}>Create order</button></div>
    </Modal>
  );
}
