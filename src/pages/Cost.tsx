import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChefHat } from "lucide-react";
import { DateRangeBar, useDateRange } from "../components/DateRangeBar";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Section, Skeleton, ErrorBox, KpiCard, EmptyState } from "../components/ui";
import { useExpenses } from "../hooks/queries";
import { fmt, toCents, sum, ratio } from "../lib/money";
import { fmtDate } from "../lib/dates";
import type { Expense } from "../lib/types";

/* Ingredient & packaging cost, calculated automatically from each order's
   recipe (see sync_order_cost_expense in the database). This is an estimate
   of what a dish costs to make, not money that left the bank -- real cash
   movement lives in Expenses via the bank feed. Kept separate on purpose so
   the two numbers are never confused, and so recipe accuracy can be worked
   on here without touching the bank-driven Expenses totals. */

type Row = Expense & { orderNumber: string; customer: string };

const ORDER_LINE = /order (\S+) \(([^)]*)\)/;

export function CostPage() {
  const nav = useNavigate();
  const [range, setRange] = useDateRange("this_year");
  const expenses = useExpenses(range);

  const rows = useMemo<Row[]>(() => (expenses.data ?? [])
    .filter((e) => e.auto_source === "order_cost")
    .map((e) => {
      const m = e.description.match(ORDER_LINE);
      return { ...e, orderNumber: m?.[1] ?? "—", customer: m?.[2] ?? "" };
    }), [expenses.data]);

  const total = sum(rows.map((r) => toCents(r.total_amount)));
  const orders = new Set(rows.map((r) => r.order_id).filter(Boolean)).size;
  const avg = ratio(total, orders);

  const cols: Column<Row>[] = [
    { key: "expense_date", header: "Date", render: (r) => fmtDate(r.expense_date) },
    { key: "orderNumber", header: "Order", primary: true, render: (r) => <span><span className="font-mono text-xs text-teal-800">{r.orderNumber}</span><span className="block text-xs text-charcoal/50">{r.customer}</span></span> },
    { key: "category", header: "Category", render: () => "Ingredients", mobile: false },
    { key: "total_amount", header: "Cost", numeric: true, render: (r) => <b>{fmt(toCents(r.total_amount))}</b>, sortValue: (r) => toCents(r.total_amount) },
  ];

  return (
    <div>
      <PageHeader title="Cost" crumbs={["Home", "Cost"]} />
      <p className="mb-3 text-sm text-charcoal/60">
        What each real order cost to make, calculated automatically from the recipe on <b>Menu &amp; Profit</b>.
        This is an estimate for margin tracking, not money that left your bank &mdash; actual spending lives in{" "}
        <button className="text-teal-700 hover:underline" onClick={() => nav("/expenses")}>Expenses</button>.
        Test orders are never included.
      </p>
      <DateRangeBar range={range} onChange={setRange} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard label="Ingredient cost" value={total} formula="Sum of every order's recipe-based ingredient and packaging cost in this period." />
        <KpiCard label="Orders costed" value={orders} kind="int" />
        <KpiCard label="Avg cost / order" value={avg} />
      </div>
      {expenses.error && <ErrorBox error={expenses.error} />}
      <Section title="Cost by order">
        {expenses.isLoading ? <Skeleton rows={6} /> : rows.length === 0 ? (
          <EmptyState title="No costed orders in this period" hint="As real orders come in, their ingredient cost appears here automatically." action={<button className="btn-gold btn-sm mt-2" onClick={() => nav("/menu")}><ChefHat size={16} /> Review recipe costs</button>} />
        ) : (
          <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => r.order_id && nav(`/orders/${r.order_id}`)} initialSort={{ key: "expense_date", dir: "desc" }} />
        )}
      </Section>
    </div>
  );
}
