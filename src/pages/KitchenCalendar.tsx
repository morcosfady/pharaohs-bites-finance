import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDays, addMonths, endOfMonth, format, startOfMonth, startOfWeek, isBefore, startOfDay } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase, unwrap } from "../lib/supabase";
import { useOrders, useWrite } from "../hooks/queries";
import { PageHeader, Skeleton, ErrorBox, useToast } from "../components/ui";

/** Accent colour of this tab. Closed days are red and open days are green, so the tab itself is violet. */
export const CALENDAR_COLOR = "#7c5cb0";

type ClosedDay = { day: string; reason: string };
const key = (d: Date) => format(d, "yyyy-MM-dd");
const noon = (day: string) => new Date(`${day}T12:00:00`);

function useClosedDays() {
  return useQuery({ queryKey: ["closed_days"], queryFn: async () => unwrap(await supabase.from("closed_days").select("day, reason").order("day")) as ClosedDay[] });
}

export function KitchenCalendarPage() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [reason, setReason] = useState("");
  const closedQ = useClosedDays();
  const ordersQ = useOrders({ limit: 500 });
  const write = useWrite();
  const toast = useToast();

  const today = startOfDay(new Date());
  const closed = useMemo(() => new Map((closedQ.data ?? []).map((c) => [c.day, c.reason])), [closedQ.data]);
  const booked = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of ordersQ.data ?? []) {
      if (!o.requested_at || o.status === "cancelled") continue;
      const k = key(new Date(o.requested_at));
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [ordersQ.data]);

  const first = startOfWeek(month);
  const weeks: Date[][] = [];
  for (let d = first; d <= endOfMonth(month); d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));

  const setDays = (days: Date[], close: boolean, msg: string) => {
    const keys = days.filter((d) => !isBefore(d, today)).map(key);
    if (!keys.length) return;
    write.mutateAsync(async () => {
      if (close) unwrap(await supabase.from("closed_days").upsert(keys.map((day) => ({ day, reason: reason.trim() })), { onConflict: "day" }).select());
      else unwrap(await supabase.from("closed_days").delete().in("day", keys).select());
    }).then(() => toast.push(msg), (e) => toast.push((e as Error).message, "err"));
  };
  const toggle = (d: Date) => {
    const isClosed = closed.has(key(d)), name = format(d, "EEE, MMM d");
    setDays([d], !isClosed, isClosed ? `${name} is open again` : `${name} is closed on the website`);
  };

  const upcoming = (closedQ.data ?? []).filter((c) => c.day >= key(today));

  return (
    <div>
      <PageHeader title="Kitchen Calendar" crumbs={["Home", "Kitchen Calendar"]} />
      <p className="mb-4 max-w-2xl text-sm text-charcoal/70">Tap a day to close it. Closed days turn red on the website, so customers cannot choose them (they see "Fully booked"). Tap again to open it. Orders already placed for a closed day are not touched.</p>
      {closedQ.isLoading ? <Skeleton rows={6} /> : closedQ.error ? <ErrorBox error={closedQ.error} /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <button className="rounded-lg p-2 hover:bg-ivory-200" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft size={20} /></button>
              <h2 className="font-display text-xl font-semibold" style={{ color: CALENDAR_COLOR }}>{format(month, "MMMM yyyy")}</h2>
              <button className="rounded-lg p-2 hover:bg-ivory-200" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><ChevronRight size={20} /></button>
            </div>
            <div className="mb-3 flex items-center gap-2 text-xs">
              <label className="shrink-0 text-charcoal/60" htmlFor="why">Note when closing (only you see it)</label>
              <input id="why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. travelling" maxLength={80} className="min-w-0 flex-1 rounded-lg border border-ivory-200 bg-white px-2 py-1.5 text-sm" />
            </div>
            <div className="grid grid-cols-[repeat(7,minmax(0,1fr))_3rem] gap-1 text-center text-[11px] uppercase tracking-wide text-charcoal/50 sm:grid-cols-[repeat(7,minmax(0,1fr))_4rem]">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d}>{d}</div>)}<div />
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {weeks.map((w) => {
                const future = w.filter((d) => !isBefore(d, today) && d.getMonth() === month.getMonth());
                const allClosed = future.length > 0 && future.every((d) => closed.has(key(d)));
                return (
                  <div key={key(w[0])} className="grid grid-cols-[repeat(7,minmax(0,1fr))_3rem] items-stretch gap-1 sm:grid-cols-[repeat(7,minmax(0,1fr))_4rem]">
                    {w.map((d) => {
                      const k = key(d), inMonth = d.getMonth() === month.getMonth(), past = isBefore(d, today), isClosed = closed.has(k), n = booked.get(k) ?? 0, isToday = k === key(today);
                      if (!inMonth) return <div key={k} />;
                      const cls = past ? "bg-ivory-200/40 text-charcoal/30"
                        : isClosed ? "bg-negative text-white shadow-sm hover:brightness-110"
                        : "bg-positive/10 text-teal-900 hover:bg-positive/20";
                      return (
                        <button key={k} disabled={past || write.isPending} onClick={() => toggle(d)}
                          title={past ? "" : isClosed ? `Closed${closed.get(k) ? `: ${closed.get(k)}` : ""}. Tap to open.` : "Open. Tap to close."}
                          aria-label={`${format(d, "EEEE, MMMM d")}, ${past ? "past" : isClosed ? "closed" : "open"}${n ? `, ${n} order${n > 1 ? "s" : ""}` : ""}`}
                          className={`flex min-h-[3.75rem] flex-col items-center justify-center rounded-lg border text-sm font-medium transition sm:min-h-[4.5rem] ${isToday ? "border-2 border-gold" : "border-transparent"} ${cls}`}>
                          <span>{d.getDate()}</span>
                          {isClosed && !past ? <span className="text-[9px] font-semibold uppercase sm:text-[10px]">Closed</span> : n > 0 ? <span className="text-[9px] sm:text-[10px]">{n} order{n > 1 ? "s" : ""}</span> : null}
                        </button>
                      );
                    })}
                    <button disabled={!future.length || write.isPending} onClick={() => setDays(future, !allClosed, allClosed ? "Week reopened" : "Week closed on the website")}
                      className="rounded-lg px-1 text-[10px] font-medium leading-tight hover:bg-ivory-200 disabled:opacity-30 sm:text-xs" style={{ color: CALENDAR_COLOR }}>
                      {allClosed ? "Open week" : "Close week"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-charcoal/60">
              <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-positive/20" /> Open</span>
              <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-negative" /> Closed (red on the website)</span>
              <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded border-2 border-gold" /> Today</span>
            </div>
            <p className="mt-2 text-xs text-charcoal/50">Customers can only book from tomorrow, so closing today does not change the website; it is there for your own planning. The order count is orders placed for that day.</p>
          </section>

          <section className="card h-fit p-4">
            <h2 className="mb-2 font-display text-lg font-semibold text-teal-900">Closed days coming up</h2>
            {upcoming.length === 0 ? <p className="text-sm text-charcoal/60">Nothing closed. Every day is open.</p> : (
              <ul className="divide-y divide-ivory-200">
                {upcoming.map((c) => (
                  <li key={c.day} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span><b>{format(noon(c.day), "EEE, MMM d")}</b>{c.reason && <span className="block text-xs text-charcoal/50">{c.reason}</span>}</span>
                    <button className="rounded-lg px-2 py-1 text-xs font-medium text-positive hover:bg-positive/10" onClick={() => setDays([noon(c.day)], false, `${format(noon(c.day), "EEE, MMM d")} is open again`)}>Reopen</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
