// Supabase Edge Function: receipt-email
// ---------------------------------------------------------------------------
// Called by the Gmail Apps Script (scripts/gmail-receipts.gs) for every email that carries the
// "PB Receipts" label. Authenticated by a shared token (RECEIPT_INBOX_TOKEN), not a user JWT.
// The Gmail Message-ID is the duplicate key: the same email can never be imported twice.
// ---------------------------------------------------------------------------
import { json, serviceClient } from "../_shared/plaid.ts";
import { parseReceiptFile } from "../_shared/receiptParse.ts";

const MAX_ATTACHMENT_BYTES = 8_000_000;
const OK_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req) => {
  const h = { "access-control-allow-origin": "*" };
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, h);
  const secret = Deno.env.get("RECEIPT_INBOX_TOKEN") ?? "";
  if (!secret) return json({ ok: false, error: "receipt inbox is not configured" }, 503, h);

  let b: { token?: string; message_id?: string; subject?: string; from?: string; date?: string; body_text?: string; attachments?: { name?: string; mime?: string; data_base64?: string }[] };
  try { b = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, h); }
  if (!safeEqual(String(b.token ?? ""), secret)) return json({ ok: false, error: "not allowed" }, 401, h);
  const messageId = String(b.message_id ?? "").trim().slice(0, 300);
  if (!messageId) return json({ ok: false, error: "message_id is required" }, 400, h);

  const db = serviceClient();
  const { data: dupe } = await db.from("receipt_files").select("id, status, outcome").eq("email_message_id", messageId).maybeSingle();
  if (dupe) return json({ ok: true, duplicate: true, status: dupe.status, outcome: dupe.outcome }, 200, h);

  const hash = await sha256("email:" + messageId);
  const body = String(b.body_text ?? "").slice(0, 60000);
  let storagePath = "", mime = "", size = 0, name = "";

  // keep the first usable attachment (the receipt PDF or photo) so it can be shown later
  const att = (b.attachments ?? []).find((a) => OK_MIME.includes(String(a.mime)) && a.data_base64);
  if (att) {
    const bytes = Uint8Array.from(atob(att.data_base64!), (c) => c.charCodeAt(0));
    if (bytes.length <= MAX_ATTACHMENT_BYTES) {
      const ext = att.mime === "application/pdf" ? "pdf" : att.mime === "image/png" ? "png" : att.mime === "image/webp" ? "webp" : "jpg";
      storagePath = `email/${hash.slice(0, 40)}.${ext}`;
      const { error } = await db.storage.from("receipts").upload(storagePath, bytes, { contentType: att.mime!, upsert: true });
      if (error) storagePath = ""; else { mime = att.mime!; size = bytes.length; name = String(att.name ?? "").slice(0, 120); }
    }
  }

  const { data: row, error } = await db.from("receipt_files").insert({
    sha256: hash, source: "email", email_message_id: messageId, email_subject: String(b.subject ?? "").slice(0, 300),
    body_text: body, storage_path: storagePath, mime, size_bytes: size, original_name: name, status: "uploaded",
  }).select("id").single();
  if (error) return json({ ok: false, error: error.message.includes("duplicate") ? "already imported" : "could not save" }, error.message.includes("duplicate") ? 200 : 500, h);

  const result = await parseReceiptFile(db, row.id);
  return json({ ok: true, id: row.id, ...result }, 200, h);
});
