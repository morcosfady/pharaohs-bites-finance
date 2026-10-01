// Supabase Edge Function: create-order
// ---------------------------------------------------------------------------
// Public intake endpoint used by the customer website before it opens
// WhatsApp. It is the ONLY way the website writes to the database.
//
//  * validates shape, types and lengths of every field
//  * re-prices every line from the products table (browser totals ignored)
//  * rejects unknown / inactive products
//  * idempotent on checkout_token (double-click / refresh safe)
//  * basic per-IP rate limiting
//  * CORS restricted to approved origins
//  * writes order + items in ONE transaction (SQL function below)
//  * returns only { ok, order_number }
//
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the
// Supabase runtime. They never appear in this repository or the browser.
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyAll, type OrderInfo } from "../_shared/notify.ts";
import { quoteDelivery } from "../_shared/delivery.ts";

const ALLOWED_ORIGINS = [
  "https://morcosfady.github.io",
  "https://pharaohsbites.com",
  "https://www.pharaohsbites.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5173",
];
// Delivery must be for tomorrow or later in the kitchen's time zone. The website
// enforces the same rule in the customer's browser; this makes it impossible to
// bypass. Customers in far-away time zones get a 12 hour grace so a legitimate
// "tomorrow morning" is never refused.
const KITCHEN_TZ = "America/Chicago";
function dayIn(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function deliveryDateProblem(requested: Date, now: Date = new Date()): string | null {
  if (requested.getTime() > now.getTime() + 400 * 24 * 3600 * 1000) return "requested date is too far ahead";
  const laterDay = dayIn(KITCHEN_TZ, requested) > dayIn(KITCHEN_TZ, now);
  const farEnough = requested.getTime() - now.getTime() >= 12 * 3600 * 1000;
  return laterDay || farEnough ? null : "delivery must be tomorrow or later";
}

const RATE_LIMIT_WINDOW_MIN = 10;
const RATE_LIMIT_MAX = 8;
const MAX_ITEMS = 40;
const MAX_QTY = 50;

type Body = {
  checkout_token?: unknown;
  pay_online?: unknown;
  fulfillment?: unknown;
  customer?: { name?: unknown; phone?: unknown; street?: unknown; apt?: unknown; city?: unknown; state?: unknown; zip?: unknown; instructions?: unknown; requested_at?: unknown; email?: unknown };
  items?: Array<{ slug?: unknown; quantity?: unknown; options?: unknown }>;
};

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

function str(v: unknown, max: number, required = false): string | null {
  if (v == null) return required ? null : "";
  if (typeof v !== "string") return null;
  // strip control chars, collapse whitespace, cap length
  const s = v.replace(/[\x00-]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  if (required && !s) return null;
  return s;
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405, headers });
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ ok: false, error: "origin not allowed" }), { status: 403, headers });
  }

  let body: Body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400, headers); }

  // ---- validate ----------------------------------------------------------
  const payOnline = body.pay_online === true;
  const isPickup = body.fulfillment === "pickup";
  const token = str(body.checkout_token, 80, true);
  if (!token || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) return json({ ok: false, error: "invalid checkout token" }, 400, headers);

  const c = body.customer ?? {};
  const name = str(c.name, 120, true);
  const phone = str(c.phone, 40, true);
  // Pickup orders carry no address (placeholders keep the database columns filled).
  const street = isPickup ? "Pickup order" : str(c.street, 200, true);
  const apt = isPickup ? "" : str(c.apt, 60);
  const city = isPickup ? "Pickup" : str(c.city, 80, true);
  const state = isPickup ? "TX" : (str(c.state, 2, true)?.toUpperCase() ?? null);
  const zip = isPickup ? "00000" : str(c.zip, 10, true);
  const instructions = str(c.instructions, 500);
  const requestedRaw = str(c.requested_at, 40);
  const emailRaw = str(c.email, 120);
  const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw) ? emailRaw : "";
  if (!email) return json({ ok: false, error: "a valid email is required" }, 400, headers);
  if (!name || !phone || !street || apt == null || !city || !state || !zip || instructions == null || requestedRaw == null) {
    return json({ ok: false, error: "missing or invalid customer fields" }, 400, headers);
  }
  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 15) return json({ ok: false, error: "invalid phone" }, 400, headers);
  if (!/^[A-Z]{2}$/.test(state)) return json({ ok: false, error: "invalid state" }, 400, headers);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return json({ ok: false, error: "invalid zip" }, 400, headers);
  if (!requestedRaw) return json({ ok: false, error: "choose a delivery date and time window" }, 400, headers);
  const requestedDate = new Date(requestedRaw);
  if (isNaN(requestedDate.getTime())) return json({ ok: false, error: "invalid requested date" }, 400, headers);
  const dateProblem = deliveryDateProblem(requestedDate);
  if (dateProblem) return json({ ok: false, error: dateProblem }, 400, headers);
  const requestedAt: string = requestedDate.toISOString();

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    return json({ ok: false, error: "invalid items" }, 400, headers);
  }
  const items: Array<{ slug: string; quantity: number; options: string }> = [];
  for (const it of body.items) {
    const slug = str(it?.slug, 80, true);
    const qty = typeof it?.quantity === "number" ? Math.floor(it.quantity) : NaN;
    const options = str(it?.options, 200);
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY || options == null) {
      return json({ ok: false, error: "invalid item" }, 400, headers);
    }
    items.push({ slug, quantity: qty, options });
  }

  // ---- service client (server-side only) ---------------------------------
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // ---- idempotency: same token => same order ------------------------------
  const { data: existing } = await supabase.from("orders").select("order_number, delivery_fee").eq("checkout_token", token).maybeSingle();
  if (existing) return json({ ok: true, order_number: existing.order_number, delivery_fee: Number(existing.delivery_fee), duplicate: true }, 200, headers);

  // ---- delivery fee (before we save anything); pickup is free ----------------
  let miles = 0, deliveryFee = 0;
  if (!isPickup) {
    const q = await quoteDelivery(street, city, state, zip);
    if (!q.ok) return json({ ok: false, error: q.error }, q.status, headers);
    miles = q.miles; deliveryFee = q.fee;
  }

  // ---- rate limit per IP -------------------------------------------------
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const ipHash = await sha256(ip + "|pharaohs-bites");
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60_000).toISOString();
  const { count } = await supabase.from("order_intake_log").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT_MAX) return json({ ok: false, error: "too many orders, please try again later" }, 429, headers);
  await supabase.from("order_intake_log").insert({ ip_hash: ipHash });

  // ---- create atomically via SQL function ---------------------------------
  const { data, error } = await supabase.rpc("intake_website_order", {
    p_token: token,
    p_customer: { name, phone, phone_digits: phoneDigits, street, apt, city, state, zip, instructions, requested_at: requestedAt },
    p_items: items,
  });

  if (error) {
    const msg = error.message || "";
    if (msg.includes("PRODUCT_NOT_FOUND")) return json({ ok: false, error: "one of the products is no longer available" }, 400, headers);
    if (msg.includes("duplicate key") && msg.includes("checkout_token")) {
      const { data: again } = await supabase.from("orders").select("order_number").eq("checkout_token", token).maybeSingle();
      if (again) return json({ ok: true, order_number: again.order_number, duplicate: true }, 200, headers);
    }
    console.error("intake failed", msg);
    return json({ ok: false, error: "could not save order" }, 500, headers);
  }

  const info: OrderInfo = { pickup: isPickup, name, phone, email, address: `${street}${apt ? ", " + apt : ""}, ${city}, ${state} ${zip}`, instructions, requestedAt, items, deliveryFee, miles };
  // Pay-online orders stay "pending" and silent until Stripe confirms payment (stripe-webhook
  // then confirms the order and sends the alert + receipt). Other orders are confirmed now.
  const { error: feeErr } = await supabase.from("orders").update({ delivery_fee: deliveryFee, delivery_miles: isPickup ? null : miles, customer_email: email, ...(isPickup ? { delivery_method: "pickup" } : {}), ...(payOnline ? { notify_payload: info } : { status: "confirmed" }) }).eq("order_number", data as string);
  if (feeErr) console.error("delivery fee update failed", feeErr.message);
  // keep the email on the customer record too (only when it was empty)
  const { data: ordRow } = await supabase.from("orders").select("customer_id").eq("order_number", data as string).maybeSingle();
  if (ordRow?.customer_id) await supabase.from("customers").update({ email }).eq("id", ordRow.customer_id).eq("email", "");
  if (!payOnline) {
    const notify = notifyAll(supabase, data as string, info);
    // keep the function alive until the alert is sent, without making the customer wait
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(notify); else await notify;
  }
  return json({ ok: true, order_number: data as string, delivery_fee: deliveryFee, miles }, 200, headers);
});

function json(payload: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(payload), { status, headers });
}
