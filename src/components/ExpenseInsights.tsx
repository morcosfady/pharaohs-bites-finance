import { useMemo, useState } from "react";
import { CalendarClock, PiggyBank, Plus, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { Skeleton, Modal, Field, useToast, ConfirmDialog } from "./ui";
import { useAllOrderFinancials, useUpcomingBills, useBudgetStatus, useExpenseCategories, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { REVENUE_STATUSES } from "../lib/metrics";
import { dueLabel, totalDue, budgetView, type BudgetRow } from "../lib/bills";
import { fmt, toCents, fromCents } from "../lib/money";
import { fmtDate, inRange, type DateRange } from "../lib/dates";

/* Three small helpers that sit on top of All expenses:
   ProfitBox     - am I making money? (sales minus what I spent, same period as the page)
   UpcomingBills - what is due in the next 30 days, so the cash is there
   BudgetsCard   - an optional monthly limit per category, with a warning as it fills up */

export function ProfitBox({ range, spentCents }: { range: DateRange; spentCents: number }) {
  const fin = useAllOrderFinancials();
  const sales = useMemo(() => (fin.data ?? [])
    .filter((o) => REVENUE_STATUSES.includes(o.status) && o.status !== "refunded" && inRange(o.created_at, range))
    .reduce((s, o) => s + toCents(o.net_product_sales) + toCents(o.delivery_revenue), 0), [fin.data, range]);
  const left = sales - spentCents;
  const kept = sales > 0 ? left / sales : null;
  return (
    <section className="card mb-4 px-5 py-4" aria-label="Am I making money">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="card-title inline-flex items-center gap-2"><Wallet size={16} className="text-gold" /> Am I making money?</h2>
        <span className="text-xs text-charcoal/50">Sales minus what you spent, for the period below</span>
      </div>
      {fin.isLoading ? <Skeleton rows={1} /> : (
        <div className="grid grid-cols-3 items-end gap-2 text-center sm:gap-4">
          <div><div className="text-[11px] uppercase tracking-wider text-teal-900/70">Sales</div><div className="font-display text-xl font-semibold text-teal-900 sm:text-3xl">{fmt(sales)}</div></div>
          <div><div className="text-[11px] uppercase tracking-wider text-teal-900/70">− Spent</div><div className="font-display text-xl font-semibold text-teal-900 sm:text-3xl">{fmt(spentCents)}</div></div>
          <div className={left < 0 ? "text-negative" : "text-positive"}>
            <div className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider">{left < 0 ? <TrendingDown size={12} /> : <TrendingUp size={12} />} = Left</div>
            <div className="font-display text-xl font-semibold sm:text-3xl">{left < 0 ? "−" : ""}{fmt(Math.abs(left))}</div>
          </div>
        </div>
      )}
      {!fin.isLoading && <p className="mt-2 text-xs text-charcoal/55">{sales === 0 ? "No sales in this period yet, so everything spent shows as a loss until orders come in." : `You keep ${Math.round((kept ?? 0) * 100)}% of every sales dollar before your own pay.`} Sales tax is not counted as sales. This is cash in and out; Menu &amp; Profit shows profit per dish.</p>}
    </section>
  );
}

export function UpcomingBills({ onOpen }: { onOpen: (expenseId: string) => void }) {
  const bills = useUpcomingBills(30);
  const today = new Date();
  const rows = bills.data ?? [];
  const in30 = totalDue(rows, 30, today), in7 = totalDue(rows, 7, today);
  return (
    <section className="card">
      <div className="card-head">
        <div><h2 className="card-title inline-flex items-center gap-2"><CalendarClock size={16} className="text-gold" /> Bills coming up</h2><p className="text-xs text-charcoal/50">Subscriptions and fixed costs due in the next 30 days.</p></div>
        {rows.length > 0 && <div className="shrink-0 text-right text-xs text-charcoal/60"><span className="block">Keep aside</span><b className="block whitespace-nowrap font-display text-xl font-semibold text-teal-900">{fmt(in30)}</b><span className="whitespace-nowrap">{fmt(in7)} in 7 days</span></div>}
      </div>
      <div className="px-5 pb-5">
        {bills.isLoading ? <Skeleton rows={2} /> : rows.length === 0
          ? <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">Nothing due in the next 30 days. Use <b>Add subscription</b> for software, licenses or insurance and it shows up here.</p>
          : <ul className="divide-y divide-ivory-200">{rows.map((b, i) => (
            <li key={`${b.expense_id}-${b.due}-${i}`}>
              <button type="button" onClick={() => onOpen(b.expense_id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-ivory-50">
                <span className="w-14 shrink-0 text-xs text-charcoal/50">{fmtDate(b.due)}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{b.vendor || b.description || "—"}</span><span className="block text-xs text-charcoal/50">{dueLabel(b.due, today)} · {b.recurrence}</span></span>
                <b className="tabular-nums">{fmt(toCents(b.amount))}</b>
              </button>
            </li>))}</ul>}
      </div>
    </section>
  );
}

const TONE = { ok: { bar: "bg-positive", text: "text-positive" }, near: { bar: "bg-warning", text: "text-warning" }, over: { bar: "bg-negative", text: "text-negative" } };

export function BudgetsCard() {
  const status = useBudgetStatus();
  const cats = useExpenseCategories();
  const write = useWrite(); const toast = useToast();
  const [edit, setEdit] = useState<{ category_id: string; limit: string; isNew: boolean } | null>(null);
  const [del, setDel] = useState<BudgetRow | null>(null);
  const rows = status.data ?? [];
  const used = new Set(rows.map((r) => r.category_id));
  const free = (cats.data ?? []).filter((c) => !used.has(c.id) && c.name !== "Personal (not business)");
  const save = async () => {
    if (!edit) return;
    try {
      await write.mutateAsync(async () => unwrap(await supabase.from("expense_budgets").upsert({ category_id: edit.category_id, monthly_limit: Number(edit.limit) }).select("category_id")));
      toast.push("Budget saved"); setEdit(null);
    } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <section className="card">
      <div className="card-head">
        <div><h2 className="card-title inline-flex items-center gap-2"><PiggyBank size={16} className="text-gold" /> Monthly budgets</h2><p className="text-xs text-charcoal/50">Set a limit for a category. You get a warning here and on Telegram as it fills up.</p></div>
        <button className="btn-ghost btn-sm" disabled={free.length === 0} onClick={() => setEdit({ category_id: free[0]?.id ?? "", limit: "", isNew: true })}><Plus size={14} /> Set budget</button>
      </div>
      <div className="px-5 pb-5">
        {status.isLoading ? <Skeleton rows={2} /> : rows.length === 0
          ? <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">No budgets yet. Try one for <b>Marketing</b> or <b>Ingredients</b>: tap <b>Set budget</b>.</p>
          : <ul className="space-y-3">{rows.map((r) => {
            const v = budgetView(r); const t = TONE[v.tone];
            return (
              <li key={r.category_id}>
                <button type="button" className="w-full text-left" onClick={() => setEdit({ category_id: r.category_id, limit: String(fromCents(v.limit)), isNew: false })} aria-label={`Edit budget for ${r.category}`}>
                  <div className="flex items-baseline justify-between gap-2"><span className="min-w-0 truncate font-medium">{r.category}</span><span className={`shrink-0 text-xs font-semibold ${t.text}`}>{Math.round(v.pct)}%</span></div>
                  <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-ivory-100"><div className={`h-full rounded-full ${t.bar}`} style={{ width: `${v.drawPct}%` }} /></div>
                  <div className="mt-0.5 flex justify-between text-xs text-charcoal/55"><span>{fmt(v.spent)} of {fmt(v.limit)} this month</span><span>{v.leftCents >= 0 ? `${fmt(v.leftCents)} left` : <b className="text-negative">{fmt(-v.leftCents)} over</b>}</span></div>
                </button>
              </li>);
          })}</ul>}
      </div>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.isNew ? "Set a monthly budget" : "Edit budget"}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category"><select className="input" disabled={!edit.isNew} value={edit.category_id} onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}>
              {(edit.isNew ? free : (cats.data ?? [])).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Limit per month ($)"><input className="input" type="number" min="1" step="1" autoFocus value={edit.limit} onChange={(e) => setEdit({ ...edit, limit: e.target.value })} placeholder="200" /></Field>
          </div>
          <div className="flex justify-between gap-2">
            {!edit.isNew ? <button className="btn-ghost text-negative" onClick={() => { const r = rows.find((x) => x.category_id === edit.category_id); setEdit(null); if (r) setDel(r); }}>Remove</button> : <span />}
            <div className="flex gap-2"><button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" disabled={!edit.category_id || !(Number(edit.limit) > 0) || write.isPending} onClick={save}>Save</button></div>
          </div>
        </Modal>
      )}
      <ConfirmDialog open={!!del} title="Remove this budget?" body="Your spending is not touched. You just stop getting warnings for this category." danger confirmLabel="Remove" onCancel={() => setDel(null)}
        onConfirm={async () => { const r = del!; setDel(null); try { await write.mutateAsync(async () => unwrap(await supabase.from("expense_budgets").delete().eq("category_id", r.category_id))); toast.push("Budget removed"); } catch (e) { toast.push((e as Error).message, "err"); } }} />
    </section>
  );
}
