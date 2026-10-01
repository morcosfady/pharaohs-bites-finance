import { useEffect, useState } from "react";
import { Check, GitMerge, Copy, Tag, ArrowDownLeft } from "lucide-react";
import { EmptyState, Skeleton, useToast } from "./ui";
import { useReviewExpenses, useMoneyIn, useExpenseCategories, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { fmt, toCents } from "../lib/money";
import { fmtDate } from "../lib/dates";
import { ruleText, sourceBadges, MONEY_IN_ACTIONS } from "../lib/expenseReview";
import type { Expense, BankTransaction } from "../lib/types";

/* The daily screen: everything the system could not decide on its own.
   Goal: inbox zero. Nothing here is guessed; the owner confirms each item. */

export function ReviewInbox() {
  const review = useReviewExpenses();
  const moneyIn = useMoneyIn();
  const cats = useExpenseCategories();
  const dupes = (review.data ?? []).filter((e) => e.review_status === "possible_duplicate");
  const needs = (review.data ?? []).filter((e) => e.review_status === "needs_review");
  const incoming = moneyIn.data ?? [];
  const empty = !review.isLoading && !moneyIn.isLoading && !dupes.length && !needs.length && !incoming.length;

  if (review.isLoading || moneyIn.isLoading) return <Skeleton rows={4} className="card p-5" />;
  if (empty) return <div className="card"><EmptyState title="Inbox zero 🎉" hint="Nothing to review. New bank charges that need a decision will show up here." /></div>;

  return (
    <div className="space-y-5">
      {dupes.length > 0 && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Possible duplicates ({dupes.length})</h2><p className="text-xs text-charcoal/50">Same amount around the same date, but the store name did not match. Nothing is merged until you say so.</p></div></div>
          <ul className="divide-y divide-ivory-200 px-5 pb-3">{dupes.map((e) => <DuplicateRow key={e.id} e={e} all={review.data ?? []} />)}</ul>
        </section>
      )}
      {needs.length > 0 && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Needs a category ({needs.length})</h2><p className="text-xs text-charcoal/50">Pick one and the system remembers it for next time.</p></div></div>
          <ul className="divide-y divide-ivory-200 px-5 pb-3">{needs.map((e) => <CategoryRow key={e.id} e={e} cats={cats.data ?? []} />)}</ul>
        </section>
      )}
      {incoming.length > 0 && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Money in ({incoming.length})</h2><p className="text-xs text-charcoal/50">Deposits are never counted as sales or expenses. Tell us what each one is.</p></div></div>
          <ul className="divide-y divide-ivory-200 px-5 pb-3">{incoming.map((t) => <MoneyInRow key={t.id} t={t} />)}</ul>
        </section>
      )}
    </div>
  );
}

function Sources({ e }: { e: Expense }) {
  return <span className="ml-1 inline-flex gap-0.5 text-xs" aria-label="Evidence">{sourceBadges(e.expense_sources).map((b) => <span key={b.key} title={b.label}>{b.icon}</span>)}</span>;
}

function ExpenseCard({ e, tag }: { e: Expense; tag: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-ivory-200 bg-white px-3 py-2 text-sm">
      <span className="badge bg-ivory-200 text-charcoal/60">{tag}</span>
      <div className="mt-1 flex items-baseline justify-between gap-2"><b className="truncate">{e.vendor || "—"}<Sources e={e} /></b><b className="tabular-nums">{fmt(toCents(e.total_amount))}</b></div>
      <div className="truncate text-xs text-charcoal/50">{fmtDate(e.expense_date)} · {e.description || "no description"}</div>
    </div>
  );
}

function DuplicateRow({ e, all }: { e: Expense; all: Expense[] }) {
  const write = useWrite(); const toast = useToast();
  const [original, setOriginal] = useState<Expense | null | undefined>(all.find((x) => x.id === e.duplicate_of));
  useEffect(() => {
    if (original || !e.duplicate_of) return;
    let live = true;
    void supabase.from("expenses").select("*, expense_categories(name), expense_sources(source_type)").eq("id", e.duplicate_of).maybeSingle()
      .then(({ data }) => { if (live) setOriginal(data as Expense | null); });
    return () => { live = false; };
  }, [original, e.duplicate_of]);
  const run = async (fn: () => Promise<unknown>, msg: string) => { try { await write.mutateAsync(fn); toast.push(msg); } catch (err) { toast.push((err as Error).message, "err"); } };
  return (
    <li className="py-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        {original ? <ExpenseCard e={original} tag="Already in your books" /> : <div className="flex-1 rounded-lg border border-dashed border-ivory-200 px-3 py-2 text-sm text-charcoal/50">The matching entry is no longer available.</div>}
        <ExpenseCard e={e} tag="New from the bank" />
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost btn-sm" disabled={write.isPending} onClick={() => run(async () => unwrap(await supabase.rpc("keep_both_expenses", { p_expense: e.id })), "Kept both as separate purchases")}><Copy size={14} /> Two purchases, keep both</button>
        {original && <button className="btn-gold btn-sm" disabled={write.isPending} onClick={() => run(async () => unwrap(await supabase.rpc("merge_expenses", { p_keep: original.id, p_drop: e.id })), "Merged. You can undo this from the audit log.")}><GitMerge size={14} /> Same purchase, merge</button>}
      </div>
    </li>
  );
}

function CategoryRow({ e, cats }: { e: Expense; cats: { id: string; name: string; cost_type: string }[] }) {
  const write = useWrite(); const toast = useToast();
  const [cat, setCat] = useState("");
  const [remember, setRemember] = useState(true);
  const fromBank = e.auto_source === "bank";
  const save = async () => {
    const c = cats.find((x) => x.id === cat); if (!c) return;
    try {
      await write.mutateAsync(async () => {
        unwrap(await supabase.from("expenses").update({ category_id: c.id, cost_type: c.cost_type as Expense["cost_type"] }).eq("id", e.id).select("id"));
        if (remember && e.vendor) unwrap(await supabase.from("bank_rules").insert({ match_text: ruleText(e.description || e.vendor), vendor: e.vendor, category_id: c.id, cost_type: c.cost_type, action: "expense", direction: "out", sort_order: 60 }).select("id"));
      });
      toast.push(remember ? `Saved, and future "${e.vendor}" charges will use ${c.name}` : "Category saved");
    } catch (err) { toast.push((err as Error).message, "err"); }
  };
  const notBusiness = async (action: "personal" | "transfer") => {
    try {
      await write.mutateAsync(async () => {
        unwrap(await supabase.from("bank_rules").insert({ match_text: ruleText(e.description || e.vendor), vendor: "", action, direction: "out", sort_order: 50 }).select("id"));
        unwrap(await supabase.rpc("reapply_bank_rules"));
      });
      toast.push(action === "personal" ? "Marked personal. Excluded from business expenses." : "Marked as a transfer. Not counted as a cost.");
    } catch (err) { toast.push((err as Error).message, "err"); }
  };
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-2 text-sm"><b className="min-w-0 truncate">{e.vendor || "—"}<Sources e={e} /></b><b className="tabular-nums">{fmt(toCents(e.total_amount))}</b></div>
      <div className="mb-2 truncate text-xs text-charcoal/50">{fmtDate(e.expense_date)} · {e.description}</div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input !w-auto min-w-[10rem] flex-1" aria-label={`Category for ${e.vendor}`} value={cat} onChange={(ev) => setCat(ev.target.value)}>
          <option value="">Choose a category…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn-gold btn-sm" disabled={!cat || write.isPending} onClick={save}><Tag size={14} /> Save</button>
        {fromBank && <>
          <button className="btn-ghost btn-sm" disabled={write.isPending} onClick={() => notBusiness("personal")}>Personal</button>
          <button className="btn-ghost btn-sm" disabled={write.isPending} onClick={() => notBusiness("transfer")}>Transfer</button>
        </>}
      </div>
      <label className="mt-1.5 flex items-center gap-1.5 text-xs text-charcoal/60"><input type="checkbox" checked={remember} onChange={(ev) => setRemember(ev.target.checked)} /> Always use this for “{ruleText(e.description || e.vendor)}”</label>
    </li>
  );
}

function MoneyInRow({ t }: { t: BankTransaction }) {
  const write = useWrite(); const toast = useToast();
  const choose = async (action: string) => {
    try {
      await write.mutateAsync(async () => {
        unwrap(await supabase.from("bank_rules").insert({ match_text: ruleText(t.name), vendor: "", action, direction: "in", sort_order: 50 }).select("id"));
        unwrap(await supabase.rpc("reapply_bank_rules"));
      });
      toast.push("Saved. It will be classified the same way next time.");
    } catch (err) { toast.push((err as Error).message, "err"); }
  };
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-2 text-sm"><b className="min-w-0 truncate"><ArrowDownLeft size={13} className="mr-1 inline text-positive" />{t.merchant_name || t.name}</b><b className="tabular-nums text-positive">+{fmt(toCents(-Number(t.amount)))}</b></div>
      <div className="mb-2 truncate text-xs text-charcoal/50">{fmtDate(t.posted_on)} · {t.name}</div>
      <div className="flex flex-wrap gap-2">
        {MONEY_IN_ACTIONS.map((a) => <button key={a.action} className="btn-ghost btn-sm" title={a.hint} disabled={write.isPending} onClick={() => choose(a.action)}><Check size={13} /> {a.label}</button>)}
      </div>
    </li>
  );
}
