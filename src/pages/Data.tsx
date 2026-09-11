import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { PageHeader, Section, Field, useToast } from "../components/ui";
import { useOrders, usePayments, useProducts, useExpenses, useCustomers, useExpenseCategories, useWrite } from "../hooks/queries";
import { toCsv, parseCsv, downloadText, isValidDate, isValidMoney, parseMoney } from "../lib/csv";
import { supabase, unwrap } from "../lib/supabase";

type Kind = "expenses" | "products" | "orders";
const TEMPLATES: Record<Kind, string[]> = {
  expenses: ["date", "vendor", "category", "description", "amount_before_tax", "sales_tax_paid", "payment_method", "cost_type", "notes"],
  products: ["slug", "name", "category", "selling_price", "tax_status", "packaging_cost", "labor_minutes", "is_active"],
  orders: ["order_number", "date", "customer_name", "customer_phone", "status", "subtotal", "discount", "delivery_fee", "tax_amount", "payment_method", "notes"],
};

export function DataPage() {
  const orders = useOrders(); const payments = usePayments(); const products = useProducts(); const expenses = useExpenses(); const customers = useCustomers(); const cats = useExpenseCategories();
  const write = useWrite(); const toast = useToast();
  const [kind, setKind] = useState<Kind>("expenses");
  const [preview, setPreview] = useState<{ rows: Record<string, string>[]; errors: string[]; headers: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const exportAll = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`orders-${stamp}.csv`, toCsv((orders.data ?? []).map((o) => ({ order_number: o.order_number, date: o.created_at, customer_name: o.customer_name, customer_phone: o.customer_phone, status: o.status, payment_status: o.payment_status, payment_method: o.payment_method, delivery_method: o.delivery_method, subtotal: o.subtotal, discount: o.discount, delivery_fee: o.delivery_fee, tax_amount: o.tax_amount, total: o.total, amount_paid: o.amount_paid, amount_refunded: o.amount_refunded, address: [o.address_street, o.address_apt, o.address_city, o.address_state, o.address_zip].filter(Boolean).join(", "), items: (o.order_items ?? []).map((i) => `${i.quantity}x ${i.product_name}`).join("; ") }))));
  };
  const backup = () => {
    const payload = { exported_at: new Date().toISOString(), orders: orders.data, payments: payments.data, products: products.data, expenses: expenses.data, customers: customers.data };
    downloadText(`pharaohs-bites-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), "application/json");
  };

  const onFile = async (file: File) => {
    const { headers, rows } = parseCsv(await file.text());
    const errors: string[] = [];
    const need = TEMPLATES[kind].slice(0, kind === "expenses" ? 5 : kind === "products" ? 4 : 6);
    for (const h of need) if (!headers.includes(h)) errors.push(`Missing column "${h}"`);
    const existingOrders = new Set((orders.data ?? []).map((o) => o.order_number));
    rows.forEach((r, i) => {
      const n = i + 2;
      if (kind === "expenses") { if (!isValidDate(r.date)) errors.push(`Row ${n}: invalid date "${r.date}"`); if (!isValidMoney(r.amount_before_tax || "0")) errors.push(`Row ${n}: invalid amount`); }
      if (kind === "products") { if (!r.name) errors.push(`Row ${n}: name required`); if (!isValidMoney(r.selling_price)) errors.push(`Row ${n}: invalid price`); }
      if (kind === "orders") { if (!isValidDate(r.date)) errors.push(`Row ${n}: invalid date`); if (!r.customer_name) errors.push(`Row ${n}: customer name required`); if (!isValidMoney(r.subtotal)) errors.push(`Row ${n}: invalid subtotal`); if (r.order_number && existingOrders.has(r.order_number)) errors.push(`Row ${n}: order ${r.order_number} already exists (skipped to prevent duplicates)`); }
    });
    setPreview({ headers, rows, errors });
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      let n = 0;
      if (kind === "expenses") {
        const cmap = new Map((cats.data ?? []).map((c) => [c.name.toLowerCase(), c]));
        for (const r of preview.rows) {
          if (!isValidDate(r.date) || !isValidMoney(r.amount_before_tax || "0")) continue;
          const c = cmap.get((r.category || "").toLowerCase());
          await write.mutateAsync(async () => unwrap(await supabase.from("expenses").insert({ expense_date: r.date.slice(0, 10), vendor: r.vendor, category_id: c?.id ?? null, description: r.description, amount_before_tax: parseMoney(r.amount_before_tax || "0"), sales_tax_paid: parseMoney(r.sales_tax_paid || "0"), payment_method: r.payment_method || null, cost_type: r.cost_type === "direct_product" ? "direct_product" : (c?.cost_type ?? "operating"), notes: r.notes || "" }).select("id"))); n++;
        }
      } else if (kind === "products") {
        for (const r of preview.rows) {
          if (!r.name || !isValidMoney(r.selling_price)) continue;
          const slug = (r.slug || r.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
          await write.mutateAsync(async () => unwrap(await supabase.from("products").upsert({ slug, name: r.name, selling_price: parseMoney(r.selling_price), tax_status: ["taxable", "nontaxable", "review"].includes(r.tax_status) ? r.tax_status : "review", packaging_cost: parseMoney(r.packaging_cost || "0"), labor_minutes: Number(r.labor_minutes || 0), is_active: r.is_active !== "false" && r.is_active !== "0" }, { onConflict: "slug" }).select("id"))); n++;
        }
      } else {
        const existing = new Set((orders.data ?? []).map((o) => o.order_number));
        for (const r of preview.rows) {
          if (!isValidDate(r.date) || !r.customer_name || !isValidMoney(r.subtotal) || (r.order_number && existing.has(r.order_number))) continue;
          await write.mutateAsync(async () => {
            const id = unwrap(await supabase.rpc("create_manual_order", { p_customer_name: r.customer_name, p_customer_phone: r.customer_phone || "", p_delivery_method: "delivery" })) as string;
            unwrap(await supabase.from("orders").update({ source: "import", created_at: new Date(r.date).toISOString(), status: r.status || "completed", subtotal: parseMoney(r.subtotal), discount: parseMoney(r.discount || "0"), delivery_fee: parseMoney(r.delivery_fee || "0"), tax_amount: parseMoney(r.tax_amount || "0"), tax_manually_set: true, payment_method: r.payment_method || null, internal_notes: `[IMPORT${r.order_number ? " " + r.order_number : ""}] ${r.notes || ""}` }).eq("id", id).select("id"));
          }); n++;
        }
      }
      toast.push(`${n} row${n === 1 ? "" : "s"} imported`); setPreview(null);
    } catch (e) { toast.push((e as Error).message, "err"); } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Import / Export & Backup" crumbs={["Home", "Import / Export"]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Export">
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost btn-sm" onClick={exportAll}><Download size={14} /> Orders CSV</button>
            <button className="btn-ghost btn-sm" onClick={() => downloadText("payments.csv", toCsv((payments.data ?? []).map((p) => ({ date: p.paid_at, order: p.orders?.order_number, customer: p.orders?.customer_name, amount: p.amount, method: p.method, reference: p.reference, voided: !!p.voided_at }))))}><Download size={14} /> Payments CSV</button>
            <button className="btn-ghost btn-sm" onClick={() => downloadText("products.csv", toCsv((products.data ?? []).map((p) => ({ slug: p.slug, name: p.name, category: p.product_categories?.name, selling_price: p.selling_price, tax_status: p.tax_status, ingredient_cost: p.ingredient_cost, packaging_cost: p.packaging_cost, labor_minutes: p.labor_minutes, is_active: p.is_active }))))}><Download size={14} /> Products CSV</button>
            <button className="btn-ghost btn-sm" onClick={() => downloadText("expenses.csv", toCsv((expenses.data ?? []).map((e) => ({ date: e.expense_date, vendor: e.vendor, category: e.expense_categories?.name, description: e.description, amount_before_tax: e.amount_before_tax, sales_tax_paid: e.sales_tax_paid, total: e.total_amount, payment_method: e.payment_method, cost_type: e.cost_type, notes: e.notes }))))}><Download size={14} /> Expenses CSV</button>
            <button className="btn-primary btn-sm" onClick={backup}><Download size={14} /> Full backup (JSON)</button>
          </div>
          <p className="mt-3 text-xs text-charcoal/50">The JSON backup contains every order, item, payment, product, expense and customer you can see. Keep it somewhere private — it includes customer names, phones and addresses. A full database-level backup is described in the README.</p>
        </Section>
        <Section title="Import CSV">
          <Field label="What are you importing?"><select className="input" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPreview(null); }}><option value="expenses">Expenses</option><option value="products">Products</option><option value="orders">Historical orders (totals only)</option></select></Field>
          <p className="mb-2 text-xs text-charcoal/60">Columns: <code>{TEMPLATES[kind].join(", ")}</code> <button className="text-teal-700 hover:underline" onClick={() => downloadText(`${kind}-template.csv`, TEMPLATES[kind].join(",") + "\r\n")}>download template</button></p>
          <input type="file" accept=".csv,text/csv" className="input" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          {preview && (
            <div className="mt-3">
              <p className="text-sm font-medium">{preview.rows.length} rows found · {preview.errors.length} problem{preview.errors.length === 1 ? "" : "s"}</p>
              {preview.errors.length > 0 && <ul className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-red-50 px-3 py-2 text-xs text-negative">{preview.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul>}
              <div className="table-wrap mt-2 max-h-64 overflow-auto"><table className="table"><thead><tr>{preview.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 20).map((r, i) => <tr key={i}>{preview.headers.map((h) => <td key={h}>{r[h]}</td>)}</tr>)}</tbody></table></div>
              <button className="btn-primary mt-3" disabled={busy || preview.rows.length === 0} onClick={commit}><Upload size={16} /> {busy ? "Importing…" : `Import valid rows${preview.errors.length ? " (invalid rows are skipped)" : ""}`}</button>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
