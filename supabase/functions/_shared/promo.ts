// Promo codes (see migration 0055). FIRSTBITE = free delivery, once per customer.
// deno-lint-ignore-file no-explicit-any
export function normCode(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase().slice(0, 30) : "";
}

/** Lower-case email; for Gmail also ignore dots and +tags so a trick address is the same customer. */
export function normEmail(e: string): string {
  const s = e.trim().toLowerCase();
  const [local, domain] = s.split("@");
  if (!domain) return s;
  if (domain === "gmail.com" || domain === "googlemail.com") return local.split("+")[0].replace(/\./g, "") + "@gmail.com";
  return local + "@" + domain;
}

export type PromoCheck = { ok: true; code: string; email_norm: string } | { ok: false; error: string };

/** Is this code real, active, and not yet used by this phone number or email? */
export async function checkPromo(supabase: any, rawCode: unknown, phoneDigits: string, email: string): Promise<PromoCheck> {
  const code = normCode(rawCode);
  if (!code) return { ok: false, error: "enter a promo code" };
  const { data: promo } = await supabase.from("promo_codes").select("code, active").eq("code", code).maybeSingle();
  if (!promo || !promo.active) return { ok: false, error: "that promo code is not valid" };
  const emailNorm = normEmail(email);
  const filters = [];
  if (phoneDigits) filters.push(`phone_digits.eq.${phoneDigits}`);
  if (emailNorm) filters.push(`email_norm.eq.${emailNorm.replace(/[,()]/g, "")}`);
  if (filters.length) {
    const { data: used } = await supabase.from("promo_redemptions").select("id").eq("code", code).not("used_at", "is", null).or(filters.join(",")).limit(1);
    if (used && used.length) return { ok: false, error: `${code} has already been used. It can only be used once per customer` };
  }
  return { ok: true, code, email_norm: emailNorm };
}

/** Mark this order's redemption as used (called once the order is paid / confirmed). Never throws. */
export async function markPromoUsed(supabase: any, orderId: string) {
  try {
    const { error } = await supabase.from("promo_redemptions").update({ used_at: new Date().toISOString() }).eq("order_id", orderId).is("used_at", null);
    if (error && !error.message.includes("promo_used_")) console.error("promo mark used failed", error.message);
  } catch (e) { console.error("promo mark used failed", String(e)); }
}
