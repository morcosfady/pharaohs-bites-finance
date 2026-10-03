// Supabase Edge Function: track
// ---------------------------------------------------------------------------
// The customer website reports what visitors do (opened a page, added a dish,
// pressed Place Order, hit a problem) so the dashboard "Website Pulse" tab can
// show it. Anonymous: a random visitor id, no cookies, no personal details.
// Origin allow-list, strict validation, per-IP rate limit, bots ignored.
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://morcosfady.github.io",
  "https://pharaohsbites.com",
  "https://www.pharaohsbites.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8123",
];
const KINDS = ["visit", "add_to_basket", "checkout_started", "problem"];  // order_placed is written by create-order only
const MAX_EVENTS = 5;
const RATE_LIMIT_PER_HOUR = 300;
const KEEP_DAYS = 180;

function corsHeaders(origin: string | null) {
  const ok = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}
const json = (p: unknown, status: number, h: Record<string, string>) => new Response(JSON.stringify(p), { status, headers: h });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\x00-\x1f]/g, " ").trim().slice(0, max) : "");

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false }, 405, headers);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ ok: false }, 403, headers);

  const ua = req.headers.get("user-agent") ?? "";
  if (/bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|python|wget/i.test(ua)) return json({ ok: true, ignored: true }, 200, headers);
  const device = /iPad|Tablet/i.test(ua) ? "tablet" : /Mobi|Android|iPhone/i.test(ua) ? "phone" : "computer";

  let body: { visitor_id?: unknown; events?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false }, 400, headers); }
  const visitor = text(body.visitor_id, 40);
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(visitor) || !Array.isArray(body.events) || !body.events.length) return json({ ok: false }, 400, headers);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const ipHash = await sha256(ip + "|pharaohs-bites-track");
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await supabase.from("site_events").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) return json({ ok: true, limited: true }, 200, headers);

  const rows = (body.events as Array<Record<string, unknown>>).slice(0, MAX_EVENTS)
    .filter((e) => typeof e?.kind === "string" && KINDS.includes(e.kind as string))
    .map((e) => {
      const m = (e.meta && typeof e.meta === "object" ? e.meta : {}) as Record<string, unknown>;
      const meta: Record<string, string> = { device };
      for (const k of ["source", "type", "item", "name", "phone4", "zip", "code"]) if (typeof m[k] === "string") meta[k] = text(m[k], 120);
      return { visitor_id: visitor, kind: e.kind as string, page: text(e.page, 40), detail: text(e.detail, 300), meta, ip_hash: ipHash };
    });
  if (!rows.length) return json({ ok: false }, 400, headers);
  const { error } = await supabase.from("site_events").insert(rows);
  if (error) { console.error("track insert failed", error.message); return json({ ok: false }, 500, headers); }

  // Housekeeping: now and then, drop rows older than KEEP_DAYS.
  if (Math.random() < 0.01) await supabase.from("site_events").delete().lt("created_at", new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  return json({ ok: true }, 200, headers);
});
