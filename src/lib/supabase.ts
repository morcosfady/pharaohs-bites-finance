import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when the build was given real Supabase credentials. */
export const isConfigured = !!url && !!anon && !/YOUR-PROJECT-REF|YOUR-ANON/.test(url + anon);

// Only the anon (public) key ever reaches the browser. It is safe solely
// because every table is protected by Row Level Security.
export const supabase: SupabaseClient = createClient(
  url && isConfigured ? url : "https://placeholder.supabase.co",
  anon && isConfigured ? anon : "placeholder",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

export const BUSINESS_WHATSAPP = (import.meta.env.VITE_BUSINESS_WHATSAPP as string | undefined) || "17879684078";

/** Throws a readable error for Supabase responses. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}
