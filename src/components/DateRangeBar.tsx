import { useState } from "react";
import { PRESETS, rangeFor, toInputDate, type DateRange, type PresetKey } from "../lib/dates";

/** Shared period selector. State lives in the URL hash-free localStorage so
 *  every page opens on the same period. */
export function useDateRange(defaultKey: PresetKey = "this_month"): [DateRange, (r: DateRange) => void] {
  const [range, setRangeState] = useState<DateRange>(() => {
    try {
      const raw = localStorage.getItem("pbf:range");
      if (raw) {
        const p = JSON.parse(raw) as { key: PresetKey; from: string; to: string };
        return rangeFor(p.key, new Date(), { from: new Date(p.from), to: new Date(p.to) });
      }
    } catch { /* ignore */ }
    return rangeFor(defaultKey);
  });
  const setRange = (r: DateRange) => {
    setRangeState(r);
    try { localStorage.setItem("pbf:range", JSON.stringify({ key: r.key, from: r.from.toISOString(), to: r.to.toISOString() })); } catch { /* ignore */ }
  };
  return [range, setRange];
}

export function DateRangeBar({ range, onChange }: { range: DateRange; onChange: (r: DateRange) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" onClick={() => onChange(rangeFor(p.key, new Date(), { from: range.from, to: range.to }))}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${range.key === p.key ? "bg-teal-800 text-ivory" : "bg-white text-teal-900 ring-1 ring-ivory-200 hover:bg-ivory-50"}`}>
            {p.label}
          </button>
        ))}
      </div>
      {range.key === "custom" && (
        <div className="flex items-center gap-2 text-sm">
          <input type="date" className="input !min-h-9 !py-1" value={toInputDate(range.from)} onChange={(e) => onChange(rangeFor("custom", new Date(), { from: new Date(e.target.value + "T00:00"), to: range.to }))} aria-label="From" />
          <span>–</span>
          <input type="date" className="input !min-h-9 !py-1" value={toInputDate(range.to)} onChange={(e) => onChange(rangeFor("custom", new Date(), { from: range.from, to: new Date(e.target.value + "T00:00") }))} aria-label="To" />
        </div>
      )}
      <span className="ml-auto text-xs text-charcoal/50">{range.from.toLocaleDateString()} – {range.to.toLocaleDateString()}</span>
    </div>
  );
}
