// Shared helpers for the Plaid edge functions.
//
// Secrets (set with `supabase secrets set`, never committed):
//   PLAID_CLIENT_ID   your Plaid client id
//   PLAID_SECRET      the secret for the environment below
//   PLAID_ENV         sandbox | production   (default: sandbox)
//   PLAID_REDIRECT_URI  required for OAuth banks such as Chase; must be
//                       registered in the Plaid dashboard first.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const ALLOWED_ORIGINS = [
  "https://morcosfady.github.io",
  "http://localhost:5173",
  "http://localhost:5174",
];

export function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });
}

const HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export function plaidEnv() {
  const env = (Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase();
  return HOSTS[env] ? env : "sandbox";
}

/** Call the Plaid API. client_id and secret are added here, never by the browser. */
export async function plaid<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
  const clientId = Deno.env.get("PLAID_CLIENT_ID");
  const secret = Deno.env.get("PLAID_SECRET");
  if (!clientId || !secret) throw new Error("PLAID_CLIENT_ID / PLAID_SECRET are not set");
  const res = await fetch(HOSTS[plaidEnv()] + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { /* keep the raw text below */ }
  if (!res.ok) {
    const code = String(parsed.error_code ?? res.status);
    const msg = String(parsed.error_message ?? text.slice(0, 300));
    throw Object.assign(new Error(`Plaid ${path} failed: ${code} ${msg}`), { plaidCode: code });
  }
  return parsed as T;
}

/** Service-role client: needed to read bank_items, which has no RLS policies. */
export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/**
 * Every Plaid function is admin-only. The caller's JWT is checked against
 * admin_profiles through is_admin(), the same rule the database enforces.
 */
export async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const origin = req.headers.get("origin");
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "not signed in" }, 401, cors(origin));
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: u } = await asUser.auth.getUser();
  if (!u?.user) return json({ ok: false, error: "not signed in" }, 401, cors(origin));
  const { data: ok, error } = await asUser.rpc("is_admin");
  if (error || ok !== true) return json({ ok: false, error: "not authorised" }, 403, cors(origin));
  return { userId: u.user.id };
}
