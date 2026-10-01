// Records a paid Stripe Checkout Session on its order. Safe to call more than once for
// the same payment: payments.reference is unique for stripe:* rows and the owner alert
// + receipt go out only the first time.
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyAll } from "./notify.ts";

/** Stripe's processing fee for this payment as an expense (unique per payment, safe to repeat).
 *  Tries the exact fee from Stripe; falls back to the standard 2.9% + 30 cents estimate when the
 *  API key has no permission to read charges. An exact fee later replaces an estimate. */
// deno-lint-ignore no-explicit-any
async function recordFee(supabase: ReturnType<typeof createClient>, s: any, orderId: string) {
  try {
    const total = (s.amount_total ?? 0) / 100;
    const ref = String(s.payment_intent ?? s.id);
    let fee = 0, estimated = true;
    const k = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").replace(/[^A-Za-z0-9_]/g, "");
    if (k && s.payment_intent) {
      const r = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(String(s.payment_intent))}?expand[]=latest_charge.balance_transaction`,
        { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const pi = await r.json();
        const f = pi?.latest_charge?.balance_transaction?.fee;
        if (typeof f === "number" && f > 0) { fee = f / 100; estimated = false; }
      }
    }
    if (fee <= 0) {
      const { data: st } = await supabase.from("expense_settings").select("stripe_fee_pct, stripe_fee_fixed").limit(1).maybeSingle();
      const pct = Number(st?.stripe_fee_pct ?? 2.9), fixed = Number(st?.stripe_fee_fixed ?? 0.3);
      fee = Math.round((total * pct / 100 + fixed) * 100) / 100;
    }
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const { error } = await supabase.rpc("record_stripe_fee", { p_ref: ref, p_fee: fee, p_date: day, p_order_id: orderId, p_estimated: estimated });
    if (error) console.error("stripe fee failed", error.message);
  } catch (e) { console.error("stripe fee failed", String(e)); }
}

// deno-lint-ignore no-explicit-any
export async function recordPaidSession(supabase: ReturnType<typeof createClient>, s: any): Promise<boolean> {
  const orderId = s?.metadata?.order_id;
  if (!orderId || s.payment_status !== "paid") return false;
  const { error } = await supabase.from("payments").insert({
    order_id: orderId,
    amount: (s.amount_total ?? 0) / 100,
    method: "card",
    reference: `stripe:${s.payment_intent ?? s.id}`,
    notes: "Paid online (Stripe Checkout)",
  });
  if (error && !error.message.includes("payments_stripe_ref_uniq")) {
    console.error("record payment failed", error.message);
    return false;
  }
  await supabase.from("orders").update({ payment_method: "card" }).eq("id", orderId);
  await recordFee(supabase, s, orderId); // never blocks the order or the alert
  const { data: ord } = await supabase.from("orders").select("order_number, notify_payload").eq("id", orderId).maybeSingle();
  if (ord?.notify_payload) {
    await supabase.from("orders").update({ status: "confirmed", notify_payload: null }).eq("id", orderId);
    await notifyAll(supabase, ord.order_number, ord.notify_payload);
  }
  return true;
}
