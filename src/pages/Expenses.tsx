import { useMemo, useState } from "react";
import { Plus, Paperclip, Repeat } from "lucide-react";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Modal, Field, Skeleton, ErrorBox, KpiCard, ConfirmDialog, useToast, EditButton } from "../components/ui";
import { useExpenses, useExpenseCategories, useProducts, useWrite, useExpenseIntegrity } from "../hooks/queries";
import { useQuery } from "@tanstack/react-query";
import { BankFeed } from "../components/BankFeed";
import { ReviewInbox } from "../components/ExpenseReview";
import { MileageTab } from "../components/Mileage";
import { TaxTab } from "../components/TaxPack";
import { CategoryBreakdown } from "../components/CategoryBreakdown";
import { MarketingTab } from "../components/MarketingTab";
import { CHANNELS } from "../lib/marketing";
import { ReceiptsTab } from "../components/Receipts";
import { sourceBadges } from "../lib/expenseReview";
import { PAYMENT_METHODS, label } from "../lib/status";
import { fmt, toCents, sum } from "../lib/money";
import { fmtDate, toInputDate } from "../lib/dates";
import { supabase, unwrap } from "../lib/supabase";
import { downloadText, toCsv } from "../lib/csv";
import type { Expense, PaymentMethod } from "../lib/types";
import { useAdvanced } from "../hooks/useMode";

type Row = Expense & { category: string; [k: string]: unknown };

export function ExpensesPage() {
  const [range, setRange] = useDateRange("this_month");
  const expenses = useExpenses(range);
  /* Subscriptions and fixed costs are shown for all time, not just the selected period. */
  const fixed = useQuery({ queryKey: ["expenses", "fixed"], queryFn: async () => unwrap(await supabase.from("expenses").select("*, expense_categories(name)").is("deleted_at", null).neq("recurrence", "none").order("expense_date", { ascending: false })) as Expense[] });
  const cats = useExpenseCategories();
  const [edit, setEdit] = useState<Expense | null | "new" | "subscription" | "marketing">(null);
  const [del, setDel] = useState<Expense | null>(null);
  const advanced = useAdvanced();
  const write = useWrite(); const toast = useToast();
  const openById = async (id: string) => {
    const { data, error } = await supabase.from("expenses").select("*, expense_categories(name)").eq("id", id).maybeSingle();
    if (error || !data) { toast.push(error?.message ?? "Expense not found", "err"); return; }
    setEdit(data as Expense);
  };
  const [tab, setTab] = useState<Tab>("all");
  const integrity = useExpenseIntegrity();
  const toReview = (integrity.data?.needs_review ?? 0) + (integrity.data?.possible_duplicates ?? 0) + (integrity.data?.money_in_unclassified ?? 0);
  /* Recipe-based order cost lives on its own Cost tab, not here -- Expenses is
     real money movement (manual entries + the bank feed). */
  const rows = useMemo<Row[]>(() => (expenses.data ?? [])
    .filter((e) => e.auto_source !== "order_cost")
    .map((e) => ({ ...e, category: e.expense_categories?.name ?? "—" })), [expenses.data]);
  const total = sum(rows.map((r) => toCents(r.total_amount)));
  /* gas bought in the period: not deductible on top of the standard mileage rate */
  const gasRows = rows.filter((r) => r.category === "Gas / mileage");
  const gas = { count: gasRows.length, total: sum(gasRows.map((r) => toCents(r.total_amount))) / 100 };
  const direct = sum(rows.filter((r) => r.cost_type === "direct_product").map((r) => toCents(r.total_amount)));
  const allCols: Column<Row>[] = [
    { key: "expense_date", header: "Date", render: (r) => fmtDate(r.expense_date) },
    { key: "vendor", header: "Vendor", primary: true, render: (r) => <span><span className="font-medium">{r.vendor || "—"}</span><span className="ml-2 inline-flex gap-0.5 text-xs">{sourceBadges(r.expense_sources).map((b) => <span key={b.key} title={b.label}>{b.icon}</span>)}</span>{r.review_status !== "ok" && <span className="badge ml-2 bg-gold-100 text-charcoal/70">{r.review_status === "possible_duplicate" ? "check" : "needs category"}</span>}<span className="block text-xs text-charcoal/50">{r.description}</span></span> },
    { key: "category", header: "Category" },
    { key: "cost_type", header: "Type", mobile: false, render: (r) => r.cost_type === "direct_product" ? "Direct product cost" : "Operating" },
    { key: "amount_before_tax", header: "Before tax", numeric: true, mobile: false, render: (r) => fmt(toCents(r.amount_before_tax)) },
    { key: "sales_tax_paid", header: "Tax paid", numeric: true, mobile: false, render: (r) => fmt(toCents(r.sales_tax_paid)) },
    { key: "total_amount", header: "Total", numeric: true, render: (r) => <b>{fmt(toCents(r.total_amount))}</b>, sortValue: (r) => toCents(r.total_amount) },
    { key: "payment_method", header: "Paid by", mobile: false, render: (r) => label(PAYMENT_METHODS, r.payment_method) },
    { key: "receipt_path", header: "Receipt", render: (r) => r.receipt_path ? <button className="text-teal-700 hover:underline" onClick={async (ev) => { ev.stopPropagation(); const { data } = await supabase.storage.from("receipts").createSignedUrl(r.receipt_path, 300); if (data?.signedUrl) window.open(data.signedUrl, "_blank"); }}><Paperclip size={14} /></button> : "" },
    { key: "recurrence", header: "Recurring", mobile: false, render: (r) => r.recurrence === "none" ? "" : r.recurrence },
  ];
  const editCol: Column<Row> = { key: "edit", header: "", render: (r) => <EditButton small label="Edit expense" onClick={() => setEdit(r)} /> };
  const cols = [...(advanced ? allCols : allCols.filter((c) => ["expense_date", "vendor", "category", "total_amount", "receipt_path"].includes(c.key))), editCol];
  return (
    <div>
      <PageHeader title="Expenses" crumbs={["Home", "Expenses"]} actions={<>
        <button className="btn-ghost btn-sm" onClick={() => downloadText(`expenses-${toInputDate(range.from)}-${toInputDate(range.to)}.csv`, toCsv(rows.map((r) => ({ date: r.expense_date, vendor: r.vendor, category: r.category, description: r.description, amount_before_tax: r.amount_before_tax, sales_tax_paid: r.sales_tax_paid, total: r.total_amount, payment_method: r.payment_method ?? "", cost_type: r.cost_type, notes: r.notes }))))}>Export CSV</button>
        <button className="btn-ghost btn-sm" onClick={() => setEdit("subscription")}><Repeat size={14} /> Add subscription</button>
        <button className="btn-gold btn-sm" onClick={() => setEdit("new")}><Plus size={16} /> Add expense</button>
      </>} />
      <TabBar tab={tab} onChange={setTab} reviewCount={toReview} />
      {tab === "review" && <ReviewInbox />}
      {tab === "bank" && <BankFeed />}
      {tab === "tax" && <TaxTab onOpenExpense={openById} />}
      {tab === "receipts" && <ReceiptsTab onOpenExpense={openById} />}
      {tab === "marketing" && <><DateRangeBar range={range} onChange={setRange} /><MarketingTab range={range} onAdd={() => setEdit("marketing")} onOpenExpense={openById} /></>}
      {tab === "mileage" && <><DateRangeBar range={range} onChange={setRange} /><MileageTab range={range} gas={gas} /></>}
      {tab === "subs" && <FixedCosts rows={fixed.data ?? []} loading={fixed.isLoading} onOpen={(e) => setEdit(e)} />}
      {tab === "all" && <>
        <DateRangeBar range={range} onChange={setRange} />
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4"><KpiCard label="Total expenses" value={total} />{advanced && <><KpiCard label="Direct product costs" value={direct} /><KpiCard label="Operating expenses" value={total - direct} /></>}<KpiCard label="Entries" value={rows.length} kind="int" />{toReview > 0 && <button type="button" className="text-left" onClick={() => setTab("review")}><KpiCard label="Items to review" value={toReview} kind="int" /></button>}</div>
        <CategoryBreakdown range={range} />
        {expenses.error && <ErrorBox error={expenses.error} />}
        {expenses.isLoading ? <Skeleton rows={8} className="card p-5" /> : <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => setEdit(r)} initialSort={{ key: "expense_date", dir: "desc" }} />}
      </>}
      {edit && <ExpenseModal expense={edit === "new" || edit === "subscription" || edit === "marketing" ? undefined : edit} subscription={edit === "subscription"} marketing={edit === "marketing"} categories={cats.data ?? []} onClose={() => setEdit(null)} onDelete={(e) => { setEdit(null); setDel(e); }} />}
      <ConfirmDialog open={!!del} title="Delete this expense?" body="It is archived (soft-deleted) and kept in the audit log." danger confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={async () => { const e = del!; setDel(null); try { await write.mutateAsync(async () => unwrap(await supabase.from("expenses").update({ deleted_at: new Date().toISOString() }).eq("id", e.id).select("id"))); toast.push("Expense deleted"); } catch (err) { toast.push((err as Error).message, "err"); } }} />
    </div>
  );
}

/* ---------- tabs ---------- */
type Tab = "all" | "marketing" | "receipts" | "review" | "mileage" | "tax" | "subs" | "bank";
const TABS: { key: Tab; label: string; short: string }[] = [{ key: "all", label: "All expenses", short: "All" }, { key: "marketing", label: "Marketing", short: "Marketing" }, { key: "receipts", label: "Receipts", short: "Receipts" }, { key: "review", label: "Review", short: "Review" }, { key: "mileage", label: "Mileage", short: "Miles" }, { key: "tax", label: "Tax", short: "Tax" }, { key: "subs", label: "Subscriptions", short: "Subs" }, { key: "bank", label: "Bank feed", short: "Bank" }];

function TabBar({ tab, onChange, reviewCount }: { tab: Tab; onChange: (t: Tab) => void; reviewCount: number }) {
  return (
    <div role="tablist" aria-label="Expenses sections" className="mb-4 flex gap-0.5 overflow-x-auto rounded-xl bg-ivory-100 p-1 sm:gap-1">
      {TABS.map((t) => (
        <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => onChange(t.key)}
          className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium sm:px-3 ${tab === t.key ? "bg-white text-teal-900 shadow-sm" : "text-charcoal/60 hover:text-teal-900"}`}>
          <span className="sm:hidden">{t.short}</span><span className="hidden sm:inline">{t.label}</span>{t.key === "review" && reviewCount > 0 && <span className="ml-1.5 rounded-full bg-gold px-1.5 py-0.5 text-[10px] font-bold text-charcoal">{reviewCount}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- Subscriptions & fixed costs ---------- */
const PER_YEAR: Record<Expense["recurrence"], number> = { none: 0, weekly: 52, monthly: 12, quarterly: 4, annual: 1 };
const CADENCE: Record<Expense["recurrence"], string> = { none: "one-off", weekly: "per week", monthly: "per month", quarterly: "per quarter", annual: "per year" };

function FixedCosts({ rows, loading, onOpen }: { rows: Expense[]; loading: boolean; onOpen: (e: Expense) => void }) {
  const yearly = sum(rows.map((r) => Math.round(toCents(r.total_amount) * PER_YEAR[r.recurrence])));
  return (
    <section className="card mb-5">
      <div className="card-head">
        <div>
          <h2 className="card-title inline-flex items-center gap-2"><Repeat size={16} className="text-gold" /> Subscriptions & fixed costs</h2>
          <p className="text-xs text-charcoal/50">Things you pay for regardless of orders: software, licenses, insurance. Shown for all time, not just the period above.</p>
        </div>
        {rows.length > 0 && <div className="shrink-0 text-right text-xs text-charcoal/60"><span className="block">Adds up to</span><b className="block whitespace-nowrap font-display text-xl font-semibold text-teal-900">{fmt(Math.round(yearly / 12))}<span className="text-sm font-normal text-charcoal/50"> / month</span></b><span className="whitespace-nowrap">{fmt(yearly)} / year</span></div>}
      </div>
      <div className="px-5 pb-5">
        {loading ? <Skeleton rows={2} /> : rows.length === 0 ? <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">Nothing here yet. Use <b>Add subscription</b> above for things like software or a yearly license.</p> : (
          <ul className="divide-y divide-ivory-200">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-ivory-50">
                  <span className="rounded-full bg-teal-50 p-2 text-teal-800"><Repeat size={14} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{r.vendor || r.description || "—"}</span><span className="block truncate text-xs text-charcoal/50">{r.description}{r.expense_categories?.name ? ` · ${r.expense_categories.name}` : ""} · since {fmtDate(r.expense_date)}</span></span>
                  <span className="text-right"><b className="block tabular-nums">{fmt(toCents(r.total_amount))}</b><span className="text-xs text-charcoal/50">{CADENCE[r.recurrence]}{r.recurrence !== "monthly" && r.recurrence !== "none" ? ` · ≈ ${fmt(Math.round(toCents(r.total_amount) * PER_YEAR[r.recurrence] / 12))}/mo` : ""}</span></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ExpenseModal({ expense, subscription, marketing, categories, onClose, onDelete }: { expense?: Expense; subscription?: boolean; marketing?: boolean; categories: { id: string; name: string; cost_type: string }[]; onClose: () => void; onDelete?: (e: Expense) => void }) {
  const products = useProducts();
  const write = useWrite(); const toast = useToast(); const advanced = useAdvanced();
  const [f, setF] = useState({ expense_date: expense?.expense_date ?? toInputDate(new Date()), vendor: expense?.vendor ?? "", category_id: expense?.category_id ?? (marketing ? (categories.find((c) => c.name === "Marketing")?.id ?? "") : ""), marketing_channel: expense?.marketing_channel ?? "", description: expense?.description ?? "", amount_before_tax: Number(expense?.amount_before_tax ?? 0), sales_tax_paid: Number(expense?.sales_tax_paid ?? 0), payment_method: expense?.payment_method ?? "card", cost_type: expense?.cost_type ?? "operating", product_id: expense?.product_id ?? "", order_id: expense?.order_id ?? "", notes: expense?.notes ?? "", recurrence: expense?.recurrence ?? (subscription ? "annual" : "none"), business_pct: Number(expense?.business_pct ?? 100), ask_accountant: expense?.ask_accountant ?? false, ask_note: expense?.ask_note ?? "" });
  /* bank and Stripe rows take their date, vendor and amount from the source and refresh on sync */
  const locked = expense?.auto_source === "bank" || expense?.auto_source === "stripe";
  const [file, setFile] = useState<File | null>(null);
  const isMarketing = categories.find((c) => c.id === f.category_id)?.name === "Marketing";
  const [busy, setBusy] = useState(false);
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const v = e.target.type === "number" ? Number(e.target.value) : e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    const next = { ...f, [k]: v };
    if (k === "category_id") { const c = categories.find((x) => x.id === v); if (c) next.cost_type = c.cost_type as "operating" | "direct_product"; }
    setF(next);
  };
  const submit = async () => {
    setBusy(true);
    try {
      let receipt_path = expense?.receipt_path ?? "";
      if (file) {
        const path = `${f.expense_date.slice(0, 7)}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.]+/g, "-")}`;
        const { error } = await supabase.storage.from("receipts").upload(path, file, { upsert: false });
        if (error) throw new Error(error.message);
        receipt_path = path;
      }
      await write.mutateAsync(async () => unwrap(await supabase.from("expenses").upsert({ ...(expense ? { id: expense.id } : {}), ...f, marketing_channel: isMarketing ? (f.marketing_channel || null) : null, category_id: f.category_id || null, product_id: f.product_id || null, order_id: f.order_id || null, payment_method: (f.payment_method || null) as PaymentMethod | null, receipt_path }).select("id")));
      toast.push(expense ? "Expense saved" : "Expense added"); onClose();
    } catch (e) { toast.push((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={expense ? "Edit expense" : subscription ? "Add subscription" : marketing ? "Add marketing expense" : "Add expense"} wide>
      {locked && <p className="mb-3 rounded-lg bg-ivory-50 px-3 py-2 text-xs text-charcoal/70">Imported automatically: date, vendor and amount come from the {expense?.auto_source === "stripe" ? "payment" : "bank"} and refresh on sync. You can change the category, business use % and notes.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date"><input className="input" type="date" disabled={locked} value={f.expense_date} onChange={u("expense_date")} /></Field>
        <Field label="Vendor"><input className="input" disabled={locked} value={f.vendor} onChange={u("vendor")} /></Field>
        <Field label="Category"><select className="input" value={f.category_id} onChange={u("category_id")}><option value="">—</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {advanced ? <>
          <Field label="Cost type" hint="Direct product costs feed COGS; operating expenses reduce net profit."><select className="input" value={f.cost_type} onChange={u("cost_type")}><option value="direct_product">Direct product cost</option><option value="operating">Operating expense</option></select></Field>
          <Field label="Amount before tax"><input className="input" disabled={locked} type="number" step="0.01" min="0" value={f.amount_before_tax} onChange={u("amount_before_tax")} /></Field>
          <Field label="Sales tax paid" hint={`Total: ${fmt(toCents(f.amount_before_tax) + toCents(f.sales_tax_paid))}`}><input className="input" type="number" step="0.01" min="0" value={f.sales_tax_paid} onChange={u("sales_tax_paid")} /></Field>
        </> : (
          <Field label="Amount paid (total)"><input className="input" disabled={locked} type="number" step="0.01" min="0" value={f.amount_before_tax} onChange={u("amount_before_tax")} /></Field>
        )}
        {isMarketing && <Field label="Marketing channel" hint="Leave on automatic and it is guessed from the vendor."><select className="input" value={f.marketing_channel ?? ""} onChange={u("marketing_channel")}><option value="">Automatic</option>{CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.emoji} {c.label}</option>)}</select></Field>}
        <Field label="Payment method"><select className="input" value={f.payment_method ?? ""} onChange={u("payment_method")}>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Recurring" hint="Anything other than one-off shows under Subscriptions & fixed costs."><select className="input" value={f.recurrence} onChange={u("recurrence")}><option value="none">One-off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></Field>
        {advanced && <>
        <Field label="Linked product (optional)"><select className="input" value={f.product_id} onChange={u("product_id")}><option value="">—</option>{(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Linked order id (optional)"><input className="input" value={f.order_id} onChange={u("order_id")} placeholder="paste order UUID" /></Field>
        </>}
        <Field label="Business use %" hint="100 for business-only. Phone, internet, utilities: only the business share counts."><input className="input" type="number" min="0" max="100" step="1" value={f.business_pct} onChange={u("business_pct")} /></Field>
        <label className="flex items-center gap-2 self-center text-sm"><input type="checkbox" checked={f.ask_accountant} onChange={u("ask_accountant")} /> Ask my accountant about this</label>
        {f.ask_accountant && <Field label="What to ask" className="sm:col-span-2"><input className="input" value={f.ask_note} onChange={u("ask_note")} placeholder="Is the mixer an asset?" /></Field>}
        <Field label="Description" className="sm:col-span-2"><input className="input" value={f.description} onChange={u("description")} /></Field>
        <Field label="Receipt photo / PDF" hint={expense?.receipt_path ? "A receipt is attached; choosing a file replaces it." : "Stored privately; only admins can open it."}><input className="input" type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        {advanced && <Field label="Notes"><input className="input" value={f.notes} onChange={u("notes")} /></Field>}
      </div>
      <div className="flex justify-between gap-2">
        {expense && onDelete ? <button className="btn-ghost text-negative" onClick={() => onDelete(expense)}>Delete</button> : <span />}
        <div className="flex gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !(f.amount_before_tax > 0 || f.sales_tax_paid > 0)} onClick={submit}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </Modal>
  );
}
