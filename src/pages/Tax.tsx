import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { startOfMonth, endOfMonth, startOfQuarter, endOfQuarter, subMonths, subQuarters, format, differenceInCalendarDays } from "date-fns";
import { PageHeader, Section, Field, Skeleton, ErrorBox, KpiCard, Badge, useToast, Modal } from "../components/ui";
import { useTaxSettings, useProducts, useTaxAdjustments, useTaxSummaries, useAllOrderFinancials, useRefunds, useOrders, useWrite } from "../hooks/queries";
import { fmt, toCents, sum, fromCents } from "../lib/money";
import { REVENUE_STATUSES } from "../lib/metrics";
import { TAX_STATUSES, cls, label } from "../lib/status";
import { supabase, unwrap } from "../lib/supabase";
import { toInputDate } from "../lib/dates";
import { downloadText, toCsv } from "../lib/csv";
import type { DeliveryTaxMode, OrderFinancial, TaxSettings, TaxStatus } from "../lib/types";

/** Tax detail of one period. Tips are a pass-through to the driver and never appear here. */
type PeriodRow = {
  start: Date; end: Date; label: string; orders: number;
  sales: number; taxable: number; exempt: number; itemTax: number; deliveryTax: number; collected: number; refundedTax: number; manual: number; liability: number;
  saved?: { filed_at: string | null };
};
const pctLabel = (rate: number) => (rate * 100).toFixed(2).replace(/\.?0+$/, "") + "%";

function periodRows(kind: "month" | "quarter", count: number, fin: OrderFinancial[], refunds: { voided_at: string | null; refunded_at: string; tax_portion: number | string }[], adj: { adjusted_on: string; amount: number | string }[], saved: { period_start: string; period_end: string; filed_at: string | null }[]): PeriodRow[] {
  const now = new Date(); const out: PeriodRow[] = [];
  for (let i = 0; i < count; i++) {
    const d = kind === "month" ? subMonths(now, i) : subQuarters(now, i);
    const start = kind === "month" ? startOfMonth(d) : startOfQuarter(d), end = kind === "month" ? endOfMonth(d) : endOfQuarter(d);
    const lbl = kind === "month" ? format(d, "MMMM yyyy") : `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
    const os = fin.filter((o) => REVENUE_STATUSES.includes(o.status) && new Date(o.created_at) >= start && new Date(o.created_at) <= end);
    const sales = sum(os.map((o) => toCents(o.net_product_sales)));
    const taxable = sum(os.map((o) => Number(o.taxable_subtotal_cents ?? 0)));
    const itemTax = sum(os.map((o) => Number(o.item_tax_cents ?? 0)));
    const deliveryTax = sum(os.map((o) => Number(o.delivery_tax_cents ?? 0)));
    const collected = sum(os.map((o) => toCents(o.tax_amount)));
    const refundedTax = sum(refunds.filter((r) => !r.voided_at && new Date(r.refunded_at) >= start && new Date(r.refunded_at) <= end).map((r) => toCents(r.tax_portion)));
    const manual = sum(adj.filter((a) => new Date(a.adjusted_on) >= start && new Date(a.adjusted_on) <= end).map((a) => toCents(a.amount)));
    out.push({ start, end, label: lbl, orders: os.length, sales, taxable, exempt: sales - taxable, itemTax, deliveryTax, collected, refundedTax, manual, liability: collected - refundedTax + manual,
      saved: saved.find((x) => x.period_start === toInputDate(start) && x.period_end === toInputDate(end)) });
  }
  return out;
}

export function TaxPage() {
  const ts = useTaxSettings(); const products = useProducts(false); const adj = useTaxAdjustments(); const sums = useTaxSummaries();
  const fin = useAllOrderFinancials(); const refunds = useRefunds(); const orders = useOrders();
  const write = useWrite(); const toast = useToast();
  const [adjOpen, setAdjOpen] = useState(false);
  const save = async (fn: () => Promise<unknown>, msg = "Saved") => { try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };
  const s = ts.data;

  const months = useMemo(() => periodRows("month", 12, fin.data ?? [], refunds.data ?? [], adj.data ?? [], sums.data ?? []), [fin.data, refunds.data, adj.data, sums.data]);
  const quarters = useMemo(() => periodRows("quarter", 8, fin.data ?? [], refunds.data ?? [], adj.data ?? [], sums.data ?? []), [fin.data, refunds.data, adj.data, sums.data]);
  // the filing period the owner set (monthly or quarterly); annual filers see the quarters
  const filing = s?.filing_frequency === "monthly" ? months : quarters;

  // Orders placed from the permit's first business date until this went live had no tax charged.
  // Estimated here only (the orders themselves are never changed): taxable dishes x the rate, plus delivery per the mode.
  const notCollected = useMemo(() => {
    if (!s) return { count: 0, taxable: 0, tax: 0 };
    const rate = Number(s.default_tax_rate), bp = Math.round(rate * 10000);
    const taxStatus = new Map((products.data ?? []).map((p) => [p.id, p.tax_status]));
    const since = new Date(s.tax_start_date + "T00:00:00");
    let count = 0, taxable = 0, tax = 0;
    for (const o of orders.data ?? []) {
      if (!REVENUE_STATUSES.includes(o.status) || new Date(o.created_at) < since || Number(o.tax_cents ?? 0) > 0 || toCents(o.tax_amount) > 0) continue;
      const items = o.order_items ?? [];
      const sub = sum(items.map((i) => toCents(i.line_total)));
      const tx = sum(items.filter((i) => (i.tax_status ?? taxStatus.get(i.product_id ?? "") ?? "review") !== "exempt").map((i) => toCents(i.line_total)));
      if (tx <= 0) continue;
      const disc = Math.min(toCents(o.discount), sub);
      const netTx = Math.max(0, tx - (sub > 0 ? Math.round(disc * tx / sub) : 0)), netSub = Math.max(0, sub - disc);
      const itemTax = Math.round(netTx * bp / 10000);
      const fee = toCents(o.delivery_fee);
      const delTax = fee > 0 && netTx > 0 ? (s.tax_delivery_mode === "all" ? Math.round(fee * bp / 10000) : s.tax_delivery_mode === "proportional" && netSub > 0 ? Math.round(fee * bp * netTx / (10000 * netSub)) : 0) : 0;
      count++; taxable += netTx; tax += itemTax + delTax;
    }
    return { count, taxable, tax };
  }, [orders.data, products.data, s]);

  const days = s?.next_due_date ? differenceInCalendarDays(new Date(s.next_due_date), new Date()) : null;
  const review = (products.data ?? []).filter((p) => p.tax_status === "review" && p.is_active);
  const thisMonth = months[0], thisQuarter = quarters[0], current = filing[0];

  const exportCsv = () => downloadText(`sales-tax-${toInputDate(new Date())}.csv`, toCsv([...months.map((r) => ({ period_type: "month", ...csvRow(r) })), ...quarters.map((r) => ({ period_type: "quarter", ...csvRow(r) }))]));
  const csvRow = (r: PeriodRow) => ({ period: r.label, period_start: toInputDate(r.start), period_end: toInputDate(r.end), orders: r.orders, net_sales: fromCents(r.sales), taxable_sales: fromCents(r.taxable), exempt_sales: fromCents(r.exempt), item_tax: fromCents(r.itemTax), delivery_tax: fromCents(r.deliveryTax), tax_collected: fromCents(r.collected), refunded_tax: fromCents(r.refundedTax), manual_adjustments: fromCents(r.manual), total_liability: fromCents(r.liability), filed: r.saved?.filed_at ? r.saved.filed_at.slice(0, 10) : "" });

  if (ts.isLoading) return <Skeleton rows={8} className="card p-5" />;
  if (ts.error || !s) return <ErrorBox error={ts.error ?? "Could not load tax settings"} />;

  const table = (rows: PeriodRow[], title: string, filedButtons: boolean) => (
    <Section title={title} className="mt-4" right={<button className="btn-ghost btn-sm" onClick={exportCsv}>CSV export</button>}>
      <div className="table-wrap"><table className="table !min-w-[860px]"><thead><tr><th>Period</th><th className="num">Orders</th><th className="num">Net sales</th><th className="num">Taxable sales</th><th className="num">Exempt sales</th><th className="num">Tax on items</th><th className="num">Tax on delivery</th><th className="num">Tax collected</th><th className="num">Refunds + adj.</th><th className="num">Total liability</th>{filedButtons && <th>Filed</th>}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.label} className={r.collected === 0 && r.orders === 0 ? "text-charcoal/40" : ""}><td>{r.label}</td><td className="num">{r.orders}</td><td className="num">{fmt(r.sales)}</td><td className="num">{fmt(r.taxable)}</td><td className="num">{fmt(r.exempt)}</td><td className="num">{fmt(r.itemTax)}</td><td className="num">{fmt(r.deliveryTax)}</td><td className="num">{fmt(r.collected)}</td><td className="num">{fmt(r.manual - r.refundedTax)}</td><td className="num font-semibold">{fmt(r.liability)}</td>
            {filedButtons && <td>{r.saved?.filed_at ? <Badge className="bg-emerald-100 text-emerald-900">Filed {r.saved.filed_at.slice(0, 10)}</Badge> : <button className="btn-ghost btn-sm" onClick={() => save(async () => unwrap(await supabase.from("tax_period_summaries").upsert({ period_start: toInputDate(r.start), period_end: toInputDate(r.end), total_sales: fromCents(r.sales), taxable_sales: fromCents(r.taxable), nontaxable_sales: fromCents(r.exempt), tax_collected: fromCents(r.collected), adjustments: fromCents(r.manual - r.refundedTax), estimated_due: fromCents(r.liability), filed_at: new Date().toISOString() }, { onConflict: "period_start,period_end" }).select("id")), "Period marked as filed")}>Mark filed</button>}</td>}
          </tr>
        ))}</tbody></table></div>
      <p className="mt-2 text-xs text-charcoal/50">Taxable sales = the dishes tax was charged on (after any promo discount). Exempt sales = bakery items sold without utensils. Driver tips are not sales and are not on this page. Total liability = tax collected, minus tax refunded to customers, plus manual adjustments.</p>
    </Section>
  );

  return (
    <div>
      <PageHeader title="Sales Tax" crumbs={["Home", "Sales Tax"]} />
      <div className="mb-4 rounded-lg border border-warning/40 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Texas Sales and Use Tax Permit, first business date <b>{s.tax_start_date}</b>. Dallas combined rate <b>{pctLabel(Number(s.default_tax_rate))}</b> (6.25% state + 1% city + 1% DART). The website charges this at checkout on prepared food, desserts and drinks; bakery items sold without utensils are exempt. Collected tax is held for the Comptroller and is never counted as income. Confirm the feteer exemption and the delivery-tax rule with the Texas Comptroller (800-252-5555).
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Tax collected this month" value={thisMonth?.collected ?? 0} formula="Sum of the sales tax on confirmed, not cancelled orders placed this month (items + delivery)." />
        <KpiCard label="Tax collected this quarter" value={thisQuarter?.collected ?? 0} formula="Same, for the current quarter." />
        <KpiCard label={`Set aside for the ${s.filing_frequency === "monthly" ? "month" : "quarter"}`} value={current?.liability ?? 0} formula="What to keep in the bank for the current filing period: tax collected, minus tax refunded, plus manual adjustments." />
        <KpiCard label="Products needing review" value={review.length} kind="int" invert formula="Products with no tax decision yet. They are charged as taxable (safe side) until you set them." />
      </div>
      {days != null && days <= s.reminder_days_before && <p className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-negative">{days < 0 ? "Your sales-tax due date has passed." : `Your ${s.filing_frequency} sales-tax return is due in ${days} day${days === 1 ? "" : "s"} (${s.next_due_date}).`} After filing, update the next due date below.</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="Tax not collected (Oct 1 to go-live)">
          <p className="text-sm text-charcoal/70">Orders placed from <b>{s.tax_start_date}</b> until sales tax went live on the website were charged <b>no tax</b>. The amount below is an estimate of what is owed on them (taxable dishes x {pctLabel(Number(s.default_tax_rate))}, plus delivery per the rule below). The orders themselves are not changed; the tax comes out of the business.</p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div><div className="text-xs uppercase tracking-wider text-charcoal/50">Orders</div><div className="font-display text-2xl font-semibold text-teal-900">{notCollected.count}</div></div>
            <div><div className="text-xs uppercase tracking-wider text-charcoal/50">Taxable sales</div><div className="font-display text-2xl font-semibold text-teal-900">{fmt(notCollected.taxable)}</div></div>
            <div><div className="text-xs uppercase tracking-wider text-charcoal/50">Tax owed (est.)</div><div className="font-display text-2xl font-semibold text-negative">{fmt(notCollected.tax)}</div></div>
          </div>
          <p className="mt-2 text-xs text-charcoal/50">Set this amount aside too. Add it to the return for its period as a manual adjustment if your accountant agrees.</p>
        </Section>
        <Section title="Tax settings" right={<button className="btn-ghost btn-sm" onClick={() => setAdjOpen(true)}>Add manual adjustment</button>}>
          <TaxSettingsForm s={s} save={save} />
        </Section>
      </div>

      {table(months, "By month (last 12)", s.filing_frequency === "monthly")}
      {table(quarters, "By quarter (filing periods)", s.filing_frequency !== "monthly")}
      {(adj.data ?? []).length > 0 && <ul className="mt-3 text-xs text-charcoal/70">{(adj.data ?? []).slice(0, 10).map((a) => <li key={a.id}>{a.adjusted_on}: {fmt(toCents(a.amount))}: {a.reason}</li>)}</ul>}

      <Section title="Product taxability" className="mt-4" right={<Link to="/products" className="text-xs text-teal-700 hover:underline">Products</Link>}>
        <p className="mb-3 text-sm text-charcoal/60">Taxable = prepared meals, trays, soups, puddings, dips, honeys and drinks. Exempt = bakery items sold without utensils (feteer meshaltet, round cake, goulash with nuts). Combos are taxable when anything inside is. <b>Needs review</b> is charged as taxable until you decide. Orders already placed keep the status they were charged with.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(products.data ?? []).filter((p) => p.is_active).map((p) => (
            <div key={p.id} className={`flex items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-sm ${p.tax_status === "review" ? "border-amber-300" : "border-ivory-200"}`}>
              <span className="truncate">{p.tax_status === "review" && <span className="mr-1 text-amber-600" title="Needs review: charged as taxable until you decide">⚠</span>}{p.name}</span>
              <select className={`badge cursor-pointer border-0 ${cls(TAX_STATUSES, p.tax_status)}`} value={p.tax_status} aria-label={`Tax status for ${p.name}`} onChange={(e) => save(async () => unwrap(await supabase.from("products").update({ tax_status: e.target.value as TaxStatus }).eq("id", p.id).select("id")), `${p.name}: ${label(TAX_STATUSES, e.target.value as TaxStatus)}`)}>{TAX_STATUSES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </div>
          ))}
        </div>
      </Section>
      <AdjustmentModal open={adjOpen} onClose={() => setAdjOpen(false)} onSave={save} />
    </div>
  );
}

/** The one place the rate lives (tax_settings.default_tax_rate). Shared by the Sales Tax page and Settings. */
export function TaxSettingsForm({ s, save }: { s: TaxSettings; save: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const upd = (patch: Partial<TaxSettings>, msg?: string) => save(async () => unwrap(await supabase.from("tax_settings").update(patch).eq("id", 1).select("id")), msg);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Sales tax rate" hint={`${pctLabel(Number(s.default_tax_rate))}. Dallas + DART = 0.0825. New orders freeze the rate in force when they are placed.`}><input className="input" type="number" step="0.0001" min="0" max="0.2" defaultValue={Number(s.default_tax_rate)} onBlur={(e) => Number(e.target.value) !== Number(s.default_tax_rate) && upd({ default_tax_rate: Number(e.target.value) }, "Tax rate saved")} /></Field>
      <Field label="Charge sales tax on the website" hint="Off = no tax on new orders (rate 0 is frozen on them)."><select className="input" value={s.tax_enabled ? "1" : "0"} onChange={(e) => upd({ tax_enabled: e.target.value === "1" }, e.target.value === "1" ? "Sales tax switched on" : "Sales tax switched off")}><option value="1">On</option><option value="0">Off</option></select></Field>
      <Field label="Tax on the delivery fee" hint="Proportional = the share of the fee that matches the taxable share of the food (default). All = whole fee once any item is taxable. None = never."><select className="input" value={s.tax_delivery_mode} onChange={(e) => upd({ tax_delivery_mode: e.target.value as DeliveryTaxMode }, "Delivery tax rule saved")}><option value="proportional">Proportional</option><option value="all">All of the fee</option><option value="none">None</option></select></Field>
      <Field label="Permit first business date"><input className="input" type="date" defaultValue={s.tax_start_date} onBlur={(e) => e.target.value && e.target.value !== s.tax_start_date && upd({ tax_start_date: e.target.value }, "Start date saved")} /></Field>
      <Field label="Filing frequency (as assigned by the Comptroller)"><select className="input" value={s.filing_frequency} onChange={(e) => upd({ filing_frequency: e.target.value as TaxSettings["filing_frequency"] })}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></Field>
      <Field label="Next return due date"><input className="input" type="date" defaultValue={s.next_due_date ?? ""} onBlur={(e) => e.target.value !== (s.next_due_date ?? "") && upd({ next_due_date: e.target.value || null })} /></Field>
      <Field label="Remind me (days before)"><input className="input" type="number" min="0" defaultValue={s.reminder_days_before} onBlur={(e) => Number(e.target.value) !== s.reminder_days_before && upd({ reminder_days_before: Number(e.target.value) })} /></Field>
      <Field label="Prices include tax?" hint="Keep No: menu prices are before tax."><select className="input" value={s.prices_include_tax ? "1" : "0"} onChange={(e) => upd({ prices_include_tax: e.target.value === "1" })}><option value="0">No, tax is added at checkout</option><option value="1">Yes, menu prices already include tax</option></select></Field>
      <Field label="Jurisdiction note" className="sm:col-span-2"><textarea className="input" defaultValue={s.jurisdiction_note} onBlur={(e) => e.target.value !== s.jurisdiction_note && upd({ jurisdiction_note: e.target.value })} /></Field>
    </div>
  );
}

function AdjustmentModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [amount, setAmount] = useState(0); const [reason, setReason] = useState(""); const [date, setDate] = useState(toInputDate(new Date()));
  return (
    <Modal open={open} onClose={onClose} title="Manual tax adjustment">
      <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Amount" hint="Negative reduces the liability (e.g. tax on a voided sale); positive increases it (e.g. the tax not collected on early October orders)."><input className="input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></Field>
      <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!amount || !reason} onClick={async () => { await onSave(async () => unwrap(await supabase.from("tax_adjustments").insert({ adjusted_on: date, amount, reason }).select("id")), "Adjustment recorded"); onClose(); }}>Save</button></div>
    </Modal>
  );
}
