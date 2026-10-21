// Supabase Edge Function: delivery-quote
// ---------------------------------------------------------------------------
// The website asks "what will this order cost?" before the customer pays. Same zone table,
// tax formula and tip rules as create-order (shared modules), so the page shows the exact
// numbers the customer will be charged. Read-only: it saves nothing.
//   { action: "config" }                       -> delivery zones, tax rate, tip options (no address needed)
//   { street, city, state, zip, items, tip, promo, ... } -> fee, miles, zone, promo check, full pricing
//   { fulfillment: "pickup", items, tip }      -> pricing only (no address lookup, delivery 0)
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import { quoteDelivery, publicDeliveryConfig } from "../_shared/delivery.ts";
import { checkPromo, normCode } from "../_shared/promo.ts";
import { normAddress } from "../_shared/address.ts";
import { loadTaxSettings, priceBasket, pricingPayload, publicTaxConfig } from "../_shared/pricing.ts";
import { TIP_MAX_CENTS, TIP_PERCENTS } from "../_shared/tip.ts";

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

  let body: { action?: unknown; fulfillment?: unknown; street?: unknown; city?: unknown; state?: unknown; zip?: unknown; promo?: unknown; apt?: unknown; phone?: unknown; email?: unknown; items?: unknown; tip?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400, headers); }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // The one copy of the zone table, the tax rate and the tip options the website is allowed to show.
  const config = async () => ({ ...publicDeliveryConfig(), ...publicTaxConfig(await loadTaxSettings(supabase)), tip_percents: [...TIP_PERCENTS], tip_max_cents: TIP_MAX_CENTS });
  if (body.action === "config") return json({ ok: true, ...(await config()) }, 200, headers);

  const quoteItems = Array.isArray(body.items)
    ? (body.items as Array<{ slug?: unknown; quantity?: unknown }>).slice(0, 60).filter((i) => typeof i?.slug === "string" && /^[a-z0-9-]{1,80}$/.test(i.slug as string) && Number.isInteger(i?.quantity) && (i.quantity as number) > 0 && (i.quantity as number) <= 50).map((i) => ({ slug: String(i.slug), quantity: Number(i.quantity) }))
    : [];
  const isPickup = body.fulfillment === "pickup";

  // ---- pickup: tax and tip estimate only --------------------------------------------------------
  if (isPickup) {
    if (!quoteItems.length) return json({ ok: true, delivery_fee: 0, miles: 0 }, 200, headers);
    const p = await priceBasket(supabase, { items: quoteItems, isDelivery: false, deliveryCents: 0, tip: body.tip as never });
    if (!p.ok) return json({ ok: false, error: p.error }, p.status, headers);
    return json({ ok: true, delivery_fee: 0, miles: 0, pricing: pricingPayload(p) }, 200, headers);
  }

  // ---- delivery: address -> zone fee, then promo, then the full pricing ----------------------------
  const street = clean(body.street, 200), city = clean(body.city, 80), state = clean(body.state, 2).toUpperCase(), zip = clean(body.zip, 10);
  if (!street || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}(-\d{4})?$/.test(zip)) return json({ ok: false, error: "incomplete address" }, 400, headers);
  const q = await quoteDelivery(street, city, state, zip);
  if (!q.ok) return json({ ok: false, error: q.error }, q.status, headers);

  // Promo check (read-only): is this code valid and unused for this phone / email / address?
  let promo: { valid: boolean; code?: string; message?: string; free?: boolean; percent?: number; flat?: number } | undefined;
  let deliveryCents = q.feeCents;
  if (normCode(body.promo)) {
    const r = await checkPromo(supabase, body.promo, clean(body.phone, 40).replace(/\D/g, ""), clean(body.email, 120), q.miles, normAddress(street, clean(body.apt, 60), zip), quoteItems.length ? quoteItems : undefined);
    promo = r.ok ? { valid: true, code: r.code, message: r.message, free: !!r.free, ...(r.percent ? { percent: r.percent } : {}), ...(typeof r.flat === "number" ? { flat: r.flat } : {}) } : { valid: false, message: r.error };
    if (r.ok) {
      // same effect on the fee as create-order: free order / free delivery -> 0, flat -> min(fee, flat), percent -> fee unchanged
      if (typeof r.flat === "number") deliveryCents = Math.min(q.feeCents, Math.round(r.flat * 100));
      else if (!r.percent) deliveryCents = 0;
    }
  }
  const out: Record<string, unknown> = { ok: true, delivery_fee: q.fee, miles: q.miles, zone: q.zone, delivery_cents: deliveryCents, ...(promo ? { promo } : {}) };
  if (quoteItems.length) {
    const p = await priceBasket(supabase, { items: quoteItems, isDelivery: true, deliveryCents, promo: promo?.valid ? { percent: promo.percent, free: promo.free } : undefined, tip: body.tip as never });
    if (!p.ok) return json({ ok: false, error: p.error }, p.status, headers);
    out.pricing = pricingPayload(p);
  }
  return json(out, 200, headers);
});
