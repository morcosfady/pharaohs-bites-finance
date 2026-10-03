/** Website Pulse: turns the raw visitor log (site_events) into plain numbers.
 *  Visitors are anonymous: a random id from their browser. */

export type SiteEvent = {
  id: number;
  created_at: string;
  visitor_id: string;
  kind: "visit" | "add_to_basket" | "checkout_started" | "order_placed" | "problem";
  page: string;
  detail: string;
  meta: Record<string, string>;
};

export type Outcome = "ordered" | "stuck" | "left_basket" | "browsing";

export type Visitor = {
  id: string;
  firstSeen: string;
  lastSeen: string;
  device: string;
  source: string;
  pages: string[];
  items: string[];
  startedCheckout: boolean;
  orders: string[];
  problems: SiteEvent[];
  outcome: Outcome;
};

export type Problem = {
  id: number;
  at: string;
  level: "attention" | "heads_up" | "technical";
  title: string;
  who: string;
  what: string;
  hint: string;
};

export type Pulse = {
  visitors: Visitor[];
  funnel: { visited: number; viewedMenu: number; addedToBasket: number; startedCheckout: number; ordered: number };
  outcomes: Record<Outcome, number>;
  sources: { name: string; visitors: number; ordered: number }[];
  devices: { name: string; visitors: number }[];
  perDay: { day: string; visitors: number; ordered: number }[];
  leftBehind: { name: string; people: number }[];
  problems: Problem[];
};

/** Every channel we recognise: colour + short mark for its tile, and the tag that goes in a link (?src=...). */
export const SOURCE_INFO: { name: string; color: string; mark: string; tag: string; where: string }[] = [
  { name: "QR code (flyer)", color: "#1f2937", mark: "QR", tag: "qr", where: "The QR code on your flyer" },
  { name: "Nextdoor", color: "#00b246", mark: "N", tag: "nextdoor", where: "Nextdoor posts and ads" },
  { name: "Instagram", color: "#d6249f", mark: "IG", tag: "instagram", where: "Instagram bio and stories" },
  { name: "Facebook", color: "#1877f2", mark: "f", tag: "facebook", where: "Facebook page and ads" },
  { name: "TikTok", color: "#111111", mark: "TT", tag: "tiktok", where: "TikTok bio" },
  { name: "YouTube", color: "#ff0000", mark: "YT", tag: "youtube", where: "YouTube channel" },
  { name: "X (Twitter)", color: "#0f1419", mark: "X", tag: "x", where: "X / Twitter bio" },
  { name: "Snapchat", color: "#f5c400", mark: "SC", tag: "snapchat", where: "Snapchat" },
  { name: "Pinterest", color: "#e60023", mark: "P", tag: "pinterest", where: "Pinterest" },
  { name: "Reddit", color: "#ff4500", mark: "R", tag: "reddit", where: "Reddit" },
  { name: "LinkedIn", color: "#0a66c2", mark: "in", tag: "linkedin", where: "LinkedIn" },
  { name: "Threads", color: "#222222", mark: "@", tag: "threads", where: "Threads" },
  { name: "WhatsApp", color: "#25d366", mark: "WA", tag: "whatsapp", where: "WhatsApp status and chats" },
  { name: "Telegram", color: "#229ed9", mark: "TG", tag: "telegram", where: "Telegram" },
  { name: "Google", color: "#4285f4", mark: "G", tag: "google", where: "Google search and your Google profile" },
  { name: "Bing", color: "#008373", mark: "B", tag: "bing", where: "Bing search" },
  { name: "Email", color: "#8b5e3c", mark: "@", tag: "email", where: "Emails and newsletters" },
  { name: "Direct", color: "#6b7280", mark: "↗", tag: "", where: "Typed the address or opened a saved link" },
  { name: "Other website", color: "#9ca3af", mark: "…", tag: "", where: "A link on some other website" },
];

export const sourceInfo = (name: string) => SOURCE_INFO.find((s) => s.name === name) ?? { name, color: "#9ca3af", mark: name.slice(0, 2).toUpperCase(), tag: "", where: "" };

/** Channels worth showing as an empty tile even before the first visit. */
export const MAIN_CHANNELS = ["QR code (flyer)", "Nextdoor", "Instagram", "Facebook", "TikTok", "Google", "WhatsApp"];

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Plain-words version of a problem the website saw. */
export function describeProblem(e: SiteEvent): Problem {
  const type = e.meta.type ?? "page";
  const msg = e.detail;
  const who = e.meta.name || e.meta.phone4 || e.meta.zip
    ? [e.meta.name, e.meta.phone4 ? `phone ending ${e.meta.phone4}` : "", e.meta.zip ? `ZIP ${e.meta.zip}` : ""].filter(Boolean).join(", ")
    : "";
  if (type === "order") {
    let hint = "Ask them to press Try again. If it keeps failing, message them on WhatsApp and add the order by hand.";
    let what = msg;
    if (/delivery address|find that address/i.test(msg)) { what = "The delivery address could not be checked."; hint = "Usually the free address lookup service was slow. Pressing Try again normally works."; }
    else if (/one-time|already been used|just used/i.test(msg)) { what = "They tried a promo code that was already used."; hint = "Nothing to fix. They can remove the code and order normally."; }
    else if (/fully booked|closed/i.test(msg)) { what = "They picked a day that is closed."; hint = "They need to choose another date."; }
    else if (/timed out|network/i.test(msg)) { what = "Their connection dropped while sending the order."; hint = "Nothing was lost on their side. They can try again."; }
    else if (/no longer available/i.test(msg)) { what = "A dish in their basket is no longer available."; hint = "Check that the dish is active in Menu & Profit."; }
    return { id: e.id, at: e.created_at, level: "attention", title: "A customer could not place an order", who, what, hint };
  }
  if (type === "address") {
    return { id: e.id, at: e.created_at, level: "heads_up", title: "Delivery fee could not be worked out", who, what: "They saw “check your address” instead of a delivery fee.", hint: "Often a typo in the street or ZIP, or the address lookup was slow. If it repeats for one ZIP, tell me and I will check it." };
  }
  if (type === "promo") {
    return { id: e.id, at: e.created_at, level: "heads_up", title: `Promo code ${e.meta.code || ""} was refused`.trim(), who, what: msg, hint: "Nothing broken: the code rules did their job. Worth a look only if the customer was meant to get it." };
  }
  return { id: e.id, at: e.created_at, level: "technical", title: "Small glitch in a visitor's browser", who, what: msg, hint: "Usually harmless. If you see the same one many times, tell me and I will look into it." };
}

export function buildPulse(events: SiteEvent[]): Pulse {
  const byVisitor = new Map<string, Visitor>();
  const ordered = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const e of ordered) {
    let v = byVisitor.get(e.visitor_id);
    if (!v) {
      v = { id: e.visitor_id, firstSeen: e.created_at, lastSeen: e.created_at, device: "", source: "", pages: [], items: [], startedCheckout: false, orders: [], problems: [], outcome: "browsing" };
      byVisitor.set(e.visitor_id, v);
    }
    v.lastSeen = e.created_at;
    if (e.meta.device && !v.device) v.device = e.meta.device;
    if (e.kind === "visit") {
      if (e.meta.source && !v.source) v.source = e.meta.source;
      if (e.page && !v.pages.includes(e.page)) v.pages.push(e.page);
    } else if (e.kind === "add_to_basket") {
      const name = e.meta.item || e.detail;
      if (name && !v.items.includes(name)) v.items.push(name);
    } else if (e.kind === "checkout_started") v.startedCheckout = true;
    else if (e.kind === "order_placed") { if (e.detail && !v.orders.includes(e.detail)) v.orders.push(e.detail); }
    else if (e.kind === "problem") v.problems.push(e);
  }

  const visitors = [...byVisitor.values()];
  for (const v of visitors) {
    const trouble = v.problems.some((p) => p.meta.type === "order" || p.meta.type === "address");
    v.outcome = v.orders.length ? "ordered" : trouble && (v.startedCheckout || v.items.length) ? "stuck" : v.items.length ? "left_basket" : "browsing";
  }
  visitors.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  const outcomes: Record<Outcome, number> = { ordered: 0, stuck: 0, left_basket: 0, browsing: 0 };
  visitors.forEach((v) => { outcomes[v.outcome]++; });

  const funnel = {
    visited: visitors.length,
    viewedMenu: visitors.filter((v) => v.pages.some((p) => p === "order" || p === "menu")).length,
    addedToBasket: visitors.filter((v) => v.items.length > 0 || v.orders.length > 0).length,
    startedCheckout: visitors.filter((v) => v.startedCheckout || v.orders.length > 0).length,
    ordered: outcomes.ordered,
  };

  const srcMap = new Map<string, { visitors: number; ordered: number }>();
  const devMap = new Map<string, number>();
  for (const v of visitors) {
    const s = v.source || "Direct";
    const row = srcMap.get(s) ?? { visitors: 0, ordered: 0 };
    row.visitors++; if (v.outcome === "ordered") row.ordered++;
    srcMap.set(s, row);
    const d = v.device || "computer";
    devMap.set(d, (devMap.get(d) ?? 0) + 1);
  }

  const dayMap = new Map<string, { visitors: Set<string>; ordered: Set<string> }>();
  for (const e of ordered) {
    const k = dayKey(e.created_at);
    const row = dayMap.get(k) ?? { visitors: new Set<string>(), ordered: new Set<string>() };
    row.visitors.add(e.visitor_id);
    if (e.kind === "order_placed") row.ordered.add(e.visitor_id);
    dayMap.set(k, row);
  }

  const left = new Map<string, number>();
  for (const v of visitors) if (v.outcome !== "ordered") for (const i of v.items) left.set(i, (left.get(i) ?? 0) + 1);

  return {
    visitors,
    funnel,
    outcomes,
    sources: [...srcMap].map(([name, r]) => ({ name, ...r })).sort((a, b) => b.visitors - a.visitors),
    devices: [...devMap].map(([name, visitors]) => ({ name, visitors })).sort((a, b) => b.visitors - a.visitors),
    perDay: [...dayMap].map(([day, r]) => ({ day, visitors: r.visitors.size, ordered: r.ordered.size })).sort((a, b) => a.day.localeCompare(b.day)),
    leftBehind: [...left].map(([name, people]) => ({ name, people })).sort((a, b) => b.people - a.people).slice(0, 8),
    problems: ordered.filter((e) => e.kind === "problem").map(describeProblem).reverse(),
  };
}
