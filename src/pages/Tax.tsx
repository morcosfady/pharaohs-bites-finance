import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { startOfMonth, endOfMonth, startOfQuarter, endOfQuarter, startOfYear, endOfYear, subMonths, subQuarters, subYears, format, differenceInCalendarDays } from "date-fns";
import { PageHeader, Section, Field, Skeleton, ErrorBox, KpiCard, Badge, useToast, Modal } from "../components/ui";
import { useTaxSettings, useProducts, useTaxAdjustments, useTaxSummaries, useAllOrderFinancials, useRefunds, useWrite } from "../hooks/queries";
import { fmt, toCents, sum, fromCents } from "../lib/money";
import { REVENUE_STATUSES } from "../lib/metrics";
import { TAX_STATUSES, cls, label } from "../lib/status";
import { supabase, unwrap } from "../lib/supabase";
import { toInputDate } from "../lib/dates";
import type { TaxStatus } from "../lib/types";

export function TaxPage() {
  const ts = useTaxSettings(); const products = useProducts(); const adj = useTaxAdjustments(); const sums = useTaxSummaries();
  const fin = useAllOrderFinancials(); const refunds = useRefunds();
  const write = useWrite(); const toast = useToast();
  const [adjOpen, setAdjOpen] = useState(false);
  const save = async (fn: () => Promise<unknown>, msg = "Saved") => { try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };
  const s = ts.data;

  // periods for the configured frequency (last 8)
  const periods = useMemo(() => {
    const now = new Date(); const out: { start: Date; end: Date; label: string }[] = [];
    for (let i = 0; i < 8; i++) {
      if (s?.filing_frequency === "monthly") { const d = subMonths(now, i); out.push({ start: startOfMonth(d), end: endOfMonth(d), label: format(d, "MMMM yyyy") }); }
      else if (s?.filing_frequency === "annual") { const d = subYears(now, i); out.push({ start: startOfYear(d), end: endOfYear(d), label: format(d, "yyyy") }); }
      else { const d = subQuarters(now, i); out.push({ start: startOfQuarter(d), end: endOfQuarter(d), label: `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}` }); }
    }
    return out;
  }, [s?.filing_frequency]);

  const rows = useMemo(() => periods.map((p) => {
    const os = (fin.data ?? []).filter((o) => REVENUE_STATUSES.includes(o.status) && new Date(o.created_at) >= p.start && new Date(o.created_at) <= p.end);
    const total = sum(os.map((o) => toCents(o.net_product_sales)));
    const taxable = sum(os.filter((o) => toCents(o.tax_amount) > 0).map((o) => toCents(o.net_product_sales)));
    const collected = sum(os.map((o) => toCents(o.tax_amount)));
    const refundedTax = sum((refunds.data ?? []).filter((r) => !r.voided_at && new Date(r.refunded_at) >= p.start && new Date(r.refunded_at) <= p.end).map((r) => toCents(r.tax_portion)));
    const manual = sum((adj.data ?? []).filter((a) => new Date(a.adjusted_on) >= p.start && new Date(a.adjusted_on) <= p.end).map((a) => toCents(a.amount)));
    const saved = (sums.data ?? []).find((x) => x.period_start === toInputDate(p.start) && x.period_end === toInputDate(p.end));
    return { ...p, total, taxable, nontaxable: total - taxable, collected, adjustments: manual - refundedTax, due: collected - refundedTax + manual, saved };
  }), [periods, fin.data, refunds.data, adj.data, sums.data]);

  const days = s?.next_due_date ? differenceInCalendarDays(new Date(s.next_due_date), new Date()) : null;
  const review = (products.data ?? []).filter((p) => p.tax_status === "review");

  if (ts.isLoading) return <Skeleton rows={8} className="card p-5" />;
  if (ts.error || !s) return <ErrorBox error={ts.error ?? "Could not load tax settings"} />;

  return (
    <div>
      <PageHeader title="Estimated Sales Tax" crumbs={["Home", "Sales Tax"]} />
      <div className="mb-4 rounded-lg border border-warning/40 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <b>Disclaimer:</b> this page produces <i>estimates</i> to help you set money aside. It does not replace a tax professional or the Texas Comptroller, and the dashboard never decides taxability for you — you set each product's status below. Collected tax is held for the state and is never counted as income.
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Current period tax collected" value={rows[0]?.collected ?? 0} />
        <KpiCard label="Estimated amount due" value={rows[0]?.due ?? 0} />
        <KpiCard label="Days to next return" value={days} kind="int" invert />
        <KpiCard label="Products needing review" value={review.length} kind="int" invert />
      </div>
      {days != null && days <= s.reminder_days_before && <p className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-negative">{days < 0 ? "Your sales-tax due date has passed." : `Your ${s.filing_frequency} sales-tax return is due in ${days} day${days === 1 ? "" : "s"} (${s.next_due_date}).`} After filing, update the next due date below.</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Tax settings">
          <Field label="Default tax rate" hint="Dallas, TX combined rate is 8.25% (0.0825). Applied to new orders; each order keeps the rate used."><input className="input" type="number" step="0.0001" min="0" defaultValue={Number(s.default_tax_rate)} onBlur={(e) => Number(e.target.value) !== Number(s.default_tax_rate) && save(async () => unwrap(await supabase.from("tax_settings").update({ default_tax_rate: Number(e.target.value) }).eq("id", 1).select("id")))} /></Field>
          <Field label="Prices include tax?"><select className="input" value={s.prices_include_tax ? "1" : "0"} onChange={(e) => save(async () => unwrap(await supabase.from("tax_settings").update({ prices_include_tax: e.target.value === "1" }).eq("id", 1).select("id")))}><option value="0">No — tax is added on top</option><option value="1">Yes — menu prices already include tax</option></select></Field>
          <Field label="Filing frequency (as assigned by the Comptroller)"><select className="input" value={s.filing_frequency} onChange={(e) => save(async () => unwrap(await supabase.from("tax_settings").update({ filing_frequency: e.target.value }).eq("id", 1).select("id")))}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></Field>
          <Field label="Next return due date"><input className="input" type="date" defaultValue={s.next_due_date ?? ""} onBlur={(e) => e.target.value !== (s.next_due_date ?? "") && save(async () => unwrap(await supabase.from("tax_settings").update({ next_due_date: e.target.value || null }).eq("id", 1).select("id")))} /></Field>
          <Field label="Remind me (days before)"><input className="input" type="number" min="0" defaultValue={s.reminder_days_before} onBlur={(e) => Number(e.target.value) !== s.reminder_days_before && save(async () => unwrap(await supabase.from("tax_settings").update({ reminder_days_before: Number(e.target.value) }).eq("id", 1).select("id")))} /></Field>
          <Field label="Jurisdiction note"><textarea className="input" defaultValue={s.jurisdiction_note} onBlur={(e) => e.target.value !== s.jurisdiction_note && save(async () => unwrap(await supabase.from("tax_settings").update({ jurisdiction_note: e.target.value }).eq("id", 1).select("id")))} /></Field>
        </Section>

        <Section title="Reporting periods" className="lg:col-span-2" right={<button className="btn-ghost btn-sm" onClick={() => setAdjOpen(true)}>Add manual adjustment</button>}>
          <div className="table-wrap"><table className="table !min-w-[720px]"><thead><tr><th>Period</th><th className="num">Total sales</th><th className="num">Taxable</th><th className="num">Nontaxable</th><th className="num">Tax collected</th><th className="num">Adjustments</th><th className="num">Est. due</th><th>Filed</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.label}><td>{r.label}</td><td className="num">{fmt(r.total)}</td><td className="num">{fmt(r.taxable)}</td><td className="num">{fmt(r.nontaxable)}</td><td className="num">{fmt(r.collected)}</td><td className="num">{fmt(r.adjustments)}</td><td className="num font-semibold">{fmt(r.due)}</td>
                <td>{r.saved?.filed_at ? <Badge className="bg-emerald-100 text-emerald-900">Filed {r.saved.filed_at.slice(0, 10)}</Badge> : <button className="btn-ghost btn-sm" onClick={() => save(async () => unwrap(await supabase.from("tax_period_summaries").upsert({ period_start: toInputDate(r.start), period_end: toInputDate(r.end), total_sales: fromCents(r.total), taxable_sales: fromCents(r.taxable), nontaxable_sales: fromCents(r.nontaxable), tax_collected: fromCents(r.collected), adjustments: fromCents(r.adjustments), estimated_due: fromCents(r.due), filed_at: new Date().toISOString() }, { onConflict: "period_start,period_end" }).select("id")), "Period marked as filed")}>Mark filed</button>}</td></tr>
            ))}</tbody></table></div>
          <p className="mt-2 text-xs text-charcoal/50">"Taxable" counts net sales on orders where tax was charged. Adjustments = manual adjustments − tax refunded to customers.</p>
          {(adj.data ?? []).length > 0 && <ul className="mt-3 text-xs text-charcoal/70">{(adj.data ?? []).slice(0, 10).map((a) => <li key={a.id}>{a.adjusted_on}: {fmt(toCents(a.amount))} — {a.reason}</li>)}</ul>}
        </Section>
      </div>

      <Section title="Product taxability" className="mt-4" right={<Link to="/products" className="text-xs text-teal-700 hover:underline">Products</Link>}>
        <p className="mb-3 text-sm text-charcoal/60">Set each product yourself. Items marked "needs review" are treated as nontaxable on new orders until you decide. Existing orders keep the decision that was in effect when they were placed.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(products.data ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-ivory-200 bg-white px-3 py-2 text-sm">
              <span className="truncate">{p.name}</span>
              <select className={`badge cursor-pointer border-0 ${cls(TAX_STATUSES, p.tax_status)}`} value={p.tax_status} aria-label={`Tax status for ${p.name}`} onChange={(e) => save(async () => unwrap(await supabase.from("products").update({ tax_status: e.target.value as TaxStatus }).eq("id", p.id).select("id")), `${p.name}: ${label(TAX_STATUSES, e.target.value as TaxStatus)}`)}>{TAX_STATUSES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
            </div>
          ))}
        </div>
      </Section>
      <AdjustmentModal open={adjOpen} onClose={() => setAdjOpen(false)} onSave={save} />
    </div>
  );
}

function AdjustmentModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [amount, setAmount] = useState(0); const [reason, setReason] = useState(""); const [date, setDate] = useState(toInputDate(new Date()));
  return (
    <Modal open={open} onClose={onClose} title="Manual tax adjustment">
      <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Amount" hint="Negative reduces the estimated liability (e.g. tax on a voided sale); positive increases it."><input className="input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></Field>
      <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!amount || !reason} onClick={async () => { await onSave(async () => unwrap(await supabase.from("tax_adjustments").insert({ adjusted_on: date, amount, reason }).select("id")), "Adjustment recorded"); onClose(); }}>Save</button></div>
    </Modal>
  );
}
