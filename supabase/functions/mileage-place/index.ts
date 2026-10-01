// Supabase Edge Function: mileage-place
// ---------------------------------------------------------------------------
// Admin-only helper for the Mileage tab: given a store address, returns the
// approximate one-way road miles from the kitchen (same method as delivery
// quotes: straight line x 1.3). The owner can overwrite the number by hand.
// Kitchen coordinates stay in secrets, never in the repo.
// ---------------------------------------------------------------------------
import { cors, json, requireAdmin } from "../_shared/plaid.ts";
import { quoteDelivery } from "../_shared/delivery.ts";

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let b: { street?: string; city?: string; state?: string; zip?: string } = {};
  try { b = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, headers); }
  const s = (v?: string) => String(v ?? "").trim().slice(0, 120);
  if (!s(b.street) || !s(b.city)) return json({ ok: false, error: "enter the street and city" }, 400, headers);
  const q = await quoteDelivery(s(b.street), s(b.city), s(b.state) || "TX", s(b.zip));
  if (!q.ok) return json({ ok: false, error: q.error }, q.status, headers);
  return json({ ok: true, miles: q.miles }, 200, headers);
});
