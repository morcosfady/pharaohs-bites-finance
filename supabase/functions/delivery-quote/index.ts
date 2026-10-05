// Supabase Edge Function: delivery-quote
// ---------------------------------------------------------------------------
// The website asks "how much is delivery to this address?" before the customer
// pays. Same formula as create-order ($5 + $1.75 per mile). Read-only: it saves
// nothing and returns only the fee and the distance.
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import { quoteDelivery } from "../_shared/delivery.ts";
import { checkPromo, normCode } from "../_shared/promo.ts";
import { normAddress } from "../_shared/address.ts";

const ALLOWED_ORIGINS = [
  "https://morcosfady.github.io",
  "https://pharaohsbites.com",
  "https://www.pharaohsbites.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5173",
];

function corsHeaders(origin: string | null) {
  const ok = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}
const json = (p: unknown, status: number, h: Record<string, string>) => new Response(JSON.stringify(p), { status, headers: h });
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405, headers);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: "origin not allowed" }, 403, headers);

  let body: { street?: unknown; city?: unknown; state?: unknown; zip?: unknown; promo?: unknown; apt?: unknown; phone?: unknown; email?: unknown; items?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400, headers); }
  const street = clean(body.street, 200), city = clean(body.city, 80), state = clean(body.state, 2).toUpperCase(), zip = clean(body.zip, 10);
  if (!street || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}(-\d{4})?$/.test(zip)) return json({ ok: false, error: "incomplete address" }, 400, headers);

  const quoteItems = Array.isArray(body.items)
    ? (body.items as Array<{ slug?: unknown; quantity?: unknown }>).slice(0, 60).filter((i) => typeof i?.slug === "string" && Number.isInteger(i?.quantity)).map((i) => ({ slug: String(i.slug), quantity: Number(i.quantity) }))
    : undefined;
  const q = await quoteDelivery(street, city, state, zip);
  if (!q.ok) return json({ ok: false, error: q.error }, q.status, headers);
  // Promo check (read-only): is this code valid and unused for this phone / email?
  let promo: { valid: boolean; code?: string; message?: string; free?: boolean; percent?: number } | undefined;
  if (normCode(body.promo)) {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const r = await checkPromo(supabase, body.promo, clean(body.phone, 40).replace(/\D/g, ""), clean(body.email, 120), q.miles, normAddress(street, clean(body.apt, 60), zip), quoteItems);
    promo = r.ok ? { valid: true, code: r.code, message: r.message, free: !!r.free, ...(r.percent ? { percent: r.percent } : {}) } : { valid: false, message: r.error };
  }
  return json({ ok: true, delivery_fee: q.fee, miles: q.miles, ...(promo ? { promo } : {}) }, 200, headers);
});
