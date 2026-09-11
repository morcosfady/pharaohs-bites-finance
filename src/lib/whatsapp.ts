/** WhatsApp helpers shared by the dashboard (and mirrored on the customer site). */

export function digitsOnly(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

/** wa.me link for a customer phone. US numbers without a country code get +1. */
export function waLink(phone: string, message?: string): string {
  let d = digitsOnly(phone);
  if (d.length === 10) d = "1" + d;
  const base = "https://wa.me/" + d;
  return message ? base + "?text=" + encodeURIComponent(message) : base;
}

export function mapsLink(parts: { street: string; apt?: string; city: string; state: string; zip: string }): string {
  const q = [parts.street, parts.apt, parts.city, parts.state, parts.zip].filter(Boolean).join(", ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}

/** Fill the owner's confirmation template. Unknown placeholders are left as-is. */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export interface WaOrderLine { name: string; quantity: number; options?: string; unitPrice: string; lineTotal: string }
export interface WaOrderInput {
  orderNumber?: string; name: string; phone?: string; address: string; instructions?: string; requested?: string;
  lines: WaOrderLine[]; subtotal: string;
}

/**
 * The customer-side message format (mirrors assets/js/main.js on the
 * website). Empty / undefined fields are omitted entirely.
 */
export function buildCustomerOrderMessage(o: WaOrderInput): string {
  const nl = "\n";
  const head = ["👑✨ NEW PHARAOH’S BITES ORDER ✨👑"];
  if (o.orderNumber) head.push("🔖 Order Number: " + o.orderNumber);
  const cust = ["👤 CUSTOMER", "🖊️ Name: " + o.name];
  if (o.phone) cust.push("📞 Phone: " + o.phone);
  cust.push("📍 Address: " + o.address);
  if (o.instructions) cust.push("📝 Delivery Instructions: " + o.instructions);
  const items = o.lines.map((l, i) => {
    const rows = ["🍽️ " + (i + 1) + ". " + l.name, "🔢 Quantity: " + l.quantity];
    if (l.options) rows.push("⚙️ Options: " + l.options);
    rows.push("💵 Unit Price: " + l.unitPrice, "🧾 Line Total: " + l.lineTotal);
    return rows.join(nl);
  });
  const totals = [
    "💰 Merchandise Subtotal: " + o.subtotal,
    "🚗 Delivery Fee: To be determined",
    "🧮 Estimated Tax: To be confirmed",
    "✅ Final Total: To be confirmed",
  ];
  if (o.requested) totals.push("🗓️ Requested Date/Time: " + o.requested);
  return [
    head.join(nl), "", cust.join(nl), "", "🛒 ORDER", "", items.join(nl + nl), "", totals.join(nl), "",
    "💳 Payment method will be arranged through Zelle or Venmo after the delivery fee and final total are confirmed.",
    "🙏 Please confirm my order and delivery fee. Thank you! 😊",
  ].join(nl);
}
