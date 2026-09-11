import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid } from "recharts";
import { Plus, Trash2 } from "lucide-react";
import { useProduct, useRecipes, useIngredients, useCategories, useSettings, useWrite, useProductSalesFor } from "../hooks/queries";
import { PageHeader, Section, Skeleton, ErrorBox, Badge, Modal, Field, useToast, KpiCard, ConfirmDialog } from "../components/ui";
import { ProductModal } from "./Products";
import { TAX_STATUSES, UNITS, cls, label } from "../lib/status";
import { fmt, toCents, fromCents, pct, ratio } from "../lib/money";
import { productUnitCost, REVENUE_STATUSES } from "../lib/metrics";
import { supabase, unwrap } from "../lib/supabase";
import { format } from "date-fns";
import type { Ingredient } from "../lib/types";
import { useAdvanced } from "../hooks/useMode";

/** Mirrors unit_to_base() in the database so the UI preview matches. */
const BASE: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592, ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, pint: 473.176, quart: 946.353, gallon: 3785.41, piece: 1, package: 1 };
export function recipeLineCost(qty: number, unit: string, pkgSize: number, pkgUnit: string, pkgPrice: number, waste: number): number {
  const q = qty * (BASE[unit] ?? 1), s = pkgSize * (BASE[pkgUnit] ?? 1);
  if (!s) return 0;
  return Math.round(pkgPrice * (q / s) * (1 + waste) * 10000) / 10000;
}

export function ProductDetailPage() {
  const { id } = useParams();
  const p = useProduct(id);
  const recipes = useRecipes(id);
  const ingredients = useIngredients();
  const cats = useCategories();
  const settings = useSettings();
  const sales = useProductSalesFor(id);
  const write = useWrite(); const toast = useToast(); const advanced = useAdvanced();
  const [edit, setEdit] = useState(false);
  const [addIng, setAddIng] = useState(false);
  const [newIng, setNewIng] = useState(false);
  const [del, setDel] = useState(false);
  const save = async (fn: () => Promise<unknown>, msg = "Saved") => { try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };

  const includeLabor = settings.data?.include_owner_labor ?? false;
  const history = useMemo(() => {
    const m = new Map<string, { units: number; revenue: number; profit: number }>();
    for (const s of sales.data ?? []) {
      if (!REVENUE_STATUSES.includes(s.status)) continue;
      const k = format(new Date(s.created_at), "yyyy-MM");
      const e = m.get(k) ?? { units: 0, revenue: 0, profit: 0 };
      e.units += s.quantity; e.revenue += fromCents(toCents(s.line_total) - toCents(s.line_discount));
      e.profit += fromCents(toCents(s.line_total) - toCents(s.line_discount) - toCents(s.line_cost) - (includeLabor ? toCents(s.line_labor_cost) : 0));
      m.set(k, e);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, ...v }));
  }, [sales.data, includeLabor]);

  if (p.isLoading) return <Skeleton rows={8} className="card p-5" />;
  if (p.error || !p.data) return <ErrorBox error={p.error ?? "Not found"} />;
  const prod = p.data;
  const unitCost = productUnitCost(prod, settings.data?.default_labor_rate_per_hour ?? 0, includeLabor);
  const unitProfit = toCents(prod.selling_price) - unitCost;
  const totals = history.reduce((a, h) => ({ units: a.units + h.units, revenue: a.revenue + h.revenue, profit: a.profit + h.profit }), { units: 0, revenue: 0, profit: 0 });

  return (
    <div>
      <PageHeader title={prod.name} crumbs={["Home", "Products", prod.name]} actions={<>
        <button className="btn-ghost btn-sm" onClick={() => setEdit(true)}>Edit product</button>
        <button className="btn-ghost btn-sm text-negative" onClick={() => setDel(true)}>Archive</button>
      </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge className={cls(TAX_STATUSES, prod.tax_status)}>{label(TAX_STATUSES, prod.tax_status)}</Badge>
        <Badge className={prod.is_active ? "bg-emerald-100 text-emerald-900" : "bg-neutral-200 text-neutral-700"}>{prod.is_active ? "Active" : "Inactive"}</Badge>
        <span className="text-charcoal/60">{prod.product_categories?.name ?? "No category"} · slug <code>{prod.slug}</code></span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <KpiCard label="Selling price" value={toCents(prod.selling_price)} />
        <KpiCard label="Est. unit cost" value={unitCost} formula={`Ingredients ${fmt(toCents(prod.ingredient_cost))} + packaging ${fmt(toCents(prod.packaging_cost))} + other ${fmt(toCents(prod.other_direct_cost))}${includeLabor ? ` + labor (${prod.labor_minutes} min)` : ""}`} />
        <KpiCard label="Est. unit profit" value={unitProfit} />
        <KpiCard label="Est. margin" value={ratio(unitProfit, toCents(prod.selling_price))} kind="pct" />
        <KpiCard label="Units sold (all time)" value={totals.units} kind="int" />
        <KpiCard label="Total profit (all time)" value={Math.round(totals.profit * 100)} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title={advanced ? "Recipe & ingredient cost" : "Ingredient cost"} right={<div className="flex gap-2">{(advanced || (recipes.data ?? []).length > 0) && <><button className="btn-ghost btn-sm" onClick={() => setNewIng(true)}>New ingredient</button><button className="btn-gold btn-sm" onClick={() => setAddIng(true)}><Plus size={14} /> Add to recipe</button></>}</div>}>
          {recipes.isLoading ? <Skeleton /> : (recipes.data ?? []).length === 0 ? <p className="text-sm text-charcoal/60">Ingredient cost per unit: <b>{fmt(toCents(prod.ingredient_cost))}</b> (typed on <button className="text-teal-700 underline" onClick={() => setEdit(true)}>Edit product</button>).{advanced ? " Or add ingredients below to calculate it from a recipe." : ""}</p> : (
            <div className="table-wrap"><table className="table !min-w-0">
              <thead><tr><th>Ingredient</th><th className="num">Used</th><th className="num">Package</th><th className="num">Waste</th><th className="num">Cost</th><th></th></tr></thead>
              <tbody>{(recipes.data ?? []).map((r) => {
                const i = r.ingredients as Ingredient;
                const c = recipeLineCost(Number(r.quantity), r.unit, Number(i.package_size), i.package_unit, Number(i.package_price), Math.max(Number(r.waste_pct), Number(i.waste_pct)));
                return <tr key={r.id}>
                  <td>{i.name}<div className="text-xs text-charcoal/50">{i.supplier}</div></td>
                  <td className="num">{Number(r.quantity)} {r.unit}</td>
                  <td className="num">{Number(i.package_size)} {i.package_unit} · {fmt(toCents(i.package_price))}</td>
                  <td className="num">{pct(Math.max(Number(r.waste_pct), Number(i.waste_pct)), 0)}</td>
                  <td className="num font-medium">{fmt(Math.round(c * 100))}</td>
                  <td><button aria-label="Remove" className="text-negative" onClick={() => save(async () => unwrap(await supabase.from("recipes").delete().eq("id", r.id).select("id")), "Removed")}><Trash2 size={14} /></button></td>
                </tr>;
              })}</tbody>
              <tfoot><tr><td colSpan={4} className="text-right font-medium">Ingredient cost per unit</td><td className="num font-semibold text-teal-900">{fmt(toCents(prod.ingredient_cost))}</td><td /></tr></tfoot>
            </table></div>
          )}
          <p className="mt-2 text-xs text-charcoal/50">Example: a $10 package of 10 lb flour with 1 lb used costs $1.00. Changing an ingredient's price updates this product from now on; past orders keep the cost that applied when they were sold.</p>
        </Section>

        <Section title="Sales history (monthly)">
          {history.length === 0 ? <p className="text-sm text-charcoal/60">No sales recorded yet.</p> : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={history}><CartesianGrid strokeDasharray="3 3" stroke="#e5ddc7" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={44} />
                <RTooltip formatter={(v: unknown, n: unknown) => n === "units" ? Number(v) : fmt(Math.round(Number(v) * 100))} />
                <Line type="monotone" dataKey="revenue" stroke="#0F4C4C" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="profit" stroke="#D4A72C" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="units" stroke="#146060" strokeDasharray="4 2" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
          <ul className="mt-2 max-h-56 divide-y divide-ivory-200 overflow-y-auto text-sm">
            {(sales.data ?? []).slice(0, 50).map((s, i) => <li key={i} className="flex justify-between py-1.5"><Link to={`/orders/${s.order_id}`} className="text-teal-700 hover:underline">{format(new Date(s.created_at), "MMM d, yyyy")}</Link><span>{s.quantity} × · {fmt(toCents(s.line_total))} · <span className="text-charcoal/50">{s.status}</span></span></li>)}
          </ul>
        </Section>
      </div>

      <ProductModal key={String(edit)} open={edit} onClose={() => setEdit(false)} categories={cats.data ?? []} product={prod} hasRecipe={(recipes.data ?? []).length > 0} />
      <AddRecipeModal open={addIng} onClose={() => setAddIng(false)} productId={prod.id} ingredients={ingredients.data ?? []} onSave={save} />
      <IngredientModal open={newIng} onClose={() => setNewIng(false)} onSave={save} />
      <ConfirmDialog open={del} title="Archive this product?" body="It is hidden from the catalogue and the website cannot order it. Sales history is kept." danger confirmLabel="Archive" onCancel={() => setDel(false)} onConfirm={async () => { setDel(false); await save(async () => unwrap(await supabase.from("products").update({ deleted_at: new Date().toISOString(), is_active: false }).eq("id", prod.id).select("id")), "Product archived"); }} />
    </div>
  );
}

function AddRecipeModal({ open, onClose, productId, ingredients, onSave }: { open: boolean; onClose: () => void; productId: string; ingredients: Ingredient[]; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [iid, setIid] = useState(""); const [qty, setQty] = useState(1); const [unit, setUnit] = useState("oz"); const [waste, setWaste] = useState(0);
  const ing = ingredients.find((i) => i.id === iid);
  const preview = ing ? recipeLineCost(qty, unit, Number(ing.package_size), ing.package_unit, Number(ing.package_price), Math.max(waste, Number(ing.waste_pct))) : 0;
  return (
    <Modal open={open} onClose={onClose} title="Add ingredient to recipe">
      <Field label="Ingredient"><select className="input" value={iid} onChange={(e) => { setIid(e.target.value); const i = ingredients.find((x) => x.id === e.target.value); if (i) setUnit(i.package_unit); }}><option value="">Choose…</option>{ingredients.map((i) => <option key={i.id} value={i.id}>{i.name} — {Number(i.package_size)} {i.package_unit} for {fmt(toCents(i.package_price))}</option>)}</select></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Quantity used"><input className="input" type="number" step="0.01" min="0" value={qty} onChange={(e) => setQty(Number(e.target.value))} /></Field>
        <Field label="Unit"><select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        <Field label="Waste %"><input className="input" type="number" step="1" min="0" max="90" value={waste * 100} onChange={(e) => setWaste(Number(e.target.value) / 100)} /></Field>
      </div>
      <p className="mb-3 text-sm">Calculated cost for this line: <b>{fmt(Math.round(preview * 100))}</b></p>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!iid || !(qty > 0)} onClick={async () => { await onSave(async () => unwrap(await supabase.from("recipes").upsert({ product_id: productId, ingredient_id: iid, quantity: qty, unit, waste_pct: waste }, { onConflict: "product_id,ingredient_id" }).select("id")), "Recipe updated"); onClose(); }}>Add</button></div>
    </Modal>
  );
}

export function IngredientModal({ open, onClose, onSave, ingredient }: { open: boolean; onClose: () => void; onSave: (fn: () => Promise<unknown>, msg?: string) => Promise<void>; ingredient?: Ingredient }) {
  const [f, setF] = useState({ name: ingredient?.name ?? "", supplier: ingredient?.supplier ?? "", package_size: Number(ingredient?.package_size ?? 1), package_unit: ingredient?.package_unit ?? "lb", package_price: Number(ingredient?.package_price ?? 0), waste_pct: Number(ingredient?.waste_pct ?? 0), notes: ingredient?.notes ?? "" });
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value });
  return (
    <Modal open={open} onClose={onClose} title={ingredient ? "Edit ingredient" : "New ingredient"}>
      <Field label="Name"><input className="input" value={f.name} onChange={u("name")} /></Field>
      <Field label="Supplier"><input className="input" value={f.supplier} onChange={u("supplier")} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Package size"><input className="input" type="number" step="0.01" min="0" value={f.package_size} onChange={u("package_size")} /></Field>
        <Field label="Unit"><select className="input" value={f.package_unit} onChange={u("package_unit")}>{UNITS.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Package price"><input className="input" type="number" step="0.01" min="0" value={f.package_price} onChange={u("package_price")} /></Field>
      </div>
      <Field label="Default waste %"><input className="input" type="number" min="0" max="90" value={f.waste_pct * 100} onChange={(e) => setF({ ...f, waste_pct: Number(e.target.value) / 100 })} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name || !(f.package_size > 0)} onClick={async () => { await onSave(async () => unwrap(await supabase.from("ingredients").upsert({ ...(ingredient ? { id: ingredient.id } : {}), ...f }).select("id")), "Ingredient saved"); onClose(); }}>Save</button></div>
    </Modal>
  );
}
