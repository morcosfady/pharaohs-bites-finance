// Pure helpers for reading receipts with the Claude API. No Deno or network calls in this file,
// so it is unit-tested from the dashboard's test suite (src/test/receipt.test.ts).

export interface ParsedItem { name: string; qty: number; unit_price: number; total: number; category: string; personal: boolean }
export interface ParsedReceipt {
  is_receipt: boolean; is_refund: boolean; vendor: string; date: string | null; card_last4: string;
  payment_method: string; subtotal: number | null; tax: number; total: number; items: ParsedItem[]; confidence: number; notes: string;
}

export const PAYMENT_METHODS = ["card", "cash", "zelle", "venmo", "other"];

/** What the model is told. Vendor hints cover the stores the owner shops at. */
export function buildSystemPrompt(categories: string[]): string {
  return `You read purchase receipts, order confirmation emails and invoices for a small home-based food business (Egyptian and Middle Eastern cloud kitchen in Dallas, Texas). Return ONLY one JSON object, no prose, no code fences.

JSON shape:
{
  "is_receipt": true,            // false for marketing emails, shipping notices without prices, anything that is not a purchase record
  "is_refund": false,            // true for a return, refund or credit
  "vendor": "Walmart",           // the short brand name only: "Walmart", "Costco", "WebstaurantStore", "Amazon", "Sam's Club", "H-E-B", "Kroger", "Aldi", "Restaurant Depot". No store numbers, no city.
  "date": "2026-10-01",          // purchase or order date as YYYY-MM-DD, or null
  "card_last4": "6171",          // last 4 digits of the card if printed, else ""
  "payment_method": "card",      // card, cash, zelle, venmo or other
  "subtotal": 91.5,              // number or null
  "tax": 7.55,                   // sales tax total, 0 if none
  "total": 99.05,                // the final amount charged, always positive, also for refunds
  "items": [ { "name": "Great Value whole milk 1 gal", "qty": 2, "unit_price": 3.48, "total": 6.96, "category": "Ingredients", "personal": false } ],
  "confidence": 0.9,             // 0 to 1: how sure you are about the total and the items
  "notes": ""                    // anything odd, short
}

Rules:
- Money is plain dollars as numbers (12.5, not "$12.50"). Never invent a line or a total: if you cannot read it, leave the item out and lower "confidence".
- One entry per purchased line. Put coupons and instant savings as a negative-total item attached to what they discount. Shipping, handling and fees are items too (category "Other" unless clearly packaging or delivery).
- Item "total" is the line price after quantity. Items plus tax should add up to "total".
- Expand cryptic names so a person can understand them: Costco "KS" is Kirkland Signature, Walmart "GV" is Great Value, "WHL MLK" is whole milk, "ORG" is organic, and so on.
- "category" must be exactly one of: ${categories.join(" | ")}.
- "personal": true only for things that are clearly not for the business: snacks and candy for personal eating, soda or energy drinks, toiletries, clothing, toys. When unsure, false.
- Store hints: Walmart, Walmart Business and Sam's Club send item lines with abbreviations. Costco warehouse receipts have item numbers and short names, and a negative line with a slash is a discount for the item above it. WebstaurantStore, Uline and Restaurant Depot are mostly packaging, foil trays, gloves and restaurant supplies. Amazon emails list items with prices and may split one order into several shipments: use the order total. Indian and Middle Eastern grocery stores use names like ghee, tahini, semolina, vermicelli, molokhia, fava beans: ingredients.
- If the document is a refund or return, set is_refund true and use the refunded amount as a positive total.
- If it is not a purchase record at all, return {"is_receipt": false, "vendor": "", "date": null, "card_last4": "", "payment_method": "other", "subtotal": null, "tax": 0, "total": 0, "items": [], "confidence": 1, "notes": "why"}.`;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Pulls the JSON object out of the model's reply, tolerating a stray code fence or sentence. */
export function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reply had no JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Forces whatever the model returned into the exact shape the database function expects. */
export function normalizeParsed(raw: unknown, categories: string[]): ParsedReceipt {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cats = new Map(categories.map((c) => [c.toLowerCase(), c]));
  const items: ParsedItem[] = (Array.isArray(o.items) ? o.items : []).slice(0, 300).map((x) => {
    const it = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const qty = num(it.qty) || 1;
    const unit = num(it.unit_price);
    const total = it.total != null && String(it.total) !== "" ? num(it.total) : Math.round(qty * unit * 100) / 100;
    return {
      name: String(it.name ?? "").trim().slice(0, 200), qty, unit_price: unit, total,
      category: cats.get(String(it.category ?? "").toLowerCase()) ?? "Other", personal: it.personal === true,
    };
  }).filter((i) => i.name !== "" && i.total !== 0);
  const date = typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
  const pm = String(o.payment_method ?? "").toLowerCase();
  return {
    is_receipt: o.is_receipt !== false,
    is_refund: o.is_refund === true,
    vendor: String(o.vendor ?? "").trim().slice(0, 80),
    date, card_last4: String(o.card_last4 ?? "").replace(/\D/g, "").slice(-4),
    payment_method: PAYMENT_METHODS.includes(pm) ? pm : "other",
    subtotal: o.subtotal == null || String(o.subtotal) === "" ? null : num(o.subtotal),
    tax: Math.max(num(o.tax), 0), total: Math.abs(num(o.total)), items,
    confidence: Math.min(Math.max(Number(o.confidence) || 0, 0), 1), notes: String(o.notes ?? "").slice(0, 300),
  };
}

/** Do the items plus tax add up to the total (within 5 cents, or without tax)? */
export function totalsAddUp(p: ParsedReceipt): boolean {
  if (!p.items.length) return true;
  const sum = Math.round(p.items.reduce((s, i) => s + Math.abs(i.total), 0) * 100);
  const total = Math.round(p.total * 100), tax = Math.round(p.tax * 100);
  return Math.abs(sum + tax - total) <= 5 || Math.abs(sum - total) <= 5;
}

/** Friendly wording for the owner when the Claude API refuses. */
export function friendlyApiError(status: number, message: string): string {
  if (status === 401) return "The Claude API key was rejected. Check the key saved in Supabase (ANTHROPIC_API_KEY).";
  if (status === 402 || /credit balance|billing/i.test(message)) return "The Claude account has no credit left. Add credit at console.anthropic.com (Billing), then tap Read again.";
  if (status === 413 || /too large|exceeds/i.test(message)) return "This photo is too large to read. Take it again closer, or upload a smaller picture.";
  if (status === 429) return "Claude is busy right now. Wait a minute and tap Read again.";
  if (status >= 500) return "Claude had a temporary problem. Tap Read again in a minute.";
  return `Could not read this receipt (${status}). ${message.slice(0, 160)}`;
}
