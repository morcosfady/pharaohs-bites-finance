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

// ---- delivery fee: $5 + $1.75 per mile from the kitchen ---------------------
// Miles = straight-line distance x 1.3 (approximate road distance). Address is
// looked up with the free US Census geocoder. Kitchen coordinates live in the
// KITCHEN_LAT / KITCHEN_LON secrets so the address is not in the public repo.
const FEE_BASE = 5;
const FEE_PER_MILE = 1.75;
const ROAD_FACTOR = 1.3;
async function geocode(address: string): Promise<{ lat: number; lon: number } | null | "error"> {
  try {
    const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(address);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "error";
    const m = (await res.json())?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lon: m.coordinates.x } : null;
  } catch { return "error"; }
}
function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => d * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// ---- notifications -------------------------------------------------------------
// Owner: free push notification through ntfy.sh (topic kept in NTFY_TOPIC).
// Customer: a styled receipt email through the business Gmail relay (Apps
// Script; RECEIPT_URL + RECEIPT_TOKEN, never exposed to the browser).
// Failures here never block the order.
type OrderInfo = { name: string; phone: string; email: string; address: string; instructions: string; requestedAt: string; items: Array<{ slug: string; quantity: number; options: string }>; deliveryFee: number; miles: number };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function receiptHtml(orderNumber: string, info: OrderInfo, lines: Array<{ qty: number; name: string; options: string }>, subtotal: number, total: number): string {
  const rows = lines.map((l) => `<tr><td style="padding:8px 0;color:#f3e9d2;border-bottom:1px solid #3a3226">${l.qty} &times; ${esc(l.name)}${l.options ? `<br><span style="color:#b9a880;font-size:12px">${esc(l.options)}</span>` : ""}</td></tr>`).join("");
  const when = new Date(info.requestedAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const win = /Delivery window: ([^|]+?) on /.exec(info.instructions)?.[1] ?? "";
  const money = (n: number) => "$" + n.toFixed(2);
  return `<!doctype html><html><body style="margin:0;background:#14110c;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14110c"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1e1a13;border:1px solid #c9a24a;border-radius:14px;overflow:hidden">
<tr><td align="center" style="padding:28px 20px 8px;color:#c9a24a;font-size:34px">&#9765;</td></tr>
<tr><td align="center" style="color:#c9a24a;font-size:26px;letter-spacing:1px;padding:0 20px">Pharaoh&rsquo;s Bites</td></tr>
<tr><td align="center" style="color:#b9a880;font-size:13px;letter-spacing:3px;padding:4px 20px 22px">EGYPTIAN CLOUD KITCHEN &middot; DALLAS</td></tr>
<tr><td style="padding:0 28px"><div style="height:1px;background:#c9a24a;opacity:.6"></div></td></tr>
<tr><td style="padding:22px 28px 6px;color:#f3e9d2;font-size:18px">Thank you, ${esc(info.name.split(" ")[0])}!</td></tr>
<tr><td style="padding:0 28px 18px;color:#d8ccb0;font-size:15px;line-height:1.6">We received your order and we are getting ready to cook. Here is your receipt.</td></tr>
<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14110c;border:1px solid #3a3226;border-radius:10px"><tr><td style="padding:14px 16px;color:#b9a880;font-size:12px;letter-spacing:2px">ORDER NUMBER<br><span style="color:#c9a24a;font-size:22px;letter-spacing:1px">${esc(orderNumber)}</span></td></tr></table></td></tr>
<tr><td style="padding:20px 28px 4px;color:#c9a24a;font-size:12px;letter-spacing:2px">YOUR ORDER</td></tr>
<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
<tr><td style="padding:14px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="color:#d8ccb0;font-size:14px">
<tr><td style="padding:3px 0">Dishes</td><td align="right">${money(subtotal)}</td></tr>
<tr><td style="padding:3px 0">Delivery (${info.miles} mi)</td><td align="right">${money(info.deliveryFee)}</td></tr>
<tr><td style="padding:10px 0 0;color:#c9a24a;font-size:17px;border-top:1px solid #3a3226">Total</td><td align="right" style="padding:10px 0 0;color:#c9a24a;font-size:17px;border-top:1px solid #3a3226"><b>${money(total)}</b></td></tr></table></td></tr>
<tr><td style="padding:22px 28px 4px;color:#c9a24a;font-size:12px;letter-spacing:2px">DELIVERY</td></tr>
<tr><td style="padding:0 28px 22px;color:#f3e9d2;font-size:15px;line-height:1.6">${esc(when)}${win ? " &middot; " + esc(win) : ""}<br><span style="color:#b9a880">${esc(info.address)}</span></td></tr>
<tr><td style="padding:0 28px"><div style="height:1px;background:#c9a24a;opacity:.6"></div></td></tr>
<tr><td align="center" style="padding:20px 28px 26px;color:#b9a880;font-size:13px;line-height:1.7">Questions? Message us on WhatsApp <a href="https://wa.me/17879684078" style="color:#c9a24a;text-decoration:none">+1 (787) 968-4078</a><br>pharaohsbites.com</td></tr>
</table></td></tr></table></body></html>`;
}

async function notifyAll(supabase: ReturnType<typeof createClient>, orderNumber: string, info: OrderInfo) {
  try {
    const { data: prods } = await supabase.from("products").select("slug, name").in("slug", info.items.map((i) => i.slug));
    const names = new Map((prods ?? []).map((p: { slug: string; name: string }) => [p.slug, p.name]));
    const { data: fin } = await supabase.from("order_financials").select("total, net_product_sales").eq("order_number", orderNumber).maybeSingle();
    const total = Number(fin?.total ?? 0), subtotal = Number(fin?.net_product_sales ?? 0);
    const lines = info.items.map((i) => ({ qty: i.quantity, name: names.get(i.slug) ?? i.slug, options: i.options }));

    const topic = Deno.env.get("NTFY_TOPIC");
    if (topic) {
      const when = new Date(info.requestedAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Chicago" });
      const win = /Delivery window: ([^|]+?) on /.exec(info.instructions)?.[1] ?? "";
      const note = info.instructions.replace(/^Delivery window: [^|]+\|?\s*/, "").trim();
      const text = `${info.name} ${info.phone}\n${info.email}\n${lines.map((l) => `${l.qty} x ${l.name}`).join(", ")}\n$${total.toFixed(2)} (delivery $${info.deliveryFee.toFixed(2)})\nDeliver: ${when}${win ? " " + win : ""}\n${info.address}${note ? "\nNote: " + note : ""}`;
      await fetch(`https://ntfy.sh/${topic}`, {
        method: "POST",
        headers: { Title: `New order ${orderNumber}`, Priority: "high", Tags: "bell", Click: "https://finance.pharaohsbites.com/#/orders" },
        body: text,
        signal: AbortSignal.timeout(10000),
      }).catch((e) => console.error("ntfy failed", String(e)));
    }

    const rUrl = Deno.env.get("RECEIPT_URL"), rToken = Deno.env.get("RECEIPT_TOKEN");
    if (rUrl && rToken && info.email) {
      await fetch(rUrl, {
        method: "POST",
        body: JSON.stringify({ token: rToken, kind: "receipt", to: info.email, subject: `Your Pharaoh's Bites order ${orderNumber}`, html: receiptHtml(orderNumber, info, lines, subtotal, total) }),
        signal: AbortSignal.timeout(20000),
      }).catch((e) => console.error("receipt failed", String(e)));
    }
  } catch (e) { console.error("notify failed", String(e)); }
}
const RATE_LIMIT_WINDOW_MIN = 10;
const RATE_LIMIT_MAX = 8;
const MAX_ITEMS = 40;
const MAX_QTY = 50;

type Body = {
  checkout_token?: unknown;
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
  const token = str(body.checkout_token, 80, true);
  if (!token || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) return json({ ok: false, error: "invalid checkout token" }, 400, headers);

  const c = body.customer ?? {};
  const name = str(c.name, 120, true);
  const phone = str(c.phone, 40, true);
  const street = str(c.street, 200, true);
  const apt = str(c.apt, 60);
  const city = str(c.city, 80, true);
  const state = str(c.state, 2, true)?.toUpperCase() ?? null;
  const zip = str(c.zip, 10, true);
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

  // ---- delivery fee (before we save anything) ---------------------------------
  const kLat = Number(Deno.env.get("KITCHEN_LAT")), kLon = Number(Deno.env.get("KITCHEN_LON"));
  if (!isFinite(kLat) || !isFinite(kLon) || !kLat || !kLon) return json({ ok: false, error: "delivery pricing is not configured" }, 503, headers);
  const where = await geocode(`${street}, ${city}, ${state} ${zip}`);
  if (where === "error") return json({ ok: false, error: "could not check the delivery address, please try again" }, 503, headers);
  if (!where) return json({ ok: false, error: "we could not find that address, please check the street, city and ZIP" }, 400, headers);
  const miles = Math.round(haversineMiles({ lat: kLat, lon: kLon }, where) * ROAD_FACTOR * 10) / 10;
  const deliveryFee = Math.round((FEE_BASE + FEE_PER_MILE * miles) * 100) / 100;

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

  const { error: feeErr } = await supabase.from("orders").update({ delivery_fee: deliveryFee }).eq("order_number", data as string);
  if (feeErr) console.error("delivery fee update failed", feeErr.message);
  const notify = notifyAll(supabase, data as string, { name, phone, email, address: `${street}${apt ? ", " + apt : ""}, ${city}, ${state} ${zip}`, instructions, requestedAt, items, deliveryFee, miles });
  // keep the function alive until the email is sent, without making the customer wait
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(notify); else await notify;
  return json({ ok: true, order_number: data as string, delivery_fee: deliveryFee, miles }, 200, headers);
});

function json(payload: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(payload), { status, headers });
}
