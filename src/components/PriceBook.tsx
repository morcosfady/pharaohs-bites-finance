import { useMemo, useState } from "react";
import { BookOpen, ArrowUpRight, ArrowDownRight, ChevronDown } from "lucide-react";
import { Skeleton, Modal, Field, useToast } from "./ui";
import { useIngredients, useIngredientLinks, useRecipeLines, useIngredientItems, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { buildIngredientPrices, itemKey, type IngredientPrice, type UnitKind } from "../lib/ingredients";
import { suggestedPackagePrice, dishImpact, priceChange, PACKAGE_UNITS } from "../lib/priceBook";
import { fmt } from "../lib/money";
import { fmtDate } from "../lib/dates";
import type { Ingredient } from "../lib/types";

/* Price book: the link between receipts and dish costs. Receipt prices are only SUGGESTIONS here. Each change
   shows which dishes it moves and by how much, and nothing changes until you tap Apply. After Apply the
   existing recipe system recalculates every dish that uses the ingredient and keeps the price history. */

const KIND_UNIT: Record<UnitKind, string> = { lb: "lb", gal: "gallon", each: "piece" };
const cleanName = (s: string) => s.replace(/\b\d+(?:\.\d+)?\s*(?:lbs?|pounds?|oz|ounces?|kg|g|gal|gallons?|l|ml|ct|count|pk|pack|fl\.?\s*oz)\b/gi, "").replace(/\s+/g, " ").trim();

/** The matching receipt price for an ingredient link (prefers a price that has a readable size). */
function receiptFor(prices: IngredientPrice[], key: string) {
  return prices.filter((p) => itemKey(p.name) === key).sort((a, b) => Number(b.normalized) - Number(a.normalized))[0] ?? null;
}

export function PriceBook() {
  const ingredients = useIngredients(); const links = useIngredientLinks(); const lines = useRecipeLines(); const items = useIngredientItems();
  const write = useWrite(); const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const prices = useMemo(() => buildIngredientPrices((items.data ?? []).map((i) => ({ description: i.description, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total, store: i.expenses?.vendor ?? "", date: i.expenses?.expense_date ?? "" })), new Date()), [items.data]);

  const rows = useMemo(() => (links.data ?? []).map((l) => {
    const ing = (ingredients.data ?? []).find((i) => i.id === l.ingredient_id);
    const rp = receiptFor(prices, l.item_key);
    if (!ing) return null;
    const sug = rp ? suggestedPackagePrice(rp.latest.price, rp.unit, ing) : null;
    const price = sug && "price" in sug ? sug.price : null;
    const used = (lines.data ?? []).filter((x) => x.ingredient_id === ing.id && x.products).map((x) => ({ product_id: x.product_id, product: x.products!.name, quantity: x.quantity, unit: x.unit, waste_pct: x.waste_pct, product_ingredient_cost: x.products!.ingredient_cost, selling_price: x.products!.selling_price }));
    return { link: l, ing, rp, price, reason: sug && "reason" in sug ? sug.reason : rp ? null : "No receipt price yet for this item.", change: price != null ? priceChange(Number(ing.package_price), price) : null, impact: price != null ? dishImpact(ing, used, price) : [] };
  }).filter((r): r is NonNullable<typeof r> => r !== null), [links.data, ingredients.data, prices, lines.data]);

  const apply = async (r: (typeof rows)[number]) => {
    if (r.price == null) return;
    try {
      await write.mutateAsync(async () => unwrap(await supabase.from("ingredients").update({ package_price: r.price }).eq("id", r.ing.id).select("id")));
      toast.push(r.impact.length ? `${r.ing.name} is now ${fmt(Math.round(r.price * 100))}. ${r.impact.length} dish${r.impact.length === 1 ? "" : "es"} recalculated.` : `${r.ing.name} is now ${fmt(Math.round(r.price * 100))}.`);
    } catch (e) { toast.push((e as Error).message, "err"); }
  };

  return (
    <section className="card">
      <div className="card-head"><div><h2 className="card-title inline-flex items-center gap-2"><BookOpen size={16} className="text-gold" /> Price book and dish costs</h2>
        <p className="text-xs text-charcoal/50">When a receipt shows a new price for an ingredient in your price book, it appears here as a suggestion. You see which dishes would change, and nothing changes until you tap Apply.</p></div></div>
      <div className="px-5 pb-5">
        {ingredients.isLoading || links.isLoading ? <Skeleton rows={3} /> : rows.length === 0 ? (
          <div className="space-y-2 rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/70">
            <p><b>Nothing connected yet.</b> Today each dish cost is a number you typed in, and there are no recipes in the system, so receipts have nothing to update. To start:</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Read some receipts (Receipts tab) so ingredient prices appear above.</li>
              <li>Tap <b>Add to price book</b> on an ingredient (flour, butter...).</li>
              <li>Open a dish on Menu &amp; Profit and add its recipe lines (how much of each ingredient it uses).</li>
            </ol>
            <p className="text-xs text-charcoal/55">Careful: the moment a dish has recipe lines, its cost comes from the recipe instead of the number you typed. Add all of a dish&apos;s ingredients before you rely on it.</p>
          </div>
        ) : (
          <ul className="divide-y divide-ivory-200">
            {rows.map((r) => {
              const worth = r.change != null && Math.abs(r.change) >= 0.03;
              const up = r.change != null && r.change > 0;
              return (
                <li key={r.link.item_key} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium [overflow-wrap:anywhere]">{r.ing.name}</div>
                      <div className="text-xs text-charcoal/50">Price book: {fmt(Math.round(Number(r.ing.package_price) * 100))} per {Number(r.ing.package_size)} {r.ing.package_unit}{r.rp ? ` · last receipt ${r.rp.latest.store}, ${fmtDate(r.rp.latest.date)}` : ""}</div>
                    </div>
                    {r.price != null && <div className="shrink-0 text-right"><b className="tabular-nums">{fmt(Math.round(r.price * 100))}</b><div className="text-xs text-charcoal/50">receipts say</div></div>}
                  </div>
                  {r.reason && <p className="mt-1 text-xs text-charcoal/55">{r.reason}</p>}
                  {r.price != null && !worth && <p className="mt-1 text-xs text-positive">Up to date: the price book matches your receipts.</p>}
                  {worth && (
                    <div className="mt-2 rounded-lg border border-gold/40 bg-gold-100/60 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`inline-flex items-center gap-1 text-sm font-medium ${up ? "text-negative" : "text-positive"}`}>{up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}Receipts say {Math.abs(Math.round((r.change ?? 0) * 100))}% {up ? "more" : "less"}</span>
                        <div className="flex gap-2">
                          {r.impact.length > 0 && <button className="btn-ghost btn-sm" onClick={() => setOpen(open === r.link.item_key ? null : r.link.item_key)} aria-expanded={open === r.link.item_key}>Dishes affected ({r.impact.length}) <ChevronDown size={13} className={open === r.link.item_key ? "rotate-180" : ""} /></button>}
                          <button className="btn-gold btn-sm" disabled={write.isPending} onClick={() => void apply(r)}>Apply new price</button>
                        </div>
                      </div>
                      {r.impact.length === 0 && <p className="mt-1 text-xs text-charcoal/60">No dish uses this ingredient yet, so no dish cost changes.</p>}
                      {open === r.link.item_key && (
                        <ul className="mt-2 divide-y divide-gold/20 text-sm">
                          {r.impact.map((d) => (
                            <li key={d.product_id} className="flex items-baseline justify-between gap-3 py-1.5">
                              <span className="min-w-0 truncate">{d.product}</span>
                              <span className="shrink-0 text-right tabular-nums">{fmt(d.oldCostCents)} → <b>{fmt(d.newCostCents)}</b> <span className={d.deltaCents > 0 ? "text-negative" : "text-positive"}>({d.deltaCents > 0 ? "+" : ""}{fmt(d.deltaCents)})</span>
                                {d.marginBefore != null && d.marginAfter != null && <span className="block text-xs text-charcoal/50">margin {Math.round(d.marginBefore * 100)}% → {Math.round(d.marginAfter * 100)}%</span>}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Button + dialog on an ingredient price row: create the price-book ingredient from the receipt and link it. */
export function AddToPriceBook({ p }: { p: IngredientPrice }) {
  const ingredients = useIngredients(); const links = useIngredientLinks();
  const write = useWrite(); const toast = useToast();
  const [open, setOpen] = useState(false);
  const key = itemKey(p.name);
  const linked = (links.data ?? []).some((l) => l.item_key === key);
  const pkgSize = p.latest.packageSize ?? 1, pkgUnit = p.latest.packageKind ? KIND_UNIT[p.latest.packageKind] : "piece", pkgPrice = p.latest.packagePrice ?? p.latest.price;
  const [f, setF] = useState({ name: cleanName(p.name) || p.name, package_size: String(Math.round(pkgSize * 1000) / 1000), package_unit: pkgUnit, package_price: pkgPrice.toFixed(2), supplier: p.latest.store });

  if (linked) return <span className="badge bg-teal-50 text-teal-800">in price book</span>;
  const save = async () => {
    try {
      await write.mutateAsync(async () => {
        const existing = (ingredients.data ?? []).find((i: Ingredient) => i.name.trim().toLowerCase() === f.name.trim().toLowerCase());
        let id = existing?.id;
        if (!id) {
          const r = unwrap(await supabase.from("ingredients").insert({ name: f.name.trim(), supplier: f.supplier, package_size: Number(f.package_size), package_unit: f.package_unit, package_price: Number(f.package_price) }).select("id").single()) as { id: string };
          id = r.id;
        }
        unwrap(await supabase.from("ingredient_receipt_links").upsert({ item_key: key, ingredient_id: id }).select("item_key"));
      });
      toast.push(`${f.name} added to the price book. Add it to a dish recipe on Menu & Profit to use it in dish costs.`); setOpen(false);
    } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <>
      <button type="button" className="text-xs text-teal-700 hover:underline" onClick={() => setOpen(true)}>+ Add to price book</button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Add to price book">
          <p className="mb-3 text-sm text-charcoal/70">This creates the ingredient the recipes use. It does not change any dish cost until you add it to a recipe.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ingredient name" className="sm:col-span-2"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Package size"><input className="input" type="number" min="0" step="0.01" value={f.package_size} onChange={(e) => setF({ ...f, package_size: e.target.value })} /></Field>
            <Field label="Unit"><select className="input" value={f.package_unit} onChange={(e) => setF({ ...f, package_unit: e.target.value })}>{PACKAGE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}</select></Field>
            <Field label="Price of that package ($)"><input className="input" type="number" min="0" step="0.01" value={f.package_price} onChange={(e) => setF({ ...f, package_price: e.target.value })} /></Field>
            <Field label="Where you buy it"><input className="input" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={!f.name.trim() || !(Number(f.package_size) > 0) || !(Number(f.package_price) >= 0) || write.isPending} onClick={save}>Add</button></div>
        </Modal>
      )}
    </>
  );
}
