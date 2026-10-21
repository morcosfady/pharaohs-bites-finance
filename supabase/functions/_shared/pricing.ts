// One place that prices a basket the way the database will: prices and tax statuses from the
// products table, tax from tax.ts, tip from tip.ts. Used by delivery-quote (the live estimate on the
// order page) and by create-order (the check BEFORE anything is saved, and the check AFTER the
// database wrote the order). The browser only ever sees these numbers; it never sets them.
// deno-lint-ignore-file no-explicit-any
import { computeTax, divHalfUp, type DeliveryTaxMode, type TaxStatus } from "./tax.ts";
import { computeTip, type Tip, type TipRequest } from "./tip.ts";

export type TaxSettings = { rate: number; enabled: boolean; mode: DeliveryTaxMode; pricesIncludeTax: boolean };
export type PricedItem = { slug: string; quantity: number; name: string; unitCents: number; lineCents: number; taxStatus: TaxStatus; taxCents: number };
export type Pricing = {
  ok: true;
  items: PricedItem[];
  subtotalCents: number;
  discountCents: number;
  deliveryCents: number;
  taxableSubtotalCents: number;
  itemTaxCents: number;
  deliveryTaxCents: number;
  taxCents: number;
  taxRate: number;
  tip: Tip;
  totalCents: number;
} | { ok: false; status: number; error: string };

export async function loadTaxSettings(supabase: any): Promise<TaxSettings> {
  const { data, error } = await supabase.from("tax_settings").select("default_tax_rate, tax_enabled, tax_delivery_mode, prices_include_tax").eq("id", 1).maybeSingle();
  if (error) console.error("tax_settings read failed", error.message);
  const mode = data?.tax_delivery_mode;
  return {
    rate: Number(data?.default_tax_rate ?? 0),
    enabled: data?.tax_enabled !== false,
    mode: mode === "none" || mode === "all" ? mode : "proportional",
    pricesIncludeTax: data?.prices_include_tax === true,
  };
}

/** What the website may show about tax and tips (sent by delivery-quote "config"). */
export function publicTaxConfig(t: TaxSettings) {
  return { tax_rate: t.enabled ? t.rate : 0, tax_enabled: t.enabled, tax_delivery_mode: t.mode };
}

export async function priceBasket(supabase: any, opts: {
  items: Array<{ slug: string; quantity: number }>;
  isDelivery: boolean;
  /** delivery fee actually charged, after any promo (0 for pickup or free delivery) */
  deliveryCents: number;
  promo?: { percent?: number; free?: boolean };
  tip?: TipRequest;
  settings?: TaxSettings;
}): Promise<Pricing> {
  const slugs = [...new Set(opts.items.map((i) => i.slug))];
  const { data: prods, error } = await supabase.from("products").select("slug, name, selling_price, tax_status, is_active, deleted_at").in("slug", slugs);
  if (error) { console.error("products read failed", error.message); return { ok: false, status: 500, error: "could not price the order" }; }
  const bySlug = new Map<string, any>((prods ?? []).map((p: any) => [p.slug, p]));
  const items: PricedItem[] = [];
  for (const it of opts.items) {
    const p = bySlug.get(it.slug);
    if (!p || !p.is_active || p.deleted_at) return { ok: false, status: 400, error: "one of the products is no longer available" };
    const unitCents = Math.round(Number(p.selling_price) * 100);
    const status: TaxStatus = p.tax_status === "exempt" ? "exempt" : p.tax_status === "taxable" ? "taxable" : "review";
    items.push({ slug: it.slug, quantity: it.quantity, name: p.name, unitCents, lineCents: unitCents * it.quantity, taxStatus: status, taxCents: 0 });
  }
  const subtotalCents = items.reduce((n, i) => n + i.lineCents, 0);
  // promo: the whole order free, or a % off the dishes (delivery charged as usual)
  const discountCents = opts.promo?.free ? subtotalCents : opts.promo?.percent ? divHalfUp(subtotalCents * opts.promo.percent, 100) : 0;
  const deliveryCents = opts.isDelivery ? Math.max(0, Math.round(opts.deliveryCents)) : 0;
  const t = opts.settings ?? await loadTaxSettings(supabase);
  const tax = computeTax({ lines: items.map((i) => ({ cents: i.lineCents, status: i.taxStatus })), discountCents, deliveryCents, rate: t.rate, mode: t.mode, enabled: t.enabled && !t.pricesIncludeTax });
  items.forEach((i, idx) => { i.taxCents = tax.lineTaxCents[idx]; });
  const tip = computeTip(opts.tip, subtotalCents, opts.isDelivery);
  if (!tip.ok) return { ok: false, status: 400, error: tip.error };
  const totalCents = Math.max(0, subtotalCents - discountCents) + deliveryCents + tax.taxCents + tip.tip.cents;
  return {
    ok: true, items, subtotalCents, discountCents, deliveryCents,
    taxableSubtotalCents: tax.taxableSubtotalCents, itemTaxCents: tax.itemTaxCents, deliveryTaxCents: tax.deliveryTaxCents, taxCents: tax.taxCents,
    taxRate: t.enabled ? t.rate : 0, tip: tip.tip, totalCents,
  };
}

/** The numbers the website shows (snake_case, cents). */
export function pricingPayload(p: Extract<Pricing, { ok: true }>) {
  return {
    subtotal_cents: p.subtotalCents, discount_cents: p.discountCents, delivery_cents: p.deliveryCents,
    taxable_subtotal_cents: p.taxableSubtotalCents, item_tax_cents: p.itemTaxCents, delivery_tax_cents: p.deliveryTaxCents, tax_cents: p.taxCents,
    tax_rate: p.taxRate, tip: { type: p.tip.type, percent: p.tip.percent, cents: p.tip.cents }, total_cents: p.totalCents,
  };
}
