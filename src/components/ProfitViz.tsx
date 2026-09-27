import { ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell } from "recharts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Section } from "./ui";
import { fmt, pct, change } from "../lib/money";

/* Shared "big number" pieces for showing total profit prominently, reused on
   both Home (real profit for the selected period) and Menu & Profit (the
   notional profit if you sold one of every costed item). Which one it is
   comes entirely from what's passed in -- these components don't know or
   care which kind of profit they're showing. */

function Delta({ cur, prev, invert }: { cur: number; prev?: number | null; invert?: boolean }) {
  if (prev == null || (prev === 0 && cur === 0)) return null;
  const ch = change(cur, prev);
  if (ch == null) return <span className="text-xs text-charcoal/50">first time 🎉</span>;
  const good = invert ? ch <= 0 : ch >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${ch === 0 ? "text-charcoal/50" : good ? "text-positive" : "text-negative"}`}>
      {ch === 0 ? <Minus size={12} /> : ch > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {ch === 0 ? "same as before" : `${pct(Math.abs(ch), 0)} vs prev`}
    </span>
  );
}

/** The headline number: total profit, with an optional faint cumulative
 *  trend washed in behind it. Pass `trend={[]}` where there's no time axis
 *  to compare against (e.g. a static per-catalog total). */
export function ProfitHero({ profit, prev, label, trend = [] }: { profit: number; prev?: number | null; label: string; trend?: { name: string; value: number }[] }) {
  const positive = profit > 0, negative = profit < 0;
  const color = positive ? "#16855B" : negative ? "#C64040" : "#083838";
  const tagline = positive
    ? "🎉 In the green — every dollar past this line is yours to keep."
    : negative
      ? "🌱 Costs are running ahead of sales right now — completely normal before day one."
      : "🌱 A blank slate. Your first order starts the story.";
  const hasTrend = trend.length > 1;
  return (
    <div className="relative mb-4 overflow-hidden rounded-2xl border border-ivory-200" style={{ background: "linear-gradient(135deg,#FCF9F2 0%,#F3E8CE 55%,#F7F0DF 100%)" }}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-2.5 opacity-50" style={{
        backgroundImage: "linear-gradient(45deg, #D4A72C 23%, transparent 24%), linear-gradient(135deg, #D4A72C 23%, transparent 24%), linear-gradient(45deg, transparent 74%, #0F4C4C 75%), linear-gradient(135deg, transparent 74%, #0F4C4C 75%)",
        backgroundSize: "20px 10px",
      }} />
      {hasTrend && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-20 opacity-25 md:h-28">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
              <defs><linearGradient id="heroTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".6" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
              <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill="url(#heroTrend)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="relative flex flex-col items-center gap-1.5 px-6 py-8 text-center md:py-10">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[.16em] text-teal-900/70">💰 Total profit · {label}</span>
        <span className="font-display font-bold leading-none tabular-nums" style={{ fontSize: "clamp(2.75rem,8vw,4.75rem)", color }}>{fmt(profit)}</span>
        <div className="[&_span]:!text-sm"><Delta cur={profit} prev={prev} /></div>
        <p className="mt-1 max-w-md text-sm text-charcoal/60">{tagline}</p>
      </div>
    </div>
  );
}

/** A fixed 60/40 split of the same total profit between the two owners. The
 *  pie shape is always 60/40 by definition; only the dollar amounts (which
 *  can be negative) come from real data. */
export function ProfitSplit({ profit, label }: { profit: number; label: string }) {
  const fady = Math.round(profit * 0.6);
  const howaida = profit - fady; // remainder keeps the two halves exact to the cent
  const loss = profit < 0;
  const shape = [{ name: "Fady", value: 60 }, { name: "Howaida", value: 40 }];
  const colors = ["#D4A72C", "#0F4C4C"];
  return (
    <Section title={`🤝 ${loss ? "Loss" : "Profit"} split — Fady & Howaida`} className="mb-4" right={<span className="text-xs text-charcoal/50">{label} · 60 / 40</span>}>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center">
        <div className="relative h-[168px] w-[168px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={shape} dataKey="value" nameKey="name" innerRadius={54} outerRadius={82} paddingAngle={3} stroke="#fff" strokeWidth={3} startAngle={90} endAngle={-270}>
                {shape.map((_, i) => <Cell key={i} fill={colors[i]} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className={`font-display text-xl font-semibold ${loss ? "text-negative" : "text-teal-900"}`}>{fmt(profit)}</span>
            <span className="text-[10px] uppercase tracking-wider text-charcoal/50">{loss ? "to cover" : "to split"}</span>
          </div>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-3 sm:w-auto">
          <PersonShare initial="F" name="Fady" pctLabel="60%" amount={fady} color="#D4A72C" loss={loss} />
          <PersonShare initial="H" name="Howaida" pctLabel="40%" amount={howaida} color="#0F4C4C" loss={loss} />
        </div>
      </div>
    </Section>
  );
}

function PersonShare({ initial, name, pctLabel, amount, color, loss }: { initial: string; name: string; pctLabel: string; amount: number; color: string; loss: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ background: color + "14" }}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-display text-base font-semibold text-white" style={{ background: color }}>{initial}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-charcoal">{name}</span>
          <span className="text-xs font-semibold text-charcoal/50">{pctLabel}</span>
        </div>
        <span className={`font-display text-lg font-semibold ${loss ? "text-negative" : ""}`} style={loss ? undefined : { color }}>{fmt(amount)}</span>
      </div>
    </div>
  );
}
