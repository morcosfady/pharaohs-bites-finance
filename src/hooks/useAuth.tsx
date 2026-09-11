import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, isConfigured } from "../lib/supabase";

export type AuthState = {
  loading: boolean;
  session: Session | null;
  /** null = unknown yet; false = signed in but NOT an approved admin */
  isAdmin: boolean | null;
  adminName: string;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminName, setAdminName] = useState("");

  useEffect(() => {
    if (!isConfigured) { setLoading(false); return; }
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => { if (!cancelled) { setSession(data.session); setLoading(false); } });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED" && !s) { setIsAdmin(null); setAdminName(""); }
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  // Admin check is enforced by the database (is_admin() + RLS). This lookup
  // only decides which screen to show.
  useEffect(() => {
    if (!session) { setIsAdmin(null); return; }
    let cancelled = false;
    supabase.from("admin_profiles").select("full_name, is_active").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setIsAdmin(!!data && data.is_active);
        setAdminName(data?.full_name || session.user.email || "");
      });
    return () => { cancelled = true; };
  }, [session]);

  // Session expiry: Supabase refreshes tokens automatically; if refresh fails
  // the SIGNED_OUT event fires and the guard sends the user to /login.

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  };
  const signOut = async () => { await supabase.auth.signOut(); };

  return <Ctx.Provider value={{ loading, session, isAdmin, adminName, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
