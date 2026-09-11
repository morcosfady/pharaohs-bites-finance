import { useEffect, useState, type ReactNode, createContext, useContext, useCallback } from "react";
import { X, Info, TrendingUp, TrendingDown, Minus, CheckCircle2, AlertTriangle, XCircle, Inbox, Pencil } from "lucide-react";
import { fmt, pct, change } from "../lib/money";

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; tone: "ok" | "err" | "info" };
const ToastCtx = createContext<{ push: (text: string, tone?: Toast["tone"]) => void }>({ push: () => {} });
export function useToast() { return useContext(ToastCtx); }
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 md:bottom-6" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto flex items-center gap-2 rounded-lg px-4 py-3 text-sm shadow-lg ${t.tone === "err" ? "bg-negative text-white" : t.tone === "info" ? "bg-teal-800 text-ivory" : "bg-positive text-white"}`}>
            {t.tone === "err" ? <XCircle size={16} /> : t.tone === "info" ? <Info size={16} /> : <CheckCircle2 size={16} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Modal ---------- */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-teal-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-ivory-50 shadow-2xl sm:rounded-2xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ivory-200 bg-ivory-50/95 px-5 py-3 backdrop-blur">
          <h3 className="font-display text-xl font-semibold text-teal-900">{title}</h3>
          <button className="rounded-lg p-2 hover:bg-ivory-200" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel = "Confirm", danger, onConfirm, onCancel }: { open: boolean; title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div className="text-sm text-charcoal/80">{body}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

/* ---------- Tooltip (accessible: focusable, aria-describedby) ---------- */
export function Tip({ text, children }: { text: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = "tip-" + text.length + text.charCodeAt(0);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="inline-flex items-center text-teal-900/50 hover:text-teal-800" aria-describedby={id} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen((v) => !v)}>
        {children ?? <Info size={14} />}
      </button>
      <span id={id} role="tooltip" className={`absolute left-1/2 top-full z-30 mt-1 w-56 -translate-x-1/2 rounded-md bg-charcoal px-3 py-2 text-xs leading-snug text-ivory shadow-lg ${open ? "" : "hidden"}`}>{text}</span>
    </span>
  );
}

/* ---------- KPI card ---------- */
export function KpiCard({ label, value, prev, formula, kind = "money", invert, spark }: {
  label: string; value: number | null; prev?: number | null; formula?: string; kind?: "money" | "int" | "pct"; invert?: boolean; spark?: number[];
}) {
  const ch = value != null && prev != null ? change(value, prev) : null;
  const good = ch == null ? null : (invert ? ch <= 0 : ch >= 0);
  const show = (v: number | null) => v == null ? "—" : kind === "money" ? fmt(v) : kind === "pct" ? pct(v) : v.toLocaleString();
  return (
    <div className="card flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium uppercase tracking-wider text-teal-900/70">{label}</span>
        {formula && <Tip text={formula} />}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="font-display text-2xl font-semibold leading-none text-teal-900">{show(value)}</span>
        {spark && spark.length > 1 && <Spark data={spark} good={good ?? true} />}
      </div>
      <div className="flex items-center gap-1 text-xs">
        {ch == null ? <span className="text-charcoal/50">{prev == null ? "" : "no prior data"}</span> : (
          <span className={`inline-flex items-center gap-1 font-medium ${ch === 0 ? "text-charcoal/50" : good ? "text-positive" : "text-negative"}`}>
            {ch === 0 ? <Minus size={12} /> : ch > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {ch === 0 ? "no change" : pct(Math.abs(ch), 0)}
            <span className="font-normal text-charcoal/50">vs prev · {show(prev ?? null)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Spark({ data, good }: { data: number[]; good: boolean }) {
  const w = 64, h = 22;
  const max = Math.max(...data), min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * (h - 2) - 1}`).join(" ");
  return <svg width={w} height={h} className="shrink-0" aria-hidden="true"><polyline points={pts} fill="none" stroke={good ? "#16855B" : "#C64040"} strokeWidth="1.5" /></svg>;
}

/* ---------- Pencil (edit) button ---------- */
export function EditButton({ onClick, label = "Edit", small, className = "" }: { onClick: (e: React.MouseEvent) => void; label?: string; small?: boolean; className?: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className={`no-print inline-flex items-center justify-center rounded-full text-teal-800 ring-1 ring-teal-800/20 transition hover:bg-gold/20 hover:ring-gold ${small ? "h-8 w-8" : "h-10 w-10"} ${className}`}>
      <Pencil size={small ? 14 : 16} />
    </button>
  );
}

/* ---------- Misc ---------- */
export function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`badge ${className}`}>{children}</span>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="rounded-full bg-teal-50 p-3 text-teal-700"><Inbox size={22} /></span>
      <p className="font-display text-lg font-semibold text-teal-900">{title}</p>
      {hint && <p className="max-w-sm text-sm text-charcoal/60">{hint}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  return <div className={`flex flex-col gap-2 ${className}`}>{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-5 w-full" style={{ width: `${90 - (i % 3) * 15}%` }} />)}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="flex items-start gap-2 rounded-lg border border-negative/30 bg-red-50 px-4 py-3 text-sm text-negative"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><span>{msg}</span></div>;
}

export function Field({ label, children, hint, className = "" }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return <label className={`field block ${className}`}><span className="label">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-charcoal/50">{hint}</span>}</label>;
}

export function PageHeader({ title, crumbs, actions }: { title: string; crumbs?: string[]; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {crumbs && <nav aria-label="Breadcrumb" className="mb-1 text-xs text-charcoal/50">{crumbs.join(" / ")}</nav>}
        <h1 className="font-display text-2xl font-semibold text-teal-900 md:text-3xl">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, children, right, className = "" }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <div className="card-head"><h2 className="card-title">{title}</h2>{right}</div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}
