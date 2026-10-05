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
import { checkPromo, markPromoUsed, normCode } from "../_shared/promo.ts";
import { normAddress } from "../_shared/address.ts";
import { parseChoices, resolveChoices, type ComboSlot } from "../_shared/combos.ts";

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
  promo?: unknown;
  visitor_id?: unknown;
  fulfillment?: unknown;
  customer?: { name?: unknown; phone?: unknown; street?: unknown; apt?: unknown; city?: unknown; state?: unknown; zip?: unknown; instructions?: unknown; requested_at?: unknown; email?: unknown };
  items?: Array<{ slug?: unknown; quantity?: unknown; options?: unknown; choices?: unknown }>;
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
  // Pickup is Monday to Friday only; Saturday and Sunday are delivery only.
  if (isPickup) {
    const wd = new Date(dayIn(KITCHEN_TZ, requestedDate) + "T12:00:00Z").getUTCDay();
    if (wd === 0 || wd === 6) return json({ ok: false, error: "Pickup is not available on Saturday or Sunday. Please choose delivery or a weekday." }, 400, headers);
  }

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    return json({ ok: false, error: "invalid items" }, 400, headers);
  }
  const items: Array<{ slug: string; quantity: number; options: string }> = [];
  const rawChoices: Array<unknown> = [];
  for (const it of body.items) {
    const slug = str(it?.slug, 80, true);
    const qty = typeof it?.quantity === "number" ? Math.floor(it.quantity) : NaN;
    const options = str(it?.options, 200);
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY || options == null) {
      return json({ ok: false, error: "invalid item" }, 400, headers);
    }
    items.push({ slug, quantity: qty, options });
    rawChoices.push(it?.choices);
  }

  // ---- extra koshary sauce is only an add-on: never more cups than koshary trays ----------------
  const qtyOf = (slug: string) => items.filter((i) => i.slug === slug).reduce((n, i) => n + i.quantity, 0);
  if (qtyOf("koshary-sauce") > qtyOf("koshary")) {
    return json({ ok: false, error: "Extra tomato sauce can only be ordered with a Koshary Tray" }, 400, headers);
  }

  // ---- service client (server-side only) ---------------------------------
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // ---- days the owner switched off in the Kitchen Calendar ---------------------------------
  const { data: closedRow, error: closedErr } = await supabase.from("closed_days").select("day").eq("day", dayIn(KITCHEN_TZ, requestedDate)).maybeSingle();
  if (closedErr) console.error("closed_days read failed", closedErr.message);
  if (closedRow) return json({ ok: false, error: "That day is fully booked. Please pick another date." }, 400, headers);

  // ---- combo choices: checked against combo_slots, then written as the readable options line --------
  const { data: slotRows, error: slotErr } = await supabase.from("combo_slots").select("*").in("combo_slug", [...new Set(items.map((i) => i.slug))]);
  if (slotErr) { console.error("combo_slots read failed", slotErr.message); return json({ ok: false, error: "could not check combo choices" }, 500, headers); }
  const slotsByCombo = new Map<string, ComboSlot[]>();
  for (const r of (slotRows ?? []) as ComboSlot[]) slotsByCombo.set(r.combo_slug, [...(slotsByCombo.get(r.combo_slug) ?? []), r]);
  if (slotsByCombo.size) {
    const wanted = [...new Set([...slotsByCombo.values()].flat().flatMap((s) => s.allowed))];
    const { data: prodNames } = await supabase.from("products").select("slug, name").in("slug", wanted);
    const names = new Map<string, string>((prodNames ?? []).map((p: { slug: string; name: string }) => [p.slug, p.name]));
    for (let i = 0; i < items.length; i++) {
      const slots = slotsByCombo.get(items[i].slug);
      if (!slots) continue;
      const parsed = parseChoices(rawChoices[i]);
      if (!parsed) return json({ ok: false, error: "invalid combo choices" }, 400, headers);
      const res = resolveChoices(slots, parsed, names);
      if (!res.ok) return json({ ok: false, error: res.error }, 400, headers);
      items[i].options = res.options;
    }
  }

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

  // ---- promo code (FIRSTBITE = free delivery, once per customer) ---------------
  let promoCode = "", promoEmail = "", feeWaived = 0, promoAddr = "", freeOrder = false, promoPercent = 0;
  if (normCode(body.promo)) {
    if (isPickup) return json({ ok: false, error: "promo codes apply to delivery orders" }, 400, headers);
    promoAddr = normAddress(street, apt, zip);
    const pc = await checkPromo(supabase, body.promo, phoneDigits, email, miles, promoAddr, items.map((i) => ({ slug: i.slug, quantity: i.quantity })));
    if (!pc.ok) return json({ ok: false, error: pc.error }, 400, headers);
    promoCode = pc.code; promoEmail = pc.email_norm; promoPercent = pc.percent ?? 0;
    feeWaived = promoPercent ? 0 : deliveryFee; if (!promoPercent) deliveryFee = 0; freeOrder = !!pc.free;
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
    p_customer: { name, phone, phone_digits: phoneDigits, street, apt, city, state, zip, instructions: promoCode ? `Promo ${promoCode} (${freeOrder ? "FREE ORDER" : promoPercent ? promoPercent + "% off dishes" : "free delivery"})${instructions ? " | " + instructions : ""}`.slice(0, 500) : instructions, requested_at: requestedAt },
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

  // A free-order promo needs no card: the order is confirmed straight away like a non-paid order.
  const payNow = payOnline && !freeOrder;
  // Percent-off code: the discount is that % of the dishes (delivery is charged as usual).
  let discount = 0;
  if (promoPercent) {
    const { data: sr } = await supabase.from("orders").select("subtotal").eq("order_number", data as string).maybeSingle();
    discount = Math.round(Number(sr?.subtotal ?? 0) * promoPercent) / 100;
  }
  const info: OrderInfo = { pickup: isPickup, name, phone, email, address: `${street}${apt ? ", " + apt : ""}, ${city}, ${state} ${zip}`, instructions, requestedAt, items, deliveryFee, miles, ...(discount ? { discount, promo: promoCode } : {}) };
  // Pay-online orders stay "pending" and silent until Stripe confirms payment (stripe-webhook
  // then confirms the order and sends the alert + receipt). Other orders are confirmed now.
  const { error: feeErr } = await supabase.from("orders").update({ delivery_fee: deliveryFee, delivery_miles: isPickup ? null : miles, customer_email: email, ...(promoCode ? { promo_code: promoCode } : {}), ...(discount ? { discount, discount_reason: `Promo ${promoCode} (${promoPercent}% off dishes)` } : {}), ...(isPickup ? { delivery_method: "pickup" } : {}), ...(payNow ? { notify_payload: info } : { status: "confirmed" }) }).eq("order_number", data as string);
  if (feeErr) console.error("delivery fee update failed", feeErr.message);
  if (promoCode) {
    const { data: po } = await supabase.from("orders").select("id").eq("order_number", data as string).maybeSingle();
    if (po?.id) {
      const { error: rErr } = await supabase.from("promo_redemptions").insert({ code: promoCode, order_id: po.id, phone_digits: phoneDigits, email_norm: promoEmail, address_norm: promoAddr, fee_waived: feeWaived, ...(freeOrder ? { used_at: new Date().toISOString() } : {}) });
      if (freeOrder && rErr) {
        // Someone else claimed the one-time code a moment ago: cancel this order, nothing is free.
        console.error("free order code already taken", rErr.message);
        await supabase.from("orders").update({ status: "cancelled", promo_code: null }).eq("id", po.id);
        return json({ ok: false, error: "That promo code was just used by someone else. Please remove it and place your order again." }, 409, headers);
      }
      if (rErr) console.error("promo redemption failed", rErr.message);
      else if (freeOrder) {
        const { data: so } = await supabase.from("orders").select("subtotal").eq("id", po.id).maybeSingle();
        const { error: dErr } = await supabase.from("orders").update({ discount: Number(so?.subtotal ?? 0), discount_reason: `Promo ${promoCode} (free order)`, payment_status: "paid", payment_method: "other" }).eq("id", po.id);
        if (dErr) console.error("free order discount failed", dErr.message);
      } else if (!payOnline) await markPromoUsed(supabase, po.id);
    }
  }
  // keep the email on the customer record too (only when it was empty)
  const { data: ordRow } = await supabase.from("orders").select("customer_id").eq("order_number", data as string).maybeSingle();
  if (ordRow?.customer_id) await supabase.from("customers").update({ email }).eq("id", ordRow.customer_id).eq("email", "");
  if (!payNow) {
    const notify = notifyAll(supabase, data as string, info);
    // keep the function alive until the alert is sent, without making the customer wait
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(notify); else await notify;
  }
  // Website Pulse: remember which visitor placed this order (anonymous id sent by the website).
  const visitor = str(body.visitor_id, 40);
  if (visitor && /^[A-Za-z0-9_-]{8,40}$/.test(visitor)) {
    const { error: vErr } = await supabase.from("site_events").insert({ visitor_id: visitor, kind: "order_placed", page: "order", detail: data as string, meta: { ...(freeOrder ? { free: "yes" } : {}), ...(promoCode ? { code: promoCode } : {}) } });
    if (vErr) console.error("site event failed", vErr.message);
  }
  return json({ ok: true, order_number: data as string, delivery_fee: deliveryFee, miles, ...(promoCode ? { promo: promoCode } : {}), ...(freeOrder ? { free: true } : {}), ...(discount ? { discount } : {}) }, 200, headers);
});

function json(payload: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(payload), { status, headers });
}
