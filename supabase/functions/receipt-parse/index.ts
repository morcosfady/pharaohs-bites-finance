// Supabase Edge Function: receipt-parse
// ---------------------------------------------------------------------------
// Admin-only. Reads one uploaded receipt ({ file_id }) or every receipt that is
// waiting for the API key ({ all_waiting: true }). The Claude key never reaches the browser.
// ---------------------------------------------------------------------------
import { cors, json, requireAdmin, serviceClient } from "../_shared/plaid.ts";
import { parseReceiptFile } from "../_shared/receiptParse.ts";

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, headers);
  const auth = await requireAdmin(req);
  if (auth instanceof Response) return auth;

  let body: { file_id?: string; all_waiting?: boolean } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, headers); }
  const db = serviceClient();

  if (body.all_waiting) {
    const { data: rows } = await db.from("receipt_files").select("id").in("status", ["waiting_key", "failed", "uploaded"]).order("created_at").limit(25);
    const results = [];
    for (const r of rows ?? []) results.push(await parseReceiptFile(db, r.id));
    return json({ ok: true, count: results.length, parsed: results.filter((r) => r.status === "parsed").length, waiting: results.filter((r) => r.status === "waiting_key").length }, 200, headers);
  }
  if (!body.file_id || !/^[0-9a-f-]{36}$/i.test(body.file_id)) return json({ ok: false, error: "file_id is required" }, 400, headers);
  return json(await parseReceiptFile(db, body.file_id), 200, headers);
});
