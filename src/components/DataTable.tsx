import { useMemo, useState, type ReactNode } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string | null;
  numeric?: boolean;
  /** show on mobile cards (default true) */
  mobile?: boolean;
  /** title of the mobile card */
  primary?: boolean;
}

/**
 * Responsive table: real <table> on md+, stacked cards on phones.
 * Sorting works on every column with sortValue (or the raw key).
 * Pagination is client-side.
 */
export function DataTable<T extends object>({ rows, columns, rowKey, pageSize = 25, onRowClick, empty, initialSort }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; pageSize?: number; onRowClick?: (r: T) => void; empty?: ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const val = (r: T) => (col?.sortValue ? col.sortValue(r) : ((r as Record<string, unknown>)[sort.key] as number | string | null));
    return [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? c : -c;
    });
  }, [rows, sort, columns]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const slice = sorted.slice(cur * pageSize, cur * pageSize + pageSize);
  const toggle = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  const primary = columns.find((c) => c.primary) ?? columns[0];

  if (!rows.length) return <div className="card">{empty ?? <p className="px-5 py-10 text-center text-sm text-charcoal/50">Nothing to show.</p>}</div>;

  return (
    <div>
      {/* desktop */}
      <div className="table-wrap hidden md:block">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.numeric ? "num" : ""}>
                  <button type="button" className="inline-flex items-center gap-1 hover:text-teal-800" onClick={() => toggle(c.key)}>
                    {c.header}
                    {sort?.key === c.key ? (sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ChevronsUpDown size={12} className="opacity-40" />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r) => (
              <tr key={rowKey(r)} className={onRowClick ? "cursor-pointer" : ""} onClick={() => onRowClick?.(r)}>
                {columns.map((c) => <td key={c.key} className={c.numeric ? "num" : ""}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* mobile cards */}
      <div className="flex flex-col gap-2 md:hidden">
        {slice.map((r) => (
          <div key={rowKey(r)} className={`card px-4 py-3 ${onRowClick ? "cursor-pointer active:bg-ivory-50" : ""}`} onClick={() => onRowClick?.(r)}>
            <div className="mb-1 font-medium text-teal-900">{primary.render ? primary.render(r) : String((r as Record<string, unknown>)[primary.key] ?? "")}</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              {columns.filter((c) => c !== primary && c.mobile !== false).map((c) => (
                <div key={c.key} className="flex justify-between gap-2 border-b border-ivory-200/60 py-0.5">
                  <dt className="text-charcoal/50">{c.header}</dt>
                  <dd className={`text-right [&_.badge]:whitespace-normal ${c.numeric ? "tabular-nums" : ""}`}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "")}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-charcoal/60">{sorted.length} rows · page {cur + 1} of {pages}</span>
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" disabled={cur === 0} onClick={() => setPage(cur - 1)}>Previous</button>
            <button className="btn-ghost btn-sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
