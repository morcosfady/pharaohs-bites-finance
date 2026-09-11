import {
  startOfDay, endOfDay, subDays, startOfWeek, endOfWeek, subWeeks, startOfMonth, endOfMonth, subMonths,
  startOfQuarter, endOfQuarter, subQuarters, startOfYear, endOfYear, subYears, differenceInCalendarDays,
  format, parseISO, isValid,
} from "date-fns";

export type PresetKey = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "this_quarter" | "this_year" | "custom";

export interface DateRange { from: Date; to: Date; key: PresetKey }

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "this_year", label: "This year" },
  { key: "custom", label: "Custom" },
];

export function rangeFor(key: PresetKey, now = new Date(), custom?: { from: Date; to: Date }): DateRange {
  const wk = { weekStartsOn: 1 as const };
  switch (key) {
    case "today": return { key, from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": { const y = subDays(now, 1); return { key, from: startOfDay(y), to: endOfDay(y) }; }
    case "this_week": return { key, from: startOfWeek(now, wk), to: endOfWeek(now, wk) };
    case "last_week": { const w = subWeeks(now, 1); return { key, from: startOfWeek(w, wk), to: endOfWeek(w, wk) }; }
    case "this_month": return { key, from: startOfMonth(now), to: endOfMonth(now) };
    case "last_month": { const m = subMonths(now, 1); return { key, from: startOfMonth(m), to: endOfMonth(m) }; }
    case "this_quarter": return { key, from: startOfQuarter(now), to: endOfQuarter(now) };
    case "this_year": return { key, from: startOfYear(now), to: endOfYear(now) };
    case "custom": return { key, from: startOfDay(custom?.from ?? subDays(now, 30)), to: endOfDay(custom?.to ?? now) };
  }
}

/** The equivalent previous period (same length immediately before). */
export function previousRange(r: DateRange): DateRange {
  const wk = { weekStartsOn: 1 as const };
  switch (r.key) {
    case "this_month": case "last_month": { const m = subMonths(r.from, 1); return { key: r.key, from: startOfMonth(m), to: endOfMonth(m) }; }
    case "this_quarter": { const q = subQuarters(r.from, 1); return { key: r.key, from: startOfQuarter(q), to: endOfQuarter(q) }; }
    case "this_year": { const y = subYears(r.from, 1); return { key: r.key, from: startOfYear(y), to: endOfYear(y) }; }
    case "this_week": case "last_week": { const w = subWeeks(r.from, 1); return { key: r.key, from: startOfWeek(w, wk), to: endOfWeek(w, wk) }; }
    default: {
      const days = differenceInCalendarDays(r.to, r.from) + 1;
      return { key: r.key, from: startOfDay(subDays(r.from, days)), to: endOfDay(subDays(r.from, 1)) };
    }
  }
}

export function inRange(iso: string, r: DateRange): boolean {
  const d = new Date(iso);
  return d >= r.from && d <= r.to;
}

export function fmtDate(iso: string | null | undefined, pattern = "MMM d, yyyy"): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? parseISO(iso) : iso;
  return isValid(d) ? format(d, pattern) : "—";
}
export function fmtDateTime(iso: string | null | undefined): string { return fmtDate(iso, "MMM d, yyyy h:mm a"); }
export function toInputDate(d: Date): string { return format(d, "yyyy-MM-dd"); }

/** Bucket key for a chart series (day / week / month) depending on range length. */
export function bucketKey(iso: string, r: DateRange): string {
  const days = differenceInCalendarDays(r.to, r.from);
  const d = new Date(iso);
  if (days <= 31) return format(d, "yyyy-MM-dd");
  if (days <= 120) return format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd");
  return format(d, "yyyy-MM");
}
export function bucketLabel(key: string): string {
  if (/^\d{4}-\d{2}$/.test(key)) return format(parseISO(key + "-01"), "MMM yy");
  return format(parseISO(key), "MMM d");
}
