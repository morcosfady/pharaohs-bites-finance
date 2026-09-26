// Supabase Edge Function: plaid-exchange
// ---------------------------------------------------------------------------
// Runs once per bank connection. Swaps the browser's short-lived public_token
// for a long-lived access_token, stores it where only the service role can
// read it, records the accounts, then hands off to plaid-sync for the first
// pull of transactions.
// ---------------------------------------------------------------------------
import { cors, json, plaid, requireAdmin, serviceClient } from "../_shared/plaid.ts";

interface PlaidAccount {
  account_id: string; name?: string; official_name?: string | null; mask?: string | null;
  type?: string; subtype?: string | null;
  balances?: { current?: number | null; available?: number | null };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);

  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: { publicToken?: string; institution?: { id?: string; name?: string } } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const publicToken = typeof body.publicToken === "string" ? body.publicToken : "";
  if (!publicToken || publicToken.length > 200) return json({ ok: false, error: "missing public token" }, 400, headers);

  const db = serviceClient();
  try {
    const ex = await plaid<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
    const accountsRes = await plaid<{ accounts: PlaidAccount[]; item?: { institution_id?: string } }>("/accounts/get", { access_token: ex.access_token });

    const { data: item, error: itemErr } = await db.from("bank_items").upsert({
      plaid_item_id: ex.item_id,
      access_token: ex.access_token,
      institution_id: body.institution?.id ?? accountsRes.item?.institution_id ?? "",
      institution_name: body.institution?.name ?? "",
      status: "active",
      last_error: "",
    }, { onConflict: "plaid_item_id" }).select("id").single();
    if (itemErr) throw new Error(itemErr.message);

    // Only depository accounts can produce expenses; credit cards do too, but
    // loans and investments are stored untracked so nothing unexpected imports.
    const rows = accountsRes.accounts.map((a) => ({
      item_id: item.id,
      plaid_account_id: a.account_id,
      name: a.name ?? "",
      official_name: a.official_name ?? "",
      mask: a.mask ?? "",
      type: a.type ?? "",
      subtype: a.subtype ?? "",
      current_balance: a.balances?.current ?? null,
      available_balance: a.balances?.available ?? null,
      is_tracked: a.type === "depository" || a.type === "credit",
    }));
    const { error: accErr } = await db.from("bank_accounts").upsert(rows, { onConflict: "plaid_account_id" });
    if (accErr) throw new Error(accErr.message);

    return json({ ok: true, itemId: item.id, accounts: rows.length }, 200, headers);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 502, headers);
  }
});
