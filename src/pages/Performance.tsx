import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, LineChart, Line, CartesianGrid, Legend } from "recharts";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Section, Skeleton, ErrorBox, KpiCard } from "../components/ui";
import { useProductSales, useCategories, useSettings } from "../hooks/queries";
import { previousRange, bucketKey, bucketLabel } from "../lib/dates";
import { rankProducts, REVENUE_STATUSES, type ProductRank } from "../lib/metrics";
import { fmt, fromCents, pct, change, toCents } from "../lib/money";

type Row = ProductRank & { rank: number; category: string; share: number | null; trend: number | null; [k: string]: unknown };

export function PerformancePage() {
  const nav = useNavigate();
  const [range, setRange] = useDateRange("this_month");
  const prev = useMemo(() => previousRange(range), [range]);
  const cur = useProductSales(range);
  const pre = useProductSales(prev);
  const cats = useCategories();
  const settings = useSettings();
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const [compare, setCompare] = useState<string[]>([]);

  const ranks = useMemo(() => rankProducts(cur.data ?? [], includeLabor), [cur.data, includeLabor]);
  const prevRanks = useMemo(() => rankProducts(pre.data ?? [], includeLabor), [pre.data, includeLabor]);
  const totalNet = ranks.reduce((s, r) => s + r.net, 0);
  const rows = useMemo<Row[]>(() => ranks.map((r, i) => {
    const p = prevRanks.find((x) => x.product_id === r.product_id);
    return { ...r, rank: i + 1, category: cats.data?.find((c) => c.id === r.category_id)?.name ?? "—", share: totalNet ? r.net / totalNet : null, trend: p ? change(r.net, p.net) : null };
  }), [ranks, prevRanks, cats.data, totalNet]);

  const best = {
    units: [...ranks].sort((a, b) => b.units - a.units)[0], revenue: ranks[0],
    profit: [...ranks].sort((a, b) => b.profit - a.profit)[0],
    highMargin: [...ranks].filter((r) => r.margin != null).sort((a, b) => b.margin! - a.margin!)[0],
    lowMargin: [...ranks].filter((r) => r.margin != null).sort((a, b) => a.margin! - b.margin!)[0],
    growing: [...rows].filter((r) => r.trend != null).sort((a, b) => b.trend! - a.trend!)[0],
    declining: rows.filter((r) => r.trend != null && r.trend < 0).sort((a, b) => a.trend! - b.trend!),
  };
  const noRecent = prevRanks.filter((p) => !ranks.some((r) => r.product_id === p.product_id));

  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of ranks) { const n = cats.data?.find((c) => c.id === r.category_id)?.name ?? "Other"; m.set(n, (m.get(n) ?? 0) + fromCents(r.net)); }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [ranks, cats.data]);

  const trend = useMemo(() => {
    const ids = compare.length ? compare : ranks.slice(0, 4).map((r) => r.product_id);
    const m = new Map<string, Record<string, number>>();
    for (const s of cur.data ?? []) {
      if (!s.product_id || !ids.includes(s.product_id) || !REVENUE_STATUSES.includes(s.status)) continue;
      const k = bucketKey(s.created_at, range);
      const e = m.get(k) ?? {};
      const name = s.product_name ?? "?";
      e[name] = (e[name] ?? 0) + fromCents(toCents(s.line_total) - toCents(s.line_discount));
      m.set(k, e);
    }
    return { rows: [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ name: bucketLabel(k), ...v })), names: ranks.filter((r) => ids.includes(r.product_id)).map((r) => r.name) };
  }, [cur.data, compare, ranks, range]);

  const cols: Column<Row>[] = [
    { key: "rank", header: "#", numeric: true },
    { key: "name", header: "Product", primary: true, render: (r) => <span className="font-medium text-teal-800">{r.name}</span> },
    { key: "category", header: "Category", mobile: false },
    { key: "units", header: "Units", numeric: true },
    { key: "orders", header: "Orders", numeric: true },
    { key: "gross", header: "Gross", numeric: true, render: (r) => fmt(r.gross) },
    { key: "discounts", header: "Discounts", numeric: true, mobile: false, render: (r) => fmt(r.discounts) },
    { key: "net", header: "Net revenue", numeric: true, render: (r) => fmt(r.net) },
    { key: "unitCost", header: "Unit cost", numeric: true, mobile: false, render: (r) => r.unitCost == null ? "—" : fmt(r.unitCost) },
    { key: "cost", header: "Total cost", numeric: true, render: (r) => fmt(r.cost) },
    { key: "profit", header: "Gross profit", numeric: true, render: (r) => <span className={r.profit < 0 ? "text-negative" : "text-positive"}>{fmt(r.profit)}</span> },
    { key: "margin", header: "Margin", numeric: true, render: (r) => pct(r.margin) },
    { key: "avgPrice", header: "Avg price", numeric: true, mobile: false, render: (r) => r.avgPrice == null ? "—" : fmt(r.avgPrice) },
    { key: "refunds", header: "Refunds", numeric: true, mobile: false },
    { key: "share", header: "% of sales", numeric: true, render: (r) => pct(r.share) },
    { key: "trend", header: "vs prev", numeric: true, render: (r) => r.trend == null ? <span className="text-charcoal/40">new</span> : <span className={r.trend < 0 ? "text-negative" : "text-positive"}>{r.trend > 0 ? "+" : ""}{pct(r.trend, 0)}</span> },
  ];

  const compRows = rows.filter((r) => compare.includes(r.product_id));

  return (
    <div>
      <PageHeader title="Product Performance" crumbs={["Home", "Product Performance"]} />
      <DateRangeBar range={range} onChange={setRange} />
      {cur.error && <ErrorBox error={cur.error} />}
      {cur.isLoading ? <Skeleton rows={8} className="card p-5" /> : ranks.length === 0 ? <div className="card p-8 text-center text-sm text-charcoal/60">No revenue orders in this period.</div> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Highlight label="Best seller (units)" name={best.units?.name} value={`${best.units?.units ?? 0} units`} />
            <Highlight label="Best seller (revenue)" name={best.revenue?.name} value={fmt(best.revenue?.net ?? 0)} />
            <Highlight label="Most profitable" name={best.profit?.name} value={fmt(best.profit?.profit ?? 0)} />
            <Highlight label="Highest margin" name={best.highMargin?.name} value={pct(best.highMargin?.margin)} />
            <Highlight label="Lowest margin" name={best.lowMargin?.name} value={pct(best.lowMargin?.margin)} warn />
            <Highlight label="Fastest growing" name={best.growing?.name} value={best.growing?.trend != null ? "+" + pct(best.growing.trend, 0) : "—"} />
          </div>
          {(best.declining.length > 0 || noRecent.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              {best.declining.length > 0 && <span className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-900">Declining: {best.declining.slice(0, 4).map((r) => `${r.name} (${pct(r.trend!, 0)})`).join(", ")}</span>}
              {noRecent.length > 0 && <span className="rounded-lg bg-neutral-100 px-3 py-1.5 text-neutral-700">No sales this period (sold previously): {noRecent.map((r) => r.name).join(", ")}</span>}
            </div>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Chart title="Quantity sold" data={ranks.slice(0, 8).map((r) => ({ name: short(r.name), value: r.units }))} />
            <Chart title="Net revenue" data={ranks.slice(0, 8).map((r) => ({ name: short(r.name), value: fromCents(r.net) }))} money />
            <Chart title="Gross profit" data={[...ranks].sort((a, b) => b.profit - a.profit).slice(0, 8).map((r) => ({ name: short(r.name), value: fromCents(r.profit) }))} money />
            <Chart title="Profit margin %" data={[...ranks].filter((r) => r.margin != null).sort((a, b) => b.margin! - a.margin!).slice(0, 8).map((r) => ({ name: short(r.name), value: Math.round(r.margin! * 1000) / 10 }))} suffix="%" />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Section title="Sales trend by product" className="lg:col-span-2" right={<span className="text-xs text-charcoal/50">{compare.length ? "selected products" : "top 4"}</span>}>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trend.rows}><CartesianGrid strokeDasharray="3 3" stroke="#e5ddc7" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={44} /><RTooltip formatter={(v: unknown) => fmt(Math.round(Number(v) * 100))} /><Legend wrapperStyle={{ fontSize: 11 }} />
                  {trend.names.map((n, i) => <Line key={n} type="monotone" dataKey={n} stroke={["#0F4C4C", "#D4A72C", "#146060", "#8c6239", "#1c7575", "#b8912e"][i % 6]} strokeWidth={2} dot={false} />)}
                </LineChart>
              </ResponsiveContainer>
            </Section>
            <Chart title="Sales by category" data={byCategory} money />
          </div>

          <Section title="Compare products" className="mt-4" right={<span className="text-xs text-charcoal/50">tick products in the table below</span>}>
            {compRows.length < 2 ? <p className="text-sm text-charcoal/60">Select two or more products to compare them side by side.</p> : (
              <div className="table-wrap"><table className="table !min-w-0"><thead><tr><th>Metric</th>{compRows.map((r) => <th key={r.product_id} className="num">{r.name}</th>)}</tr></thead>
                <tbody>{([["Units", (r: Row) => String(r.units)], ["Net revenue", (r: Row) => fmt(r.net)], ["Total cost", (r: Row) => fmt(r.cost)], ["Gross profit", (r: Row) => fmt(r.profit)], ["Margin", (r: Row) => pct(r.margin)], ["Avg price", (r: Row) => r.avgPrice == null ? "—" : fmt(r.avgPrice)], ["% of sales", (r: Row) => pct(r.share)], ["vs previous", (r: Row) => r.trend == null ? "new" : pct(r.trend, 0)]] as [string, (r: Row) => string][]).map(([m, f]) => <tr key={m}><td className="font-medium">{m}</td>{compRows.map((r) => <td key={r.product_id} className="num">{f(r)}</td>)}</tr>)}</tbody></table></div>
            )}
          </Section>

          <div className="mt-4">
            <DataTable rows={rows} columns={[{ key: "cmp", header: "", mobile: false, render: (r) => <input type="checkbox" aria-label={`Compare ${r.name}`} checked={compare.includes(r.product_id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setCompare((c) => e.target.checked ? [...c, r.product_id] : c.filter((x) => x !== r.product_id))} /> }, ...cols]} rowKey={(r) => r.product_id} onRowClick={(r) => nav(`/products/${r.product_id}`)} initialSort={{ key: "net", dir: "desc" }} pageSize={50} />
          </div>
        </>
      )}
    </div>
  );
}

function short(n: string) { return n.length > 18 ? n.slice(0, 17) + "…" : n; }
function Highlight({ label, name, value, warn }: { label: string; name?: string; value: string; warn?: boolean }) {
  return <div className={`card px-4 py-3 ${warn ? "border-warning/40" : ""}`}><div className="text-xs uppercase tracking-wider text-teal-900/70">{label}</div><div className="truncate font-display text-lg font-semibold text-teal-900">{name ?? "—"}</div><div className="text-sm text-charcoal/70">{value}</div></div>;
}
function Chart({ title, data, money, suffix }: { title: string; data: { name: string; value: number }[]; money?: boolean; suffix?: string }) {
  return (
    <Section title={title}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 8 }}><XAxis type="number" hide /><YAxis type="category" dataKey="name" width={96} tick={{ fontSize: 11 }} />
          <RTooltip formatter={(v: unknown) => money ? fmt(Math.round(Number(v) * 100)) : Number(v) + (suffix ?? "")} /><Bar dataKey="value" fill="#0F4C4C" radius={4} /></BarChart>
      </ResponsiveContainer>
    </Section>
  );
}
export { KpiCard };
