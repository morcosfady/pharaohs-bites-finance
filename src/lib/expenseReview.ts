/* Small pure helpers for the Expenses Review inbox and source badges. */

/** The bit of a bank description worth remembering as a rule: everything before the
 *  first store number / reference id, e.g. "WAL-MART #1234 DALLAS TX" -> "WAL-MART",
 *  "DEPOSIT ID NUMBER 28114" -> "DEPOSIT ID NUMBER". Falls back to the whole text. */
export function ruleText(description: string): string {
  const clean = description.trim().replace(/\s+/g, " ");
  const words: string[] = [];
  for (const w of clean.split(" ")) {
    if (/[#*\d]/.test(w)) break; // store numbers and reference ids end the useful part
    words.push(w);
  }
  const head = words.join(" ").replace(/[,\s-]+$/, "").trim();
  return (head.length >= 3 ? head : clean).toUpperCase();
}

export const SOURCE_BADGES: Record<string, { icon: string; label: string }> = {
  bank: { icon: "🏦", label: "Bank" },
  receipt: { icon: "📸", label: "Receipt" },
  email: { icon: "📧", label: "Order email" },
  stripe: { icon: "💳", label: "Stripe" },
  subscription: { icon: "🔁", label: "Subscription" },
  manual: { icon: "✍️", label: "Entered by hand" },
  mileage: { icon: "🚗", label: "Mileage" },
};

/** Unique, stably ordered badges for the evidence behind one expense. */
export function sourceBadges(sources: { source_type: string }[] | undefined | null) {
  const order = Object.keys(SOURCE_BADGES);
  const seen = new Set((sources ?? []).map((s) => s.source_type));
  return order.filter((k) => seen.has(k)).map((k) => ({ key: k, ...SOURCE_BADGES[k] }));
}

export const MONEY_IN_ACTIONS = [
  { action: "owner_contribution", label: "Owner put money in", hint: "Not income, not an expense" },
  { action: "transfer", label: "Transfer / not a sale", hint: "Moving money between accounts" },
  { action: "personal", label: "Personal", hint: "Not part of the business" },
] as const;

export const RULE_ACTIONS = [
  { value: "expense", label: "Business expense" },
  { value: "transfer", label: "Transfer (not a cost)" },
  { value: "owner_contribution", label: "Owner contribution" },
  { value: "personal", label: "Personal (excluded)" },
  { value: "payout", label: "Stripe payout (not income)" },
] as const;

export function ruleActionLabel(action: string): string {
  return RULE_ACTIONS.find((a) => a.value === action)?.label ?? action;
}
