import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Upload, FileText, RefreshCw, AlertTriangle, Mail } from "lucide-react";
import { Skeleton, Modal, useToast, EmptyState } from "./ui";
import { useReceipts, useNeedsReceipt, useExpenseItems, useExpenseCategories, useWrite } from "../hooks/queries";
import { supabase, unwrap } from "../lib/supabase";
import { fmt, toCents } from "../lib/money";
import { fmtDate } from "../lib/dates";
import { isImagePath } from "../lib/gallery";
import { fileProblem, safeName, sha256Hex, shrinkImage, receiptStatus } from "../lib/receiptUpload";
import { useQueryClient } from "@tanstack/react-query";
import type { ReceiptFile } from "../lib/types";

/* Receipts: snap a photo or upload a file; Claude reads every item; the database matches it with the
   bank charge so a purchase is counted once. The same photo twice is refused before it uploads. */

async function callParse(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("receipt-parse", { body });
  if (error) {
    const d = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(d?.error ?? error.message);
  }
  return data as { ok?: boolean; status?: string; outcome?: string; error?: string; count?: number; parsed?: number; waiting?: number };
}

export function ReceiptsTab({ onOpenExpense }: { onOpenExpense: (id: string) => void }) {
  const receipts = useReceipts();
  const needs = useNeedsReceipt();
  const toast = useToast(); const qc = useQueryClient();
  const camera = useRef<HTMLInputElement>(null); const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<ReceiptFile | null>(null);
  const rows = useMemo(() => receipts.data ?? [], [receipts.data]);
  const waiting = rows.filter((r) => r.status === "waiting_key").length;
  const thumbs = useThumbs(rows);

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    for (const file of Array.from(list)) {
      const bad = fileProblem(file);
      if (bad) { toast.push(bad, "err"); continue; }
      try {
        setBusy(`Checking ${file.name}…`);
        const sha = await sha256Hex(file);
        const { data: dupe } = await supabase.from("receipt_files").select("created_at, parsed, status").eq("sha256", sha).maybeSingle();
        if (dupe) { toast.push(`Already uploaded on ${fmtDate(dupe.created_at)}. Nothing was added twice.`, "err"); continue; }

        setBusy("Uploading…");
        const blob = await shrinkImage(file);
        const mime = blob === file ? file.type : "image/jpeg";
        const path = `inbox/${new Date().toISOString().slice(0, 7)}/${sha.slice(0, 12)}-${safeName(file.name)}`;
        const up = await supabase.storage.from("receipts").upload(path, blob, { contentType: mime, upsert: false });
        if (up.error && !/already exists|Duplicate/i.test(up.error.message)) throw new Error(up.error.message);
        const ins = await supabase.from("receipt_files").insert({ sha256: sha, storage_path: path, original_name: file.name.slice(0, 120), mime, size_bytes: blob.size, source: "upload", status: "uploaded" }).select("id").single();
        if (ins.error) throw new Error(/duplicate|unique/i.test(ins.error.message) ? "This receipt was already uploaded." : ins.error.message);

        setBusy("Reading the receipt…");
        const res = await callParse({ file_id: ins.data.id });
        if (res.status === "waiting_key") toast.push("Saved. It will be read as soon as the AI key is added.");
        else if (res.ok === false) toast.push(res.error ?? "Could not read it. Open it for details.", "err");
        else toast.push(res.outcome === "linked" ? "Read and matched to the bank charge." : res.outcome === "refund" ? "Refund recorded." : res.outcome === "partial" ? "Read and matched to part of a charge." : res.outcome === "possible_duplicate" ? "Read. It may be a duplicate: check it." : "Read and added as a new expense.");
      } catch (e) { toast.push((e as Error).message, "err"); }
    }
    setBusy(""); qc.invalidateQueries();
  }

  async function readWaiting() {
    setBusy("Reading waiting receipts…");
    try {
      const r = await callParse({ all_waiting: true });
      toast.push(r.waiting ? "Still waiting for the AI key." : `Read ${r.parsed ?? 0} of ${r.count ?? 0} receipts.`, r.waiting ? "err" : "ok");
    } catch (e) { toast.push((e as Error).message, "err"); }
    setBusy(""); qc.invalidateQueries();
  }

  return (
    <div className="space-y-5">
      <section className="card">
        <div className="card-head"><div><h2 className="card-title inline-flex items-center gap-2"><Camera size={16} className="text-gold" /> Add a receipt</h2>
          <p className="text-xs text-charcoal/50">Photo or PDF. Every item is read and filed. The same receipt twice is refused.</p></div></div>
        <div className="flex flex-wrap items-center gap-2 px-5 pb-5">
          <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <input ref={picker} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <button className="btn-gold" disabled={!!busy} onClick={() => camera.current?.click()}><Camera size={16} /> Take photo</button>
          <button className="btn-ghost" disabled={!!busy} onClick={() => picker.current?.click()}><Upload size={16} /> Upload file</button>
          {waiting > 0 && <button className="btn-ghost" disabled={!!busy} onClick={readWaiting}><RefreshCw size={14} /> Read {waiting} waiting</button>}
          {busy && <span className="text-sm text-charcoal/60"><RefreshCw size={13} className="mr-1 inline animate-spin" />{busy}</span>}
        </div>
        <p className="flex items-start gap-2 border-t border-ivory-200 px-5 py-3 text-xs text-charcoal/60"><Mail size={14} className="mt-0.5 shrink-0" /><span>Order emails (Walmart, Costco, Amazon…): give them the Gmail label <b>PB Receipts</b> and they arrive here by themselves.</span></p>
      </section>

      {(needs.data ?? []).length > 0 && (
        <section className="card">
          <div className="card-head"><div><h2 className="card-title">Waiting for a receipt ({needs.data!.length})</h2><p className="text-xs text-charcoal/50">Store charges from the bank with no receipt yet. Upload the receipt and it attaches by itself.</p></div></div>
          <ul className="divide-y divide-ivory-200 px-5 pb-3 text-sm">
            {needs.data!.map((n) => (
              <li key={n.expense_id}><button type="button" onClick={() => onOpenExpense(n.expense_id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-ivory-50">
                <span className="w-14 shrink-0 text-xs text-charcoal/50">{fmtDate(n.expense_date)}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{n.vendor}</span><span className="text-xs text-charcoal/50">{n.days_waiting} days ago</span></span>
                <b className="tabular-nums">{fmt(toCents(n.total_amount))}</b>
              </button></li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2 className="card-title">Receipts ({rows.length})</h2></div>
        <div className="px-5 pb-5">
          {receipts.isLoading ? <Skeleton rows={3} /> : rows.length === 0 ? <EmptyState title="No receipts yet" hint="Tap Take photo after your next shopping trip." /> : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((r) => {
                const st = receiptStatus(r);
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => setOpen(r)} className="flex w-full gap-3 rounded-xl border border-ivory-200 bg-white p-2.5 text-left hover:border-gold">
                      <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-ivory-100 text-charcoal/40">
                        {thumbs[r.id] ? <img src={thumbs[r.id]} alt="" className="h-full w-full object-cover" /> : r.source === "email" ? <Mail size={22} /> : <FileText size={22} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{r.parsed?.vendor || r.email_subject || r.original_name || "Receipt"}</span>
                        <span className="block text-xs text-charcoal/50">{r.parsed?.date ? fmtDate(r.parsed.date) : fmtDate(r.created_at)}{r.parsed?.total ? ` · ${fmt(toCents(r.parsed.total))}` : ""}{r.source === "email" ? " · email" : ""}</span>
                        <span className={`badge mt-1 ${st.tone === "good" ? "bg-teal-50 text-teal-800" : st.tone === "bad" ? "bg-negative/10 text-negative" : st.tone === "wait" ? "bg-gold-100 text-charcoal/70" : "bg-ivory-200 text-charcoal/60"}`}>{st.text}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {open && <ReceiptDetail receipt={rows.find((r) => r.id === open.id) ?? open} onClose={() => setOpen(null)} onOpenExpense={(id) => { setOpen(null); onOpenExpense(id); }} />}
    </div>
  );
}

/** Signed thumbnail URLs for the gallery (private bucket), fetched in one call. */
function useThumbs(rows: ReceiptFile[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = rows.filter((r) => r.storage_path && r.mime.startsWith("image/")).map((r) => r.id).join(",");
  useEffect(() => {
    const withImg = rows.filter((r) => r.storage_path && r.mime.startsWith("image/")).slice(0, 60);
    if (!withImg.length) return;
    let live = true;
    void supabase.storage.from("receipts").createSignedUrls(withImg.map((r) => r.storage_path), 900).then(({ data }) => {
      if (!live || !data) return;
      const map: Record<string, string> = {};
      data.forEach((d, i) => { if (d.signedUrl) map[withImg[i].id] = d.signedUrl; });
      setUrls(map);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

function ReceiptDetail({ receipt, onClose, onOpenExpense }: { receipt: ReceiptFile; onClose: () => void; onOpenExpense: (id: string) => void }) {
  const items = useExpenseItems(receipt.expense_id);
  const cats = useExpenseCategories();
  const write = useWrite(); const toast = useToast(); const qc = useQueryClient();
  const [urls, setUrls] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const st = receiptStatus(receipt);
  const paths = [receipt.storage_path, ...(receipt.extra_paths ?? [])].filter(Boolean);
  useEffect(() => {
    if (!paths.length) return;
    let live = true;
    void supabase.storage.from("receipts").createSignedUrls(paths, 600).then(({ data }) => { if (live && data) setUrls(data.map((d) => d.signedUrl ?? "")); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.storage_path, (receipt.extra_paths ?? []).join("|")]);

  const setCategory = async (itemId: string, name: string, categoryId: string) => {
    const c = cats.data?.find((x) => x.id === categoryId); if (!c) return;
    const business = c.name !== "Personal (not business)";
    try {
      await write.mutateAsync(async () => {
        unwrap(await supabase.from("expense_items").update({ category_id: categoryId, is_business: business }).eq("id", itemId).select("id"));
        unwrap(await supabase.rpc("remember_item_category", { p_name: name, p_category: categoryId, p_business: business }));
      });
      toast.push(`Saved. Next time “${name.split(" ").slice(0, 3).join(" ")}” goes to ${c.name}.`);
    } catch (e) { toast.push((e as Error).message, "err"); }
  };
  const readAgain = async () => {
    setBusy(true);
    try { const r = await callParse({ file_id: receipt.id }); toast.push(r.ok === false ? (r.error ?? "Could not read it") : r.status === "waiting_key" ? "Still waiting for the AI key." : "Read again", r.ok === false ? "err" : "ok"); }
    catch (e) { toast.push((e as Error).message, "err"); }
    setBusy(false); qc.invalidateQueries();
  };

  const p = receipt.parsed;
  return (
    <Modal open onClose={onClose} title={p?.vendor || receipt.email_subject || "Receipt"} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          {urls.map((u, i) => !u ? null : isImagePath(paths[i] ?? "", receipt.mime)
            ? <a key={i} href={u} target="_blank" rel="noreferrer" className="mb-2 block"><img src={u} alt={`Receipt page ${i + 1}`} className="max-h-[55vh] w-full rounded-lg border border-ivory-200 object-contain" /></a>
            : <a key={i} className="btn-ghost mb-2" href={u} target="_blank" rel="noreferrer"><FileText size={16} /> Open the PDF</a>)}
          {!receipt.storage_path && <p className="rounded-lg bg-ivory-50 px-3 py-2 text-sm text-charcoal/60">Read from the email text. {receipt.email_subject}</p>}
        </div>
        <div className="space-y-3 text-sm">
          <p><span className={`badge ${st.tone === "bad" ? "bg-negative/10 text-negative" : st.tone === "good" ? "bg-teal-50 text-teal-800" : "bg-gold-100 text-charcoal/70"}`}>{st.text}</span>
            {p?.total ? <b className="ml-2">{fmt(toCents(p.total))}</b> : null}{p?.date ? <span className="ml-2 text-charcoal/50">{fmtDate(p.date)}</span> : null}</p>
          {receipt.error && <p className="flex gap-2 rounded-lg bg-gold-100 px-3 py-2 text-xs"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" /><span>{receipt.error}</span></p>}
          {items.isLoading ? <Skeleton rows={3} /> : (items.data ?? []).length > 0 && (
            <ul className="divide-y divide-ivory-200">
              {(items.data ?? []).map((i) => (
                <li key={i.id} className="py-2">
                  <div className="flex items-baseline justify-between gap-2"><span className="min-w-0 truncate">{i.description}</span><b className="tabular-nums">{fmt(toCents(i.line_total))}</b></div>
                  <select className="input mt-1 !py-1 text-xs" aria-label={`Category for ${i.description}`} value={i.is_business ? (i.category_id ?? "") : (cats.data?.find((c) => c.name === "Personal (not business)")?.id ?? "")} onChange={(e) => void setCategory(i.id, i.description, e.target.value)}>
                    <option value="">No category</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {receipt.expense_id && <button className="btn-gold btn-sm" onClick={() => onOpenExpense(receipt.expense_id!)}>Open the expense</button>}
            <button className="btn-ghost btn-sm" disabled={busy} onClick={readAgain}><RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Read again</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
