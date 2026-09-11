import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { isConfigured } from "../lib/supabase";
import { Lock, LogOut } from "lucide-react";

export function LoginPage() {
  const { session, isAdmin, signIn, signOut, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session && isAdmin) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const err = await signIn(email.trim(), password);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-teal-900 p-4" style={{ backgroundImage: "radial-gradient(circle at 20% 10%, rgba(212,167,44,.18), transparent 45%), radial-gradient(circle at 90% 90%, rgba(15,76,76,.9), #083838 60%)" }}>
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center"><img src="./brand/logo.png" alt="Pharaoh's Bites" className="h-36 w-auto drop-shadow-[0_8px_30px_rgba(212,167,44,.35)]" /></div>
        <div className="rounded-2xl border border-white/10 bg-ivory p-6 shadow-2xl sm:p-8">
          <div className="mb-5 text-center">
            <h1 className="font-display text-2xl font-semibold text-teal-900">Finance Dashboard</h1>
            <p className="mt-1 flex items-center justify-center gap-1 text-xs uppercase tracking-[.2em] text-charcoal/50"><Lock size={12} /> Owner access only</p>
          </div>

          {!isConfigured ? (
            <div className="rounded-lg border border-warning/40 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">Not connected to Supabase yet.</p>
              <p className="mt-1">Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see README → Setup) and rebuild.</p>
            </div>
          ) : loading ? (
            <p className="text-center text-sm text-charcoal/60">Checking session…</p>
          ) : session && isAdmin === false ? (
            <div className="text-center">
              <div className="rounded-lg border border-negative/30 bg-red-50 px-4 py-3 text-sm text-negative">
                <p className="font-medium">This account is not an approved administrator.</p>
                <p className="mt-1">Signed in as {session.user.email}. Financial data stays locked by the database until the owner adds this user to <code>admin_profiles</code>.</p>
              </div>
              <button className="btn-ghost mt-4" onClick={signOut}><LogOut size={16} /> Sign out</button>
            </div>
          ) : session && isAdmin === null ? (
            <p className="text-center text-sm text-charcoal/60">Verifying access…</p>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <label className="block"><span className="label">Email</span><input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label className="block"><span className="label">Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-negative">{error}</p>}
              <button type="submit" className="btn-gold w-full" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
              <p className="text-center text-xs text-charcoal/50">There is no public registration. Accounts are created by the owner in Supabase.</p>
            </form>
          )}
        </div>
        <p className="mt-4 text-center text-[11px] text-ivory/50">Private system · not indexed · figures are estimates, not tax advice</p>
      </div>
    </div>
  );
}
