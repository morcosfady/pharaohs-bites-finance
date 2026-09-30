// Supabase Edge Function: create-checkout
// ---------------------------------------------------------------------------
// Website calls this right after create-order. Two actions:
//  * create: builds a Stripe Checkout Session for the order's balance (amount
//    is read from the database, never from the browser) and returns its url.
//  * status: says whether the order has been paid (used on the return page).
// Both need order_number + the checkout_token that created the order.
// Secrets: STRIPE_SECRET_KEY (set with `supabase secrets set`).
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://morcosfady.github.io",
  "https://pharaohsbites.com",
  "https://www.pharaohsbites.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8123",
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

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405, headers);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: "origin not allowed" }, 403, headers);

  let body: { action?: string; order_number?: string; checkout_token?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400, headers); }
  const { action, order_number, checkout_token } = body;
  if (!order_number || !/^[A-Za-z0-9-]{3,40}$/.test(order_number) || !checkout_token || !/^[A-Za-z0-9_-]{16,80}$/.test(checkout_token)) {
    return json({ ok: false, error: "invalid request" }, 400, headers);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: order } = await supabase.from("orders").select("id, order_number, status").eq("order_number", order_number).eq("checkout_token", checkout_token).maybeSingle();
  if (!order) return json({ ok: false, error: "order not found" }, 404, headers);
  const { data: fin } = await supabase.from("order_financials").select("balance_due, amount_paid").eq("id", order.id).maybeSingle();
  const balanceCents = Math.round(Number(fin?.balance_due ?? 0) * 100);
  const paid = balanceCents <= 0 && Number(fin?.amount_paid ?? 0) > 0;

  if (action === "status") return json({ ok: true, paid }, 200, headers);
  if (action !== "create") return json({ ok: false, error: "invalid action" }, 400, headers);
  if (order.status === "cancelled") return json({ ok: false, error: "order cancelled" }, 400, headers);
  if (paid) return json({ ok: true, paid: true }, 200, headers);
  if (balanceCents < 50) return json({ ok: false, error: "amount too small for card payment" }, 400, headers);

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return json({ ok: false, error: "online payment is not configured" }, 503, headers);

  const back = `${origin}/order.html`;
  const desc = `Pharaoh's Bites order ${order.order_number}`;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(balanceCents),
    "line_items[0][price_data][product_data][name]": desc,
    client_reference_id: order.order_number,
    "metadata[order_number]": order.order_number,
    "metadata[order_id]": order.id,
    "payment_intent_data[metadata][order_number]": order.order_number,
    "payment_intent_data[description]": desc,
    success_url: `${back}?paid=1&order=${encodeURIComponent(order.order_number)}`,
    cancel_url: `${back}?cancelled=1&order=${encodeURIComponent(order.order_number)}`,
  });
  let res: Response;
  // deno-lint-ignore no-explicit-any
  let session: any;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.replace(/[^A-Za-z0-9_]/g, "")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `co_${order.order_number}_${balanceCents}_${Math.floor(Date.now() / 3_600_000)}`,
      },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    session = await res.json();
  } catch (e) {
    console.error("stripe call threw", String(e));
    return json({ ok: false, error: "could not reach the payment provider" }, 502, headers);
  }
  if (!res.ok || !session.url) {
    console.error("stripe session failed", JSON.stringify(session?.error ?? session));
    return json({ ok: false, error: "could not start payment" }, 502, headers);
  }
  await supabase.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);
  return json({ ok: true, url: session.url, amount: balanceCents / 100 }, 200, headers);
});
