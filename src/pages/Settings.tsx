import { useEffect, useState } from "react";
import { PageHeader, Section, Field, Skeleton, ErrorBox, useToast } from "../components/ui";
import { useSettings, useWrite } from "../hooks/queries";
import { ORDER_STATUSES, PAYMENT_METHODS, DELIVERY_PROVIDERS } from "../lib/status";
import { supabase, unwrap } from "../lib/supabase";
import { useAuth } from "../hooks/useAuth";
import type { BusinessSettings } from "../lib/types";

export function SettingsPage() {
  const q = useSettings(); const write = useWrite(); const toast = useToast(); const { adminName, session } = useAuth();
  const [f, setF] = useState<Partial<BusinessSettings>>({});
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  if (q.isLoading) return <Skeleton rows={8} className="card p-5" />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? "Could not load settings"} />;
  const u = (k: keyof BusinessSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const save = async () => { try { await write.mutateAsync(async () => unwrap(await supabase.from("business_settings").update({ ...f, id: 1 }).eq("id", 1).select("id"))); toast.push("Settings saved"); } catch (e) { toast.push((e as Error).message, "err"); } };
  return (
    <div>
      <PageHeader title="Settings" crumbs={["Home", "Settings"]} actions={<button className="btn-primary" onClick={save} disabled={write.isPending}>Save changes</button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Business information">
          <Field label="Business name"><input className="input" value={f.business_name ?? ""} onChange={u("business_name")} /></Field>
          <Field label="Owner name"><input className="input" value={f.owner_name ?? ""} onChange={u("owner_name")} /></Field>
          <Field label="Address"><input className="input" value={f.address ?? ""} onChange={u("address")} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Phone (display)"><input className="input" value={f.phone ?? ""} onChange={u("phone")} /></Field><Field label="WhatsApp number (digits)"><input className="input" value={f.whatsapp_number ?? ""} onChange={u("whatsapp_number")} /></Field></div>
          <Field label="Email"><input className="input" value={f.email ?? ""} onChange={u("email")} /></Field>
          <Field label="Logo URL" hint="Leave blank to use the built-in Pharaoh's Bites logo."><input className="input" value={f.logo_url ?? ""} onChange={u("logo_url")} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Currency"><input className="input" value={f.currency ?? "USD"} onChange={u("currency")} /></Field><Field label="Time zone"><input className="input" value={f.timezone ?? "America/Chicago"} onChange={u("timezone")} /></Field></div>
        </Section>
        <Section title="Financial settings">
          <p className="mb-3 text-xs text-charcoal/60">The default tax rate, filing frequency and due date live on the <a href="#/tax" className="text-teal-700 hover:underline">Sales Tax</a> page.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default delivery rate ($/mile)"><input className="input" type="number" step="0.01" min="0" value={Number(f.default_delivery_rate_per_mile ?? 0)} onChange={u("default_delivery_rate_per_mile")} /></Field>
            <Field label="Default mileage cost ($/mile)"><input className="input" type="number" step="0.01" min="0" value={Number(f.default_mileage_cost_per_mile ?? 0)} onChange={u("default_mileage_cost_per_mile")} /></Field>
            <Field label="Owner labor rate ($/hour)"><input className="input" type="number" step="0.01" min="0" value={Number(f.default_labor_rate_per_hour ?? 0)} onChange={u("default_labor_rate_per_hour")} /></Field>
            <Field label="Low-margin warning (%)"><input className="input" type="number" step="1" min="0" max="100" value={Math.round(Number(f.low_margin_warning_pct ?? 0.3) * 100)} onChange={(e) => setF({ ...f, low_margin_warning_pct: Number(e.target.value) / 100 })} /></Field>
            <Field label="Minimum order amount"><input className="input" type="number" step="0.01" min="0" value={Number(f.minimum_order_amount ?? 0)} onChange={u("minimum_order_amount")} /></Field>
            <Field label="Order-number prefix" hint="e.g. PB → PB-2026-00001"><input className="input" maxLength={6} value={f.order_number_prefix ?? "PB"} onChange={u("order_number_prefix")} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.include_owner_labor} onChange={u("include_owner_labor")} /> Include owner labor in profit calculations (uses labor minutes on each product × labor rate)</label>
        </Section>
        <Section title="Order settings">
          <Field label="Default WhatsApp message to customers" hint="Placeholders: {name} {order_number} {delivery_fee} {total}"><textarea className="input min-h-24" value={f.default_whatsapp_message ?? ""} onChange={u("default_whatsapp_message")} /></Field>
          <Field label="Cancellation rules"><textarea className="input" value={f.cancellation_rules ?? ""} onChange={u("cancellation_rules")} /></Field>
          <div className="grid gap-3 text-xs text-charcoal/70 sm:grid-cols-3">
            <div><p className="mb-1 font-medium text-teal-900">Order statuses</p><ul>{ORDER_STATUSES.map((s) => <li key={s.value}>{s.label}</li>)}</ul></div>
            <div><p className="mb-1 font-medium text-teal-900">Payment methods</p><ul>{PAYMENT_METHODS.map((s) => <li key={s.value}>{s.label}</li>)}</ul></div>
            <div><p className="mb-1 font-medium text-teal-900">Delivery methods</p><ul>{DELIVERY_PROVIDERS.map((s) => <li key={s.value}>{s.label}</li>)}</ul></div>
          </div>
          <p className="mt-2 text-xs text-charcoal/50">These lists are fixed in the database schema so historical records stay consistent; ask your developer to add new values via a migration.</p>
        </Section>
        <Section title="Account & security">
          <p className="text-sm">Signed in as <b>{adminName}</b> ({session?.user.email}).</p>
          <ul className="mt-2 list-disc pl-5 text-sm text-charcoal/70">
            <li>Only users listed in <code>admin_profiles</code> can read or change any data — enforced by database Row Level Security, not just this screen.</li>
            <li>Public sign-up is disabled in Supabase Auth. To add a manager, create the user in the Supabase dashboard and insert their id into <code>admin_profiles</code> (see README).</li>
            <li>Sessions refresh automatically and expire on sign-out or when the refresh token is revoked.</li>
            <li>The website writes orders only through the <code>create-order</code> Edge Function, never directly to these tables.</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
