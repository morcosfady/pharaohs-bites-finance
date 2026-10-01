/* Marketing spend by channel. The channel is stored on each marketing expense (guessed from the vendor in the
   database, changeable by the owner). Money is summed in cents. */
import { toCents } from "./money";
import type { Num } from "./types";

export type ChannelKey = "social" | "flyers_print" | "online_ads" | "email_web" | "events" | "influencers" | "other";
export const CHANNELS: { key: ChannelKey; label: string; emoji: string; hint: string }[] = [
  { key: "social", label: "Social media", emoji: "📱", hint: "Facebook, Instagram, TikTok ads and boosts" },
  { key: "flyers_print", label: "Flyers & print", emoji: "📄", hint: "Flyers, business cards, banners, stickers, menus" },
  { key: "online_ads", label: "Online ads", emoji: "🔎", hint: "Google, Yelp, Nextdoor" },
  { key: "email_web", label: "Email & website", emoji: "✉️", hint: "Newsletters, email tools, SEO" },
  { key: "events", label: "Events & samples", emoji: "🎪", hint: "Tastings, booths, pop-ups, giveaways" },
  { key: "influencers", label: "Influencers & collabs", emoji: "🤝", hint: "Creators, sponsorships, partnerships" },
  { key: "other", label: "Other marketing", emoji: "📣", hint: "Anything else that gets you customers" },
];
export const channelOf = (key: string | null | undefined) => CHANNELS.find((c) => c.key === key) ?? CHANNELS[CHANNELS.length - 1];

export interface MarketingExpense {
  id: string; expense_date: string; vendor: string; description: string; total_amount: Num; marketing_channel: string | null; receipt_path: string;
}
export interface ChannelShare { key: ChannelKey; label: string; emoji: string; cents: number; count: number; share: number; prevCents: number; change: number | null; entries: MarketingExpense[] }
export interface MarketingSummary {
  totalCents: number; prevTotalCents: number; change: number | null; channels: ChannelShare[]; unused: string[];
  /** marketing cost as a share of sales; null when there were no sales */
  pctOfSales: number | null; /** marketing cost divided by orders; null when there were no orders */ costPerOrderCents: number | null;
}

function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return cur > 0 ? null : 0;
  return (cur - prev) / prev;
}

export function summarizeMarketing(rows: MarketingExpense[], prevRows: MarketingExpense[], salesCents: number, orders: number): MarketingSummary {
  const sum = (list: MarketingExpense[]) => {
    const m = new Map<ChannelKey, { cents: number; entries: MarketingExpense[] }>();
    for (const r of list) {
      const k = channelOf(r.marketing_channel).key;
      const e = m.get(k) ?? { cents: 0, entries: [] };
      e.cents += toCents(r.total_amount); e.entries.push(r); m.set(k, e);
    }
    return m;
  };
  const cur = sum(rows), prev = sum(prevRows);
  const totalCents = [...cur.values()].reduce((s, e) => s + e.cents, 0);
  const prevTotalCents = [...prev.values()].reduce((s, e) => s + e.cents, 0);
  const channels = CHANNELS.filter((c) => cur.has(c.key)).map((c) => {
    const e = cur.get(c.key)!;
    return { key: c.key, label: c.label, emoji: c.emoji, cents: e.cents, count: e.entries.length, share: totalCents > 0 ? e.cents / totalCents : 0,
      prevCents: prev.get(c.key)?.cents ?? 0, change: pctChange(e.cents, prev.get(c.key)?.cents ?? 0),
      entries: [...e.entries].sort((a, b) => b.expense_date.localeCompare(a.expense_date)) };
  }).sort((a, b) => b.cents - a.cents);
  return {
    totalCents, prevTotalCents, change: pctChange(totalCents, prevTotalCents), channels,
    unused: CHANNELS.filter((c) => !cur.has(c.key) && c.key !== "other").map((c) => c.label),
    pctOfSales: salesCents > 0 ? totalCents / salesCents : null,
    costPerOrderCents: orders > 0 ? Math.round(totalCents / orders) : null,
  };
}
