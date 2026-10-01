// Reads one stored receipt (photo, PDF or email text) with the Claude API and hands the result to the
// database function apply_parsed_receipt(), which matches it, splits it and refuses duplicates.
// Secrets: ANTHROPIC_API_KEY (set by the owner in Supabase), optional RECEIPT_MODEL.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildSystemPrompt, friendlyApiError, normalizeParsed, parseModelJson } from "./receiptSchema.ts";

const DEFAULT_MODEL = "claude-sonnet-5-5";
const SKIP_CATEGORIES = ["Refunds", "Payment processing fees", "Personal (not business)"];

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export type ParseResult = { ok: boolean; status: string; outcome?: string; expense_id?: string; error?: string };

export async function parseReceiptFile(db: SupabaseClient, fileId: string): Promise<ParseResult> {
  const { data: f } = await db.from("receipt_files").select("*").eq("id", fileId).maybeSingle();
  if (!f) return { ok: false, status: "failed", error: "receipt not found" };

  const key = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").replace(/[^A-Za-z0-9_\-]/g, "");
  if (!key) {
    await db.from("receipt_files").update({ status: "waiting_key", error: "Waiting for the Claude API key to be added." }).eq("id", fileId);
    return { ok: true, status: "waiting_key" };
  }

  await db.from("receipt_files").update({ status: "parsing", error: "" }).eq("id", fileId);
  const fail = async (error: string): Promise<ParseResult> => {
    await db.from("receipt_files").update({ status: "failed", error }).eq("id", fileId);
    return { ok: false, status: "failed", error };
  };

  try {
    const { data: cats } = await db.from("expense_categories").select("name").order("sort_order");
    const categories = (cats ?? []).map((c: { name: string }) => c.name).filter((n: string) => !SKIP_CATEGORIES.includes(n));

    // the document: a stored file, or the text of an email
    const content: Record<string, unknown>[] = [];
    if (f.storage_path) {
      const { data: blob, error } = await db.storage.from("receipts").download(f.storage_path);
      if (error || !blob) return await fail("Could not open the stored file.");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > 12_000_000) return await fail("This file is too large to read. Upload a smaller picture.");
      const b64 = toBase64(bytes);
      if (f.mime === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
      else content.push({ type: "image", source: { type: "base64", media_type: f.mime || "image/jpeg", data: b64 } });
      if (f.body_text) content.push({ type: "text", text: `Email text that came with it:\n${String(f.body_text).slice(0, 20000)}` });
    } else {
      content.push({ type: "text", text: `Email subject: ${f.email_subject}\n\n${String(f.body_text).slice(0, 60000)}` });
    }
    content.push({ type: "text", text: "Read this document and return the JSON object." });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: Deno.env.get("RECEIPT_MODEL") || DEFAULT_MODEL, max_tokens: 4000,
        system: buildSystemPrompt(categories), messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = raw.slice(0, 300);
      try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* keep raw */ }
      return await fail(friendlyApiError(res.status, msg));
    }
    const reply = JSON.parse(raw);
    const text = (reply.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    const parsed = normalizeParsed(parseModelJson(text), categories);

    if (!parsed.is_receipt) return await fail(`This does not look like a purchase receipt${parsed.notes ? `: ${parsed.notes}` : "."}`);

    const { data: applied, error: applyErr } = await db.rpc("apply_parsed_receipt", { p_file_id: fileId, p_parsed: parsed });
    if (applyErr) return await fail(`Could not save the receipt: ${applyErr.message}`);
    const a = applied as { outcome?: string; expense_id?: string };
    return { ok: a.outcome !== "failed", status: a.outcome === "failed" ? "failed" : "parsed", outcome: a.outcome, expense_id: a.expense_id };
  } catch (e) {
    return await fail(`Could not read this receipt: ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
}
