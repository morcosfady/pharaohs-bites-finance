// Supabase Edge Function: plaid-sync
// ---------------------------------------------------------------------------
// Pulls new bank activity and turns money-out into expenses.
//
//  * /transactions/sync is cursor based, so each run only fetches what changed
//  * plaid_transaction_id is unique -> the same transaction can never import twice
//  * apply_bank_transaction() decides vendor, category and cost type from the
//    rules table, and skips deposits, pending rows and transfers
//  * safe to run as often as you like; runs on a schedule via pg_cron too
// ---------------------------------------------------------------------------
import { cors, json, plaid, requireAdmin, serviceClient } from "../_shared/plaid.ts";

interface Txn {
  transaction_id: string; account_id: string; date: string; name?: string;
  merchant_name?: string | null; amount: number; iso_currency_code?: string | null;
  pending?: boolean; pending_transaction_id?: string | null; payment_channel?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
}
interface SyncRes {
  added: Txn[]; modified: Txn[]; removed: { transaction_id: string }[];
  next_cursor: string; has_more: boolean;
}

const MAX_PAGES = 30; // guards against an unbounded first sync

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);

  // A scheduled run authenticates with a shared secret instead of a user JWT.
  const cronKey = Deno.env.get("SYNC_CRON_SECRET");
  const isCron = !!cronKey && req.headers.get("x-cron-secret") === cronKey;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth instanceof Response) return auth;
  }

  const db = serviceClient();
  const { data: items, error } = await db.from("bank_items").select("id, plaid_item_id, access_token, cursor").eq("status", "active");
  if (error) return json({ ok: false, error: error.message }, 500, headers);
  if (!items?.length) return json({ ok: true, items: 0, added: 0, expenses: 0 }, 200, headers);

  let totalAdded = 0, totalExpenses = 0, totalRemoved = 0;
  const problems: string[] = [];

  for (const item of items) {
    try {
      // account_id -> our uuid
      const { data: accs } = await db.from("bank_accounts").select("id, plaid_account_id").eq("item_id", item.id);
      const byPlaidId = new Map((accs ?? []).map((a) => [a.plaid_account_id, a.id]));

      let cursor: string | undefined = item.cursor ?? undefined;
      const touched: string[] = [];

      for (let page = 0; page < MAX_PAGES; page++) {
        const res: SyncRes = await plaid<SyncRes>("/transactions/sync", {
          access_token: item.access_token,
          ...(cursor ? { cursor } : {}),
          count: 500,
        });

        // A pending charge that posts arrives as a NEW id pointing at the old one.
        // Re-key the stored row so it stays ONE transaction (and one expense).
        for (const t of res.added) {
          if (t.pending_transaction_id) {
            await db.from("bank_transactions").update({ plaid_transaction_id: t.transaction_id })
              .eq("plaid_transaction_id", t.pending_transaction_id);
          }
        }

        const upserts = [...res.added, ...res.modified]
          .filter((t) => byPlaidId.has(t.account_id))
          .map((t) => ({
            account_id: byPlaidId.get(t.account_id)!,
            plaid_transaction_id: t.transaction_id,
            posted_on: t.date,
            name: t.name ?? "",
            merchant_name: t.merchant_name ?? "",
            amount: t.amount,
            iso_currency_code: t.iso_currency_code ?? "USD",
            pending: !!t.pending,
            pending_transaction_id: t.pending_transaction_id ?? null,
            plaid_category: t.personal_finance_category?.primary ?? "",
            payment_channel: t.payment_channel ?? "",
          }));

        if (upserts.length) {
          const { data: saved, error: upErr } = await db.from("bank_transactions")
            .upsert(upserts, { onConflict: "plaid_transaction_id" }).select("id");
          if (upErr) throw new Error(upErr.message);
          totalAdded += res.added.length;
          for (const s of saved ?? []) touched.push(s.id);
        }

        if (res.removed.length) {
          // Archives bank-owned expenses, un-links adopted manual ones, drops the evidence.
          const ids = res.removed.map((r) => r.transaction_id);
          const { error: rmErr } = await db.rpc("remove_bank_transactions", { p_plaid_ids: ids });
          if (rmErr) throw new Error(rmErr.message);
          totalRemoved += ids.length;
        }

        cursor = res.next_cursor;
        if (!res.has_more) break;
      }

      // Turn each touched transaction into (or out of) an expense.
      for (const id of touched) {
        const { data: expenseId, error: applyErr } = await db.rpc("apply_bank_transaction", { p_txn_id: id });
        if (applyErr) { problems.push(`apply ${id}: ${applyErr.message}`); continue; } // one bad row never blocks the rest
        if (expenseId) totalExpenses += 1;
      }

      await db.from("bank_items").update({ cursor, last_synced_at: new Date().toISOString(), last_error: "", status: "active" }).eq("id", item.id);
    } catch (e) {
      const msg = (e as Error).message;
      const needsReauth = /ITEM_LOGIN_REQUIRED|INVALID_ACCESS_TOKEN|ITEM_NOT_FOUND/.test(msg);
      await db.from("bank_items").update({ last_error: msg.slice(0, 500), status: needsReauth ? "needs_reauth" : "active" }).eq("id", item.id);
      problems.push(msg);
    }
  }

  return json({
    ok: problems.length === 0, items: items.length,
    added: totalAdded, removed: totalRemoved, expenses: totalExpenses,
    ...(problems.length ? { problems } : {}),
  }, problems.length ? 207 : 200, headers);
});
