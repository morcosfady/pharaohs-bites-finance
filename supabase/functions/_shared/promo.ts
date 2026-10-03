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

/** Free-delivery promo codes only cover addresses this close to the kitchen. */
export const PROMO_MAX_MILES = 5;

export type PromoCheck = { ok: true; code: string; email_norm: string; message?: string; free?: boolean } | { ok: false; error: string };

/** Is this code real, active, and not yet used by this phone number or email? */
export async function checkPromo(supabase: any, rawCode: unknown, phoneDigits: string, email: string, miles?: number, addressNorm = "", items?: Array<{ slug: string; quantity: number }>): Promise<PromoCheck> {
  const code = normCode(rawCode);
  if (!code) return { ok: false, error: "enter a promo code" };
  const { data: promo } = await supabase.from("promo_codes").select("code, active, kind, single_use, max_miles, welcome_message, vegan_only, max_subtotal").eq("code", code).maybeSingle();
  if (!promo || !promo.active) return { ok: false, error: "that promo code is not valid" };
  const maxMiles = promo.max_miles == null ? null : Number(promo.max_miles);
  if (maxMiles !== null && typeof miles === "number" && miles > maxMiles) {
    return { ok: false, error: `Sorry, ${code} free delivery is for addresses within ${maxMiles} miles of our kitchen, and yours is about ${miles} miles away. You can still order, and delivery is just charged at the normal fee.` };
  }
  if (promo.single_use) {
    const { data: taken } = await supabase.from("promo_redemptions").select("id").eq("code", code).not("used_at", "is", null).limit(1);
    if (taken && taken.length) return { ok: false, error: `${code} is a one-time code and has already been used` };
  }
  // Some codes only cover vegan dishes and/or a maximum amount of food.
  if (items && items.length && (promo.vegan_only || promo.max_subtotal != null)) {
    const { data: prods } = await supabase.from("products").select("slug, name, selling_price, vegan").in("slug", items.map((i) => i.slug));
    const bySlug = new Map((prods ?? []).map((p: any) => [p.slug, p]));
    if (promo.vegan_only) {
      const notVegan = items.filter((i) => !(bySlug.get(i.slug) as any)?.vegan).map((i) => (bySlug.get(i.slug) as any)?.name ?? i.slug);
      if (notVegan.length) return { ok: false, error: `${code} works on vegan dishes only. Please remove: ${[...new Set(notVegan)].join(", ")}.` };
    }
    if (promo.max_subtotal != null) {
      const sub = items.reduce((n, i) => n + i.quantity * Number((bySlug.get(i.slug) as any)?.selling_price ?? 0), 0);
      if (sub > Number(promo.max_subtotal)) return { ok: false, error: `${code} covers up to $${Number(promo.max_subtotal)} of food and your dishes come to $${sub.toFixed(2)}. Please bring your order to $${Number(promo.max_subtotal)} or less.` };
    }
  }
  const emailNorm = normEmail(email);
  const filters = [];
  if (phoneDigits) filters.push(`phone_digits.eq.${phoneDigits}`);
  if (emailNorm) filters.push(`email_norm.eq.${emailNorm.replace(/[,()]/g, "")}`);
  if (addressNorm) filters.push(`address_norm.eq."${addressNorm.replace(/"/g, "")}"`);
  if (filters.length) {
    const { data: used } = await supabase.from("promo_redemptions").select("id, address_norm").eq("code", code).not("used_at", "is", null).or(filters.join(",")).limit(5);
    if (used && used.length) {
      if (addressNorm && used.some((r: any) => r.address_norm === addressNorm)) {
        return { ok: false, error: `${code} has already been used for this delivery address. It can only be used once per address, so delivery is charged at the normal fee` };
      }
      return { ok: false, error: `${code} has already been used with this phone number or email. It can only be used once per customer` };
    }
  }
  return { ok: true, code, email_norm: emailNorm, message: promo.welcome_message || undefined, free: promo.kind === "free_order" };
}

/** Mark this order's redemption as used (called once the order is paid / confirmed). Never throws. */
export async function markPromoUsed(supabase: any, orderId: string) {
  try {
    const { error } = await supabase.from("promo_redemptions").update({ used_at: new Date().toISOString() }).eq("order_id", orderId).is("used_at", null);
    if (error && !error.message.includes("promo_used_")) console.error("promo mark used failed", error.message);
  } catch (e) { console.error("promo mark used failed", String(e)); }
}

/** Called right before payment. If this order's code was meanwhile used (paid) by the same phone / email
 *  on another order, the free delivery is withdrawn: the fee goes back on the order. Returns true if so. */
export async function reconcilePromo(supabase: any, orderId: string): Promise<boolean> {
  const { data: mine } = await supabase.from("promo_redemptions").select("id, code, phone_digits, email_norm, address_norm, fee_waived, used_at").eq("order_id", orderId).maybeSingle();
  if (!mine || mine.used_at) return false;
  const { data: pc } = await supabase.from("promo_codes").select("single_use").eq("code", mine.code).maybeSingle();
  if (pc?.single_use) {
    const { data: taken } = await supabase.from("promo_redemptions").select("id").eq("code", mine.code).neq("order_id", orderId).not("used_at", "is", null).limit(1);
    if (taken && taken.length) {
      await supabase.from("promo_redemptions").delete().eq("id", mine.id);
      await supabase.from("orders").update({ delivery_fee: mine.fee_waived, promo_code: null }).eq("id", orderId);
      return true;
    }
  }
  const filters = [];
  if (mine.phone_digits) filters.push(`phone_digits.eq.${mine.phone_digits}`);
  if (mine.email_norm) filters.push(`email_norm.eq.${String(mine.email_norm).replace(/[,()]/g, "")}`);
  if (mine.address_norm) filters.push(`address_norm.eq."${String(mine.address_norm).replace(/"/g, "")}"`);
  if (!filters.length) return false;
  const { data: used } = await supabase.from("promo_redemptions").select("id").eq("code", mine.code).neq("order_id", orderId).not("used_at", "is", null).or(filters.join(",")).limit(1);
  if (!used || !used.length) return false;
  await supabase.from("promo_redemptions").delete().eq("id", mine.id);
  await supabase.from("orders").update({ delivery_fee: mine.fee_waived, promo_code: null }).eq("id", orderId);
  return true;
}
