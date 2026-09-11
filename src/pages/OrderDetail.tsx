import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { MessageCircle, MapPin, Printer, Plus, Trash2 } from "lucide-react";
import { useOrder, useProducts, useSettings, useWrite, useAudit } from "../hooks/queries";
import { PageHeader, Badge, Section, Skeleton, ErrorBox, Modal, Field, ConfirmDialog, useToast } from "../components/ui";
import { ORDER_STATUSES, PAYMENT_STATUSES, PAYMENT_METHODS, DELIVERY_PROVIDERS, DELIVERY_STATUSES, cls, label } from "../lib/status";
import { fmt, toCents, fromCents, pct } from "../lib/money";
import { fmtDateTime } from "../lib/dates";
import { waLink, mapsLink, fillTemplate } from "../lib/whatsapp";
import { supabase, unwrap } from "../lib/supabase";
import type { Order, OrderItem, OrderStatus, PaymentMethod, DeliveryProvider, DeliveryStatus, DeliveryRecord } from "../lib/types";
import { useAdvanced } from "../hooks/useMode";

const SIMPLE_STATUSES: { value: OrderStatus; label: string }[] = [
  { value: "pending_whatsapp_confirmation", label: "New" }, { value: "confirmed", label: "Confirmed" }, { value: "completed", label: "Done" }, { value: "cancelled", label: "Cancelled" },
];

export function OrderDetailPage() {
  const { id } = useParams();
  const q = useOrder(id);
  const settings = useSettings();
  const advanced = useAdvanced();
  const write = useWrite();
  const toast = useToast();
  const o = q.data;
  const [confirm, setConfirm] = useState<{ title: string; body: string; run: () => Promise<void>; danger?: boolean } | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editCust, setEditCust] = useState(false);

  const save = async (fn: () => Promise<unknown>, msg = "Saved") => {
    try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); }
  };
  const upd = (patch: Partial<Order>, msg?: string) => save(async () => unwrap(await supabase.from("orders").update(patch).eq("id", id!).select("id")), msg);

  if (q.isLoading) return <Skeleton rows={10} className="card p-5" />;
  if (q.error || !o) return <ErrorBox error={q.error ?? "Order not found"} />;

  const items = o.order_items ?? [];
  const d = Array.isArray(o.delivery_records) ? o.delivery_records[0] : o.delivery_records ?? null;
  const cost = items.reduce((s, i) => s + i.quantity * (toCents(i.unit_ingredient_cost) + toCents(i.unit_packaging_cost) + toCents(i.unit_other_cost)), 0);
  const labor = items.reduce((s, i) => s + i.quantity * toCents(i.unit_labor_cost), 0);
  const deliveryRevenue = o.delivery_fee_customer_paid ? toCents(o.delivery_fee) : 0;
  const profit = toCents(o.subtotal) - toCents(o.discount) + deliveryRevenue - cost - toCents(d?.actual_cost ?? 0) - (settings.data?.include_owner_labor ? labor : 0);
  const balance = toCents(o.total) - toCents(o.amount_paid) + toCents(o.amount_refunded);
  const address = { street: o.address_street, apt: o.address_apt, city: o.address_city, state: o.address_state, zip: o.address_zip };
  const locked = o.status === "completed" || o.status === "refunded" || o.status === "cancelled";

  const setStatus = (s: OrderStatus) => {
    const sensitive = s === "cancelled" || s === "refunded" || s === "completed";
    const run = () => upd({ status: s }, `Status → ${label(ORDER_STATUSES, s)}`);
    if (sensitive) setConfirm({ title: `Mark order ${label(ORDER_STATUSES, s).toLowerCase()}?`, body: s === "cancelled" ? "Cancelled orders are excluded from sales. The order is kept for the audit trail." : s === "refunded" ? "Record the refund amount separately in Payments & refunds; the original transaction is preserved." : "Completed orders count towards revenue, cost and profit.", run, danger: s === "cancelled" });
    else run();
  };

  const ownerMsg = fillTemplate(settings.data?.default_whatsapp_message ?? "", { name: o.customer_name, order_number: o.order_number, delivery_fee: fmt(toCents(o.delivery_fee)), total: fmt(toCents(o.total)) });

  return (
    <div>
      <PageHeader title={o.order_number} crumbs={["Home", "Orders", o.order_number]} actions={<>
        <a className="btn-ghost btn-sm no-print" href={waLink(o.customer_phone, ownerMsg)} target="_blank" rel="noopener"><MessageCircle size={16} /> WhatsApp customer</a>
        {o.delivery_method === "delivery" && <a className="btn-ghost btn-sm no-print" href={mapsLink(address)} target="_blank" rel="noopener"><MapPin size={16} /> Open in Maps</a>}
        <button className="btn-ghost btn-sm no-print" onClick={() => window.print()}><Printer size={16} /> Print / PDF</button>
      </>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge className={cls(ORDER_STATUSES, o.status)}>{label(ORDER_STATUSES, o.status)}</Badge>
        <Badge className={cls(PAYMENT_STATUSES, o.payment_status)}>{label(PAYMENT_STATUSES, o.payment_status)}</Badge>
        <span className="text-xs text-charcoal/60">Placed {fmtDateTime(o.created_at)} · via {o.source}{o.requested_at ? ` · requested for ${fmtDateTime(o.requested_at)}` : ""}</span>
      </div>

      {/* status workflow */}
      <div className="no-print mb-4 flex flex-wrap gap-1.5">
        {(advanced ? ORDER_STATUSES : SIMPLE_STATUSES).map((s) => (
          <button key={s.value} disabled={s.value === o.status || write.isPending} onClick={() => setStatus(s.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition disabled:opacity-60 ${s.value === o.status ? "bg-teal-800 text-ivory ring-teal-800" : "bg-white text-teal-900 ring-ivory-200 hover:bg-ivory-50"}`}>
            {s.label}
          </button>
        ))}
        {!advanced && !SIMPLE_STATUSES.some((s) => s.value === o.status) && <span className="badge bg-teal-100 text-teal-900">{label(ORDER_STATUSES, o.status)}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3 print:hidden">
        <div className="space-y-4 lg:col-span-2">
          {/* items */}
          <Section title="Items" right={!locked && <button className="btn-ghost btn-sm no-print" onClick={() => setAddOpen(true)}><Plus size={14} /> Add product</button>}>
            <div className="table-wrap"><table className="table !min-w-0">
              <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Line</th><th>Taxable</th><th className="no-print"></th></tr></thead>
              <tbody>
                {items.map((i) => <ItemRow key={i.id} item={i} locked={locked} onSave={save} />)}
                {items.length === 0 && <tr><td colSpan={6} className="text-center text-charcoal/50">No items yet.</td></tr>}
              </tbody>
            </table></div>
          </Section>

          {/* money */}
          <Section title="Pricing, delivery & tax">
            <div className="grid gap-4 sm:grid-cols-2">
              <MoneyField label="Discount" value={o.discount} disabled={locked} onSave={(v) => upd({ discount: v })} />
              <Field label="Discount reason"><input className="input" defaultValue={o.discount_reason} disabled={locked} onBlur={(e) => e.target.value !== o.discount_reason && upd({ discount_reason: e.target.value })} /></Field>
              <MoneyField label="Delivery fee charged" value={o.delivery_fee} disabled={locked} onSave={(v) => upd({ delivery_fee: v })} />
              {advanced && <Field label="Who pays the delivery fee">
                <select className="input" value={o.delivery_fee_customer_paid ? "customer" : "business"} disabled={locked} onChange={(e) => upd({ delivery_fee_customer_paid: e.target.value === "customer" })}>
                  <option value="customer">Customer pays (counts as revenue)</option><option value="business">Business absorbs / subsidised</option>
                </select>
              </Field>}
              {advanced && <Field label="Tax rate applied" hint="Estimated sales tax. Set per order; product taxability is per line.">
                <input className="input" type="number" step="0.0001" min="0" defaultValue={Number(o.tax_rate_applied)} disabled={locked || o.tax_manually_set} onBlur={(e) => Number(e.target.value) !== Number(o.tax_rate_applied) && upd({ tax_rate_applied: Number(e.target.value) })} />
              </Field>}
              {advanced && <div>
                <MoneyField label={o.tax_manually_set ? "Tax amount (manual)" : "Tax amount (calculated)"} value={o.tax_amount} disabled={locked || !o.tax_manually_set} onSave={(v) => upd({ tax_amount: v, tax_manually_set: true })} />
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={o.tax_manually_set} disabled={locked} onChange={(e) => upd({ tax_manually_set: e.target.checked })} /> set tax manually</label>
              </div>}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-y-1 border-t border-ivory-200 pt-3 text-sm sm:grid-cols-4">
              <dt className="text-charcoal/60">Subtotal</dt><dd className="text-right tabular-nums">{fmt(toCents(o.subtotal))}</dd>
              <dt className="text-charcoal/60">Discount</dt><dd className="text-right tabular-nums">−{fmt(toCents(o.discount))}</dd>
              <dt className="text-charcoal/60">Delivery</dt><dd className="text-right tabular-nums">{fmt(toCents(o.delivery_fee))}</dd>
              <dt className="text-charcoal/60">Est. tax</dt><dd className="text-right tabular-nums">{fmt(toCents(o.tax_amount))}</dd>
              <dt className="font-medium">Final total</dt><dd className="text-right font-display text-lg font-semibold text-teal-900">{fmt(toCents(o.total))}</dd>
              <dt className="text-charcoal/60">Paid</dt><dd className="text-right tabular-nums">{fmt(toCents(o.amount_paid))}</dd>
              <dt className="text-charcoal/60">Balance due</dt><dd className={`text-right tabular-nums ${balance > 0 ? "text-negative" : "text-positive"}`}>{fmt(balance)}</dd>
            </dl>
            <dl className={`mt-3 grid grid-cols-2 gap-y-1 rounded-lg bg-teal-50 px-3 py-2 text-sm sm:grid-cols-4 ${advanced ? "" : "hidden"}`}>
              <dt className="text-charcoal/60">Cost of goods</dt><dd className="text-right tabular-nums">{fmt(cost)}</dd>
              <dt className="text-charcoal/60">Delivery cost</dt><dd className="text-right tabular-nums">{fmt(toCents(d?.actual_cost ?? 0))}</dd>
              <dt className="text-charcoal/60">Owner labor{settings.data?.include_owner_labor ? "" : " (excluded)"}</dt><dd className="text-right tabular-nums">{fmt(labor)}</dd>
              <dt className="font-medium">Order profit</dt><dd className={`text-right font-semibold tabular-nums ${profit < 0 ? "text-negative" : "text-positive"}`}>{fmt(profit)} <span className="text-xs font-normal text-charcoal/50">({pct(toCents(o.subtotal) - toCents(o.discount) ? profit / (toCents(o.subtotal) - toCents(o.discount)) : null)})</span></dd>
            </dl>
          </Section>

          {/* payments */}
          <Section title={advanced ? "Payments & refunds" : "Payment"} right={<div className="no-print flex gap-2">{advanced && <button className="btn-ghost btn-sm" onClick={() => setRefundOpen(true)}>Refund</button>}<button className="btn-gold btn-sm" onClick={() => setPayOpen(true)}><Plus size={14} /> Record payment</button></div>}>
            <div className={`grid gap-4 sm:grid-cols-2 ${advanced ? "" : "hidden"}`}>
              <Field label="Payment method"><select className="input" value={o.payment_method ?? ""} onChange={(e) => upd({ payment_method: (e.target.value || null) as PaymentMethod | null })}><option value="">—</option>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
              <Field label="Payment status" hint="Derived automatically from payments; choose Disputed or Deposit received to override."><select className="input" value={o.payment_status} onChange={(e) => upd({ payment_status: e.target.value as Order["payment_status"] })}>{PAYMENT_STATUSES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
            </div>
            <ul className="divide-y divide-ivory-200 text-sm">
              {(o.payments ?? []).map((p) => (
                <li key={p.id} className={`flex flex-wrap items-center gap-2 py-2 ${p.voided_at ? "line-through opacity-50" : ""}`}>
                  <span className="text-positive">+{fmt(toCents(p.amount))}</span><span>{label(PAYMENT_METHODS, p.method)}</span><span className="text-xs text-charcoal/50">{fmtDateTime(p.paid_at)}{p.reference ? ` · ref ${p.reference}` : ""}{p.notes ? ` · ${p.notes}` : ""}</span>
                  {!p.voided_at && <button className="no-print ml-auto text-xs text-negative hover:underline" onClick={() => setConfirm({ title: "Void this payment?", body: "The payment stays in the audit trail but no longer counts.", danger: true, run: () => save(async () => unwrap(await supabase.from("payments").update({ voided_at: new Date().toISOString() }).eq("id", p.id).select("id")), "Payment voided") })}>void</button>}
                </li>
              ))}
              {(o.refunds ?? []).map((r) => (
                <li key={r.id} className={`flex flex-wrap items-center gap-2 py-2 ${r.voided_at ? "line-through opacity-50" : ""}`}>
                  <span className="text-negative">−{fmt(toCents(r.amount))}</span><span>refund · {label(PAYMENT_METHODS, r.method)}</span><span className="text-xs text-charcoal/50">{fmtDateTime(r.refunded_at)}{r.reason ? ` · ${r.reason}` : ""}{toCents(r.tax_portion) ? ` · incl. ${fmt(toCents(r.tax_portion))} tax` : ""}</span>
                </li>
              ))}
              {!(o.payments?.length || o.refunds?.length) && <li className="py-3 text-charcoal/50">No payments recorded.</li>}
            </ul>
          </Section>

          {/* delivery */}
          {o.delivery_method === "delivery" && <DeliveryPanel orderId={o.id} record={d} fee={toCents(o.delivery_fee)} locked={locked} onSave={save} mileageCost={Number(settings.data?.default_mileage_cost_per_mile ?? 0)} deliveryRate={Number(settings.data?.default_delivery_rate_per_mile ?? 0)} onFee={(v) => upd({ delivery_fee: v })} advanced={advanced} />}

          {/* notes */}
          <Section title="Notes">
            <div className={`grid gap-4 ${advanced ? "sm:grid-cols-2" : ""}`}>
              <Field label={advanced ? "Internal notes (owner only)" : "Notes"}><textarea className="input min-h-24" defaultValue={o.internal_notes} onBlur={(e) => e.target.value !== o.internal_notes && upd({ internal_notes: e.target.value })} /></Field>
              {advanced && <Field label="Customer-visible notes (printed on the summary)"><textarea className="input min-h-24" defaultValue={o.customer_notes} onBlur={(e) => e.target.value !== o.customer_notes && upd({ customer_notes: e.target.value })} /></Field>}
            </div>
          </Section>
        </div>

        <div className="space-y-4">
          <Section title="Customer" right={<button className="btn-ghost btn-sm no-print" onClick={() => setEditCust(true)}>Edit</button>}>
            <p className="font-medium">{o.customer_name}</p>
            <p className="text-sm">{o.customer_phone}</p>
            {o.delivery_method === "delivery" ? (
              <p className="mt-2 text-sm text-charcoal/80">{o.address_street}{o.address_apt ? `, ${o.address_apt}` : ""}<br />{o.address_city}, {o.address_state} {o.address_zip}</p>
            ) : <p className="mt-2 text-sm">Customer pickup</p>}
            {o.delivery_instructions && <p className="mt-2 rounded-lg bg-ivory-50 px-3 py-2 text-xs">📝 {o.delivery_instructions}</p>}
            {o.customer_id && <Link to={`/customers/${o.customer_id}`} className="no-print mt-2 inline-block text-xs text-teal-700 hover:underline">Customer history →</Link>}
          </Section>
          <Section title="History">
            <ol className="space-y-2 text-xs">
              {[...(o.order_status_history ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((h) => (
                <li key={h.id} className="flex gap-2"><span className="w-28 shrink-0 text-charcoal/50">{fmtDateTime(h.created_at)}</span><span>{h.from_status ? `${label(ORDER_STATUSES, h.from_status)} → ` : ""}<b>{label(ORDER_STATUSES, h.to_status)}</b>{h.note ? ` — ${h.note}` : ""}</span></li>
              ))}
            </ol>
            {advanced && <AuditTrail table="orders" id={o.id} />}
          </Section>
          {!locked && <div className="no-print flex gap-2">
            <button className="btn-primary flex-1" onClick={() => setStatus("confirmed")} disabled={o.status === "confirmed"}>Confirm order</button>
            <button className="btn-danger" onClick={() => setStatus("cancelled")}>Cancel</button>
          </div>}
        </div>
      </div>

      {/* print summary */}
      <PrintSummary o={o} items={items} business={settings.data?.business_name ?? "Pharaoh's Bites"} />

      <ConfirmDialog open={!!confirm} title={confirm?.title ?? ""} body={confirm?.body} danger={confirm?.danger} onCancel={() => setConfirm(null)} onConfirm={async () => { const c = confirm; setConfirm(null); await c?.run(); }} />
      <PaymentModal open={payOpen} onClose={() => setPayOpen(false)} orderId={o.id} balance={balance} defaultMethod={o.payment_method} onSave={save} />
      <RefundModal open={refundOpen} onClose={() => setRefundOpen(false)} orderId={o.id} maxAmount={toCents(o.amount_paid) - toCents(o.amount_refunded)} payments={o.payments ?? []} onSave={save} />
      <AddProductModal open={addOpen} onClose={() => setAddOpen(false)} orderId={o.id} onSave={save} />
      <EditCustomerModal open={editCust} onClose={() => setEditCust(false)} o={o} onSave={(patch) => upd(patch, "Customer updated")} />
    </div>
  );
}

function ItemRow({ item, locked, onSave }: { item: OrderItem; locked: boolean; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const upd = (patch: Partial<OrderItem>) => onSave(async () => unwrap(await supabase.from("order_items").update(patch).eq("id", item.id).select("id")));
  return (
    <tr>
      <td><div>{item.product_name}</div>{!locked ? <input className="input !min-h-8 !py-0.5 mt-1 text-xs" placeholder="options" defaultValue={item.options} onBlur={(e) => e.target.value !== item.options && upd({ options: e.target.value })} /> : item.options && <div className="text-xs text-charcoal/60">{item.options}</div>}</td>
      <td className="num">{locked ? item.quantity : <input type="number" min={1} className="input !min-h-8 !w-16 !py-0.5 text-right" defaultValue={item.quantity} onBlur={(e) => { const v = Math.max(1, parseInt(e.target.value || "1", 10)); if (v !== item.quantity) upd({ quantity: v }); }} />}</td>
      <td className="num">{locked ? fmt(toCents(item.unit_price)) : <input type="number" step="0.01" min={0} className="input !min-h-8 !w-20 !py-0.5 text-right" defaultValue={fromCents(toCents(item.unit_price))} onBlur={(e) => { const v = Number(e.target.value); if (toCents(v) !== toCents(item.unit_price)) upd({ unit_price: v }); }} />}</td>
      <td className="num font-medium">{fmt(toCents(item.line_total))}</td>
      <td><label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={item.is_taxable} disabled={locked} onChange={(e) => upd({ is_taxable: e.target.checked })} />{item.is_taxable ? "taxable" : "nontaxable"}</label></td>
      <td className="no-print">{!locked && <button className="text-negative hover:underline" aria-label="Remove line" onClick={() => onSave(async () => unwrap(await supabase.from("order_items").delete().eq("id", item.id).select("id")), "Line removed")}><Trash2 size={14} /></button>}</td>
    </tr>
  );
}

function MoneyField({ label: l, value, disabled, onSave }: { label: string; value: number | string; disabled?: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(fromCents(toCents(value)));
  useEffect(() => setV(fromCents(toCents(value))), [value]);
  return <Field label={l}><input className="input" type="number" step="0.01" min="0" value={v} disabled={disabled} onChange={(e) => setV(Number(e.target.value))} onBlur={() => toCents(v) !== toCents(value) && onSave(v)} /></Field>;
}

function DeliveryPanel({ orderId, record, fee, locked, onSave, mileageCost, deliveryRate, onFee, advanced }: { orderId: string; record: DeliveryRecord | null; fee: number; advanced: boolean; locked: boolean; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void>; mileageCost: number; deliveryRate: number; onFee: (v: number) => void }) {
  const r = record as (DeliveryRecord & { provider: DeliveryProvider; status: DeliveryStatus }) | null;
  const upsert = (patch: Record<string, unknown>) => onSave(async () => unwrap(await supabase.from("delivery_records").upsert({ order_id: orderId, ...(r ? { id: r.id } : {}), ...patch }, { onConflict: "order_id" }).select("id")), "Delivery updated");
  const miles = Number(r?.distance_miles ?? 0);
  const suggestedFee = Math.round(miles * deliveryRate * 100);
  const suggestedCost = Math.round(miles * mileageCost * 100);
  const cost = toCents(r?.actual_cost ?? 0);
  return (
    <Section title="Delivery">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Distance (miles)"><input className="input" type="number" step="0.1" min="0" defaultValue={miles} disabled={locked} onBlur={(e) => Number(e.target.value) !== miles && upsert({ distance_miles: Number(e.target.value) })} /></Field>
        <Field label={advanced ? "Actual delivery cost" : "What the delivery cost you (gas / courier)"} hint={miles ? `Suggested at ${fmt(Math.round(mileageCost * 100))}/mi: ${fmt(suggestedCost)}` : undefined}><input className="input" type="number" step="0.01" min="0" defaultValue={fromCents(cost)} onBlur={(e) => toCents(e.target.value) !== cost && upsert({ actual_cost: Number(e.target.value) })} /></Field>
        {advanced && <>
        <Field label="Provider"><select className="input" value={r?.provider ?? "owner"} onChange={(e) => upsert({ provider: e.target.value })}>{DELIVERY_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
        <Field label="Driver"><input className="input" defaultValue={r?.driver ?? ""} onBlur={(e) => e.target.value !== (r?.driver ?? "") && upsert({ driver: e.target.value })} /></Field>
        <Field label="Tracking / reference"><input className="input" defaultValue={r?.tracking_ref ?? ""} onBlur={(e) => e.target.value !== (r?.tracking_ref ?? "") && upsert({ tracking_ref: e.target.value })} /></Field>
        <Field label="Delivery status"><select className="input" value={r?.status ?? "not_started"} onChange={(e) => upsert({ status: e.target.value })}>{DELIVERY_STATUSES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
        <Field label="Delivery notes" className="sm:col-span-3"><input className="input" defaultValue={r?.notes ?? ""} onBlur={(e) => e.target.value !== (r?.notes ?? "") && upsert({ notes: e.target.value })} /></Field>
        </>}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {miles > 0 && !locked && <button className="btn-ghost btn-sm no-print" onClick={() => onFee(fromCents(suggestedFee))}>Use suggested fee {fmt(suggestedFee)} ({fmt(Math.round(deliveryRate * 100))}/mi)</button>}
        <span className={`ml-auto ${fee - cost < 0 ? "text-negative" : "text-positive"}`}>Delivery {fee - cost < 0 ? "loss" : "profit"}: {fmt(fee - cost)}</span>
      </div>
    </Section>
  );
}

function PaymentModal({ open, onClose, orderId, balance, defaultMethod, onSave }: { open: boolean; onClose: () => void; orderId: string; balance: number; defaultMethod: PaymentMethod | null; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [amount, setAmount] = useState(fromCents(Math.max(balance, 0)));
  const [method, setMethod] = useState<PaymentMethod>(defaultMethod ?? "zelle");
  const [ref, setRef] = useState(""); const [notes, setNotes] = useState(""); const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
  useEffect(() => { if (open) { setAmount(fromCents(Math.max(balance, 0))); setMethod(defaultMethod ?? "zelle"); } }, [open, balance, defaultMethod]);
  return (
    <Modal open={open} onClose={onClose} title="Record payment">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount"><input className="input" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></Field>
        <Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Date & time"><input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Transaction / reference" hint="Never store card numbers or bank logins."><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Notes" className="sm:col-span-2"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!(amount > 0)} onClick={async () => { await onSave(async () => unwrap(await supabase.from("payments").insert({ order_id: orderId, amount, method, reference: ref, notes, paid_at: new Date(date).toISOString() }).select("id")), "Payment recorded"); await supabase.from("orders").update({ payment_method: method }).eq("id", orderId); onClose(); }}>Save payment</button></div>
    </Modal>
  );
}

function RefundModal({ open, onClose, orderId, maxAmount, payments, onSave }: { open: boolean; onClose: () => void; orderId: string; maxAmount: number; payments: { id: string; amount: number | string; method: PaymentMethod }[]; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [amount, setAmount] = useState(0); const [tax, setTax] = useState(0); const [method, setMethod] = useState<PaymentMethod>("zelle"); const [reason, setReason] = useState(""); const [pid, setPid] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Record refund">
      <p className="mb-3 text-xs text-charcoal/60">Refundable: {fmt(Math.max(maxAmount, 0))}. The original payment is preserved; the refund is recorded separately.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Refund amount"><input className="input" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></Field>
        <Field label="Tax portion of the refund" hint="Reduces your estimated tax liability."><input className="input" type="number" step="0.01" min="0" value={tax} onChange={(e) => setTax(Number(e.target.value))} /></Field>
        <Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Against payment (optional)"><select className="input" value={pid} onChange={(e) => setPid(e.target.value)}><option value="">—</option>{payments.map((p) => <option key={p.id} value={p.id}>{fmt(toCents(p.amount))} · {p.method}</option>)}</select></Field>
        <Field label="Reason" className="sm:col-span-2"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-danger" disabled={!(amount > 0) || toCents(amount) > Math.max(maxAmount, 0)} onClick={async () => { await onSave(async () => unwrap(await supabase.from("refunds").insert({ order_id: orderId, amount, tax_portion: tax, method, reason, payment_id: pid || null }).select("id")), "Refund recorded"); onClose(); }}>Record refund</button></div>
    </Modal>
  );
}

function AddProductModal({ open, onClose, orderId, onSave }: { open: boolean; onClose: () => void; orderId: string; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const products = useProducts(false);
  const [pid, setPid] = useState(""); const [qty, setQty] = useState(1); const [opts, setOpts] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Add product to order">
      <Field label="Product"><select className="input" value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Choose…</option>{(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} — {fmt(toCents(p.selling_price))}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Quantity"><input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} /></Field><Field label="Options"><input className="input" value={opts} onChange={(e) => setOpts(e.target.value)} /></Field></div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!pid} onClick={async () => { await onSave(async () => unwrap(await supabase.rpc("add_order_item", { p_order_id: orderId, p_product_id: pid, p_quantity: qty, p_options: opts })), "Product added"); onClose(); }}>Add</button></div>
    </Modal>
  );
}

function EditCustomerModal({ open, onClose, o, onSave }: { open: boolean; onClose: () => void; o: Order; onSave: (patch: Partial<Order>) => void }) {
  const [f, setF] = useState({ customer_name: o.customer_name, customer_phone: o.customer_phone, address_street: o.address_street, address_apt: o.address_apt, address_city: o.address_city, address_state: o.address_state, address_zip: o.address_zip, delivery_instructions: o.delivery_instructions, delivery_method: o.delivery_method, requested_at: o.requested_at ? o.requested_at.slice(0, 16) : "" });
  useEffect(() => { if (open) setF({ customer_name: o.customer_name, customer_phone: o.customer_phone, address_street: o.address_street, address_apt: o.address_apt, address_city: o.address_city, address_state: o.address_state, address_zip: o.address_zip, delivery_instructions: o.delivery_instructions, delivery_method: o.delivery_method, requested_at: o.requested_at ? o.requested_at.slice(0, 16) : "" }); }, [open, o]);
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="Edit customer & delivery details" wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name"><input className="input" value={f.customer_name} onChange={u("customer_name")} /></Field>
        <Field label="Phone"><input className="input" value={f.customer_phone} onChange={u("customer_phone")} /></Field>
        <Field label="Fulfilment"><select className="input" value={f.delivery_method} onChange={u("delivery_method")}><option value="delivery">Delivery</option><option value="pickup">Pickup</option></select></Field>
        <Field label="Requested date/time"><input className="input" type="datetime-local" value={f.requested_at} onChange={u("requested_at")} /></Field>
        <Field label="Street"><input className="input" value={f.address_street} onChange={u("address_street")} /></Field>
        <Field label="Apt / unit"><input className="input" value={f.address_apt} onChange={u("address_apt")} /></Field>
        <Field label="City"><input className="input" value={f.address_city} onChange={u("address_city")} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="State"><input className="input" maxLength={2} value={f.address_state} onChange={u("address_state")} /></Field><Field label="ZIP"><input className="input" value={f.address_zip} onChange={u("address_zip")} /></Field></div>
        <Field label="Delivery instructions" className="sm:col-span-2"><input className="input" value={f.delivery_instructions} onChange={u("delivery_instructions")} /></Field>
      </div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={() => { onSave({ ...f, requested_at: f.requested_at ? new Date(f.requested_at).toISOString() : null } as Partial<Order>); onClose(); }}>Save</button></div>
    </Modal>
  );
}

function AuditTrail({ table, id }: { table: string; id: string }) {
  const q = useAudit(table, id);
  const [open, setOpen] = useState(false);
  const rows = q.data ?? [];
  const summary = useMemo(() => rows.map((r) => {
    const changed = r.action === "UPDATE" && r.old_data && r.new_data ? Object.keys(r.new_data).filter((k) => JSON.stringify(r.old_data![k]) !== JSON.stringify(r.new_data![k]) && k !== "updated_at").slice(0, 6) : [];
    return { ...r, changed };
  }), [rows]);
  return (
    <div className="mt-3 border-t border-ivory-200 pt-2">
      <button className="text-xs text-teal-700 hover:underline no-print" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Show"} audit trail ({rows.length})</button>
      {open && <ul className="mt-2 space-y-1 text-[11px] text-charcoal/70">{summary.map((r) => <li key={r.id}>{fmtDateTime(r.created_at)} · {r.action}{r.changed.length ? ": " + r.changed.join(", ") : ""}</li>)}</ul>}
    </div>
  );
}

function PrintSummary({ o, items, business }: { o: Order; items: OrderItem[]; business: string }) {
  return (
    <div className="hidden print:block">
      <div className="mt-6 border-t-2 border-teal-800 pt-4">
        <h2 className="font-display text-2xl">{business} — Order summary {o.order_number}</h2>
        <p className="text-sm">{fmtDateTime(o.created_at)} · {o.customer_name} · {o.customer_phone}</p>
        {o.delivery_method === "delivery" && <p className="text-sm">{o.address_street}{o.address_apt ? `, ${o.address_apt}` : ""}, {o.address_city}, {o.address_state} {o.address_zip}</p>}
        <table className="mt-3 w-full text-sm"><thead><tr><th className="text-left">Item</th><th className="text-right">Qty</th><th className="text-right">Unit</th><th className="text-right">Total</th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.id}><td>{i.product_name}{i.options ? ` (${i.options})` : ""}</td><td className="text-right">{i.quantity}</td><td className="text-right">{fmt(toCents(i.unit_price))}</td><td className="text-right">{fmt(toCents(i.line_total))}</td></tr>)}</tbody></table>
        <div className="mt-3 text-right text-sm">
          <div>Subtotal {fmt(toCents(o.subtotal))}</div>{toCents(o.discount) > 0 && <div>Discount −{fmt(toCents(o.discount))}</div>}<div>Delivery {fmt(toCents(o.delivery_fee))}</div><div>Estimated sales tax {fmt(toCents(o.tax_amount))}</div>
          <div className="text-lg font-semibold">Total {fmt(toCents(o.total))}</div><div>Paid {fmt(toCents(o.amount_paid))} · Balance {fmt(toCents(o.total) - toCents(o.amount_paid) + toCents(o.amount_refunded))}</div>
        </div>
        {o.customer_notes && <p className="mt-3 text-sm">{o.customer_notes}</p>}
        <p className="mt-4 text-xs text-charcoal/60">Sales tax shown is an estimate. Thank you for ordering from {business}.</p>
      </div>
    </div>
  );
}
