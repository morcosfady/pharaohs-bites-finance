import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { ChevronDown, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Skeleton } from "./ui";
import { useCategoryRows } from "../hooks/queries";
import { breakdown, quickTotals, donutSlices, colorFor, categoryEmoji, type CategoryShare } from "../lib/categoryBreakdown";
import { fmt } from "../lib/money";
import { previousRange, type DateRange } from "../lib/dates";

/* "Where the money goes": every category on its own, in a donut and a ranked list.
   Sits on the All expenses tab and follows the date filter above it. */

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

export function CategoryBreakdown({ range }: { range: DateRange }) {
  const prev = useMemo(() => previousRange(range), [range]);
  const cur = useCategoryRows(range);
  const before = useCategoryRows(prev);
  const [open, setOpen] = useState<string | null>(null);

  const b = useMemo(() => breakdown(cur.data ?? [], before.data ?? []), [cur.data, before.data]);
  // colours follow the ranking on screen, so the biggest categories are always different colours
  const order = useMemo(() => b.categories.map((c) => c.name), [b.categories]);
  const slices = useMemo(() => donutSlices(b.categories), [b.categories]);
  const quick = useMemo(() => quickTotals(b), [b]);
  const top = b.categories[0]?.cents ?? 0;

  if (cur.isLoading) return <Skeleton rows={5} className="card mb-5 p-5" />;

  return (
    <section className="card mb-5">
      <div className="card-head">
        <div><h2 className="card-title">Where the money goes</h2><p className="text-xs text-charcoal/50">Every category on its own, for the period above. Tap a category to see which vendors it came from.</p></div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 px-5 pb-4 sm:grid-cols-3 lg:grid-cols-5">
        {quick.map((q) => (
          <div key={q.key} className="rounded-xl border border-ivory-200 bg-white px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-teal-900/70"><span aria-hidden>{q.emoji}</span><span className="[overflow-wrap:anywhere]">{q.label}</span></div>
            <div className="mt-0.5 font-display text-xl font-semibold text-teal-900">{fmt(q.cents)}</div>
            <div className="text-xs text-charcoal/50">{q.cents > 0 ? `${pct(q.share)} of spending` : "nothing this period"}</div>
          </div>
        ))}
      </div>

      {b.categories.length === 0 ? (
        <p className="mx-5 mb-5 rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">No expenses in this period yet.</p>
      ) : (
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:items-start">
          <div className="relative mx-auto h-56 w-56 md:h-64 md:w-64" role="img" aria-label={`Spending by category, total ${fmt(b.totalCents)}`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={slices} dataKey="cents" nameKey="name" innerRadius="62%" outerRadius="96%" paddingAngle={slices.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
                  {slices.map((s) => <Cell key={s.name} fill={colorFor(s.name, order)} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [fmt(Number(v)), String(n)]} contentStyle={{ borderRadius: 10, border: "1px solid #eadfc6", fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-[11px] uppercase tracking-wider text-charcoal/50">Total spent</span>
              <span className="font-display text-2xl font-semibold text-teal-900">{fmt(b.totalCents)}</span>
              <span className="text-xs text-charcoal/50">{b.categories.length} categories</span>
            </div>
          </div>

          <ul className="divide-y divide-ivory-200">
            {b.categories.map((c) => (
              <Row key={c.name} c={c} top={top} color={colorFor(c.name, order)} open={open === c.name} onToggle={() => setOpen(open === c.name ? null : c.name)} />
            ))}
          </ul>
        </div>
      )}

      {b.personalCents > 0 && <p className="border-t border-ivory-200 px-5 py-2.5 text-xs text-charcoal/60">Not counted: {fmt(b.personalCents)} of personal items found on receipts. A receipt with mixed items is split, so each item counts under its own category.</p>}
    </section>
  );
}

function Row({ c, top, color, open, onToggle }: { c: CategoryShare; top: number; color: string; open: boolean; onToggle: () => void }) {
  const width = top > 0 ? Math.max((c.cents / top) * 100, 2) : 0;
  // for costs, spending MORE than last period is the warning direction
  const up = c.change != null && c.change > 0.005, down = c.change != null && c.change < -0.005;
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full py-2.5 text-left hover:bg-ivory-50">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <span aria-hidden>{categoryEmoji(c.name)}</span>
          <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{c.name}</span>
          <ChevronDown size={14} className={`shrink-0 text-charcoal/40 transition ${open ? "rotate-180" : ""}`} />
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-ivory-100"><div className="h-full rounded-full" style={{ width: `${width}%`, background: color }} /></div>
          <span className="flex shrink-0 items-baseline gap-2">
            {c.change != null && (up || down) && (
              <span className={`inline-flex items-center text-xs ${up ? "text-negative" : "text-positive"}`} title="Compared with the previous period">
                {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(Math.round(c.change * 100))}%
              </span>
            )}
            <b className="tabular-nums">{fmt(c.cents)}</b>
            <span className="w-9 text-right text-xs text-charcoal/50">{pct(c.share)}</span>
          </span>
        </div>
      </button>
      {open && (
        <ul className="mb-2 ml-5 space-y-1 rounded-lg bg-ivory-50 px-3 py-2 text-sm">
          {c.vendors.slice(0, 6).map((v) => (
            <li key={v.vendor} className="flex justify-between gap-3"><span className="min-w-0 truncate">{v.vendor}<span className="text-xs text-charcoal/50"> · {v.count} {v.count === 1 ? "entry" : "entries"}</span></span><b className="tabular-nums">{fmt(v.cents)}</b></li>
          ))}
          {c.vendors.length > 6 && <li className="text-xs text-charcoal/50">+ {c.vendors.length - 6} more vendors</li>}
          {c.prevCents > 0 && <li className="border-t border-ivory-200 pt-1 text-xs text-charcoal/50">Previous period: {fmt(c.prevCents)}</li>}
        </ul>
      )}
    </li>
  );
}
