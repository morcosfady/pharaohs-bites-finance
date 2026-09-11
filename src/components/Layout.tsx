import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { LayoutDashboard, ShoppingBag, Package, BarChart3, Users, Receipt, CreditCard, Truck, FileText, Percent, Settings, Database, LogOut, Menu, Bell, X, Lightbulb } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useAdvanced } from "../hooks/useMode";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeOrders, useOrders, useTaxSettings } from "../hooks/queries";
import { differenceInCalendarDays } from "date-fns";

const NAV = [
  { to: "/", label: "Home", icon: LayoutDashboard, end: true },
  { to: "/orders", label: "Orders", icon: ShoppingBag },
  { to: "/products", label: "Products", icon: Package },
  { to: "/expenses", label: "Expenses", icon: Receipt },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/performance", label: "Best Sellers", icon: BarChart3, advanced: true },
  { to: "/customers", label: "Customers", icon: Users, advanced: true },
  { to: "/payments", label: "Payments", icon: CreditCard, advanced: true },
  { to: "/deliveries", label: "Deliveries", icon: Truck, advanced: true },
  { to: "/tax", label: "Sales Tax", icon: Percent, advanced: true },
  { to: "/insights", label: "Insights", icon: Lightbulb, advanced: true },
  { to: "/data", label: "Import / Export", icon: Database, advanced: true },
  { to: "/settings", label: "Settings", icon: Settings },
];
const MOBILE = ["/", "/orders", "/products", "/expenses", "/reports"];

export function Layout() {
  const { adminName, signOut } = useAuth();
  const advanced = useAdvanced();
  const items = NAV.filter((n) => advanced || !n.advanced);
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const qc = useQueryClient();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => subscribeOrders(() => { qc.invalidateQueries({ queryKey: ["orders"] }); qc.invalidateQueries({ queryKey: ["order_financials"] }); qc.invalidateQueries({ queryKey: ["order"] }); }), [qc]);

  const { data: orders } = useOrders({ limit: 300 });
  const { data: tax } = useTaxSettings();
  const pending = orders?.filter((o) => o.status === "pending_whatsapp_confirmation").length ?? 0;
  const taxDays = tax?.next_due_date ? differenceInCalendarDays(new Date(tax.next_due_date), new Date()) : null;
  const notices = [
    pending > 0 ? { text: `${pending} pending WhatsApp order${pending > 1 ? "s" : ""} to confirm`, to: "/orders?status=pending_whatsapp_confirmation" } : null,
    taxDays != null && taxDays <= (tax?.reminder_days_before ?? 14) ? { text: taxDays < 0 ? "Sales-tax due date has passed" : `Sales-tax return due in ${taxDays} day${taxDays === 1 ? "" : "s"}`, to: "/tax" } : null,
  ].filter(Boolean) as { text: string; to: string }[];
  const [bell, setBell] = useState(false);

  const nav = (
    <nav className="flex flex-col gap-0.5 p-3">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${isActive ? "bg-gold/15 font-medium text-gold-soft" : "text-ivory/75 hover:bg-white/5 hover:text-ivory"}`}>
          <n.icon size={18} /> {n.label}
          {n.to === "/orders" && pending > 0 && <span className="ml-auto rounded-full bg-gold px-2 py-0.5 text-[10px] font-semibold text-teal-900">{pending}</span>}
        </NavLink>
      ))}
      {!advanced && <NavLink to="/settings" className="mt-2 rounded-lg px-3 py-2 text-[11px] uppercase tracking-wider text-ivory/40 hover:text-ivory/70">More tools: turn on Advanced in Settings</NavLink>}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[250px_1fr]">
      {/* sidebar */}
      <aside className="hidden bg-teal-900 text-ivory md:sticky md:top-0 md:flex md:h-screen md:flex-col" style={{ backgroundImage: "linear-gradient(180deg,#0F4C4C 0%,#083838 100%)" }}>
        <div className="flex items-center gap-3 px-4 py-5">
          <img src="./brand/mark.png" alt="" className="h-11 w-11 object-contain" />
          <div><div className="font-display text-lg font-semibold leading-tight">Pharaoh's Bites</div><div className="text-[11px] uppercase tracking-[.2em] text-gold-soft/90">Finance</div></div>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-white/10 p-3">
          <div className="truncate px-3 text-xs text-ivory/60">{adminName}</div>
          <button className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ivory/75 hover:bg-white/5" onClick={signOut}><LogOut size={16} /> Sign out</button>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-ivory-200 bg-ivory/90 px-4 py-2.5 backdrop-blur">
          <div className="flex items-center gap-3 md:hidden">
            <button className="rounded-lg p-2 hover:bg-ivory-200" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
            <img src="./brand/mark.png" alt="" className="h-8 w-8 object-contain" />
            <span className="font-display text-lg font-semibold text-teal-900">Finance</span>
          </div>
          <div className="hidden text-sm text-charcoal/60 md:block">Owner dashboard · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
          <div className="relative">
            <button className="relative rounded-lg p-2 hover:bg-ivory-200" onClick={() => setBell((v) => !v)} aria-label="Notifications">
              <Bell size={20} />
              {notices.length > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-negative" />}
            </button>
            {bell && (
              <div className="absolute right-0 mt-1 w-72 rounded-xl border border-ivory-200 bg-white p-2 shadow-xl">
                {notices.length === 0 ? <p className="px-2 py-3 text-sm text-charcoal/60">All caught up.</p> : notices.map((n) => (
                  <NavLink key={n.text} to={n.to} className="block rounded-lg px-3 py-2 text-sm hover:bg-ivory-50" onClick={() => setBell(false)}>{n.text}</NavLink>
                ))}
              </div>
            )}
          </div>
        </header>

        {import.meta.env.VITE_DEMO === "1" && (
          <div className="bg-gold px-4 py-2 text-center text-xs font-medium text-teal-900">
            DEMO with sample data — edit anything; changes stay in this browser only.{" "}
            <button className="underline" onClick={() => (window as unknown as { __resetDemo?: () => void }).__resetDemo?.()}>Reset demo data</button>
            {" · "}The real dashboard is at <a className="underline" href="https://morcosfady.github.io/pharaohs-bites-finance/">/pharaohs-bites-finance/</a> once Supabase is connected.
          </div>
        )}
        <main className="flex-1 px-4 pb-24 pt-4 md:px-6 md:pb-8">
          <Outlet />
        </main>

        {/* mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-ivory-200 bg-white/95 backdrop-blur md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {NAV.filter((n) => MOBILE.includes(n.to)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[10px] ${isActive ? "text-teal-800" : "text-charcoal/50"}`}>
              <n.icon size={20} />{n.label}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-teal-900/50" />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-teal-900 text-ivory shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-4"><span className="font-display text-lg">Pharaoh's Bites</span><button onClick={() => setOpen(false)} aria-label="Close menu"><X size={20} /></button></div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <button className="flex items-center gap-3 border-t border-white/10 px-6 py-4 text-sm" onClick={signOut}><LogOut size={16} /> Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}
