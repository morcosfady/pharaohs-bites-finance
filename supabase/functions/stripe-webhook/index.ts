// Supabase Edge Function: stripe-webhook
// ---------------------------------------------------------------------------
// Stripe calls this when a Checkout payment succeeds. It verifies the Stripe
// signature, then records the payment on the order (method "card"). Retries
// are harmless: payments.reference is unique for stripe:* rows.
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_...).
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyAll } from "../_shared/notify.ts";

async function verify(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const t = header.split(",").find((p) => p.startsWith("t="))?.slice(2);
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s === hex);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (req.method !== "POST" || !secret) return new Response("not configured", { status: 400 });
  const raw = await req.text();
  if (!(await verify(raw, req.headers.get("stripe-signature"), secret))) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return new Response("ignored", { status: 200 });
  const s = event.data?.object;
  if (!s || s.payment_status !== "paid") return new Response("not paid", { status: 200 });
  const orderId = s.metadata?.order_id;
  if (!orderId) return new Response("no order", { status: 200 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { error } = await supabase.from("payments").insert({
    order_id: orderId,
    amount: (s.amount_total ?? 0) / 100,
    method: "card",
    reference: `stripe:${s.payment_intent ?? s.id}`,
    notes: "Paid online (Stripe Checkout)",
  });
  if (error && !error.message.includes("payments_stripe_ref_uniq")) {
    console.error("record payment failed", error.message);
    return new Response("error", { status: 500 }); // Stripe will retry
  }
  await supabase.from("orders").update({ payment_method: "card" }).eq("id", orderId);
  // First confirmation of this order: confirm it and send the owner alert + customer receipt.
  const { data: ord } = await supabase.from("orders").select("order_number, notify_payload").eq("id", orderId).maybeSingle();
  if (ord?.notify_payload) {
    await supabase.from("orders").update({ status: "confirmed", notify_payload: null }).eq("id", orderId);
    await notifyAll(supabase, ord.order_number, ord.notify_payload);
  }
  return new Response("ok", { status: 200 });
});
