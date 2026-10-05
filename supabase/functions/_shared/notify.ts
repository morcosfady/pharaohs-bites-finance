// Shared by create-order (free / pay-later orders) and stripe-webhook (paid orders).
// Sends the owner Telegram/ntfy alert and the customer email receipt.
import { createClient } from "npm:@supabase/supabase-js@2";

// ---- notifications -------------------------------------------------------------
// Owner: free push notification through ntfy.sh (topic kept in NTFY_TOPIC).
// Customer: a styled receipt email through the business Gmail relay (Apps
// Script; RECEIPT_URL + RECEIPT_TOKEN, never exposed to the browser).
// Failures here never block the order.
export type OrderInfo = { pickup?: boolean; name: string; phone: string; email: string; address: string; instructions: string; requestedAt: string; items: Array<{ slug: string; quantity: number; options: string }>; deliveryFee: number; miles: number; discount?: number; promo?: string };
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Allergens per dish (mirror of assets/js/data.js on the website; combos = every possible pick) for the receipt.
const ALLERGENS: Record<string, string[]> = {
  "feteer-meshaltet": ["Milk", "Eggs", "Wheat"],
  "feteer-beef": ["Milk", "Eggs", "Wheat", "Soy"],
  "macarona-bechamel": ["Milk", "Wheat", "Soy"],
  "goulash-beef": ["Milk", "Wheat", "Soy"],
  "kofta-tray": ["Wheat", "Soy"],
  "meatballs-spaghetti": ["Wheat", "Soy"],
  "orzo-soup": ["Wheat"],
  "koshary": ["Wheat"],
  "om-ali": ["Milk", "Wheat", "Tree nuts"],
  "goulash-nuts": ["Milk", "Wheat", "Tree nuts"],
  "round-cake": ["Milk", "Eggs", "Wheat"],
  "chocolate-pudding": ["Milk", "Soy"],
  "banana-pudding": ["Milk", "Wheat"],
  "rice-pudding": ["Milk", "Tree nuts"],
  "creme-caramel": ["Milk", "Eggs"],
  "white-cheese": ["Milk"],
  "tahini": ["Sesame"],
  "baba-ganoush": ["Sesame"],
  "hummus": ["Sesame"],
  "protein-shake": ["Milk", "Soy"],
  "avocado-drink": ["Milk"],
  "avocado-drink-almond": ["Tree nuts"],
  "protein-shake-almond": ["Milk", "Soy", "Tree nuts"],
  "party-tray": ["Milk", "Eggs", "Wheat", "Soy", "Sesame", "Tree nuts"],
  "family-feast": ["Milk", "Eggs", "Wheat", "Soy", "Sesame", "Tree nuts"],
  "egyptian-breakfast": ["Milk", "Eggs", "Wheat", "Soy", "Sesame"],
  "meal-for-one": ["Milk", "Eggs", "Wheat", "Soy", "Sesame", "Tree nuts"],
  "feteer-dip-trio": ["Milk", "Sesame"],
  "pick-3-puddings": ["Milk", "Eggs", "Wheat", "Soy", "Tree nuts"],
};
// TCS foods get the safe-handling line + "Made on" date. Store-bought add-ons are not cottage foods; Diet Coke is resale (no disclosure).
const TCS = new Set(["feteer-beef", "macarona-bechamel", "goulash-beef", "kofta-tray", "koshary", "meatballs-spaghetti", "lentil-soup", "chocolate-pudding", "banana-pudding", "creme-caramel", "rice-pudding", "white-cheese", "hummus", "baba-ganoush", "protein-shake", "avocado-drink", "avocado-drink-almond", "protein-shake-almond", "om-ali", "party-tray", "family-feast", "egyptian-breakfast", "meal-for-one", "feteer-dip-trio", "pick-3-puddings"]);
const STORE_BOUGHT = new Set(["tahini", "black-honey", "white-honey"]);
const RESALE = new Set(["diet-coke"]);

export function receiptHtml(orderNumber: string, info: OrderInfo, lines: Array<{ qty: number; name: string; options: string; slug: string }>, subtotal: number, total: number): string {
  const rows = lines.map((l) => `<tr><td style="padding:8px 0;color:#f3e9d2;border-bottom:1px solid #3a3226">${l.qty} &times; ${esc(l.name)}${l.options ? `<br><span style="color:#b9a880;font-size:12px">${esc(l.options)}</span>` : ""}${ALLERGENS[l.slug]?.length ? `<br><span style="color:#a39373;font-size:12px;line-height:1.5">Contains: ${esc(ALLERGENS[l.slug].join(", "))}</span>` : ""}</td></tr>`).join("");
  const when = new Date(info.requestedAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const win = /Delivery window: ([^|]+?) on /.exec(info.instructions)?.[1] ?? "";
  const money = (n: number) => "$" + n.toFixed(2);
  // Texas cottage food label info (H&S Code 437.0193). Safe-handling line must stay at 12 pt (16px) minimum on the receipt.
  const foodLines = lines.filter((l) => !RESALE.has(l.slug));
  const hasTcs = foodLines.some((l) => TCS.has(l.slug));
  const storeBought = foodLines.filter((l) => STORE_BOUGHT.has(l.slug)).map((l) => l.name);
  const foodInfo = `<tr><td style="padding:14px 28px 16px;color:#a39373;font-size:9px;line-height:1.35"><span style="color:#c9a24a;font-size:9px;letter-spacing:2px">FOOD INFO</span><br><b>Pharaoh&rsquo;s Bites is a Texas Cottage Food Operation, Reg. #20668.</b><br>THIS PRODUCT WAS PRODUCED IN A PRIVATE RESIDENCE THAT IS NOT SUBJECT TO GOVERNMENTAL LICENSING OR INSPECTION.<br>Home kitchen: may contain traces of milk, eggs, wheat, soy, tree nuts, sesame.${storeBought.length ? `<br>${esc(storeBought.join(", "))} ${storeBought.length > 1 ? "are" : "is"} store-bought, not a cottage food.` : ""}${hasTcs ? `<br>Made on: ${esc(when)}<br><span style="display:block;margin-top:6px;color:#a39373;font-size:16px;line-height:1.4"><b>SAFE HANDLING INSTRUCTIONS:</b> To prevent illness from bacteria, keep this food refrigerated or frozen until the food is prepared for consumption.</span>` : ""}</td></tr>
<tr><td style="padding:0 28px"><div style="height:1px;background:#c9a24a;opacity:.6"></div></td></tr>
`;
  return `<!doctype html><html><body style="margin:0;background:#14110c;font-family:Georgia,serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14110c"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1e1a13;border:1px solid #c9a24a;border-radius:14px;overflow:hidden">
<tr><td align="center" style="padding:28px 20px 8px;color:#c9a24a;font-size:34px">&#9765;</td></tr>
<tr><td align="center" style="color:#c9a24a;font-size:26px;letter-spacing:1px;padding:0 20px">Pharaoh&rsquo;s Bites</td></tr>
<tr><td align="center" style="color:#b9a880;font-size:13px;letter-spacing:3px;padding:4px 20px 22px">EGYPTIAN CLOUD KITCHEN &middot; DALLAS</td></tr>
<tr><td style="padding:0 28px"><div style="height:1px;background:#c9a24a;opacity:.6"></div></td></tr>
<tr><td style="padding:22px 28px 6px;color:#f3e9d2;font-size:18px">Thank you, ${esc(info.name.split(" ")[0])}!</td></tr>
<tr><td style="padding:0 28px 18px;color:#d8ccb0;font-size:15px;line-height:1.6">We received your order and we are getting ready to cook. Here is your receipt.</td></tr>
<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14110c;border:1px solid #3a3226;border-radius:10px"><tr><td style="padding:14px 16px;color:#b9a880;font-size:12px;letter-spacing:2px">ORDER NUMBER<br><span style="color:#c9a24a;font-size:22px;letter-spacing:1px">${esc(orderNumber)}</span></td></tr></table></td></tr>
<tr><td style="padding:20px 28px 4px;color:#c9a24a;font-size:12px;letter-spacing:2px">YOUR ORDER</td></tr>
<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
<tr><td style="padding:14px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="color:#d8ccb0;font-size:14px">
<tr><td style="padding:3px 0">Dishes</td><td align="right">${money(subtotal + (info.discount ?? 0))}</td></tr>
${info.discount ? `<tr><td style="padding:3px 0">Promo ${info.promo ?? ""}</td><td align="right">-${money(info.discount)}</td></tr>` : ""}
<tr><td style="padding:3px 0">${info.pickup ? "Pickup" : `Delivery (${info.miles} mi)`}</td><td align="right">${info.pickup ? "Free" : money(info.deliveryFee)}</td></tr>
<tr><td style="padding:10px 0 0;color:#c9a24a;font-size:17px;border-top:1px solid #3a3226">Total</td><td align="right" style="padding:10px 0 0;color:#c9a24a;font-size:17px;border-top:1px solid #3a3226"><b>${money(total)}</b></td></tr></table></td></tr>
<tr><td style="padding:22px 28px 4px;color:#c9a24a;font-size:12px;letter-spacing:2px">${info.pickup ? "PICKUP" : "DELIVERY"}</td></tr>
<tr><td style="padding:0 28px 22px;color:#f3e9d2;font-size:15px;line-height:1.6">${esc(when)}${win ? " &middot; " + esc(win) : ""}<br><span style="color:#b9a880">${esc(info.pickup ? (Deno.env.get("KITCHEN_ADDRESS") ?? "We will send you the pickup address") : info.address)}</span></td></tr>
<tr><td style="padding:0 28px"><div style="height:1px;background:#c9a24a;opacity:.6"></div></td></tr>
${foodInfo}<tr><td align="center" style="padding:20px 28px 26px;color:#b9a880;font-size:13px;line-height:1.7">Questions? Message us on WhatsApp <a href="https://wa.me/17879684078" style="color:#c9a24a;text-decoration:none">+1 (787) 968-4078</a><br>pharaohsbites.com</td></tr>
</table></td></tr></table></body></html>`;
}

// Arabic dish names (same as the website menu) for the owner alert.
const AR_NAMES: Record<string, string> = {
  "feteer-meshaltet": "فطير مشلتت",
  "feteer-beef": "فطير محشي لحمة",
  "macarona-bechamel": "صينية مكرونة بشاميل",
  "goulash-beef": "صينية جلاش باللحمة",
  "kofta-tray": "صينية كفتة بالصلصة والأرز",
  "meatballs-spaghetti": "كرات لحم نباتية بالمكرونة",
  "koshary": "كشري",
  "koshary-sauce": "صلصة طماطم إضافية",
  "lentil-soup": "شوربة عدس",
  "om-ali": "أم علي",
  "goulash-nuts": "صينية جلاش بالمكسرات",
  "round-cake": "كيكة صغيرة",
  "chocolate-pudding": "بودينج شوكولاتة",
  "banana-pudding": "بودينج موز",
  "rice-pudding": "رز باللبن",
  "creme-caramel": "كريم كراميل",
  "white-cheese": "جبنة بيضاء",
  "black-honey": "عسل أسود",
  "white-honey": "عسل أبيض",
  "tahini": "طحينة",
  "baba-ganoush": "بابا غنوج",
  "hummus": "حمص",
  "protein-shake": "مشروب البروتين بالشوكولاتة",
  "avocado-drink": "عصير أفوكادو",
  "avocado-drink-almond": "عصير أفوكادو بحليب اللوز",
  "protein-shake-almond": "مشروب البروتين بحليب اللوز",
  "diet-coke": "دايت كوكاكولا",
  "feteer-dip-trio": "طبق الإضافات",
  "feteer-and-dip-trio": "فطير مع ثلاثية الإضافات",
  "pick-3-puddings": "اختر ٣ بودينج",
  "egyptian-breakfast": "فطار مصري",
  "family-feast": "عزومة العيلة",
  "meal-for-one": "وجبة لفرد",
  "party-tray": "صينية الحفلة",
};

export async function notifyAll(supabase: ReturnType<typeof createClient>, orderNumber: string, info: OrderInfo) {
  try {
    const { data: prods } = await supabase.from("products").select("slug, name, selling_price").in("slug", info.items.map((i) => i.slug));
    const names = new Map((prods ?? []).map((p: { slug: string; name: string }) => [p.slug, p.name]));
    const prices = new Map((prods ?? []).map((p: { slug: string; selling_price: number | string }) => [p.slug, Number(p.selling_price)]));
    const { data: fin } = await supabase.from("order_financials").select("total, net_product_sales").eq("order_number", orderNumber).maybeSingle();
    const total = Number(fin?.total ?? 0), subtotal = Number(fin?.net_product_sales ?? 0);
    const lines = info.items.map((i) => ({ qty: i.quantity, name: names.get(i.slug) ?? i.slug, options: i.options, slug: i.slug }));

    const topic = Deno.env.get("NTFY_TOPIC");
    const tgToken = Deno.env.get("TELEGRAM_BOT_TOKEN"), tgChat = Deno.env.get("TELEGRAM_CHAT_ID");
    const status: string[] = [];
    if (topic || (tgToken && tgChat)) {
      const when = new Date(info.requestedAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Chicago" });
      const win = /Delivery window: ([^|]+?) on /.exec(info.instructions)?.[1] ?? "";
      const note = info.instructions.replace(/^Delivery window: [^|]+\|?\s*/, "").trim();
      const placed = new Date().toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
      const usd = (n: number) => "$" + n.toFixed(2);
      const itemLines = info.items.flatMap((i) => [`🍽️ ${i.quantity} × ${names.get(i.slug) ?? i.slug}${i.options ? " (" + i.options + ")" : ""} — ${usd(i.quantity * (prices.get(i.slug) ?? 0))}`, ...(AR_NAMES[i.slug] ? [`🇪🇬 ${AR_NAMES[i.slug]}`] : [])]);
      const rule = "━━━━━━━━━━━━━━━━";
      const text = [
        `🔖 Order: ${orderNumber}`,
        `🕒 Placed: ${placed}`,
        rule,
        "👤 CUSTOMER",
        `🙋 ${info.name}`,
        `📱 ${info.phone}`,
        `✉️ ${info.email}`,
        `🏠 ${info.address}`,
        `🗓️ Delivery: ${when}${win ? " · " + win : ""}`,
        ...(note ? [`📝 Note: ${note}`] : []),
        rule,
        "🛒 ITEMS",
        ...itemLines,
        rule,
        `🧮 Dishes: ${usd(subtotal + (info.discount ?? 0))}`,
        ...(info.discount ? [`🏷️ Promo ${info.promo ?? ""}: -${usd(info.discount)}`] : []),
        `🚗 Delivery (${info.miles} mi): ${usd(info.deliveryFee)}`,
        `✅ TOTAL: ${usd(total)}`,
      ].join("\n");
      // Telegram (primary): no shared-IP limits.
      if (tgToken && tgChat) {
        const bigDate = new Date(info.requestedAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago" }).toUpperCase();
        const bar = "━━━━━━━━━━━━━━━━";
        const tgHtml = [
          `🔔 <b>NEW ORDER ${esc(orderNumber)}</b>`,
          "",
          `<blockquote>⏰ <b>${info.pickup ? "PICKUP ON" : "DELIVER ON"}</b>\n📅 <b><u>${esc(bigDate)}</u></b>\n🕐 <code>${esc(win || "time not set")}</code></blockquote>`,
          bar,
          "<b>👤 CUSTOMER</b>",
          `🙋 <b>${esc(info.name)}</b>`,
          `📱 ${esc(info.phone)}`,
          `✉️ ${esc(info.email)}`,
          info.pickup ? "🛍️ <b>PICKUP</b> (no delivery)" : `🏠 ${esc(info.address)}`,
          ...(note ? [`📝 <i>${esc(note)}</i>`] : []),
          bar,
          "<b>🛒 ITEMS</b>",
          ...info.items.flatMap((i) => [`🍽️ <b>${i.quantity} ×</b> ${esc(names.get(i.slug) ?? i.slug)}${i.options ? " (" + esc(i.options) + ")" : ""} — ${usd(i.quantity * (prices.get(i.slug) ?? 0))}`, ...(AR_NAMES[i.slug] ? [`🇪🇬 <i>${esc(AR_NAMES[i.slug])}</i>`] : [])]),
          bar,
          `🧮 Dishes: ${usd(subtotal + (info.discount ?? 0))}`,
          ...(info.discount ? [`🏷️ Promo ${esc(info.promo ?? "")}: -${usd(info.discount)}`] : []),
          info.pickup ? "🛍️ Pickup: free" : `🚗 Delivery (${info.miles} mi): ${usd(info.deliveryFee)}`,
          `✅ <b>TOTAL: ${usd(total)}</b>`,
          bar,
          `📦 <b>Total items: ${info.items.reduce((n, i) => n + i.quantity, 0)}</b>`,
        ].join("\n");
        const tr = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text: tgHtml, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: "Open dashboard", url: "https://finance.pharaohsbites.com/#/orders" }]] } }),
          signal: AbortSignal.timeout(10000),
        }).catch((e) => { console.error("telegram failed", String(e)); return null; });
        if (!tr) status.push("telegram: network error");
        else if (!tr.ok) { const t = await tr.text(); console.error("telegram status", tr.status, t); status.push(`telegram ${tr.status}: ${t.slice(0, 160)}`); }
      }
      // ntfy (backup). A failure here must never stop the receipt email.
      if (topic) {
        const nr = await fetch(`https://ntfy.sh/${topic}`, {
          method: "POST",
          headers: { Title: `New order ${orderNumber}`, Priority: "urgent", Tags: "bell", Click: "https://finance.pharaohsbites.com/#/orders", ...(Deno.env.get("NTFY_TOKEN") ? { Authorization: `Bearer ${Deno.env.get("NTFY_TOKEN")!.trim()}` } : {}) },
          body: text,
          signal: AbortSignal.timeout(10000),
        }).catch((e) => { console.error("ntfy failed", String(e)); return null; });
        if (!nr) status.push("ntfy: network error");
        else if (!nr.ok) { const t = await nr.text(); console.error("ntfy status", nr.status, t); status.push(`ntfy ${nr.status}`); }
      }
    }

    const rUrl = Deno.env.get("RECEIPT_URL"), rToken = Deno.env.get("RECEIPT_TOKEN");
    if (rUrl && rToken && info.email && !info.email.toLowerCase().endsWith("@example.com")) {
      await fetch(rUrl, {
        method: "POST",
        body: JSON.stringify({ token: rToken, kind: "receipt", to: info.email, subject: `Your Pharaoh's Bites order ${orderNumber}`, html: receiptHtml(orderNumber, info, lines, subtotal, total) }),
        signal: AbortSignal.timeout(20000),
      }).catch((e) => console.error("receipt failed", String(e)));
    }
    return status.length ? status.join("; ") : "ok";
  } catch (e) { console.error("notify failed", String(e)); return "notify failed: " + String(e); }
}
