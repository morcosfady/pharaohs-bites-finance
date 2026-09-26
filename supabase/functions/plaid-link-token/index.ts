// Supabase Edge Function: plaid-link-token
// ---------------------------------------------------------------------------
// Creates the short-lived link_token that Plaid Link needs in the browser.
// Admin-only. Pass { itemId } to re-authenticate an existing connection
// instead of adding a new one (Plaid calls this update mode).
// ---------------------------------------------------------------------------
import { cors, json, plaid, requireAdmin, serviceClient } from "../_shared/plaid.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);

  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: { itemId?: string } = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  try {
    const payload: Record<string, unknown> = {
      user: { client_user_id: auth.userId },
      client_name: "Pharaoh's Bites Finance",
      country_codes: ["US"],
      language: "en",
    };
    const redirect = Deno.env.get("PLAID_REDIRECT_URI");
    if (redirect) payload.redirect_uri = redirect;

    if (body.itemId) {
      // update mode: repair a connection that needs the bank login again
      const db = serviceClient();
      const { data: item } = await db.from("bank_items").select("access_token").eq("id", body.itemId).single();
      if (!item) return json({ ok: false, error: "unknown connection" }, 404, headers);
      payload.access_token = item.access_token;
    } else {
      payload.products = ["transactions"];
    }

    const res = await plaid<{ link_token: string; expiration: string }>("/link/token/create", payload);
    return json({ ok: true, linkToken: res.link_token, expiration: res.expiration }, 200, headers);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 502, headers);
  }
});
