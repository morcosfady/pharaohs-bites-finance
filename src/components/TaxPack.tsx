import { useMemo, useState } from "react";
import { FileText, Download, AlertTriangle, CheckCircle2, Settings2 } from "lucide-react";
import { Skeleton, KpiCard, useToast, Field } from "./ui";
import { useTaxSummaryYear, useTaxQuality, useTaxExtras, useTaxRows, useExpenseSettings, useExpenseCategories, useMileageLogs, useMileageSettings, useSettings, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { downloadText, toCsv } from "../lib/csv";
import { fmt, toCents } from "../lib/money";
import { fmtDate } from "../lib/dates";
import { SCHEDULE_C_LINES, lineForm, lineLabel, qualityIssues, sortLines, startupStatus, taxCsvRows } from "../lib/taxpack";
import { summarizeMileage } from "../lib/mileage";
import type { DateRange } from "../lib/dates";

/* Year-end tax view of the expenses. DRAFT mapping to Schedule C for the accountant; anything
   uncertain says "Ask accountant". Totals come from the expense_tax_view (one row per real expense). */

const years = (() => { const now = new Date().getFullYear(); const out: number[] = []; for (let y = Math.max(now, 2026); y >= 2026; y--) out.push(y); return out; })();
const cents = (n: unknown) => Math.round(Number(n) * 100);

export function TaxTab({ onOpenExpense }: { onOpenExpense: (id: string) => void }) {
  const [year, setYear] = useState(years[0]);
  const summary = useTaxSummaryYear(year); const quality = useTaxQuality(year); const extras = useTaxExtras(year); const rows = useTaxRows(year);
  const settings = useExpenseSettings(); const mset = useMileageSettings(); const biz = useSettings(); const name = biz.data?.business_name || "Pharaoh's Bites";
  const range = useMemo<DateRange>(() => ({ key: "custom", from: new Date(year, 0, 1), to: new Date(year, 11, 31, 23, 59, 59) }), [year]);
  const mileage = useMileageLogs(range);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const lines = sortLines(summary.data ?? []);
  const issues = qualityIssues(quality.data);
  const blocking = issues.filter((i) => i.blocking);
  const msum = useMemo(() => summarizeMileage(mileage.data ?? []), [mileage.data]);
  const startup = startupStatus(Number(lines.find((l) => l.line_key === "startup")?.deductible ?? 0), Number(settings.data?.startup_limit ?? 5000));
  const totalDeductible = lines.filter((l) => !["startup", "uncategorized", "refunds", "personal"].includes(l.line_key)).reduce((s, l) => s + cents(l.deductible), 0);
  const asks = (rows.data ?? []).filter((r) => r.ask_reason);
  const assets = (rows.data ?? []).filter((r) => r.asset_candidate);
  const loading = summary.isLoading || rows.isLoading;

  async function pdf() {
    setBusy(true);
    try {
      const { buildTaxPdf } = await import("../lib/taxPdf");
      const blob = await buildTaxPdf({
        year, businessName: name, startDate: settings.data?.business_start_date ?? "", assetThreshold: Number(settings.data?.asset_threshold ?? 500), startupLimit: Number(settings.data?.startup_limit ?? 5000),
        method: mset.data?.method ?? "standard", methodConfirmed: mset.data?.method_confirmed ?? false,
        summary: summary.data ?? [], rows: rows.data ?? [], quality: quality.data, extras: extras.data, mileage: mileage.data ?? [],
      });
      const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `tax-pack-${year}.pdf`; a.click(); URL.revokeObjectURL(url);
      toast.push(blocking.length ? "PDF downloaded. It lists the items still to fix." : "PDF downloaded");
    } catch (e) { toast.push((e as Error).message, "err"); } finally { setBusy(false); }
  }
  const csvExpenses = () => downloadText(`expenses-tax-${year}.csv`, toCsv(taxCsvRows(rows.data ?? [])));
  const csvMileage = () => downloadText(`mileage-${year}.csv`, toCsv((mileage.data ?? []).filter((r) => r.counted).map((r) => ({ date: r.trip_date, kind: r.kind, purpose: r.purpose, from: r.from_label, to: r.to_label, miles: r.miles, miles_estimated: r.estimated ? "yes" : "", irs_cents_per_mile: r.cents_per_mile ?? "", deduction: r.deduction ?? "" }))));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm"><span className="text-charcoal/60">Tax year</span>
          <select className="input !w-auto" value={year} onChange={(e) => setYear(Number(e.target.value))}>{years.map((y) => <option key={y} value={y}>{y}{y === 2026 ? " (short first year)" : ""}</option>)}</select></label>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className="btn-gold btn-sm" disabled={busy || loading} onClick={pdf}><FileText size={14} /> {busy ? "Building…" : "Download Tax Pack (PDF)"}</button>
          <button className="btn-ghost btn-sm" disabled={loading} onClick={csvExpenses}><Download size={14} /> Expenses CSV</button>
          <button className="btn-ghost btn-sm" disabled={mileage.isLoading} onClick={csvMileage}><Download size={14} /> Mileage CSV</button>
        </div>
      </div>

      <p className="rounded-lg bg-ivory-50 px-4 py-2.5 text-xs text-charcoal/70"><b>Draft.</b> Bookkeeping support for your accountant, not tax advice. The Schedule C line for each category is a draft: confirm it with your accountant. Anything uncertain says <i>Ask accountant</i>.</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Deductible expenses" value={totalDeductible} />
        <KpiCard label="Startup costs" value={cents(startup.total)} />
        <KpiCard label="Mileage deduction" value={cents(msum.deduction)} />
        <KpiCard label="Ask accountant" value={asks.length} kind="int" />
      </div>

      <section className="card">
        <div className="card-head"><div><h2 className="card-title">Is it clean?</h2><p className="text-xs text-charcoal/50">Fix the red items before you send the pack. Warnings are listed in the PDF.</p></div></div>
        <div className="px-5 pb-5">
          {quality.isLoading ? <Skeleton rows={2} /> : issues.length === 0
            ? <p className="flex items-center gap-2 text-sm text-positive"><CheckCircle2 size={16} /> Clean. Nothing waiting for you.</p>
            : <ul className="space-y-1.5 text-sm">{issues.map((i) => <li key={i.key} className="flex items-start gap-2"><AlertTriangle size={15} className={`mt-0.5 shrink-0 ${i.blocking ? "text-negative" : "text-warning"}`} /><span>{i.text}{i.blocking ? <b className="text-negative"> · fix first</b> : <span className="text-charcoal/50"> · warning</span>}</span></li>)}</ul>}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">By Schedule C line</h2></div>
        <div className="px-5 pb-5">
          {loading ? <Skeleton rows={4} /> : lines.length === 0 ? <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">No expenses in {year} yet.</p> : (
            <ul className="divide-y divide-ivory-200 text-sm">
              {lines.map((l) => (
                <li key={l.line_key} className="flex items-center gap-3 py-2">
                  <span className="w-16 shrink-0 text-xs text-charcoal/50">{lineForm(l.line_key)}</span>
                  <span className="min-w-0 flex-1">{lineLabel(l.line_key)}<span className="block text-xs text-charcoal/50">{Number(l.entries)} entr{Number(l.entries) === 1 ? "y" : "ies"} · spent {fmt(cents(l.total))}</span></span>
                  <b className="tabular-nums">{fmt(cents(l.deductible))}</b>
                </li>
              ))}
              <li className="flex items-center gap-3 py-2 font-semibold"><span className="w-16" /><span className="flex-1">Total deductible <span className="text-xs font-normal text-charcoal/50">(not counting startup, refunds, uncategorized)</span></span><span className="tabular-nums">{fmt(totalDeductible)}</span></li>
            </ul>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">Startup costs</h2></div>
        <div className="space-y-1 px-5 pb-5 text-sm">
          <p>Spent before <b>{fmtDate(settings.data?.business_start_date)}</b>: <b>{fmt(cents(startup.total))}</b> of a draft first-year limit of {fmt(cents(startup.limit))}. {startup.withinLimit ? <span className="text-positive">Within the limit ({fmt(cents(startup.remaining))} left).</span> : <span className="text-negative">{fmt(cents(startup.over))} over the limit.</span>}</p>
          <p className="text-xs text-charcoal/60"><i>Ask accountant:</i> the startup election, what qualifies, and how any excess is spread over time.</p>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">Mileage</h2></div>
        <div className="px-5 pb-5 text-sm">
          <p><b>{msum.miles.toFixed(1)}</b> business miles · <b>{msum.trips}</b> trips · deduction <b>{fmt(cents(msum.deduction))}</b> ({mset.data?.method === "actual" ? "actual car expenses selected" : "standard mileage rate"}{mset.data?.method_confirmed ? ", confirmed" : ", not confirmed with accountant yet"}).</p>
        </div>
      </section>

      {assets.length > 0 && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Possible assets ({assets.length})</h2><p className="text-xs text-charcoal/50">Purchases of {fmt(cents(settings.data?.asset_threshold ?? 500))} or more. <i>Ask accountant:</i> depreciate or expense?</p></div></div>
          <ul className="divide-y divide-ivory-200 px-5 pb-3 text-sm">{assets.map((r) => <Item key={`${r.expense_id}-${r.line_no}`} id={r.expense_id} date={r.expense_date} vendor={r.vendor} amount={r.total_amount} sub={r.description} onOpen={onOpenExpense} />)}</ul>
        </section>
      )}

      {asks.length > 0 && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Ask accountant ({asks.length})</h2><p className="text-xs text-charcoal/50">Tap one to set its category or business use %.</p></div></div>
          <ul className="divide-y divide-ivory-200 px-5 pb-3 text-sm">{asks.map((r) => <Item key={`${r.expense_id}-${r.line_no}`} id={r.expense_id} date={r.expense_date} vendor={r.vendor} amount={r.total_amount} sub={r.ask_reason ?? ""} onOpen={onOpenExpense} />)}</ul>
        </section>
      )}

      {extras.data && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Left out on purpose</h2><p className="text-xs text-charcoal/50">Money that is neither a business cost nor income.</p></div></div>
          <dl className="grid gap-2 px-5 pb-5 text-sm sm:grid-cols-2">
            <Row k="Personal spending" v={fmt(cents(extras.data.personal_total))} />
            <Row k="Owner put money in" v={fmt(cents(extras.data.owner_contributions))} />
            <Row k="Stripe payouts (not income again)" v={fmt(cents(extras.data.stripe_payouts))} />
            <Row k="Transfers between own accounts" v={fmt(cents(extras.data.transfers))} />
          </dl>
        </section>
      )}

      <SettingsAndMapping />
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between gap-3 rounded-lg bg-ivory-50 px-3 py-2"><dt className="text-charcoal/60">{k}</dt><dd className="font-semibold tabular-nums">{v}</dd></div>;

function Item({ id, date, vendor, amount, sub, onOpen }: { id: string; date: string; vendor: string; amount: number | string; sub: string; onOpen: (id: string) => void }) {
  return (
    <li><button type="button" onClick={() => onOpen(id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-ivory-50">
      <span className="w-14 shrink-0 text-xs text-charcoal/50">{fmtDate(date)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{vendor || "—"}</span><span className="block text-xs text-charcoal/60 [overflow-wrap:anywhere]">{sub}</span></span>
      <b className="tabular-nums">{fmt(toCents(amount))}</b>
    </button></li>
  );
}

/* ---------- settings + category mapping ---------- */
function SettingsAndMapping() {
  const [open, setOpen] = useState(false);
  const settings = useExpenseSettings(); const cats = useExpenseCategories();
  const write = useWrite(); const toast = useToast();
  const s = settings.data;
  const saveSetting = async (patch: Record<string, unknown>) => { try { await write.mutateAsync(async () => unwrap(await supabase.from("expense_settings").update(patch).eq("id", true).select("id"))); toast.push("Saved"); } catch (e) { toast.push((e as Error).message, "err"); } };
  const saveCat = async (id: string, patch: Record<string, unknown>) => { try { await write.mutateAsync(async () => unwrap(await supabase.from("expense_categories").update(patch).eq("id", id).select("id"))); toast.push("Saved"); } catch (e) { toast.push((e as Error).message, "err"); } };
  return (
    <section className="card">
      <button type="button" className="card-head w-full text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div><h2 className="card-title inline-flex items-center gap-2"><Settings2 size={16} className="text-gold" /> Tax settings and category lines</h2><p className="text-xs text-charcoal/50">Business start date, asset limit, and which Schedule C line each category goes to (draft: confirm with your accountant).</p></div>
        <span className="text-sm text-teal-700">{open ? "Hide" : "Edit"}</span>
      </button>
      {open && s && (
        <div className="space-y-4 px-5 pb-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Business start date" hint="Expenses before this date are startup costs."><input className="input" type="date" defaultValue={s.business_start_date} onBlur={(e) => e.target.value && e.target.value !== s.business_start_date && saveSetting({ business_start_date: e.target.value })} /></Field>
            <Field label="Possible asset from ($)" hint="Single purchases at or above this are flagged."><input className="input" type="number" min="0" step="1" defaultValue={Number(s.asset_threshold)} onBlur={(e) => Number(e.target.value) !== Number(s.asset_threshold) && saveSetting({ asset_threshold: Number(e.target.value) })} /></Field>
            <Field label="Startup limit ($)" hint="Draft first-year limit. Ask accountant."><input className="input" type="number" min="0" step="1" defaultValue={Number(s.startup_limit)} onBlur={(e) => Number(e.target.value) !== Number(s.startup_limit) && saveSetting({ startup_limit: Number(e.target.value) })} /></Field>
          </div>
          <ul className="divide-y divide-ivory-200">
            {(cats.data ?? []).map((c) => (
              <li key={c.id} className="grid gap-2 py-2 sm:grid-cols-[1fr_1.4fr_auto] sm:items-center">
                <span className="font-medium">{c.name}</span>
                <select className="input" aria-label={`Schedule C line for ${c.name}`} value={c.schedule_c_line ?? ""} onChange={(e) => saveCat(c.id, { schedule_c_line: e.target.value || null })}>
                  <option value="">No line yet</option>{SCHEDULE_C_LINES.filter((l) => !["startup", "uncategorized"].includes(l.key)).map((l) => <option key={l.key} value={l.key}>{l.form}: {l.label}</option>)}
                </select>
                <select className="input" aria-label={`Treatment of ${c.name}`} value={c.treatment ?? "deductible"} onChange={(e) => saveCat(c.id, { treatment: e.target.value })}>
                  <option value="cogs">Cost of goods</option><option value="deductible">Deductible</option><option value="excluded">Not deducted</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
