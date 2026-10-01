import { useMemo, useState } from "react";
import { Car, Plus, MapPin, Route, Trash2, AlertTriangle, Check } from "lucide-react";
import { Skeleton, Modal, Field, KpiCard, useToast, ConfirmDialog, EmptyState, EditButton } from "./ui";
import { useMileageLogs, useMileageSettings, useIrsRates, useMileagePlaces, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { fmt } from "../lib/money";
import { fmtDate, toInputDate, type DateRange } from "../lib/dates";
import { summarizeMileage, routeCandidates, formatCents, KIND_LABEL } from "../lib/mileage";
import type { MileageLog, MileagePlace } from "../lib/types";

/* Mileage: a tax deduction (miles x the IRS rate in force on each trip date), reported next to
   expenses but never added into them. Delivery trips appear by themselves when an order is
   completed (one per order, ever). Bookkeeping support, not tax advice: choices that need an
   accountant say so. */

export function MileageTab({ range, gas }: { range: DateRange; gas: { count: number; total: number } }) {
  const logs = useMileageLogs(range);
  const settings = useMileageSettings();
  const rates = useIrsRates();
  const places = useMileagePlaces();
  const write = useWrite(); const toast = useToast();
  const [edit, setEdit] = useState<MileageLog | "new" | null>(null);
  const [placeModal, setPlaceModal] = useState(false);
  const [routeModal, setRouteModal] = useState(false);
  const [del, setDel] = useState<MileageLog | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const rows = useMemo(() => logs.data ?? [], [logs.data]);
  const sum = useMemo(() => summarizeMileage(rows), [rows]);
  const s = settings.data;
  const unconfirmedRates = (rates.data ?? []).filter((r) => !r.confirmed);
  const pickedRows = rows.filter((r) => picked.includes(r.id));
  const sameDay = pickedRows.length > 1 && new Set(pickedRows.map((r) => r.trip_date)).size === 1;
  const toggle = (id: string) => setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  const run = async (fn: () => Promise<unknown>, msg: string) => { try { await write.mutateAsync(fn); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };

  const quickTrip = (p: MileagePlace) => run(async () => unwrap(await supabase.from("mileage_logs").insert({
    trip_date: toInputDate(new Date()), kind: "supply", purpose: `Supply run: ${p.name}`, from_label: "Kitchen", to_label: p.name,
    miles: Math.round(Number(p.one_way_miles) * 2 * 10) / 10, vehicle: s?.vehicle ?? "", estimated: true,
    notes: "Round trip. Miles saved with the place (estimate unless you measured them).",
  }).select("id")), `${p.name} trip added (${(Number(p.one_way_miles) * 2).toFixed(1)} mi). Tapped by mistake? Delete it below.`);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Business miles" value={sum.miles} kind="int" />
        <KpiCard label="Mileage deduction" value={sum.deduction} />
        <KpiCard label="Trips" value={sum.trips} kind="int" />
        <div className="card flex flex-col gap-1 px-4 py-3"><span className="text-xs font-medium uppercase leading-tight tracking-wider text-teal-900/70">IRS rate</span><span className="font-display text-2xl font-semibold text-teal-900">{formatCents((rates.data ?? []).find((r) => r.effective_from <= toInputDate(range.to) && r.effective_to >= toInputDate(range.to))?.cents_per_mile)}</span><span className="text-xs text-charcoal/50">per mile, on the period end date</span></div>
      </div>

      {(unconfirmedRates.length > 0 || sum.missingRate > 0 || sum.estimatedMiles > 0 || (s?.method === "standard" && gas.count > 0)) && (
        <div className="space-y-2 rounded-xl border border-warning/40 bg-gold-100 px-4 py-3 text-sm">
          {unconfirmedRates.length > 0 && <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" /><span><b>Confirm the IRS rate.</b> I copied it from irs.gov on 2026-10-01 (72.5¢ Jan to Jun, 76¢ Jul to Dec). Check it below and tap Confirm.</span></p>}
          {sum.missingRate > 0 && <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" /><span><b>{sum.missingRate} trip{sum.missingRate === 1 ? " has" : "s have"} no IRS rate</b> for its date, so no deduction is counted yet. Add the rate below.</span></p>}
          {sum.estimatedMiles > 0 && <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" /><span><b>{sum.estimatedMiles.toFixed(1)} of {sum.miles.toFixed(1)} miles are estimates</b> (from the delivery fee formula, not an odometer or a map). <i>Ask accountant</i> if that is acceptable. Edit a trip and tick “measured” once you have the real number.</span></p>}
          {s?.method === "standard" && gas.count > 0 && <p className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" /><span><b>Gas is not deducted separately.</b> With the standard mileage method, the {gas.count} gas purchase{gas.count === 1 ? "" : "s"} in this period ({fmt(Math.round(gas.total * 100))}) are excluded from deductions. <i>Ask accountant</i> before choosing the method.</span></p>}
        </div>
      )}

      <section className="card">
        <div className="card-head"><div><h2 className="card-title inline-flex items-center gap-2"><MapPin size={16} className="text-gold" /> One-tap supply trips</h2><p className="text-xs text-charcoal/50">Tap a store when you go shopping. Counts there and back.</p></div>
          <button className="btn-ghost btn-sm" onClick={() => setPlaceModal(true)}><Plus size={14} /> Add place</button></div>
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          {places.isLoading ? <Skeleton rows={1} /> : (places.data ?? []).length === 0
            ? <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">No places yet. Add Costco, Walmart, WebstaurantStore… once, then it is one tap per trip.</p>
            : (places.data ?? []).map((p) => (
              <button key={p.id} className="btn-ghost" disabled={write.isPending} onClick={() => quickTrip(p)}><Car size={14} /> {p.name} <span className="text-xs text-charcoal/50">{(Number(p.one_way_miles) * 2).toFixed(1)} mi</span></button>
            ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><div><h2 className="card-title">Trip log</h2><p className="text-xs text-charcoal/50">Delivery trips are added automatically when an order is completed.</p></div>
          <div className="flex flex-wrap gap-2">
            {sameDay && <button className="btn-gold btn-sm" onClick={() => setRouteModal(true)}><Route size={14} /> Combine {pickedRows.length} into one route</button>}
            <button className="btn-ghost btn-sm" onClick={() => setEdit("new")}><Plus size={14} /> Add trip</button>
          </div></div>
        <div className="px-5 pb-5">
          {logs.isLoading ? <Skeleton rows={3} /> : rows.length === 0 ? <EmptyState title="No trips in this period" hint="Complete a delivery order or tap a supply trip above." /> : (
            <ul className="divide-y divide-ivory-200">
              {rows.map((r) => {
                const canPick = r.kind === "delivery" && r.counted && !r.route_id;
                return (
                  <li key={r.id} className={`flex items-center gap-3 py-2.5 ${r.counted ? "" : "opacity-50"}`}>
                    {routeCandidates(rows, r.trip_date).length > 1 && canPick
                      ? <input type="checkbox" aria-label={`Select trip ${r.purpose}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                      : <span className="w-4" />}
                    <span className="w-14 shrink-0 text-xs text-charcoal/50">{fmtDate(r.trip_date)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.purpose || KIND_LABEL[r.kind]}
                        {r.estimated && <span className="badge ml-2 bg-ivory-200 text-charcoal/60" title="Miles are an estimate">est.</span>}
                        {r.route_id && <span className="badge ml-2 bg-ivory-200 text-charcoal/60" title="Counted inside a combined route">in route</span>}
                      </span>
                      <span className="block truncate text-xs text-charcoal/50">{r.from_label || "—"} → {r.to_label || "—"}</span>
                    </span>
                    <span className="text-right"><b className="block tabular-nums">{Number(r.miles).toFixed(1)} mi</b><span className="text-xs text-charcoal/50">{r.counted ? (r.deduction == null ? "no rate" : fmt(Math.round(Number(r.deduction) * 100))) : "not counted"}</span></span>
                    {r.counted && !r.order_id && r.kind === "delivery" && r.to_label === "Several customers"
                      ? <button className="text-xs text-teal-700 hover:underline" onClick={() => run(async () => unwrap(await supabase.rpc("split_mileage_route", { p_route_id: r.id })), "Route split back into its trips")}>split</button>
                      : <EditButton small label="Edit trip" onClick={() => setEdit(r)} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <SettingsCard />

      {edit && <TripModal trip={edit === "new" ? undefined : edit} vehicle={s?.vehicle ?? ""} onClose={() => setEdit(null)} onDelete={(t) => { setEdit(null); setDel(t); }} />}
      {placeModal && <PlaceModal onClose={() => setPlaceModal(false)} />}
      {routeModal && <RouteModal trips={pickedRows} onClose={() => setRouteModal(false)} onDone={() => { setRouteModal(false); setPicked([]); }} />}
      <ConfirmDialog open={!!del} title="Delete this trip?" body="It is archived (kept in the audit log) and stops counting. A deleted delivery trip is not recreated." danger confirmLabel="Delete"
        onCancel={() => setDel(null)}
        onConfirm={async () => { const t = del!; setDel(null); await run(async () => unwrap(await supabase.from("mileage_logs").update({ deleted_at: new Date().toISOString() }).eq("id", t.id).select("id")), "Trip deleted"); }} />
    </div>
  );
}

/* ---------- settings: method, round trip, vehicle, rates ---------- */
function SettingsCard() {
  const settings = useMileageSettings(); const rates = useIrsRates();
  const write = useWrite(); const toast = useToast();
  const s = settings.data;
  const [newRate, setNewRate] = useState({ from: "", to: "", cents: "" });
  const save = async (patch: Record<string, unknown>, msg = "Saved") => { try { await write.mutateAsync(async () => unwrap(await supabase.from("mileage_settings").update(patch).eq("id", true).select("id"))); toast.push(msg); } catch (e) { toast.push((e as Error).message, "err"); } };
  if (!s) return null;
  return (
    <section className="card">
      <div className="card-head"><h2 className="card-title">Mileage settings</h2></div>
      <div className="space-y-4 px-5 pb-5 text-sm">
        <div>
          <b>Method</b>
          <div className="mt-1 flex flex-wrap gap-2">
            {(["standard", "actual"] as const).map((m) => (
              <label key={m} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${s.method === m ? "border-teal-800 bg-teal-50" : "border-ivory-200"}`}>
                <input type="radio" name="method" checked={s.method === m} onChange={() => save({ method: m, method_confirmed: false })} />
                {m === "standard" ? "Standard mileage rate" : "Actual car expenses"}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-charcoal/60">Standard = miles x IRS rate; gas and repairs for that car are not deducted on top. <b>Ask accountant</b> which method to use.</p>
          <label className="mt-1.5 flex items-center gap-2 text-xs"><input type="checkbox" checked={s.method_confirmed} onChange={(e) => save({ method_confirmed: e.target.checked })} /> My accountant confirmed this choice</label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.delivery_round_trip} onChange={(e) => save({ delivery_round_trip: e.target.checked }, "Saved. Applies to future deliveries.")} /> Count deliveries there and back</label>
          <Field label="Vehicle" className="!mb-0"><input className="input" defaultValue={s.vehicle} onBlur={(e) => e.target.value !== s.vehicle && save({ vehicle: e.target.value })} /></Field>
        </div>
        <div>
          <b>IRS rates</b> <span className="text-xs text-charcoal/50">(copied from irs.gov; confirm each one)</span>
          <ul className="mt-1 divide-y divide-ivory-200">
            {(rates.data ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 flex-1">{fmtDate(r.effective_from)} to {fmtDate(r.effective_to)}</span>
                <b>{formatCents(r.cents_per_mile)}</b>
                {r.confirmed ? <span className="badge bg-teal-50 text-teal-800"><Check size={10} /> confirmed</span>
                  : <button className="btn-ghost btn-sm" onClick={async () => { try { await write.mutateAsync(async () => unwrap(await supabase.from("irs_mileage_rates").update({ confirmed: true }).eq("id", r.id).select("id"))); toast.push("Rate confirmed"); } catch (e) { toast.push((e as Error).message, "err"); } }}>Confirm</button>}
              </li>
            ))}
          </ul>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            <input className="input" type="date" aria-label="Rate starts" value={newRate.from} onChange={(e) => setNewRate({ ...newRate, from: e.target.value })} />
            <input className="input" type="date" aria-label="Rate ends" value={newRate.to} onChange={(e) => setNewRate({ ...newRate, to: e.target.value })} />
            <input className="input" type="number" step="0.1" min="0" placeholder="cents" aria-label="Cents per mile" value={newRate.cents} onChange={(e) => setNewRate({ ...newRate, cents: e.target.value })} />
            <button className="btn-ghost btn-sm" disabled={!newRate.from || !newRate.to || !(Number(newRate.cents) > 0)}
              onClick={async () => { try { await write.mutateAsync(async () => unwrap(await supabase.from("irs_mileage_rates").insert({ effective_from: newRate.from, effective_to: newRate.to, cents_per_mile: Number(newRate.cents), source: "Entered by owner" }).select("id"))); setNewRate({ from: "", to: "", cents: "" }); toast.push("Rate added. Confirm it when checked."); } catch (e) { toast.push((e as Error).message, "err"); } }}>Add rate</button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- modals ---------- */
function TripModal({ trip, vehicle, onClose, onDelete }: { trip?: MileageLog; vehicle: string; onClose: () => void; onDelete: (t: MileageLog) => void }) {
  const write = useWrite(); const toast = useToast();
  const [f, setF] = useState({ trip_date: trip?.trip_date ?? toInputDate(new Date()), purpose: trip?.purpose ?? "", from_label: trip?.from_label ?? "Kitchen", to_label: trip?.to_label ?? "", miles: Number(trip?.miles ?? 0), notes: trip?.notes ?? "", measured: trip ? !trip.estimated : true });
  const u = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const submit = async () => {
    const { measured, ...rest } = f;
    const row = { ...rest, miles: Math.round(f.miles * 10) / 10, estimated: !measured, kind: trip?.kind ?? "other", vehicle: trip?.vehicle ?? vehicle };
    try { await write.mutateAsync(async () => unwrap(trip ? await supabase.from("mileage_logs").update(row).eq("id", trip.id).select("id") : await supabase.from("mileage_logs").insert(row).select("id"))); toast.push(trip ? "Trip saved" : "Trip added"); onClose(); } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <Modal open onClose={onClose} title={trip ? "Edit trip" : "Add trip"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date"><input className="input" type="date" value={f.trip_date} onChange={u("trip_date")} /></Field>
        <Field label="Miles (total, there and back)"><input className="input" type="number" step="0.1" min="0" value={f.miles || ""} onChange={u("miles")} /></Field>
        <Field label="Purpose" className="sm:col-span-2"><input className="input" value={f.purpose} onChange={u("purpose")} placeholder="Picked up packaging" /></Field>
        <Field label="From"><input className="input" value={f.from_label} onChange={u("from_label")} /></Field>
        <Field label="To"><input className="input" value={f.to_label} onChange={u("to_label")} /></Field>
        <Field label="Notes" className="sm:col-span-2"><input className="input" value={f.notes} onChange={u("notes")} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.measured} onChange={u("measured")} /> These miles are measured (odometer or map), not a guess</label>
      </div>
      <div className="flex justify-between gap-2">
        {trip ? <button className="btn-ghost text-negative" onClick={() => onDelete(trip)}><Trash2 size={14} /> Delete</button> : <span />}
        <div className="flex gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!(f.miles > 0) || write.isPending} onClick={submit}>Save</button></div>
      </div>
    </Modal>
  );
}

function PlaceModal({ onClose }: { onClose: () => void }) {
  const write = useWrite(); const toast = useToast();
  const [f, setF] = useState({ name: "", street: "", city: "", zip: "", miles: "" });
  const [busy, setBusy] = useState(false);
  const measure = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("mileage-place", { body: { street: f.street, city: f.city, state: "TX", zip: f.zip } });
      if (error) { const d = await (error as { context?: Response }).context?.json?.().catch(() => null); throw new Error(d?.error ?? error.message); }
      if ((data as { ok?: boolean })?.ok === false) throw new Error((data as { error?: string }).error);
      setF((x) => ({ ...x, miles: String((data as { miles: number }).miles) }));
      toast.push("Estimated from the kitchen. Change it if you know the real distance.");
    } catch (e) { toast.push((e as Error).message, "err"); } finally { setBusy(false); }
  };
  const submit = async () => {
    try { await write.mutateAsync(async () => unwrap(await supabase.from("mileage_places").insert({ name: f.name.trim(), address: [f.street, f.city, f.zip].filter(Boolean).join(", "), one_way_miles: Number(f.miles) }).select("id"))); toast.push("Place saved"); onClose(); } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <Modal open onClose={onClose} title="Add a place">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Costco" /></Field>
        <Field label="Street" className="sm:col-span-2"><input className="input" value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label="ZIP"><input className="input" inputMode="numeric" value={f.zip} onChange={(e) => setF({ ...f, zip: e.target.value })} /></Field>
        <Field label="Miles one way from the kitchen" hint="Tap Measure for an estimate, or type your own." className="sm:col-span-2">
          <div className="flex gap-2"><input className="input" type="number" step="0.1" min="0" value={f.miles} onChange={(e) => setF({ ...f, miles: e.target.value })} /><button className="btn-ghost shrink-0" disabled={busy || !f.street || !f.city} onClick={measure}>{busy ? "Measuring…" : "Measure"}</button></div>
        </Field>
      </div>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name.trim() || !(Number(f.miles) > 0) || write.isPending} onClick={submit}>Save</button></div>
    </Modal>
  );
}

function RouteModal({ trips, onClose, onDone }: { trips: MileageLog[]; onClose: () => void; onDone: () => void }) {
  const write = useWrite(); const toast = useToast();
  const biggest = Math.max(...trips.map((t) => Number(t.miles)));
  const alone = trips.reduce((s, t) => s + Number(t.miles), 0);
  const [miles, setMiles] = useState(String(biggest));
  const submit = async () => {
    try { await write.mutateAsync(async () => unwrap(await supabase.rpc("combine_mileage_route", { p_trip_ids: trips.map((t) => t.id), p_total_miles: Number(miles) }))); toast.push("Combined into one route"); onDone(); } catch (e) { toast.push((e as Error).message, "err"); }
  };
  return (
    <Modal open onClose={onClose} title="Combine into one route">
      <p className="mb-3 text-sm text-charcoal/70">{trips.length} deliveries on {fmtDate(trips[0].trip_date)} were one outing. Counted separately they add up to <b>{alone.toFixed(1)} mi</b>, which overstates it. Enter the real total miles you drove.</p>
      <Field label="Total miles for the route" hint={`Starts at your longest single trip (${biggest.toFixed(1)} mi). The separate trips stay in the log but stop counting.`}><input className="input" type="number" step="0.1" min="0" value={miles} onChange={(e) => setMiles(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!(Number(miles) > 0) || write.isPending} onClick={submit}>Combine</button></div>
    </Modal>
  );
}
