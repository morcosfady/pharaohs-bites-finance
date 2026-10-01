// Supabase Edge Function: weekly-summary
// ---------------------------------------------------------------------------
// Sends the owner a Monday Telegram message: what was spent, top categories, budgets near their limit,
// price jumps, bills in the next 7 days. Runs from pg_cron (x-cron-secret = SYNC_CRON_SECRET) or by an
// admin (the dashboard can ask for { preview: true } to see the text without sending).
// ---------------------------------------------------------------------------
import { cors, json, requireAdmin, serviceClient } from "../_shared/plaid.ts";
import { formatWeeklySummary, type WeeklySummary } from "../_shared/weeklySummary.ts";

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);

  const cronKey = Deno.env.get("SYNC_CRON_SECRET");
  const isCron = !!cronKey && req.headers.get("x-cron-secret") === cronKey;
  if (!isCron) { const auth = await requireAdmin(req); if (auth instanceof Response) return auth; }

  let body: { preview?: boolean; to?: string } = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  const db = serviceClient();
  const args = body.to && /^\d{4}-\d{2}-\d{2}$/.test(body.to) ? { p_to: body.to } : {};
  const { data, error } = await db.rpc("weekly_summary", args);
  if (error) return json({ ok: false, error: error.message }, 500, headers);
  const text = formatWeeklySummary(data as WeeklySummary);
  if (body.preview) return json({ ok: true, text }, 200, headers);

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN"), chat = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chat) return json({ ok: false, error: "Telegram is not configured" }, 503, headers);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Open Expenses", url: "https://finance.pharaohsbites.com/#/expenses" }]] } }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!res || !res.ok) return json({ ok: false, error: `telegram ${res?.status ?? "network error"}` }, 502, headers);
  return json({ ok: true, sent: true }, 200, headers);
});
