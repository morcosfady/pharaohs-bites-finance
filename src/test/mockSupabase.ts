/**
 * In-browser stand-in for the Supabase client used by `npm run demo` and the
 * published /demo/ site. It keeps a small relational store in memory (and in
 * localStorage so edits survive a refresh), understands the subset of the
 * PostgREST builder the app uses, computes the two views, and mimics the
 * database triggers (order totals, payment status, status history).
 * Nothing here runs in production.
 */
import * as F from "./fixtures";
import type { DeliveryRecord } from "../lib/types";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
const KEY = "pbf:demo-store";
const uid = () => "d" + Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

function seed(): Store {
  const orders = F.ORDERS.map(({ order_items, payments, refunds, delivery_records, order_status_history, ...o }) => { void order_items; void payments; void refunds; void delivery_records; void order_status_history; return { ...o } as Row; });
  const items = F.ORDERS.flatMap((o) => (o.order_items ?? []).map((i) => ({ ...i })));
  const deliveries = F.ORDERS.flatMap((o) => (o.delivery_records as DeliveryRecord[]).map((d) => ({ ...d })));
  const history = F.ORDERS.flatMap((o) => (o.order_status_history ?? []).map((h) => ({ ...h })));
  const customers = F.CUSTOMERS.map(({ customer_addresses, ...c }) => { void customer_addresses; return { ...c } as Row; });
  const addresses = F.CUSTOMERS.flatMap((c) => (c.customer_addresses ?? []).map((a) => ({ ...a })));
  const products = F.PRODUCTS.map(({ product_categories, ...p }) => { void product_categories; return { ...p } as Row; });
  const expenses = F.EXPENSES.map(({ expense_categories, ...e }) => { void expense_categories; return { ...e } as Row; });
  const payments = F.PAYMENTS.map(({ orders: _o, ...p }) => { void _o; return { ...p } as Row; });
  return {
    orders, order_items: items as Row[], delivery_records: deliveries as Row[], order_status_history: history as Row[], customers, customer_addresses: addresses as Row[],
    products, product_categories: F.CATS.map((c) => ({ ...c })), ingredients: [
      { id: "i1", name: "All-purpose flour", supplier: "Costco", package_size: 25, package_unit: "lb", package_price: 12.99, waste_pct: 0.02, notes: "", updated_at: now(), deleted_at: null },
      { id: "i2", name: "Ghee", supplier: "Sam's Club", package_size: 32, package_unit: "oz", package_price: 14.5, waste_pct: 0.01, notes: "", updated_at: now(), deleted_at: null },
    ], recipes: [{ id: "r1", product_id: "p1", ingredient_id: "i1", quantity: 1, unit: "lb", waste_pct: 0 }, { id: "r2", product_id: "p1", ingredient_id: "i2", quantity: 4, unit: "oz", waste_pct: 0 }],
    expenses, expense_categories: [{ id: "x1", name: "Ingredients", cost_type: "direct_product", sort_order: 1 }, { id: "x2", name: "Marketing", cost_type: "operating", sort_order: 2 }, { id: "x3", name: "Bank / payment fees", cost_type: "operating", sort_order: 3 }, { id: "x4", name: "Packaging", cost_type: "direct_product", sort_order: 4 }, { id: "x5", name: "Gas / mileage", cost_type: "operating", sort_order: 5 }],
    payments, refunds: F.REFUNDS.map((r) => ({ ...r })), business_settings: [{ ...F.SETTINGS }], tax_settings: [{ ...F.TAX }], tax_adjustments: [], tax_period_summaries: [], audit_logs: [],
    admin_profiles: [{ user_id: "demo", full_name: "Demo Owner", role: "owner", is_active: true }], order_counters: [{ year: 2026, last_seq: 6 }],
  };
}

let store: Store = (() => { try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch { /* ignore */ } return seed(); })();
function persist() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* ignore */ } }
export function resetDemoStore() { store = seed(); persist(); location.reload(); }
(window as unknown as { __resetDemo?: () => void }).__resetDemo = resetDemoStore;

/* ---- "triggers" ---------------------------------------------------------- */
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
function recalcOrder(orderId: string) {
  const o = store.orders.find((x) => x.id === orderId); if (!o) return;
  const items = store.order_items.filter((i) => i.order_id === orderId);
  for (const i of items) i.line_total = r2(n(i.quantity) * n(i.unit_price));
  const sub = items.reduce((s, i) => s + n(i.line_total), 0);
  const taxable = items.filter((i) => i.is_taxable).reduce((s, i) => s + n(i.line_total), 0);
  const tax = o.tax_manually_set ? n(o.tax_amount) : o.prices_include_tax ? 0 : r2(Math.max(taxable - (sub > 0 ? n(o.discount) * taxable / sub : 0), 0) * n(o.tax_rate_applied));
  const paid = store.payments.filter((p) => p.order_id === orderId && !p.voided_at).reduce((s, p) => s + n(p.amount), 0);
  const refunded = store.refunds.filter((p) => p.order_id === orderId && !p.voided_at).reduce((s, p) => s + n(p.amount), 0);
  o.subtotal = r2(sub); o.tax_amount = tax; o.total = r2(Math.max(sub - n(o.discount), 0) + n(o.delivery_fee) + tax); o.amount_paid = r2(paid); o.amount_refunded = r2(refunded); o.updated_at = now();
  if (o.payment_status !== "disputed") {
    o.payment_status = refunded > 0 && refunded >= paid ? "refunded" : refunded > 0 ? "partially_refunded" : paid <= 0 ? "unpaid" : paid >= n(o.total) ? "paid" : o.payment_status === "deposit_received" ? "deposit_received" : "partially_paid";
  }
}
function afterWrite(table: string, before: Row | null, after: Row | null) {
  const rec = (after ?? before) as Row;
  if (["order_items", "payments", "refunds"].includes(table)) recalcOrder(rec.order_id as string);
  if (table === "orders" && before && after && before.status !== after.status) {
    store.order_status_history.push({ id: uid(), order_id: after.id, from_status: before.status, to_status: after.status, changed_by: "demo", note: "", created_at: now() });
    if (after.status === "completed" && !after.completed_at) after.completed_at = now();
    if (after.status === "cancelled" && !after.cancelled_at) after.cancelled_at = now();
    if (after.status === "confirmed" && !after.confirmed_at) after.confirmed_at = now();
  }
  if (table === "orders" && after) recalcOrder(after.id as string);
  if (table === "expenses" && after) after.total_amount = r2(n(after.amount_before_tax) + n(after.sales_tax_paid));
  if (table === "recipes" || table === "ingredients") for (const p of store.products) recalcProduct(p.id as string);
  if (["orders", "order_items", "payments", "refunds", "expenses", "products", "customers"].includes(table)) store.audit_logs.push({ id: store.audit_logs.length + 1, table_name: table, record_id: String(rec.id ?? ""), action: !before ? "INSERT" : !after ? "DELETE" : "UPDATE", changed_by: "demo", old_data: before, new_data: after, created_at: now() });
  persist();
}
const BASE: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592, ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41, piece: 1, package: 1 };
function recalcProduct(pid: string) {
  const p = store.products.find((x) => x.id === pid); if (!p) return;
  let cost = 0;
  for (const r of store.recipes.filter((x) => x.product_id === pid)) {
    const i = store.ingredients.find((x) => x.id === r.ingredient_id); if (!i) continue;
    const q = n(r.quantity) * (BASE[r.unit as string] ?? 1), s = n(i.package_size) * (BASE[i.package_unit as string] ?? 1);
    if (s) cost += n(i.package_price) * (q / s) * (1 + Math.max(n(r.waste_pct), n(i.waste_pct)));
  }
  p.ingredient_cost = Math.round(cost * 10000) / 10000;
}

/* ---- views ---------------------------------------------------------------- */
function viewOrderFinancials(): Row[] {
  return store.orders.map((o) => {
    const items = store.order_items.filter((i) => i.order_id === o.id);
    const cogs = items.reduce((s, i) => s + n(i.quantity) * (n(i.unit_ingredient_cost) + n(i.unit_packaging_cost) + n(i.unit_other_cost)), 0);
    const d = store.delivery_records.find((x) => x.order_id === o.id);
    const delivRev = o.delivery_fee_customer_paid ? n(o.delivery_fee) : 0;
    const net = n(o.subtotal) - n(o.discount);
    return { id: o.id, order_number: o.order_number, created_at: o.created_at, completed_at: o.completed_at, status: o.status, payment_status: o.payment_status, payment_method: o.payment_method, delivery_method: o.delivery_method, customer_id: o.customer_id, customer_name: o.customer_name, customer_phone: o.customer_phone,
      gross_product_revenue: o.subtotal, discount: o.discount, net_product_sales: r2(net), delivery_revenue: delivRev, tax_amount: o.tax_amount, total: o.total, amount_paid: o.amount_paid, amount_refunded: o.amount_refunded,
      balance_due: r2(n(o.total) - n(o.amount_paid) + n(o.amount_refunded)), cogs: r2(cogs), packaging_cost: r2(items.reduce((s, i) => s + n(i.quantity) * n(i.unit_packaging_cost), 0)), labor_cost: r2(items.reduce((s, i) => s + n(i.quantity) * n(i.unit_labor_cost), 0)),
      delivery_cost: n(d?.actual_cost), items_count: items.reduce((s, i) => s + n(i.quantity), 0), gross_profit: r2(net - cogs), contribution_profit: r2(net + delivRev - cogs - n(d?.actual_cost)), deleted_at: o.deleted_at };
  });
}
function viewProductSales(): Row[] {
  return store.order_items.flatMap((i) => {
    const o = store.orders.find((x) => x.id === i.order_id); if (!o || o.deleted_at) return [];
    const p = store.products.find((x) => x.id === i.product_id);
    return [{ product_id: i.product_id, product_name: p?.name ?? i.product_name, category_id: p?.category_id ?? null, created_at: o.created_at, completed_at: o.completed_at, status: o.status, quantity: i.quantity, refunded_qty: i.refunded_qty, line_total: i.line_total,
      line_cost: r2(n(i.quantity) * (n(i.unit_ingredient_cost) + n(i.unit_packaging_cost) + n(i.unit_other_cost))), line_labor_cost: r2(n(i.quantity) * n(i.unit_labor_cost)), line_discount: n(o.subtotal) > 0 ? r2(n(o.discount) * n(i.line_total) / n(o.subtotal)) : 0, order_id: o.id }];
  });
}

/* ---- embeds (relations) --------------------------------------------------- */
const EMBEDS: Record<string, Record<string, { table: string; fk: string; many: boolean; on?: string }>> = {
  orders: { order_items: { table: "order_items", fk: "order_id", many: true }, payments: { table: "payments", fk: "order_id", many: true }, refunds: { table: "refunds", fk: "order_id", many: true }, delivery_records: { table: "delivery_records", fk: "order_id", many: true }, order_status_history: { table: "order_status_history", fk: "order_id", many: true } },
  products: { product_categories: { table: "product_categories", fk: "category_id", many: false, on: "id" } },
  customers: { customer_addresses: { table: "customer_addresses", fk: "customer_id", many: true } },
  payments: { orders: { table: "orders", fk: "order_id", many: false, on: "id" } },
  delivery_records: { orders: { table: "orders", fk: "order_id", many: false, on: "id" } },
  expenses: { expense_categories: { table: "expense_categories", fk: "category_id", many: false, on: "id" } },
  recipes: { ingredients: { table: "ingredients", fk: "ingredient_id", many: false, on: "id" } },
};
function embed(table: string, rows: Row[], select: string): Row[] {
  const rels = [...select.matchAll(/(\w+)\(([^)]*)\)/g)].map((m) => m[1]);
  if (!rels.length) return rows.map((r) => ({ ...r }));
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const rel of rels) {
      const e = EMBEDS[table]?.[rel]; if (!e) continue;
      const src = store[e.table] ?? [];
      if (e.many) out[rel] = src.filter((x) => x[e.fk] === r.id).map((x) => ({ ...x }));
      else { const hit = src.find((x) => x[e.on!] === r[e.fk]); out[rel] = hit ? { ...hit } : null; }
    }
    return out;
  });
}

/* ---- query builder -------------------------------------------------------- */
type Filter = (r: Row) => boolean;
class Builder implements PromiseLike<{ data: unknown; error: null | { message: string } }> {
  private filters: Filter[] = []; private orderBy: { col: string; asc: boolean } | null = null; private lim: number | null = null;
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select"; private payload: Row | Row[] | null = null; private sel = "*"; private one: "single" | "maybe" | null = null; private countOnly = false; private conflict = "id";
  private table: string;
  constructor(table: string) { this.table = table; }
  select(cols = "*", opts?: { count?: string; head?: boolean }) { if (this.mode === "select") this.sel = cols; if (opts?.head) this.countOnly = true; return this; }
  insert(rows: Row | Row[]) { this.mode = "insert"; this.payload = rows; return this; }
  update(patch: Row) { this.mode = "update"; this.payload = patch; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) { this.mode = "upsert"; this.payload = rows; if (opts?.onConflict) this.conflict = opts.onConflict; return this; }
  delete() { this.mode = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => r[c] == v); return this; }
  gte(c: string, v: string) { this.filters.push((r) => String(r[c] ?? "") >= v); return this; }
  lte(c: string, v: string) { this.filters.push((r) => String(r[c] ?? "") <= v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(nn: number) { this.lim = nn; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  private rows(): Row[] {
    const base = this.table === "order_financials" ? viewOrderFinancials() : this.table === "product_sales" ? viewProductSales() : (store[this.table] ?? []);
    return base.filter((r) => this.filters.every((f) => f(r)));
  }
  private finish(rows: Row[]) {
    if (this.orderBy) { const { col, asc } = this.orderBy; rows = [...rows].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1)); }
    if (this.lim != null) rows = rows.slice(0, this.lim);
    const data = embed(this.table, rows, this.sel);
    if (this.one === "single") return data.length ? { data: data[0], error: null } : { data: null, error: { message: "Row not found" } };
    if (this.one === "maybe") return { data: data[0] ?? null, error: null };
    if (this.countOnly) return { data: null, count: data.length, error: null };
    return { data, error: null };
  }
  private run() {
    try {
      if (this.mode === "select") return this.finish(this.rows());
      const tbl = (store[this.table] ??= []);
      if (this.mode === "insert" || this.mode === "upsert") {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        const out: Row[] = [];
        for (const row of list) {
          const keys = this.conflict.split(",").map((k) => k.trim());
          const existing = this.mode === "upsert" ? tbl.find((r) => keys.every((k) => row[k] != null && r[k] === row[k])) : undefined;
          if (existing) { const before = { ...existing }; Object.assign(existing, row, { updated_at: now() }); afterWrite(this.table, before, existing); out.push(existing); }
          else {
            const rec: Row = { id: uid(), created_at: now(), updated_at: now(), ...row };
            if (this.table === "orders") { rec.order_number ??= nextNumber(); Object.assign(rec, { status: rec.status ?? "pending_whatsapp_confirmation", payment_status: "unpaid", subtotal: 0, discount: rec.discount ?? 0, delivery_fee: rec.delivery_fee ?? 0, delivery_fee_customer_paid: true, tax_rate_applied: rec.tax_rate_applied ?? 0.0825, tax_amount: 0, tax_manually_set: false, prices_include_tax: false, total: 0, amount_paid: 0, amount_refunded: 0, internal_notes: rec.internal_notes ?? "", customer_notes: "", address_street: rec.address_street ?? "", address_apt: "", address_city: rec.address_city ?? "", address_state: rec.address_state ?? "", address_zip: rec.address_zip ?? "", delivery_instructions: "", requested_at: null, discount_reason: "", delivery_subsidy: 0, confirmed_at: null, completed_at: null, cancelled_at: null, deleted_at: null, source: rec.source ?? "manual" }); }
            if (this.table === "payments" || this.table === "refunds") rec.voided_at = null;
            if (this.table === "payments") rec.paid_at ??= now();
            if (this.table === "refunds") { rec.refunded_at ??= now(); rec.tax_portion ??= 0; }
            if (this.table === "expenses") Object.assign(rec, { deleted_at: null, receipt_path: rec.receipt_path ?? "", recurrence: rec.recurrence ?? "none" });
            if (this.table === "products") Object.assign(rec, { deleted_at: null, ingredient_cost: 0, name_ar: "", image_url: rec.image_url ?? "" });
            if (this.table === "customers") Object.assign(rec, { deleted_at: null, status: rec.status ?? "active", internal_notes: "", email: rec.email ?? "", merged_into_id: null });
            if (this.table === "ingredients") rec.deleted_at = null;
            tbl.push(rec); afterWrite(this.table, null, rec); out.push(rec);
            if (this.table === "orders") store.order_status_history.push({ id: uid(), order_id: rec.id, from_status: null, to_status: rec.status, changed_by: "demo", note: "Order created (manual)", created_at: now() });
          }
        }
        return this.one ? { data: out[0], error: null } : { data: out, error: null };
      }
      if (this.mode === "update") {
        const hits = tbl.filter((r) => this.filters.every((f) => f(r)));
        for (const r of hits) { const before = { ...r }; Object.assign(r, this.payload as Row, { updated_at: now() }); afterWrite(this.table, before, r); }
        return { data: hits, error: null };
      }
      if (this.mode === "delete") {
        const hits = tbl.filter((r) => this.filters.every((f) => f(r)));
        store[this.table] = tbl.filter((r) => !hits.includes(r));
        for (const r of hits) afterWrite(this.table, r, null);
        return { data: hits, error: null };
      }
      return { data: null, error: { message: "unsupported" } };
    } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  }
  then<R1 = unknown, R2 = never>(res?: ((v: { data: unknown; error: null | { message: string } }) => R1 | PromiseLike<R1>) | null, rej?: ((e: unknown) => R2 | PromiseLike<R2>) | null) {
    return new Promise((r) => setTimeout(() => r(this.run()), 60)).then(res as (v: unknown) => R1, rej ?? undefined);
  }
}
function nextNumber() { const c = store.order_counters[0]; c.last_seq = n(c.last_seq) + 1; return `PB-2026-${String(c.last_seq).padStart(5, "0")}`; }

/* ---- rpc ------------------------------------------------------------------ */
async function rpc(fn: string, args: Row) {
  await new Promise((r) => setTimeout(r, 60));
  if (fn === "create_manual_order") {
    const b = new Builder("orders");
    const res = await b.insert({ customer_name: args.p_customer_name, customer_phone: args.p_customer_phone ?? "", delivery_method: args.p_delivery_method ?? "delivery", source: "manual" }).select("id").single();
    return { data: (res.data as Row).id, error: null };
  }
  if (fn === "add_order_item") {
    const p = store.products.find((x) => x.id === args.p_product_id); if (!p) return { data: null, error: { message: "product not found" } };
    const labor = Math.round((n(p.labor_minutes) / 60) * n(store.business_settings[0].default_labor_rate_per_hour) * 10000) / 10000;
    const res = await new Builder("order_items").insert({ order_id: args.p_order_id, product_id: p.id, product_name: p.name, options: args.p_options ?? "", quantity: args.p_quantity, unit_price: p.selling_price, line_total: 0, is_taxable: p.tax_status === "taxable", unit_ingredient_cost: p.ingredient_cost, unit_packaging_cost: p.packaging_cost, unit_labor_cost: labor, unit_other_cost: p.other_direct_cost, refunded_qty: 0 }).select("id").single();
    return { data: (res.data as Row).id, error: null };
  }
  if (fn === "merge_customers") {
    for (const o of store.orders) if (o.customer_id === args.p_merge) o.customer_id = args.p_keep;
    for (const a of store.customer_addresses) if (a.customer_id === args.p_merge) { a.customer_id = args.p_keep; a.is_default = false; }
    const c = store.customers.find((x) => x.id === args.p_merge); if (c) { c.merged_into_id = args.p_keep; c.deleted_at = now(); }
    persist(); return { data: null, error: null };
  }
  return { data: null, error: { message: "unknown rpc " + fn } };
}

/* ---- public surface ------------------------------------------------------- */
export const isConfigured = true;
export const BUSINESS_WHATSAPP = "17879684078";
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T { if (res.error) throw new Error(res.error.message); return res.data as T; }
export const supabase = {
  from: (table: string) => new Builder(table),
  rpc,
  storage: { from: () => ({ upload: async (path: string) => ({ data: { path }, error: null }), createSignedUrl: async () => ({ data: { signedUrl: "data:text/plain,Receipt%20preview%20is%20not%20available%20in%20the%20demo" }, error: null }) }) },
  channel: () => ({ on: function () { return this; }, subscribe: () => ({}) }),
  removeChannel: () => {},
  auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signInWithPassword: async () => ({ error: null }), signOut: async () => {} },
};
