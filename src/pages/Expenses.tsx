import { useMemo, useState } from "react";
import { Plus, Paperclip } from "lucide-react";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Modal, Field, Skeleton, ErrorBox, KpiCard, ConfirmDialog, useToast } from "../components/ui";
import { useExpenses, useExpenseCategories, useProducts, useWrite } from "../hooks/queries";
import { PAYMENT_METHODS, label } from "../lib/status";
import { fmt, toCents, sum } from "../lib/money";
import { fmtDate, toInputDate } from "../lib/dates";
import { supabase, unwrap } from "../lib/supabase";
import { downloadText, toCsv } from "../lib/csv";
import type { Expense, PaymentMethod } from "../lib/types";

type Row = Expense & { category: string; [k: string]: unknown };

export function ExpensesPage() {
  const [range, setRange] = useDateRange("this_month");
  const expenses = useExpenses(range);
  const cats = useExpenseCategories();
  const [edit, setEdit] = useState<Expense | null | "new">(null);
  const [del, setDel] = useState<Expense | null>(null);
  const write = useWrite(); const toast = useToast();
  const rows = useMemo<Row[]>(() => (expenses.data ?? []).map((e) => ({ ...e, category: e.expense_categories?.name ?? "—" })), [expenses.data]);
  const total = sum(rows.map((r) => toCents(r.total_amount)));
  const direct = sum(rows.filter((r) => r.cost_type === "direct_product").map((r) => toCents(r.total_amount)));
  const cols: Column<Row>[] = [
    { key: "expense_date", header: "Date", render: (r) => fmtDate(r.expense_date) },
    { key: "vendor", header: "Vendor", primary: true, render: (r) => <span><span className="font-medium">{r.vendor || "—"}</span><span className="block text-xs text-charcoal/50">{r.description}</span></span> },
    { key: "category", header: "Category" },
    { key: "cost_type", header: "Type", mobile: false, render: (r) => r.cost_type === "direct_product" ? "Direct product cost" : "Operating" },
    { key: "amount_before_tax", header: "Before tax", numeric: true, mobile: false, render: (r) => fmt(toCents(r.amount_before_tax)) },
    { key: "sales_tax_paid", header: "Tax paid", numeric: true, mobile: false, render: (r) => fmt(toCents(r.sales_tax_paid)) },
    { key: "total_amount", header: "Total", numeric: true, render: (r) => <b>{fmt(toCents(r.total_amount))}</b>, sortValue: (r) => toCents(r.total_amount) },
    { key: "payment_method", header: "Paid by", mobile: false, render: (r) => label(PAYMENT_METHODS, r.payment_method) },
    { key: "receipt_path", header: "Receipt", render: (r) => r.receipt_path ? <button className="text-teal-700 hover:underline" onClick={async (ev) => { ev.stopPropagation(); const { data } = await supabase.storage.from("receipts").createSignedUrl(r.receipt_path, 300); if (data?.signedUrl) window.open(data.signedUrl, "_blank"); }}><Paperclip size={14} /></button> : "" },
    { key: "recurrence", header: "Recurring", mobile: false, render: (r) => r.recurrence === "none" ? "" : r.recurrence },
  ];
  return (
    <div>
      <PageHeader title="Expenses" crumbs={["Home", "Expenses"]} actions={<>
        <button className="btn-ghost btn-sm" onClick={() => downloadText(`expenses-${toInputDate(range.from)}-${toInputDate(range.to)}.csv`, toCsv(rows.map((r) => ({ date: r.expense_date, vendor: r.vendor, category: r.category, description: r.description, amount_before_tax: r.amount_before_tax, sales_tax_paid: r.sales_tax_paid, total: r.total_amount, payment_method: r.payment_method ?? "", cost_type: r.cost_type, notes: r.notes }))))}>Export CSV</button>
        <button className="btn-gold btn-sm" onClick={() => setEdit("new")}><Plus size={16} /> Add expense</button>
      </>} />
      <DateRangeBar range={range} onChange={setRange} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4"><KpiCard label="Total expenses" value={total} /><KpiCard label="Direct product costs" value={direct} /><KpiCard label="Operating expenses" value={total - direct} /><KpiCard label="Entries" value={rows.length} kind="int" /></div>
      {expenses.error && <ErrorBox error={expenses.error} />}
      {expenses.isLoading ? <Skeleton rows={8} className="card p-5" /> : <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => setEdit(r)} initialSort={{ key: "expense_date", dir: "desc" }} />}
      {edit && <ExpenseModal expense={edit === "new" ? undefined : edit} categories={cats.data ?? []} onClose={() => setEdit(null)} onDelete={(e) => { setEdit(null); setDel(e); }} />}
      <ConfirmDialog open={!!del} title="Delete this expense?" body="It is archived (soft-deleted) and kept in the audit log." danger confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={async () => { const e = del!; setDel(null); try { await write.mutateAsync(async () => unwrap(await supabase.from("expenses").update({ deleted_at: new Date().toISOString() }).eq("id", e.id).select("id"))); toast.push("Expense deleted"); } catch (err) { toast.push((err as Error).message, "err"); } }} />
    </div>
  );
}

export function ExpenseModal({ expense, categories, onClose, onDelete }: { expense?: Expense; categories: { id: string; name: string; cost_type: string }[]; onClose: () => void; onDelete?: (e: Expense) => void }) {
  const products = useProducts();
  const write = useWrite(); const toast = useToast();
  const [f, setF] = useState({ expense_date: expense?.expense_date ?? toInputDate(new Date()), vendor: expense?.vendor ?? "", category_id: expense?.category_id ?? "", description: expense?.description ?? "", amount_before_tax: Number(expense?.amount_before_tax ?? 0), sales_tax_paid: Number(expense?.sales_tax_paid ?? 0), payment_method: expense?.payment_method ?? "card", cost_type: expense?.cost_type ?? "operating", product_id: expense?.product_id ?? "", order_id: expense?.order_id ?? "", notes: expense?.notes ?? "", recurrence: expense?.recurrence ?? "none" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const v = e.target.type === "number" ? Number(e.target.value) : e.target.value;
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
      await write.mutateAsync(async () => unwrap(await supabase.from("expenses").upsert({ ...(expense ? { id: expense.id } : {}), ...f, category_id: f.category_id || null, product_id: f.product_id || null, order_id: f.order_id || null, payment_method: (f.payment_method || null) as PaymentMethod | null, receipt_path }).select("id")));
      toast.push(expense ? "Expense saved" : "Expense added"); onClose();
    } catch (e) { toast.push((e as Error).message, "err"); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={expense ? "Edit expense" : "Add expense"} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date"><input className="input" type="date" value={f.expense_date} onChange={u("expense_date")} /></Field>
        <Field label="Vendor"><input className="input" value={f.vendor} onChange={u("vendor")} /></Field>
        <Field label="Category"><select className="input" value={f.category_id} onChange={u("category_id")}><option value="">—</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Cost type" hint="Direct product costs feed COGS; operating expenses reduce net profit."><select className="input" value={f.cost_type} onChange={u("cost_type")}><option value="direct_product">Direct product cost</option><option value="operating">Operating expense</option></select></Field>
        <Field label="Amount before tax"><input className="input" type="number" step="0.01" min="0" value={f.amount_before_tax} onChange={u("amount_before_tax")} /></Field>
        <Field label="Sales tax paid" hint={`Total: ${fmt(toCents(f.amount_before_tax) + toCents(f.sales_tax_paid))}`}><input className="input" type="number" step="0.01" min="0" value={f.sales_tax_paid} onChange={u("sales_tax_paid")} /></Field>
        <Field label="Payment method"><select className="input" value={f.payment_method ?? ""} onChange={u("payment_method")}>{PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Recurring"><select className="input" value={f.recurrence} onChange={u("recurrence")}><option value="none">One-off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></Field>
        <Field label="Linked product (optional)"><select className="input" value={f.product_id} onChange={u("product_id")}><option value="">—</option>{(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Linked order id (optional)"><input className="input" value={f.order_id} onChange={u("order_id")} placeholder="paste order UUID" /></Field>
        <Field label="Description" className="sm:col-span-2"><input className="input" value={f.description} onChange={u("description")} /></Field>
        <Field label="Receipt photo / PDF" hint={expense?.receipt_path ? "A receipt is attached; choosing a file replaces it." : "Stored privately; only admins can open it."}><input className="input" type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Notes"><input className="input" value={f.notes} onChange={u("notes")} /></Field>
      </div>
      <div className="flex justify-between gap-2">
        {expense && onDelete ? <button className="btn-ghost text-negative" onClick={() => onDelete(expense)}>Delete</button> : <span />}
        <div className="flex gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy || !(f.amount_before_tax > 0 || f.sales_tax_paid > 0)} onClick={submit}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </Modal>
  );
}
