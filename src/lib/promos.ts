// Promo codes for the dashboard "Promos" tab: what each code does, whether it is live, how much it has been
// used, and what it has cost / earned. Pure functions (no database calls) so they can be tested.
import { addDays, differenceInCalendarDays, format } from "date-fns";

export type PromoKind = "free_delivery" | "percent_off" | "free_order";

export type PromoCode = {
  code: string;
  kind: PromoKind;
  active: boolean;
  label: string;
  notes: string;
  single_use: boolean;
  max_uses: number | null;
  max_miles: number | null;
  vegan_only: boolean;
  max_subtotal: number | null;
  percent_off: number | null;
  first_order_only: boolean;
  welcome_message: string | null;
  starts_at: string | null;
  expires_at: string | null;
  created_at: string;
};

export type Redemption = {
  id: string;
  code: string;
  order_id: string;
  fee_waived: number;
  used_at: string | null;
  created_at: string;
};

export type PromoOrder = {
  id: string;
  order_number: string;
  customer_name: string;
  status: string;
  subtotal: number;
  discount: number;
  delivery_fee: number;
  total: number;
};

/** A refused attempt seen by the website ("already used", "outside the miles limit"...). */
export type Refusal = { code: string; message: string; at: string };

export type PromoStatus = "active" | "paused" | "scheduled" | "expired" | "used_up";

export const STATUS_INFO: Record<PromoStatus, { label: string; cls: string; dot: string; hint: string }> = {
  active: { label: "Active", cls: "bg-emerald-100 text-emerald-800", dot: "#16855B", hint: "Customers can use it right now." },
  paused: { label: "Paused", cls: "bg-slate-200 text-slate-700", dot: "#64748b", hint: "You switched it off. The website says it is not valid." },
  scheduled: { label: "Starts soon", cls: "bg-sky-100 text-sky-800", dot: "#0284c7", hint: "It has a start date in the future." },
  expired: { label: "Expired", cls: "bg-red-100 text-red-800", dot: "#c0392b", hint: "Its end date has passed." },
  used_up: { label: "Used up", cls: "bg-amber-100 text-amber-800", dot: "#d9822b", hint: "It reached its limit of uses." },
};

/** How many times the code may be used in total (null = no limit). */
export const usesAllowed = (p: PromoCode): number | null => (p.single_use ? 1 : p.max_uses);

export function promoStatus(p: PromoCode, usedCount: number, now = new Date()): PromoStatus {
  const limit = usesAllowed(p);
  if (limit !== null && usedCount >= limit) return "used_up";
  if (p.expires_at && new Date(p.expires_at) < now) return "expired";
  if (!p.active) return "paused";
  if (p.starts_at && new Date(p.starts_at) > now) return "scheduled";
  return "active";
}

/** One line in plain words: what the customer gets. */
export function describeOffer(p: PromoCode): string {
  if (p.kind === "percent_off") return `${p.percent_off ?? 0}% off the dishes`;
  if (p.kind === "free_order") return "The whole order is free";
  return p.max_miles != null ? `Free delivery within ${p.max_miles} miles` : "Free delivery";
}

/** Short rules shown as little tags on the card. */
export function ruleTags(p: PromoCode): string[] {
  const tags: string[] = [];
  if (p.first_order_only) tags.push("First order only");
  tags.push("Once per phone, email and address");
  const limit = usesAllowed(p);
  if (p.single_use) tags.push("One-time code");
  else if (limit !== null) tags.push(`Max ${limit} uses in total`);
  if (p.max_miles != null && p.kind !== "free_delivery") tags.push(`Within ${p.max_miles} miles`);
  if (p.vegan_only) tags.push("Vegan dishes only");
  if (p.max_subtotal != null) tags.push(`Up to $${p.max_subtotal} of food`);
  return tags;
}

/** Text the owner can paste into a message to a customer. */
export function shareText(p: PromoCode): string {
  const rules = ruleTags(p).filter((t) => !t.startsWith("Once per")).join(", ").toLowerCase();
  const until = p.expires_at ? ` Valid until ${format(new Date(p.expires_at), "MMMM d")}.` : "";
  return `Use code ${p.code} when you order at pharaohsbites.com: ${describeOffer(p).toLowerCase()}${rules ? ` (${rules})` : ""}.${until}`;
}

export type PromoStats = {
  code: PromoCode;
  status: PromoStatus;
  used: Redemption[];          // paid / confirmed
  waiting: Redemption[];       // code applied to an order that is not paid yet
  limit: number | null;
  givenAway: number;           // discount + delivery fee waived, paid orders only
  revenue: number;             // total of the paid orders that used the code
  lastUsed: string | null;
  refused: Refusal[];
  daysLeft: number | null;     // until expiry, when it has one
  endingSoon: boolean;
  quiet: boolean;              // active, but nobody used it for 14+ days
};

export function buildPromoStats(codes: PromoCode[], redemptions: Redemption[], orders: Map<string, PromoOrder>, refusals: Refusal[], now = new Date()): PromoStats[] {
  return codes.map((code) => {
    const mine = redemptions.filter((r) => r.code === code.code);
    const cancelled = (r: Redemption) => orders.get(r.order_id)?.status === "cancelled";
    const used = mine.filter((r) => r.used_at && !cancelled(r)).sort((a, b) => String(b.used_at).localeCompare(String(a.used_at)));
    const waiting = mine.filter((r) => !r.used_at && !cancelled(r));
    const status = promoStatus(code, used.length, now);
    let givenAway = 0, revenue = 0;
    for (const r of used) {
      const o = orders.get(r.order_id);
      givenAway += Number(r.fee_waived || 0) + Number(o?.discount || 0);
      revenue += Number(o?.total || 0);
    }
    const lastUsed = used[0]?.used_at ?? null;
    const daysLeft = code.expires_at ? differenceInCalendarDays(new Date(code.expires_at), now) : null;
    const since = lastUsed ?? code.created_at;
    return {
      code, status, used, waiting, limit: usesAllowed(code),
      givenAway: Math.round(givenAway * 100) / 100, revenue: Math.round(revenue * 100) / 100, lastUsed,
      refused: refusals.filter((x) => x.code === code.code),
      daysLeft,
      endingSoon: status === "active" && daysLeft !== null && daysLeft <= 3,
      quiet: status === "active" && now > addDays(new Date(since), 14),
    };
  });
}

/** Order the cards: live codes first, then the ones that ended. */
const RANK: Record<PromoStatus, number> = { active: 0, scheduled: 1, paused: 2, used_up: 3, expired: 4 };
export const sortStats = (a: PromoStats, b: PromoStats) => RANK[a.status] - RANK[b.status] || b.used.length - a.used.length || a.code.code.localeCompare(b.code.code);

export type Attention = { key: string; tone: "red" | "amber" | "blue"; text: string; code: string };

/** The "needs your attention" list at the top of the tab. */
export function attentionList(stats: PromoStats[], now = new Date()): Attention[] {
  const out: Attention[] = [];
  for (const s of stats) {
    const c = s.code.code;
    if (s.endingSoon) out.push({ key: `end-${c}`, tone: "amber", code: c, text: `${c} ends ${s.daysLeft === 0 ? "today" : s.daysLeft === 1 ? "tomorrow" : `in ${s.daysLeft} days`}. Extend it if you want it to keep working.` });
    if (s.status === "active" && s.limit !== null && s.limit - s.used.length === 1 && s.limit > 1) out.push({ key: `last-${c}`, tone: "amber", code: c, text: `${c} has only 1 use left.` });
    const stale = s.waiting.filter((r) => now.getTime() - new Date(r.created_at).getTime() > 6 * 3600 * 1000);
    if (stale.length) out.push({ key: `wait-${c}`, tone: "blue", code: c, text: `${stale.length} ${stale.length === 1 ? "customer applied" : "customers applied"} ${c} but ${stale.length === 1 ? "has" : "have"} not paid yet. A reminder message may win the order.` });
    if (s.quiet) out.push({ key: `quiet-${c}`, tone: "blue", code: c, text: `${c} has not been used for 2 weeks. Share it again (the Copy message button makes it easy).` });
    const recent = s.refused.filter((r) => now.getTime() - new Date(r.at).getTime() < 7 * 86400000);
    if (recent.length >= 3) out.push({ key: `ref-${c}`, tone: "red", code: c, text: `${recent.length} people were refused ${c} in the last 7 days. Check the reasons on its card.` });
  }
  return out;
}

/** Group the refused attempts of a code by reason, most common first. */
export function refusalReasons(refusals: Refusal[]): { message: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of refusals) m.set(r.message, (m.get(r.message) ?? 0) + 1);
  return [...m.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count);
}

/** Valid code names: letters, numbers, dash, underscore (the website removes spaces and capitalises). */
export const CODE_RE = /^[A-Z0-9_-]{3,30}$/;
export const cleanCode = (v: string) => v.replace(/\s+/g, "").toUpperCase();
