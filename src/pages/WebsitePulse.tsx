import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { Copy, Smartphone, Monitor, Tablet, ShoppingBag, ShoppingBasket, Eye, AlertTriangle, Info } from "lucide-react";
import { supabase, unwrap } from "../lib/supabase";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { PageHeader, Skeleton, ErrorBox, EmptyState, useToast } from "../components/ui";
import { buildPulse, sourceInfo, SOURCE_INFO, MAIN_CHANNELS, type Outcome, type SiteEvent, type Visitor } from "../lib/siteActivity";
import type { DateRange } from "../lib/dates";

/** Accent colour of this tab (nav icon + headings). */
export const PULSE_COLOR = "#d9822b";

/** The visitor log, newest first. Supabase returns 1000 rows per request, so ask in pages. */
function useSiteEvents(range: DateRange) {
  return useQuery({
    queryKey: ["site_events", range.from.toISOString(), range.to.toISOString()],
    refetchInterval: 60_000,
    queryFn: async () => {
      const all: SiteEvent[] = [];
      for (let from = 0; from < 20000; from += 1000) {
        const rows = unwrap(await supabase.from("site_events").select("id, created_at, visitor_id, kind, page, detail, meta")
          .gte("created_at", range.from.toISOString()).lte("created_at", range.to.toISOString())
          .order("id", { ascending: false }).range(from, from + 999)) as SiteEvent[];
        all.push(...rows);
        if (rows.length < 1000) break;
      }
      return all;
    },
  });
}

/** Order numbers -> order ids, so a visitor's order can be opened. */
function useOrderIds(numbers: string[]) {
  return useQuery({
    enabled: numbers.length > 0,
    queryKey: ["pulse_order_ids", numbers.join(",")],
    queryFn: async () => {
      const rows = unwrap(await supabase.from("orders").select("id, order_number").in("order_number", numbers)) as { id: string; order_number: string }[];
      return new Map(rows.map((r) => [r.order_number, r.id]));
    },
  });
}

const OUTCOME: Record<Outcome, { label: string; cls: string }> = {
  ordered: { label: "Ordered", cls: "bg-emerald-100 text-emerald-800" },
  stuck: { label: "Tried to order, hit a problem", cls: "bg-red-100 text-red-800" },
  left_basket: { label: "Left with items in basket", cls: "bg-amber-100 text-amber-800" },
  browsing: { label: "Just looking", cls: "bg-slate-100 text-slate-700" },
};

const DeviceIcon = ({ d }: { d: string }) => d === "phone" ? <Smartphone size={14} /> : d === "tablet" ? <Tablet size={14} /> : <Monitor size={14} />;

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return <div className="h-2.5 w-full rounded-full bg-ivory-200"><div className="h-2.5 rounded-full" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, backgroundColor: color }} /></div>;
}

const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export function WebsitePulsePage() {
  const [range, setRange] = useDateRange("this_week");
  const q = useSiteEvents(range);
  const pulse = useMemo(() => buildPulse(q.data ?? []), [q.data]);
  const orderNumbers = useMemo(() => [...new Set(pulse.visitors.flatMap((v) => v.orders))], [pulse.visitors]);
  const orderIds = useOrderIds(orderNumbers);
  const [filter, setFilter] = useState<"all" | Outcome>("all");
  const [showTech, setShowTech] = useState(false);
  const f = pulse.funnel;
  const toast = useToast();
  const SITE = "https://pharaohsbites.com";
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.push("Link copied"), () => toast.push("Could not copy, select the link and copy it", "err"));
  const seen = new Set(pulse.sources.map((s) => s.name));
  const empty = MAIN_CHANNELS.filter((n) => !seen.has(n));

  const visitorsShown = pulse.visitors.filter((v) => filter === "all" || v.outcome === filter).slice(0, 60);
  const problems = pulse.problems.filter((p) => showTech || p.level !== "technical");
  const maxDay = Math.max(1, ...pulse.perDay.map((d) => d.visitors));
  const steps = [
    { label: "Visited the website", n: f.visited, icon: Eye },
    { label: "Looked at the menu", n: f.viewedMenu, icon: Eye },
    { label: "Added something to the basket", n: f.addedToBasket, icon: ShoppingBasket },
    { label: "Pressed Place Order", n: f.startedCheckout, icon: ShoppingBag },
    { label: "Order placed", n: f.ordered, icon: ShoppingBag },
  ];

  const linksSection = (
    <section className="card p-4">
      <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>Your tracking links</h2>
      <p className="mb-3 text-xs text-charcoal/60">Use these exact links where you share the website, and every visit is counted under the right name. Without them, many visits (flyer QR codes, Nextdoor, Instagram bio) just show up as “Direct”. The QR code on a new flyer should open the first link.</p>
      <ul className="grid gap-2 md:grid-cols-2">
        {SOURCE_INFO.filter((s) => s.tag).map((s) => {
          const link = s.tag === "qr" ? `${SITE}/qr` : `${SITE}/?src=${s.tag}`;
          return (
            <li key={s.tag} className="flex items-center gap-3 rounded-lg bg-ivory-50 px-3 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: s.color }}>{s.mark}</span>
              <div className="min-w-0 flex-1"><div className="text-sm font-medium text-teal-900">{s.name}</div><div className="truncate text-xs text-charcoal/60" title={link}>{link}</div></div>
              <button type="button" className="btn-ghost inline-flex items-center gap-1 text-xs" onClick={() => copy(link)}><Copy size={14} /> Copy</button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div>
      <PageHeader title="Website Pulse" crumbs={["Home", "Website Pulse"]} />
      <p className="mb-3 max-w-3xl text-sm text-charcoal/70">Who visits your website, who ends up ordering, who leaves, and anything that went wrong along the way. Visitors are anonymous: we only count them, we never see names unless an order fails (then just a first name and the last 4 phone digits, so you can help them).</p>
      <DateRangeBar range={range} onChange={setRange} />

      {q.error ? <ErrorBox error={q.error} /> : q.isLoading ? <Skeleton rows={8} className="card p-5" /> : f.visited === 0 ? (
        <div className="card"><EmptyState title="No visits recorded for this period yet" hint="Visits appear here within a minute. Your own visits are not counted if you opened the website once with ?me=1 on that device." /></div>
      ) : null}
      {q.error || q.isLoading || f.visited > 0 ? null : <div className="mt-4">{linksSection}</div>}
      {q.error || q.isLoading || f.visited === 0 ? null : (
        <div className="grid gap-4">
          {/* Headline numbers */}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="card px-4 py-3"><div className="text-xs font-medium uppercase tracking-wider text-teal-900/70">Visitors</div><div className="font-display text-3xl font-semibold text-teal-900">{f.visited}</div><div className="text-xs text-charcoal/60">different people on the website</div></div>
            <div className="card px-4 py-3"><div className="text-xs font-medium uppercase tracking-wider text-teal-900/70">Ordered</div><div className="font-display text-3xl font-semibold text-positive">{pulse.outcomes.ordered}</div><div className="text-xs text-charcoal/60">{pctOf(pulse.outcomes.ordered, f.visited)} of visitors bought</div></div>
            <div className="card px-4 py-3"><div className="text-xs font-medium uppercase tracking-wider text-teal-900/70">Left without ordering</div><div className="font-display text-3xl font-semibold text-teal-900">{f.visited - pulse.outcomes.ordered}</div><div className="text-xs text-charcoal/60">{pulse.outcomes.left_basket + pulse.outcomes.stuck} of them had items in the basket</div></div>
            <div className="card px-4 py-3"><div className="text-xs font-medium uppercase tracking-wider text-teal-900/70">Problems seen</div><div className={`font-display text-3xl font-semibold ${pulse.problems.filter((p) => p.level === "attention").length ? "text-negative" : "text-teal-900"}`}>{pulse.problems.filter((p) => p.level !== "technical").length}</div><div className="text-xs text-charcoal/60">{pulse.problems.filter((p) => p.level === "attention").length} stopped an order</div></div>
          </section>

          {/* Journey */}
          <section className="card p-4">
            <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>The journey to an order</h2>
            <p className="mb-3 text-xs text-charcoal/60">Each step shows how many visitors got that far. Big drops show where people give up.</p>
            <div className="grid gap-3">
              {steps.map((s, i) => (
                <div key={s.label}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="text-teal-900">{i + 1}. {s.label}</span>
                    <span className="font-medium">{s.n} <span className="font-normal text-charcoal/50">{i === 0 ? "" : `· ${pctOf(s.n, steps[i - 1].n)} of the step before`}</span></span>
                  </div>
                  <Bar value={s.n} max={steps[0].n} color={i === steps.length - 1 ? "#16855B" : PULSE_COLOR} />
                </div>
              ))}
            </div>
          </section>

          {/* Where visitors come from */}
          <section className="card p-4">
            <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>Where visitors come from</h2>
            <p className="mb-4 text-xs text-charcoal/60">Which of your channels (flyer, Instagram, Nextdoor...) bring people in, and which of them actually order. Channels with no visitors yet are greyed out.</p>
            <div className="grid items-center gap-4 lg:grid-cols-[240px_1fr]">
              <div className="mx-auto h-56 w-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pulse.sources} dataKey="visitors" nameKey="name" innerRadius={62} outerRadius={100} paddingAngle={2} stroke="none">
                      {pulse.sources.map((s) => <Cell key={s.name} fill={sourceInfo(s.name).color} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none -mt-36 text-center"><div className="font-display text-3xl font-semibold text-teal-900">{f.visited}</div><div className="text-xs text-charcoal/60">visitors</div></div>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {pulse.sources.map((s) => {
                  const info = sourceInfo(s.name);
                  return (
                    <div key={s.name} className="rounded-xl border border-ivory-200 bg-white p-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style={{ backgroundColor: info.color }}>{info.mark}</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-teal-900">{s.name}</div>
                          <div className="text-xs text-charcoal/60">{pctOf(s.visitors, f.visited)} of all visitors</div>
                        </div>
                        <div className="text-right"><div className="font-display text-2xl font-semibold leading-none text-teal-900">{s.visitors}</div><div className="text-[10px] uppercase text-charcoal/50">visitors</div></div>
                      </div>
                      <div className="mt-2"><Bar value={s.visitors} max={pulse.sources[0].visitors} color={info.color} /></div>
                      <div className="mt-1.5 flex justify-between text-xs"><span className={s.ordered ? "font-medium text-positive" : "text-charcoal/50"}>{s.ordered} ordered</span><span className="text-charcoal/50">{pctOf(s.ordered, s.visitors)} bought</span></div>
                    </div>
                  );
                })}
                {empty.map((n) => {
                  const info = sourceInfo(n);
                  return (
                    <div key={n} className="rounded-xl border border-dashed border-ivory-300 bg-ivory-50/60 p-3 opacity-70">
                      <div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ivory-200 text-sm font-bold text-charcoal/50">{info.mark}</span><div className="flex-1 font-medium text-charcoal/60">{n}</div><div className="text-xs text-charcoal/50">no visitors yet</div></div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-3 border-t border-ivory-200 pt-3 text-sm">
              {pulse.devices.map((d) => <span key={d.name} className="inline-flex items-center gap-1.5 rounded-full bg-ivory-100 px-3 py-1 capitalize"><DeviceIcon d={d.name} /> {d.name}: {d.visitors} ({pctOf(d.visitors, f.visited)})</span>)}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Left behind */}
            <section className="card p-4">
              <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>Added to the basket but not bought</h2>
              <p className="mb-3 text-xs text-charcoal/60">Dishes people wanted but left without ordering. A good list to send a reminder or a promo about.</p>
              {pulse.leftBehind.length === 0 ? <p className="text-sm text-charcoal/60">Nothing left behind in this period.</p> : (
                <ul className="grid gap-2">
                  {pulse.leftBehind.map((i) => <li key={i.name} className="flex items-center justify-between rounded-lg bg-ivory-50 px-3 py-2 text-sm"><span>{i.name}</span><span className="text-charcoal/60">{i.people} {i.people === 1 ? "person" : "people"}</span></li>)}
                </ul>
              )}
            </section>
          </div>

          {/* Day by day */}
          {pulse.perDay.length > 1 && (
            <section className="card p-4">
              <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>Day by day</h2>
              <p className="mb-3 text-xs text-charcoal/60">Visitors each day. The green part is the people who ordered.</p>
              <div className="flex h-36 items-end gap-1.5 overflow-x-auto pb-1">
                {pulse.perDay.map((d) => (
                  <div key={d.day} className="flex min-w-[28px] flex-1 flex-col items-center justify-end gap-1" title={`${d.day}: ${d.visitors} visitors, ${d.ordered} ordered`}>
                    <span className="text-[10px] text-charcoal/60">{d.visitors}</span>
                    <div className="relative w-full rounded-t bg-teal-700/70" style={{ height: `${(d.visitors / maxDay) * 100}px` }}>
                      {d.ordered > 0 && <div className="absolute bottom-0 w-full rounded-t bg-positive" style={{ height: `${(d.ordered / d.visitors) * 100}%` }} />}
                    </div>
                    <span className="text-[10px] text-charcoal/50">{format(new Date(`${d.day}T12:00:00`), "d MMM")}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Problems */}
          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>Things that went wrong</h2>
              <label className="flex items-center gap-2 text-xs text-charcoal/70"><input type="checkbox" checked={showTech} onChange={(e) => setShowTech(e.target.checked)} /> also show small technical glitches</label>
            </div>
            <p className="mb-3 text-xs text-charcoal/60">When a customer sees an error on the website, it shows up here in plain words, newest first. If someone tells you “it didn't work”, look for their first name or the last 4 digits of their phone.</p>
            {problems.length === 0 ? <p className="rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">Nothing went wrong in this period. 🎉</p> : (
              <ul className="grid gap-2">
                {problems.slice(0, 40).map((p) => (
                  <li key={p.id} className={`rounded-xl border-l-4 px-4 py-3 text-sm ${p.level === "attention" ? "border-negative bg-red-50" : p.level === "heads_up" ? "border-warning bg-amber-50" : "border-ivory-300 bg-ivory-50"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <b className="flex items-center gap-1.5">{p.level === "attention" ? <AlertTriangle size={15} className="text-negative" /> : <Info size={15} className="text-charcoal/50" />}{p.title}</b>
                      <span className="text-xs text-charcoal/60" title={format(new Date(p.at), "PPp")}>{formatDistanceToNow(new Date(p.at), { addSuffix: true })}</span>
                    </div>
                    {p.who && <div className="mt-0.5 text-charcoal/80">Customer: {p.who}</div>}
                    <div className="mt-0.5 text-charcoal/80">{p.what}</div>
                    <div className="mt-1 text-xs text-charcoal/60">What to do: {p.hint}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Visitors */}
          <section className="card p-4">
            <h2 className="font-display text-lg font-semibold" style={{ color: PULSE_COLOR }}>Visitors, one by one</h2>
            <p className="mb-3 text-xs text-charcoal/60">Most recent first. Visitors are anonymous, so each one is just a short code. If they ordered, the order number opens the order.</p>
            <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
              {([["all", `Everyone (${pulse.visitors.length})`], ["ordered", `Ordered (${pulse.outcomes.ordered})`], ["stuck", `Hit a problem (${pulse.outcomes.stuck})`], ["left_basket", `Left with basket (${pulse.outcomes.left_basket})`], ["browsing", `Just looking (${pulse.outcomes.browsing})`]] as [typeof filter, string][]).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded-full px-3 py-1.5 font-medium ${filter === k ? "bg-teal-800 text-ivory" : "bg-white text-teal-900 ring-1 ring-ivory-200 hover:bg-ivory-50"}`}>{label}</button>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-charcoal/50"><tr><th className="py-2 pr-3">Visitor</th><th className="pr-3">Last seen</th><th className="pr-3">From</th><th className="pr-3">Device</th><th className="pr-3">Put in basket</th><th>What happened</th></tr></thead>
                <tbody>
                  {visitorsShown.map((v: Visitor) => (
                    <tr key={v.id} className="border-t border-ivory-200 align-top">
                      <td className="py-2 pr-3 font-mono text-xs">#{v.id.slice(-4).toUpperCase()}</td>
                      <td className="pr-3 whitespace-nowrap text-xs" title={format(new Date(v.lastSeen), "PPp")}>{formatDistanceToNow(new Date(v.lastSeen), { addSuffix: true })}</td>
                      <td className="pr-3">{v.source || "Direct"}</td>
                      <td className="pr-3 capitalize"><span className="inline-flex items-center gap-1"><DeviceIcon d={v.device} />{v.device || "—"}</span></td>
                      <td className="pr-3 text-xs">{v.items.length ? v.items.join(", ") : "—"}</td>
                      <td>
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${OUTCOME[v.outcome].cls}`}>{OUTCOME[v.outcome].label}</span>
                        {v.orders.map((n) => { const id = orderIds.data?.get(n); return id ? <Link key={n} to={`/orders/${id}`} className="ml-2 text-xs text-teal-800 underline">{n}</Link> : <span key={n} className="ml-2 text-xs">{n}</span>; })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pulse.visitors.length > 60 && filter === "all" && <p className="mt-2 text-xs text-charcoal/50">Showing the 60 most recent of {pulse.visitors.length}.</p>}
          </section>

          {linksSection}

          <p className="text-xs text-charcoal/50">Good to know: a “visitor” is one browser. Someone who comes back on another phone counts as two. Your own visits are skipped once you open the website with <code>?me=1</code> on that device. Records are kept for 6 months.</p>
        </div>
      )}
    </div>
  );
}
