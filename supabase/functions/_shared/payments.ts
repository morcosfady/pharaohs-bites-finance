// Records a paid Stripe Checkout Session on its order. Safe to call more than once for
// the same payment: payments.reference is unique for stripe:* rows and the owner alert
// + receipt go out only the first time.
import { createClient } from "npm:@supabase/supabase-js@2";
import { notifyAll } from "./notify.ts";

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
  const { data: ord } = await supabase.from("orders").select("order_number, notify_payload").eq("id", orderId).maybeSingle();
  if (ord?.notify_payload) {
    await supabase.from("orders").update({ status: "confirmed", notify_payload: null }).eq("id", orderId);
    await notifyAll(supabase, ord.order_number, ord.notify_payload);
  }
  return true;
}
