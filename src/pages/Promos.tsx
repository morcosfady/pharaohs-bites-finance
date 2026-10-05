import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow, addDays } from "date-fns";
import { Ticket, Copy, MessageSquare, Pause, Play, Pencil, Plus, Truck, Percent, Gift, Users, Wallet, ShoppingBag, Clock, ShieldAlert, Bell, ChevronDown } from "lucide-react";
import { supabase, unwrap } from "../lib/supabase";
import { useWrite } from "../hooks/queries";
import { PageHeader, Skeleton, ErrorBox, EmptyState, Modal, Field, useToast } from "../components/ui";
import { money } from "../lib/money";
import {
  buildPromoStats, sortStats, attentionList, refusalReasons, describeOffer, ruleTags, shareText, STATUS_INFO, CODE_RE, cleanCode,
  type PromoCode, type Redemption, type PromoOrder, type Refusal, type PromoStats, type PromoKind,
} from "../lib/promos";

/** Accent colour of this tab (nav icon + headings). */
export const PROMOS_COLOR = "#d6577a";

type SiteProblem = { created_at: string; detail: string; meta: { type?: string; code?: string } };

/** Codes, every time a code was applied to an order, those orders, and the refused attempts (last 90 days). */
function usePromos() {
  return useQuery({
    queryKey: ["promos"],
    refetchInterval: 60_000,
    queryFn: async () => {
      const codes = unwrap(await supabase.from("promo_codes").select("*").order("created_at", { ascending: false })) as PromoCode[];
      const redemptions = unwrap(await supabase.from("promo_redemptions").select("id, code, order_id, fee_waived, used_at, created_at").order("created_at", { ascending: false }).limit(2000)) as Redemption[];
      const ids = [...new Set(redemptions.map((r) => r.order_id))];
      const orders = new Map<string, PromoOrder>();
      for (let i = 0; i < ids.length; i += 150) {
        const rows = unwrap(await supabase.from("orders").select("id, order_number, customer_name, status, subtotal, discount, delivery_fee, total").in("id", ids.slice(i, i + 150))) as PromoOrder[];
        rows.forEach((o) => orders.set(o.id, o));
      }
      // Refused attempts come from the website activity log. If that table cannot be read, the tab still works.
      let refusals: Refusal[] = [];
      try {
        const since = addDays(new Date(), -90).toISOString();
        const rows = unwrap(await supabase.from("site_events").select("created_at, detail, meta").eq("kind", "problem").gte("created_at", since).order("id", { ascending: false }).limit(1000)) as SiteProblem[];
        refusals = rows.filter((r) => r.meta?.type === "promo" && r.meta?.code).map((r) => ({ code: String(r.meta.code).toUpperCase(), message: r.detail, at: r.created_at }));
      } catch { /* ignore */ }
      return { codes, redemptions, orders, refusals };
    },
  });
}

const KIND_ICON: Record<PromoKind, typeof Truck> = { free_delivery: Truck, percent_off: Percent, free_order: Gift };

function Kpi({ icon: Icon, label, value, sub, color }: { icon: typeof Users; label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="card flex items-center gap-3 px-4 py-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: color }}><Icon size={20} /></span>
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-wider text-teal-900/70">{label}</div>
        <div className="font-display text-2xl font-semibold leading-tight text-teal-900">{value}</div>
        {sub && <div className="text-xs text-charcoal/60">{sub}</div>}
      </div>
    </div>
  );
}

function UsageMeter({ used, limit, color }: { used: number; limit: number | null; color: string }) {
  if (limit === null) return <div className="text-xs text-charcoal/60">{used} {used === 1 ? "use" : "uses"} so far · no limit</div>;
  const pctUsed = Math.min(100, (used / limit) * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs"><span className="font-medium text-teal-900">{used} of {limit} used</span><span className="text-charcoal/60">{Math.max(0, limit - used)} left</span></div>
      <div className="h-2.5 w-full rounded-full bg-ivory-200"><div className="h-2.5 rounded-full" style={{ width: `${Math.max(used ? 3 : 0, pctUsed)}%`, backgroundColor: color }} /></div>
    </div>
  );
}

function PromoCard({ s, onEdit, onToggle, orders }: { s: PromoStats; onEdit: () => void; onToggle: () => void; orders: Map<string, PromoOrder> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const st = STATUS_INFO[s.status];
  const Icon = KIND_ICON[s.code.kind];
  const copy = (text: string, ok: string) => navigator.clipboard.writeText(text).then(() => toast.push(ok), () => toast.push("Could not copy, select the text and copy it", "err"));
  const ended = s.status === "expired" || s.status === "used_up";
  const reasons = refusalReasons(s.refused);
  return (
    <article className={`card overflow-hidden ${ended ? "opacity-90" : ""}`}>
      <div className="h-1.5" style={{ backgroundColor: st.dot }} />
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-lg border-2 border-dashed px-3 py-1 font-mono text-lg font-bold tracking-wider text-teal-900" style={{ borderColor: PROMOS_COLOR }}>{s.code.code}</span>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${st.cls}`} title={st.hint}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: st.dot }} />{st.label}</span>
            </div>
            {s.code.label && <div className="mt-1 text-sm text-charcoal/70">{s.code.label}</div>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn-ghost inline-flex items-center gap-1 text-xs" onClick={() => copy(s.code.code, "Code copied")}><Copy size={14} /> Code</button>
            <button type="button" className="btn-ghost inline-flex items-center gap-1 text-xs" onClick={() => copy(shareText(s.code), "Message copied, paste it to your customer")}><MessageSquare size={14} /> Message</button>
            {s.status !== "expired" && s.status !== "used_up" && (
              <button type="button" className="btn-ghost inline-flex items-center gap-1 text-xs" onClick={onToggle}>{s.code.active ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Resume</>}</button>
            )}
            <button type="button" className="btn-ghost inline-flex items-center gap-1 text-xs" onClick={onEdit}><Pencil size={14} /> Edit</button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-base font-medium text-teal-900"><Icon size={18} style={{ color: PROMOS_COLOR }} />{describeOffer(s.code)}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">{ruleTags(s.code).map((t) => <span key={t} className="rounded-full bg-ivory-100 px-2.5 py-0.5 text-xs text-teal-900">{t}</span>)}</div>

        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <UsageMeter used={s.used.length} limit={s.limit} color={st.dot} />
          <div className="flex items-center gap-1.5 text-xs text-charcoal/70">
            <Clock size={14} />
            {s.code.expires_at
              ? (s.status === "expired" ? `Expired ${format(new Date(s.code.expires_at), "MMM d, yyyy")}` : `Ends ${format(new Date(s.code.expires_at), "MMM d, yyyy")}${s.daysLeft !== null && s.daysLeft <= 14 ? ` (${s.daysLeft === 0 ? "today" : `${s.daysLeft} ${s.daysLeft === 1 ? "day" : "days"} left`})` : ""}`)
              : "No end date"}
            {s.code.starts_at && new Date(s.code.starts_at) > new Date() ? ` · starts ${format(new Date(s.code.starts_at), "MMM d")}` : ""}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-ivory-50 px-2 py-2"><div className="font-display text-xl font-semibold text-teal-900">{money(s.givenAway)}</div><div className="text-[11px] uppercase text-charcoal/50">given away</div></div>
          <div className="rounded-lg bg-ivory-50 px-2 py-2"><div className="font-display text-xl font-semibold text-teal-900">{money(s.revenue)}</div><div className="text-[11px] uppercase text-charcoal/50">paid by customers</div></div>
          <div className="rounded-lg bg-ivory-50 px-2 py-2"><div className="font-display text-xl font-semibold text-teal-900">{s.lastUsed ? formatDistanceToNow(new Date(s.lastUsed), { addSuffix: true }).replace("about ", "") : "never"}</div><div className="text-[11px] uppercase text-charcoal/50">last used</div></div>
        </div>

        {(s.waiting.length > 0 || reasons.length > 0) && (
          <div className="mt-3 grid gap-1.5 text-xs">
            {s.waiting.length > 0 && <div className="flex items-center gap-1.5 rounded-lg bg-sky-50 px-3 py-1.5 text-sky-900"><Bell size={13} /> {s.waiting.length} {s.waiting.length === 1 ? "order has" : "orders have"} this code but {s.waiting.length === 1 ? "is" : "are"} not paid yet.</div>}
            {reasons.length > 0 && (
              <div className="rounded-lg bg-red-50 px-3 py-1.5 text-red-900">
                <div className="flex items-center gap-1.5 font-medium"><ShieldAlert size={13} /> {s.refused.length} {s.refused.length === 1 ? "attempt was" : "attempts were"} refused (last 90 days)</div>
                <ul className="mt-1 list-disc pl-5">{reasons.slice(0, 3).map((r) => <li key={r.message}>{r.message} <span className="text-red-900/60">· {r.count}×</span></li>)}</ul>
              </div>
            )}
          </div>
        )}

        <button type="button" className="mt-3 flex w-full items-center justify-between rounded-lg px-1 py-1 text-sm font-medium text-teal-800 hover:bg-ivory-50" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>Who used it ({s.used.length}{s.waiting.length ? ` + ${s.waiting.length} waiting` : ""})</span><ChevronDown size={16} className={open ? "rotate-180" : ""} />
        </button>
        {open && (
          s.used.length + s.waiting.length === 0 ? <p className="px-1 py-2 text-sm text-charcoal/60">Nobody has used this code yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[460px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-charcoal/50"><tr><th className="py-1.5 pr-3">Order</th><th className="pr-3">Customer</th><th className="pr-3">When</th><th className="pr-3 text-right">Given away</th><th>Status</th></tr></thead>
                <tbody>
                  {[...s.used, ...s.waiting].map((r) => {
                    const o = orders.get(r.order_id);
                    const when = r.used_at ?? r.created_at;
                    return (
                      <tr key={r.id} className="border-t border-ivory-200">
                        <td className="py-1.5 pr-3">{o ? <Link to={`/orders/${o.id}`} className="text-teal-800 underline">{o.order_number}</Link> : "—"}</td>
                        <td className="pr-3">{o?.customer_name || "—"}</td>
                        <td className="pr-3 whitespace-nowrap text-xs" title={format(new Date(when), "PPp")}>{format(new Date(when), "MMM d, h:mm a")}</td>
                        <td className="pr-3 text-right">{money(Number(r.fee_waived || 0) + Number(o?.discount || 0))}</td>
                        <td>{r.used_at ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">Used</span> : <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">Waiting for payment</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </article>
  );
}

const dateValue = (iso: string | null) => (iso ? format(new Date(iso), "yyyy-MM-dd") : "");

type Draft = {
  code: string; kind: PromoKind; percent: string; label: string; notes: string; welcome: string;
  startsAt: string; expiresAt: string; maxUses: string; maxMiles: string; maxSubtotal: string; firstOrder: boolean; vegan: boolean;
};

const blankDraft = (): Draft => ({ code: "", kind: "free_delivery", percent: "20", label: "", notes: "", welcome: "", startsAt: "", expiresAt: "", maxUses: "", maxMiles: "", maxSubtotal: "", firstOrder: false, vegan: false });
const draftFrom = (p: PromoCode): Draft => ({
  code: p.code, kind: p.kind, percent: String(p.percent_off ?? ""), label: p.label, notes: p.notes, welcome: p.welcome_message ?? "",
  startsAt: dateValue(p.starts_at), expiresAt: dateValue(p.expires_at), maxUses: p.single_use ? "1" : p.max_uses != null ? String(p.max_uses) : "",
  maxMiles: p.max_miles != null ? String(p.max_miles) : "", maxSubtotal: p.max_subtotal != null ? String(p.max_subtotal) : "", firstOrder: p.first_order_only, vegan: p.vegan_only,
});

function PromoForm({ editing, existing, onClose }: { editing: PromoCode | null; existing: string[]; onClose: () => void }) {
  const [d, setD] = useState<Draft>(editing ? draftFrom(editing) : blankDraft());
  const write = useWrite();
  const toast = useToast();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  const save = async () => {
    const code = cleanCode(d.code);
    if (!editing) {
      if (!CODE_RE.test(code)) return toast.push("The code needs 3 to 30 letters, numbers, dashes or underscores (no spaces).", "err");
      if (existing.includes(code)) return toast.push(`${code} already exists. Edit it instead.`, "err");
      if (d.kind === "percent_off" && !(Number(d.percent) > 0 && Number(d.percent) <= 100)) return toast.push("Type a percentage between 1 and 100.", "err");
      if (d.kind === "free_order" && num(d.maxUses) === null && num(d.maxSubtotal) === null) return toast.push("A free-order code gives the whole order away. Set a limit on total uses or on the food amount first.", "err");
    }
    const maxUses = num(d.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return toast.push("Max uses must be a whole number, 1 or more.", "err");
    if (d.startsAt && d.expiresAt && d.expiresAt < d.startsAt) return toast.push("The end date is before the start date.", "err");
    const common = {
      label: d.label.trim(), notes: d.notes.trim(), welcome_message: d.welcome.trim() || null,
      starts_at: d.startsAt ? new Date(`${d.startsAt}T00:00:00`).toISOString() : null,
      expires_at: d.expiresAt ? new Date(`${d.expiresAt}T23:59:59`).toISOString() : null,
      max_uses: editing?.single_use ? null : maxUses,
    };
    try {
      await write.mutateAsync(async () => {
        if (editing) return unwrap(await supabase.from("promo_codes").update(common).eq("code", editing.code).select());
        return unwrap(await supabase.from("promo_codes").insert({
          code, kind: d.kind, active: true, single_use: false, ...common,
          percent_off: d.kind === "percent_off" ? Number(d.percent) : null,
          max_miles: num(d.maxMiles), max_subtotal: num(d.maxSubtotal), first_order_only: d.firstOrder, vegan_only: d.vegan,
        }).select());
      });
      toast.push(editing ? `${editing.code} saved` : `${code} created. It works on the website right away.`);
      onClose();
    } catch (e) { toast.push(e instanceof Error ? e.message : "Could not save", "err"); }
  };

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${editing.code}` : "New promo code"} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && (
          <>
            <Field label="Code" hint="What the customer types. Capital letters and numbers, no spaces."><input className="input font-mono uppercase" value={d.code} onChange={(e) => set("code", cleanCode(e.target.value))} maxLength={30} placeholder="SUMMER20" /></Field>
            <Field label="What does it give?">
              <select className="input" value={d.kind} onChange={(e) => set("kind", e.target.value as PromoKind)}>
                <option value="free_delivery">Free delivery</option>
                <option value="percent_off">Percent off the dishes</option>
                <option value="free_order">Whole order free</option>
              </select>
            </Field>
            {d.kind === "percent_off" && <Field label="Percent off the dishes"><input className="input" inputMode="numeric" value={d.percent} onChange={(e) => set("percent", e.target.value.replace(/[^0-9.]/g, ""))} /></Field>}
          </>
        )}
        <Field label="Name for you" hint="Only you see this. For example who the code is for."><input className="input" value={d.label} onChange={(e) => set("label", e.target.value)} maxLength={80} placeholder="Church bazaar" /></Field>
        <Field label="Max uses in total" hint="Empty = no limit. Each customer can still only use it once."><input className="input" inputMode="numeric" value={d.maxUses} disabled={!!editing?.single_use} onChange={(e) => set("maxUses", e.target.value.replace(/[^0-9]/g, ""))} placeholder={editing?.single_use ? "One-time code" : "No limit"} /></Field>
        <Field label="Starts on" hint="Empty = works right away."><input type="date" className="input" value={d.startsAt} onChange={(e) => set("startsAt", e.target.value)} /></Field>
        <Field label="Ends on" hint="Empty = never ends. It works through the end of that day.">
          <input type="date" className="input" value={d.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
          <span className="mt-1 flex flex-wrap gap-1.5">
            {[7, 14, 30].map((n) => <button key={n} type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => set("expiresAt", format(addDays(new Date(), n), "yyyy-MM-dd"))}>+{n} days</button>)}
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => set("expiresAt", "")}>No end date</button>
          </span>
        </Field>
        {!editing && (
          <>
            <Field label="Only within … miles" hint="Empty = any distance."><input className="input" inputMode="decimal" value={d.maxMiles} onChange={(e) => set("maxMiles", e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
            <Field label="Up to … $ of food" hint="Empty = any amount. Orders above it are refused."><input className="input" inputMode="decimal" value={d.maxSubtotal} onChange={(e) => set("maxSubtotal", e.target.value.replace(/[^0-9.]/g, ""))} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.firstOrder} onChange={(e) => set("firstOrder", e.target.checked)} /> First order only (customers who ordered before are refused)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.vegan} onChange={(e) => set("vegan", e.target.checked)} /> Vegan dishes only</label>
          </>
        )}
        <Field label="Message the customer sees when it works" className="sm:col-span-2" hint="Empty = the website says the code was applied."><input className="input" value={d.welcome} onChange={(e) => set("welcome", e.target.value)} maxLength={200} placeholder="🎉 Welcome! Your discount is applied." /></Field>
        <Field label="Notes for you" className="sm:col-span-2"><textarea className="input min-h-[70px]" value={d.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} /></Field>
      </div>
      {editing && <p className="mt-3 text-xs text-charcoal/60">What the code gives (free delivery, percent off) cannot be changed after it is created, so its history stays true. Create a new code instead.</p>}
      <div className="mt-5 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save} disabled={write.isPending}>{editing ? "Save changes" : "Create code"}</button></div>
    </Modal>
  );
}

type Filter = "all" | "live" | "ended";

export function PromosPage() {
  const q = usePromos();
  const write = useWrite();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [form, setForm] = useState<{ editing: PromoCode | null } | null>(null);

  const stats = useMemo(() => (q.data ? buildPromoStats(q.data.codes, q.data.redemptions, q.data.orders, q.data.refusals).sort(sortStats) : []), [q.data]);
  const attention = useMemo(() => attentionList(stats), [stats]);
  const live = stats.filter((s) => s.status === "active" || s.status === "scheduled");
  const ended = stats.filter((s) => s.status === "expired" || s.status === "used_up");
  const shown = stats.filter((s) => filter === "all" || (filter === "live" ? s.status === "active" || s.status === "scheduled" || s.status === "paused" : ended.includes(s)));
  const totalUses = stats.reduce((n, s) => n + s.used.length, 0);
  const given = stats.reduce((n, s) => n + s.givenAway, 0);
  const revenue = stats.reduce((n, s) => n + s.revenue, 0);
  const waiting = stats.reduce((n, s) => n + s.waiting.length, 0);

  const recent = useMemo(() => {
    if (!q.data) return [];
    return q.data.redemptions.filter((r) => r.used_at && q.data.orders.get(r.order_id)?.status !== "cancelled").sort((a, b) => String(b.used_at).localeCompare(String(a.used_at))).slice(0, 10);
  }, [q.data]);

  const toggle = async (p: PromoCode) => {
    try {
      await write.mutateAsync(async () => unwrap(await supabase.from("promo_codes").update({ active: !p.active }).eq("code", p.code).select()));
      toast.push(p.active ? `${p.code} paused. The website now refuses it.` : `${p.code} is live again.`);
    } catch (e) { toast.push(e instanceof Error ? e.message : "Could not change it", "err"); }
  };

  return (
    <div>
      <PageHeader title="Promos" crumbs={["Home", "Promos"]} actions={<button className="btn-primary inline-flex items-center gap-1.5" onClick={() => setForm({ editing: null })}><Plus size={16} /> New promo</button>} />
      <p className="mb-4 max-w-3xl text-sm text-charcoal/70">Every promo code, whether it is live, how many times it was used, who used it, and what it cost you. Changes here work on the website within seconds.</p>

      {q.error ? <ErrorBox error={q.error} /> : q.isLoading ? <Skeleton rows={8} className="card p-5" /> : stats.length === 0 ? (
        <div className="card"><EmptyState title="No promo codes yet" hint="Create your first one with the New promo button." action={<button className="btn-primary" onClick={() => setForm({ editing: null })}>New promo</button>} /></div>
      ) : (
        <div className="grid gap-4">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={Ticket} label="Live codes" value={String(live.length)} sub={`of ${stats.length} in total`} color={PROMOS_COLOR} />
            <Kpi icon={Users} label="Times used" value={String(totalUses)} sub={waiting ? `${waiting} more waiting for payment` : "all paid"} color="#0d6e6e" />
            <Kpi icon={Wallet} label="Given away" value={money(given)} sub="discounts + free delivery" color="#d9822b" />
            <Kpi icon={ShoppingBag} label="Paid with a code" value={money(revenue)} sub={totalUses ? `about ${money(revenue / totalUses)} per order` : "no orders yet"} color="#16855B" />
          </section>

          {attention.length > 0 && (
            <section className="card p-4">
              <h2 className="mb-2 font-display text-lg font-semibold" style={{ color: PROMOS_COLOR }}>Needs your attention</h2>
              <ul className="grid gap-2">
                {attention.map((a) => (
                  <li key={a.key} className={`rounded-lg border-l-4 px-3 py-2 text-sm ${a.tone === "red" ? "border-negative bg-red-50" : a.tone === "amber" ? "border-warning bg-amber-50" : "border-sky-500 bg-sky-50"}`}>{a.text}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap gap-1.5 text-xs">
            {([["all", `All codes (${stats.length})`], ["live", `Live or paused (${stats.length - ended.length})`], ["ended", `Ended (${ended.length})`]] as [Filter, string][]).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded-full px-3 py-1.5 font-medium ${filter === k ? "bg-teal-800 text-ivory" : "bg-white text-teal-900 ring-1 ring-ivory-200 hover:bg-ivory-50"}`}>{label}</button>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {shown.map((s) => <PromoCard key={s.code.code} s={s} orders={q.data!.orders} onEdit={() => setForm({ editing: s.code })} onToggle={() => toggle(s.code)} />)}
          </div>
          {shown.length === 0 && <div className="card"><EmptyState title="Nothing in this list" hint="Try another filter." /></div>}

          <section className="card p-4">
            <h2 className="mb-1 font-display text-lg font-semibold" style={{ color: PROMOS_COLOR }}>Latest uses</h2>
            <p className="mb-3 text-xs text-charcoal/60">The last 10 orders that were paid with a promo code.</p>
            {recent.length === 0 ? <p className="text-sm text-charcoal/60">No promo code has been used on a paid order yet.</p> : (
              <ul className="grid gap-2">
                {recent.map((r) => {
                  const o = q.data!.orders.get(r.order_id);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ivory-50 px-3 py-2 text-sm">
                      <span className="flex items-center gap-2"><span className="rounded border border-dashed px-2 py-0.5 font-mono text-xs font-bold" style={{ borderColor: PROMOS_COLOR }}>{r.code}</span>{o ? <Link to={`/orders/${o.id}`} className="text-teal-800 underline">{o.order_number}</Link> : "—"}<span className="text-charcoal/70">{o?.customer_name}</span></span>
                      <span className="text-xs text-charcoal/60">{money(Number(r.fee_waived || 0) + Number(o?.discount || 0))} given away · {formatDistanceToNow(new Date(r.used_at!), { addSuffix: true })}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <p className="text-xs text-charcoal/50">Good to know: a code counts as “used” only after the customer pays. An order that applied the code but is not paid yet shows as “waiting”. Pausing a code never changes orders already placed.</p>
        </div>
      )}
      {form && <PromoForm editing={form.editing} existing={(q.data?.codes ?? []).map((c) => c.code)} onClose={() => setForm(null)} />}
    </div>
  );
}
