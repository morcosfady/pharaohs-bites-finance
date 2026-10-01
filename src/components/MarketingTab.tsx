import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Plus, ChevronDown, ArrowUpRight, ArrowDownRight, Megaphone } from "lucide-react";
import { Skeleton, EmptyState, KpiCard, useToast } from "./ui";
import { useMarketingExpenses, useAllOrderFinancials, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { summarizeMarketing, CHANNELS, type ChannelShare, type ChannelKey } from "../lib/marketing";
import { colorFor } from "../lib/categoryBreakdown";
import { REVENUE_STATUSES } from "../lib/metrics";
import { fmt, toCents } from "../lib/money";
import { fmtDate, previousRange, inRange, type DateRange } from "../lib/dates";

/* Marketing: what you spend to get customers, by channel (social media, flyers and print, ads...), what share of
   sales it is, and what each order costs you in marketing. Charges from the bank (Meta, TikTok, Vistaprint...)
   land here by themselves; the channel is a guess you can change with one tap. */

const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

export function MarketingTab({ range, onAdd, onOpenExpense }: { range: DateRange; onAdd: () => void; onOpenExpense: (id: string) => void }) {
  const prev = useMemo(() => previousRange(range), [range]);
  const cur = useMarketingExpenses(range);
  const before = useMarketingExpenses(prev);
  const fin = useAllOrderFinancials();
  const [open, setOpen] = useState<string | null>(null);

  const sales = useMemo(() => {
    const live = (fin.data ?? []).filter((o) => REVENUE_STATUSES.includes(o.status) && o.status !== "refunded" && inRange(o.created_at, range));
    return { cents: live.reduce((s, o) => s + toCents(o.net_product_sales), 0), orders: live.length };
  }, [fin.data, range]);
  const m = useMemo(() => summarizeMarketing(cur.data ?? [], before.data ?? [], sales.cents, sales.orders), [cur.data, before.data, sales]);
  const order = useMemo(() => m.channels.map((c) => c.label), [m.channels]);
  const top = m.channels[0]?.cents ?? 0;

  if (cur.isLoading) return <Skeleton rows={5} className="card p-5" />;
  const up = m.change != null && m.change > 0.005, down = m.change != null && m.change < -0.005;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-charcoal/60">What you spend to bring customers in. Meta, TikTok, Vistaprint and similar bank charges appear here by themselves.</p>
        <button className="btn-gold btn-sm" onClick={onAdd}><Plus size={16} /> Add marketing expense</button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card flex flex-col gap-1 px-4 py-3">
          <span className="text-xs font-medium uppercase leading-tight tracking-wider text-teal-900/70">Marketing spend</span>
          <span className="font-display text-3xl font-semibold leading-none text-teal-900">{fmt(m.totalCents)}</span>
          <span className="text-xs text-charcoal/55">{(up || down) ? <span className={`inline-flex items-center ${up ? "text-negative" : "text-positive"}`}>{up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(Math.round((m.change ?? 0) * 100))}% vs last period</span> : "all channels"}</span>
        </div>
        <KpiCard label="Share of sales" value={m.pctOfSales == null ? null : Math.round(m.pctOfSales * 1000) / 10} kind="pct" formula="Marketing spend ÷ product sales in the period. Many small food businesses stay under 10%." />
        <div className="card flex flex-col gap-1 px-4 py-3">
          <span className="text-xs font-medium uppercase leading-tight tracking-wider text-teal-900/70">Marketing per order</span>
          <span className="font-display text-3xl font-semibold leading-none text-teal-900">{m.costPerOrderCents == null ? "—" : fmt(m.costPerOrderCents)}</span>
          <span className="text-xs text-charcoal/55">{sales.orders ? `${sales.orders} order${sales.orders === 1 ? "" : "s"} in the period` : "no orders yet"}</span>
        </div>
        <div className="card flex flex-col gap-1 px-4 py-3">
          <span className="text-xs font-medium uppercase leading-tight tracking-wider text-teal-900/70">Biggest channel</span>
          <span className="font-display text-xl font-semibold leading-tight text-teal-900 [overflow-wrap:anywhere]">{m.channels[0] ? `${m.channels[0].emoji} ${m.channels[0].label}` : "—"}</span>
          <span className="text-xs text-charcoal/55">{m.channels[0] ? `${fmt(m.channels[0].cents)} · ${pct(m.channels[0].share)}` : "nothing spent yet"}</span>
        </div>
      </div>

      <section className="card">
        <div className="card-head"><div><h2 className="card-title inline-flex items-center gap-2"><Megaphone size={16} className="text-gold" /> By channel</h2><p className="text-xs text-charcoal/50">Tap a channel to see each charge. The channel is a guess from the vendor name: change it on any charge.</p></div></div>
        {m.channels.length === 0 ? <div className="px-5 pb-5"><EmptyState title="No marketing spend in this period" hint="Add a flyer print job or an ad, or pick a longer period above." action={<button className="btn-gold btn-sm" onClick={onAdd}><Plus size={14} /> Add marketing expense</button>} /></div> : (
          <div className="grid gap-4 px-5 pb-5 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:items-start">
            <div className="relative mx-auto h-52 w-52 md:h-60 md:w-60" role="img" aria-label={`Marketing by channel, total ${fmt(m.totalCents)}`}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={m.channels.map((c) => ({ name: c.label, cents: c.cents }))} dataKey="cents" nameKey="name" innerRadius="62%" outerRadius="96%" paddingAngle={m.channels.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
                    {m.channels.map((c) => <Cell key={c.key} fill={colorFor(c.label, order)} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [fmt(Number(v)), String(n)]} contentStyle={{ borderRadius: 10, border: "1px solid #eadfc6", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] uppercase tracking-wider text-charcoal/50">Marketing</span>
                <span className="font-display text-2xl font-semibold text-teal-900">{fmt(m.totalCents)}</span>
              </div>
            </div>
            <ul className="divide-y divide-ivory-200">
              {m.channels.map((c) => <ChannelRow key={c.key} c={c} top={top} color={colorFor(c.label, order)} open={open === c.key} onToggle={() => setOpen(open === c.key ? null : c.key)} onOpenExpense={onOpenExpense} />)}
            </ul>
          </div>
        )}
        {m.unused.length > 0 && m.channels.length > 0 && <p className="border-t border-ivory-200 px-5 py-2.5 text-xs text-charcoal/60">Not used in this period: {m.unused.join(", ")}.</p>}
      </section>
    </div>
  );
}

function ChannelRow({ c, top, color, open, onToggle, onOpenExpense }: { c: ChannelShare; top: number; color: string; open: boolean; onToggle: () => void; onOpenExpense: (id: string) => void }) {
  const width = top > 0 ? Math.max((c.cents / top) * 100, 2) : 0;
  const up = c.change != null && c.change > 0.005, down = c.change != null && c.change < -0.005;
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full py-2.5 text-left hover:bg-ivory-50">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <span aria-hidden>{c.emoji}</span>
          <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{c.label}</span>
          <ChevronDown size={14} className={`shrink-0 text-charcoal/40 transition ${open ? "rotate-180" : ""}`} />
        </div>
        <div className="mt-1.5 flex items-center gap-3">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-ivory-100"><div className="h-full rounded-full" style={{ width: `${width}%`, background: color }} /></div>
          <span className="flex shrink-0 items-baseline gap-2">
            {(up || down) && <span className={`inline-flex items-center text-xs ${up ? "text-negative" : "text-positive"}`} title="Compared with the previous period">{up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(Math.round((c.change ?? 0) * 100))}%</span>}
            <b className="tabular-nums">{fmt(c.cents)}</b>
            <span className="w-9 text-right text-xs text-charcoal/50">{pct(c.share)}</span>
          </span>
        </div>
      </button>
      {open && <ul className="mb-2 ml-5 divide-y divide-ivory-200 rounded-lg bg-ivory-50 px-3 text-sm">{c.entries.slice(0, 40).map((e) => <Entry key={e.id} e={e} onOpen={() => onOpenExpense(e.id)} />)}</ul>}
    </li>
  );
}

function Entry({ e, onOpen }: { e: ReturnType<typeof summarizeMarketing>["channels"][number]["entries"][number]; onOpen: () => void }) {
  const write = useWrite(); const toast = useToast();
  const move = async (key: string) => {
    try { await write.mutateAsync(async () => unwrap(await supabase.from("expenses").update({ marketing_channel: key as ChannelKey }).eq("id", e.id).select("id"))); toast.push("Moved to " + (CHANNELS.find((c) => c.key === key)?.label ?? key)); }
    catch (err) { toast.push((err as Error).message, "err"); }
  };
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 truncate text-left font-medium text-teal-800 hover:underline">{e.vendor || "—"}</button>
        <b className="shrink-0 tabular-nums">{fmt(toCents(e.total_amount))}</b>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-charcoal/50">
        <span className="min-w-0 truncate">{fmtDate(e.expense_date)}{e.description ? ` · ${e.description}` : ""}</span>
        <select className="input !w-auto !py-0.5 text-xs" aria-label={`Channel for ${e.vendor}`} value={e.marketing_channel ?? "other"} disabled={write.isPending} onChange={(ev) => void move(ev.target.value)}>
          {CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.emoji} {c.label}</option>)}
        </select>
      </div>
    </li>
  );
}

