import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Landmark, RefreshCw, AlertTriangle, Plus, Link2, EyeOff, Eye, Wand2, Trash2 } from "lucide-react";
import { Section, Skeleton, Modal, Field, useToast, ConfirmDialog } from "./ui";
import { useBankAccounts, useBankTransactions, useBankRules, useExpenseCategories, useWrite, callPlaid, loadPlaidLink } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { fmt, toCents, sum } from "../lib/money";
import { fmtDate } from "../lib/dates";
import type { BankRule, BankTransaction } from "../lib/types";

/* The bank feed: connect a bank through Plaid, pull activity, and let the
   rules decide which expense each transaction becomes. Plaid's access token
   never reaches this code -- the edge functions hold it. */

export function BankFeed() {
  const accounts = useBankAccounts();
  const txns = useBankTransactions(300);
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"" | "link" | "sync">("");
  const [rulesOpen, setRulesOpen] = useState(false);

  const connected = accounts.data ?? [];
  const item = connected[0]?.bank_items ?? null;
  const needsReauth = connected.some((a) => a.bank_items?.status === "needs_reauth");

  const recent = txns.data ?? [];
  const imported = recent.filter((t) => t.expense_id);
  const skipped = recent.filter((t) => !t.expense_id && !t.pending && Number(t.amount) > 0);
  const moneyOut = sum(imported.map((t) => toCents(t.amount)));

  async function connect(itemId?: string) {
    setBusy("link");
    try {
      const [{ linkToken }, Plaid] = await Promise.all([
        callPlaid<{ linkToken: string }>("plaid-link-token", itemId ? { itemId } : {}),
        loadPlaidLink(),
      ]);
      const handler = Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          try {
            await callPlaid("plaid-exchange", { publicToken, institution: { id: metadata.institution?.institution_id, name: metadata.institution?.name } });
            toast.push("Bank connected. Pulling transactions…");
            await sync();
          } catch (e) { toast.push((e as Error).message, "err"); }
          finally { handler.destroy(); }
        },
        onExit: (err) => {
          if (err?.display_message || err?.error_message) toast.push(err.display_message || err.error_message || "", "err");
          handler.destroy();
        },
      });
      handler.open();
    } catch (e) { toast.push((e as Error).message, "err"); }
    finally { setBusy(""); }
  }

  async function sync() {
    setBusy("sync");
    try {
      const r = await callPlaid<{ added: number; expenses: number; problems?: string[] }>("plaid-sync");
      qc.invalidateQueries();
      toast.push(r.problems?.length ? r.problems[0] : `${r.added} new transaction${r.added === 1 ? "" : "s"}, ${r.expenses} expense${r.expenses === 1 ? "" : "s"} created`, r.problems?.length ? "err" : "ok");
    } catch (e) { toast.push((e as Error).message, "err"); }
    finally { setBusy(""); }
  }

  return (
    <Section
      title="🏦 Bank feed"
      className="mb-5"
      right={connected.length > 0 ? (
        <div className="flex gap-2">
          <button className="btn-ghost btn-sm" onClick={() => setRulesOpen(true)}><Wand2 size={14} /> Rules</button>
          <button className="btn-ghost btn-sm" disabled={!!busy} onClick={sync}><RefreshCw size={14} className={busy === "sync" ? "animate-spin" : ""} /> {busy === "sync" ? "Syncing…" : "Sync now"}</button>
        </div>
      ) : undefined}
    >
      {accounts.isLoading ? <Skeleton rows={2} /> : connected.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <span className="rounded-full bg-teal-50 p-3 text-teal-800"><Landmark size={24} /></span>
          <p className="font-display text-lg font-semibold text-teal-900">No bank connected yet</p>
          <p className="max-w-md text-sm text-charcoal/60">
            Connect your Chase account and every payment leaving it becomes an expense here automatically.
            You log in to Chase through Plaid&apos;s own secure window — this dashboard never sees your banking password.
          </p>
          <button className="btn-gold btn-sm mt-1" disabled={!!busy} onClick={() => connect()}><Link2 size={16} /> {busy === "link" ? "Opening…" : "Connect bank"}</button>
        </div>
      ) : (
        <>
          {needsReauth && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-gold-100 px-4 py-2.5 text-sm">
              <AlertTriangle size={16} className="shrink-0 text-warning" />
              <span className="flex-1">Chase needs you to sign in again before new transactions can arrive.</span>
              <button className="btn-ghost btn-sm" onClick={() => connect(connected.find((a) => a.bank_items?.status === "needs_reauth")?.item_id)}>Reconnect</button>
            </div>
          )}
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            {connected.map((a) => (
              <div key={a.id} className={`rounded-lg border px-3 py-2 ${a.is_tracked ? "border-ivory-200 bg-white" : "border-ivory-200 bg-ivory-50 opacity-60"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{a.bank_items?.institution_name || "Bank"} ·· {a.mask}</span>
                  <button
                    className="text-charcoal/40 hover:text-teal-800"
                    title={a.is_tracked ? "Stop importing this account" : "Start importing this account"}
                    aria-label={a.is_tracked ? `Stop importing ${a.name}` : `Start importing ${a.name}`}
                    onClick={async () => { await supabase.from("bank_accounts").update({ is_tracked: !a.is_tracked }).eq("id", a.id); qc.invalidateQueries({ queryKey: ["bank_accounts"] }); }}
                  >{a.is_tracked ? <Eye size={14} /> : <EyeOff size={14} />}</button>
                </div>
                <div className="truncate text-xs text-charcoal/50">{a.name}{a.current_balance != null && ` · ${fmt(toCents(a.current_balance))}`}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-charcoal/60">
            <span><b className="text-charcoal">{imported.length}</b> imported as expenses · <b className="text-charcoal">{fmt(moneyOut)}</b></span>
            {skipped.length > 0 && <span><b className="text-charcoal">{skipped.length}</b> skipped by a rule</span>}
            <span>Last sync: {item?.last_synced_at ? fmtDate(item.last_synced_at) : "never"}</span>
            <button className="text-teal-700 hover:underline" onClick={() => connect()}><Plus size={11} className="inline" /> add another bank</button>
          </div>
          {item?.last_error && <p className="mt-2 text-xs text-negative">{item.last_error}</p>}
          <RecentList rows={recent.slice(0, 8)} />
        </>
      )}
      {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}
    </Section>
  );
}

function RecentList({ rows }: { rows: BankTransaction[] }) {
  if (!rows.length) return null;
  return (
    <ul className="mt-3 divide-y divide-ivory-200 border-t border-ivory-200 pt-1">
      {rows.map((t) => {
        const out = Number(t.amount) > 0;
        return (
          <li key={t.id} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="w-16 shrink-0 text-xs text-charcoal/50">{fmtDate(t.posted_on)}</span>
            <span className="min-w-0 flex-1 truncate">{t.merchant_name || t.name}</span>
            {t.pending && <span className="badge bg-ivory-200 text-charcoal/60">pending</span>}
            {!t.pending && !out && <span className="badge bg-teal-50 text-teal-800">money in</span>}
            {!t.pending && out && !t.expense_id && <span className="badge bg-ivory-200 text-charcoal/60">skipped</span>}
            {t.expense_id && <span className="badge bg-gold-100 text-charcoal/70">expense</span>}
            <span className={`w-20 shrink-0 text-right tabular-nums ${out ? "" : "text-positive"}`}>{out ? fmt(toCents(t.amount)) : "+" + fmt(toCents(-Number(t.amount)))}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RulesModal({ onClose }: { onClose: () => void }) {
  const rules = useBankRules();
  const cats = useExpenseCategories();
  const write = useWrite();
  const toast = useToast();
  const qc = useQueryClient();
  const [del, setDel] = useState<BankRule | null>(null);
  const [draft, setDraft] = useState({ match_text: "", vendor: "", category_id: "", cost_type: "operating" as BankRule["cost_type"], skip: false });

  const save = async (fn: () => Promise<unknown>, msg: string) => {
    try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); }
  };

  return (
    <Modal open onClose={onClose} title="Bank import rules" wide>
      <p className="mb-3 text-sm text-charcoal/70">
        The first rule whose text appears in the bank description wins. <b>Skip</b> means never create an
        expense — use it for transfers between your own accounts and credit-card payments, which are not costs.
      </p>
      <div className="mb-4 rounded-lg border border-ivory-200 bg-white p-3">
        <div className="grid gap-2 sm:grid-cols-5">
          <Field label="If description contains" className="sm:col-span-2 !mb-0"><input className="input" value={draft.match_text} onChange={(e) => setDraft({ ...draft, match_text: e.target.value })} placeholder="COSTCO" /></Field>
          <Field label="Show vendor as" className="!mb-0"><input className="input" value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} placeholder="Costco" /></Field>
          <Field label="Category" className="!mb-0"><select className="input" value={draft.category_id} onChange={(e) => { const c = cats.data?.find((x) => x.id === e.target.value); setDraft({ ...draft, category_id: e.target.value, cost_type: (c?.cost_type ?? "operating") as BankRule["cost_type"] }); }}><option value="">—</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Action" className="!mb-0"><select className="input" value={draft.skip ? "skip" : "import"} onChange={(e) => setDraft({ ...draft, skip: e.target.value === "skip" })}><option value="import">Import as expense</option><option value="skip">Skip</option></select></Field>
        </div>
        <div className="mt-2 flex justify-end">
          <button className="btn-gold btn-sm" disabled={!draft.match_text.trim() || write.isPending}
            onClick={async () => {
              await save(async () => unwrap(await supabase.from("bank_rules").insert({ ...draft, category_id: draft.category_id || null, sort_order: 60 }).select("id")), "Rule added");
              setDraft({ match_text: "", vendor: "", category_id: "", cost_type: "operating", skip: false });
            }}><Plus size={14} /> Add rule</button>
        </div>
      </div>

      {rules.isLoading ? <Skeleton rows={4} /> : (
        <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-ivory-200">
          <table className="table !min-w-0">
            <thead><tr><th>Contains</th><th>Vendor</th><th>Category</th><th>Action</th><th /></tr></thead>
            <tbody>
              {(rules.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.match_text}</td>
                  <td>{r.vendor || <span className="text-charcoal/40">from bank</span>}</td>
                  <td>{cats.data?.find((c) => c.id === r.category_id)?.name ?? <span className="text-charcoal/40">—</span>}</td>
                  <td>{r.skip ? <span className="badge bg-ivory-200 text-charcoal/60">skip</span> : <span className="badge bg-teal-50 text-teal-800">expense</span>}</td>
                  <td className="text-right"><button className="text-charcoal/40 hover:text-negative" aria-label={`Delete rule ${r.match_text}`} onClick={() => setDel(r)}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <button className="btn-ghost" disabled={write.isPending}
          onClick={() => save(async () => { await supabase.rpc("reapply_bank_rules"); qc.invalidateQueries(); }, "Rules re-applied to every transaction")}>
          <Wand2 size={16} /> Re-apply to all transactions
        </button>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </div>

      <ConfirmDialog open={!!del} title="Delete this rule?" body="Transactions it matched keep the expenses they already created until you re-apply the rules."
        danger confirmLabel="Delete" onCancel={() => setDel(null)}
        onConfirm={async () => { const r = del!; setDel(null); await save(async () => unwrap(await supabase.from("bank_rules").delete().eq("id", r.id)), "Rule deleted"); }} />
    </Modal>
  );
}
