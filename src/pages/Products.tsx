import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { DataTable, type Column } from "../components/DataTable";
import { PageHeader, Badge, Skeleton, ErrorBox, Modal, Field, useToast, EditButton } from "../components/ui";
import { useProducts, useCategories, useSettings, useWrite, useAllOrderFinancials, useProductSalesFor } from "../hooks/queries";
import { TAX_STATUSES, cls, label } from "../lib/status";
import { fmt, toCents, pct, ratio } from "../lib/money";
import { productUnitCost, REVENUE_STATUSES } from "../lib/metrics";
import { supabase, unwrap } from "../lib/supabase";
import { useQuery } from "@tanstack/react-query";
import type { Product, ProductSale } from "../lib/types";
import { fmtDate } from "../lib/dates";
import { useAdvanced } from "../hooks/useMode";

type Row = Product & { unitCost: number; unitProfit: number; margin: number | null; sold: number; revenue: number; profit: number; category: string };

export function ProductsPage() {
  const nav = useNavigate();
  const products = useProducts();
  const cats = useCategories();
  const settings = useSettings();
  const sales = useQuery({ queryKey: ["product_sales", "all"], queryFn: async () => unwrap(await supabase.from("product_sales").select("*").limit(20000)) as ProductSale[] });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const recipeIds = useQuery({ queryKey: ["recipes", "product-ids"], queryFn: async () => new Set((unwrap(await supabase.from("recipes").select("product_id")) as { product_id: string }[]).map((r) => r.product_id)) });
  const advanced = useAdvanced();
  const includeLabor = settings.data?.include_owner_labor ?? false;
  const laborRate = settings.data?.default_labor_rate_per_hour ?? 0;

  const rows = useMemo<Row[]>(() => (products.data ?? []).map((p) => {
    const unitCost = productUnitCost(p, laborRate, includeLabor);
    const unitProfit = toCents(p.selling_price) - unitCost;
    const mine = (sales.data ?? []).filter((s) => s.product_id === p.id && REVENUE_STATUSES.includes(s.status));
    const sold = mine.reduce((s, x) => s + x.quantity, 0);
    const revenue = mine.reduce((s, x) => s + toCents(x.line_total) - toCents(x.line_discount), 0);
    const cost = mine.reduce((s, x) => s + toCents(x.line_cost) + (includeLabor ? toCents(x.line_labor_cost) : 0), 0);
    return { ...p, unitCost, unitProfit, margin: ratio(unitProfit, toCents(p.selling_price)), sold, revenue, profit: revenue - cost, category: p.product_categories?.name ?? "—" };
  }), [products.data, sales.data, laborRate, includeLabor]);

  const allCols: Column<Row>[] = [
    { key: "name", header: "Product", primary: true, render: (p) => <div className="flex items-center gap-2">{p.image_url && <img src={p.image_url} alt="" className="h-9 w-9 rounded object-cover" loading="lazy" />}<div><div className="font-medium">{p.name}</div><div className="text-xs text-charcoal/50">{p.category}{!p.is_active && " · inactive"}</div></div></div> },
    { key: "selling_price", header: "Price", numeric: true, render: (p) => fmt(toCents(p.selling_price)), sortValue: (p) => toCents(p.selling_price) },
    { key: "tax_status", header: "Tax", render: (p) => <Badge className={cls(TAX_STATUSES, p.tax_status)}>{label(TAX_STATUSES, p.tax_status)}</Badge> },
    { key: "ingredient_cost", header: "Ingredients", numeric: true, mobile: false, render: (p) => fmt(toCents(p.ingredient_cost)), sortValue: (p) => toCents(p.ingredient_cost) },
    { key: "packaging_cost", header: "Packaging", numeric: true, mobile: false, render: (p) => fmt(toCents(p.packaging_cost)), sortValue: (p) => toCents(p.packaging_cost) },
    { key: "unitCost", header: "Unit cost", numeric: true, render: (p) => fmt(p.unitCost) },
    { key: "unitProfit", header: "Unit profit", numeric: true, render: (p) => <span className={p.unitProfit < 0 ? "text-negative" : ""}>{fmt(p.unitProfit)}</span> },
    { key: "margin", header: "Margin", numeric: true, render: (p) => <span className={p.margin != null && p.margin < Number(settings.data?.low_margin_warning_pct ?? 0.3) ? "text-warning" : ""}>{pct(p.margin)}</span> },
    { key: "sold", header: "Sold", numeric: true },
    { key: "revenue", header: "Revenue", numeric: true, render: (p) => fmt(p.revenue) },
    { key: "profit", header: "Profit", numeric: true, render: (p) => fmt(p.profit) },
    { key: "updated_at", header: "Updated", mobile: false, render: (p) => fmtDate(p.updated_at) },
  ];
  const editCol: Column<Row> = { key: "edit", header: "", render: (p) => <EditButton small label={`Edit ${p.name}`} onClick={() => setEditing(p)} /> };
  const cols = [...(advanced ? allCols : allCols.filter((c) => ["name", "selling_price", "unitCost", "unitProfit", "sold", "profit"].includes(c.key))), editCol];

  return (
    <div>
      <PageHeader title="Products" crumbs={["Home", "Products"]} actions={<button className="btn-gold btn-sm" onClick={() => setOpen(true)}><Plus size={16} /> New product</button>} />
      <p className="mb-3 text-sm text-charcoal/60">{advanced ? `Unit cost = ingredients (from recipes) + packaging + other direct cost${includeLabor ? " + owner labor" : ""}. Click a product to edit it and its recipe.` : "Click a product to change its price or what it costs you to make."}</p>
      {products.error && <ErrorBox error={products.error} />}
      {products.isLoading ? <Skeleton rows={8} className="card p-5" /> : <DataTable rows={rows} columns={cols} rowKey={(p) => p.id} onRowClick={(p) => nav(`/products/${p.id}`)} initialSort={{ key: "revenue", dir: "desc" }} />}
      <ProductModal open={open} onClose={() => setOpen(false)} categories={cats.data ?? []} />
      {editing && <ProductModal key={editing.id} open onClose={() => setEditing(null)} categories={cats.data ?? []} product={editing} hasRecipe={recipeIds.data?.has(editing.id) ?? false} />}
    </div>
  );
}

export function ProductModal({ open, onClose, categories, product, hasRecipe }: { open: boolean; onClose: () => void; categories: { id: string; name: string }[]; product?: Product; hasRecipe?: boolean }) {
  const write = useWrite(); const toast = useToast(); const nav = useNavigate(); const advanced = useAdvanced();
  const [f, setF] = useState({ name: product?.name ?? "", slug: product?.slug ?? "", category_id: product?.category_id ?? "", description: product?.description ?? "", image_url: product?.image_url ?? "", selling_price: Number(product?.selling_price ?? 0), is_active: product?.is_active ?? true, tax_status: product?.tax_status ?? "review", packaging_cost: Number(product?.packaging_cost ?? 0), labor_minutes: Number(product?.labor_minutes ?? 0), other_direct_cost: Number(product?.other_direct_cost ?? 0), ingredient_cost: Number(product?.ingredient_cost ?? 0) });
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const submit = async () => {
    const slug = (f.slug || f.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    try {
      const { ingredient_cost, ...rest } = f;
      const payload = { ...(product ? { id: product.id } : {}), ...rest, slug, category_id: f.category_id || null, ...(hasRecipe ? {} : { ingredient_cost }) };
      const row = (await write.mutateAsync(async () => unwrap(await supabase.from("products").upsert(payload).select("id").single()))) as { id: string };
      toast.push(product ? "Product saved" : "Product created"); onClose(); if (!product) nav(`/products/${row.id}`);
    } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <Modal open={open} onClose={onClose} title={product ? "Edit product" : "New product"} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={f.name} onChange={u("name")} /></Field>
        <Field label="Selling price"><input className="input" type="number" step="0.01" min="0" value={f.selling_price} onChange={u("selling_price")} /></Field>
        <Field label="Category"><select className="input" value={f.category_id} onChange={u("category_id")}><option value="">—</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Tax status" hint="You decide taxability; the dashboard never guesses."><select className="input" value={f.tax_status} onChange={u("tax_status")}>{TAX_STATUSES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
        <Field label="Ingredient cost per unit" hint={hasRecipe ? "Calculated from the recipe; edit the recipe to change it." : "Type what the ingredients cost you for one unit (or build a recipe on the product page)."}><input className="input" type="number" step="0.01" min="0" value={f.ingredient_cost} disabled={hasRecipe} onChange={u("ingredient_cost")} /></Field>
        <Field label="Packaging cost per unit"><input className="input" type="number" step="0.01" min="0" value={f.packaging_cost} onChange={u("packaging_cost")} /></Field>
        {advanced && <>
        <Field label="Other direct cost per unit"><input className="input" type="number" step="0.01" min="0" value={f.other_direct_cost} onChange={u("other_direct_cost")} /></Field>
        <Field label="Labor minutes per unit"><input className="input" type="number" step="1" min="0" value={f.labor_minutes} onChange={u("labor_minutes")} /></Field>
        <Field label="Slug (website id)" hint="Must match the id used on the customer website for online ordering."><input className="input" value={f.slug} onChange={u("slug")} placeholder="auto from name" /></Field>
        <Field label="Active"><select className="input" value={f.is_active ? "1" : "0"} onChange={(e) => setF({ ...f, is_active: e.target.value === "1" })}><option value="1">Active (orderable)</option><option value="0">Inactive</option></select></Field>
        <Field label="Image URL"><input className="input" value={f.image_url} onChange={u("image_url")} /></Field>
        <Field label="Description" className="sm:col-span-2"><textarea className="input" value={f.description} onChange={u("description")} /></Field>
        </>}
      </div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name || write.isPending} onClick={submit}>Save</button></div>
    </Modal>
  );
}

/* re-exported so ProductDetail can reuse the sales list */
export { useProductSalesFor, useAllOrderFinancials };
