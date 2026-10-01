import { useEffect, useMemo, useState } from "react";
import { FileText, ChevronLeft, ChevronRight, Download, ExternalLink, Search, Images } from "lucide-react";
import { Skeleton, EmptyState, Modal } from "./ui";
import { useReceipts } from "../hooks/queries";
import { supabase } from "../lib/supabase";
import { toGalleryItems, groupByMonth, filterGallery, monthsOf, monthLabel, isImage, type GalleryItem } from "../lib/gallery";
import { fmt } from "../lib/money";
import { fmtDate } from "../lib/dates";

/* Gallery: the original pictures and PDFs of every receipt, newest first, by month. Tap one to enlarge it, flip
   through them, download it, or jump to the expense. Pictures live in the private receipts bucket; links are
   short-lived and only work for the signed-in admin. */

export function GalleryTab({ onOpenExpense, onGoReceipts }: { onOpenExpense: (id: string) => void; onGoReceipts: () => void }) {
  const receipts = useReceipts();
  const [q, setQ] = useState(""); const [month, setMonth] = useState(""); const [kind, setKind] = useState<"all" | "photos" | "pdf">("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const all = useMemo(() => toGalleryItems(receipts.data ?? []), [receipts.data]);
  const shown = useMemo(() => filterGallery(all, { q, month, kind }), [all, q, month, kind]);
  const groups = useMemo(() => groupByMonth(shown), [shown]);
  const missing = (receipts.data ?? []).filter((r) => !r.storage_path).length;
  const thumbs = useThumbs(shown);
  const idx = shown.findIndex((i) => i.id === openId);

  if (receipts.isLoading) return <Skeleton rows={5} className="card p-5" />;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-2 px-4 py-3">
        <label className="relative min-w-[10rem] flex-1"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-charcoal/40" />
          <input className="input !pl-8" placeholder="Search a store (Costco, Amazon…)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search receipts" /></label>
        <select className="input !w-auto" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          <option value="">All months</option>{monthsOf(all).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>
        <select className="input !w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Type">
          <option value="all">Photos and PDFs</option><option value="photos">Photos only</option><option value="pdf">PDFs only</option></select>
      </div>

      {all.length === 0 ? (
        <div className="card"><EmptyState title="No pictures yet" hint="Upload a receipt photo or PDF and it shows up here." action={<button className="btn-gold btn-sm" onClick={onGoReceipts}>Go to Receipts</button>} /></div>
      ) : groups.length === 0 ? (
        <p className="rounded-lg bg-ivory-50 px-4 py-3 text-sm text-charcoal/60">Nothing matches. Clear the search or pick another month.</p>
      ) : groups.map((g) => (
        <section key={g.key}>
          <div className="mb-2 flex items-baseline justify-between gap-2"><h2 className="font-display text-lg font-semibold text-teal-900">{g.label}</h2><span className="text-xs text-charcoal/55">{g.items.length} receipt{g.items.length === 1 ? "" : "s"}{g.totalCents ? ` · ${fmt(g.totalCents)}` : ""}</span></div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {g.items.map((it) => (
              <li key={it.id}>
                <button type="button" onClick={() => setOpenId(it.id)} className="group relative block aspect-[3/4] w-full overflow-hidden rounded-xl border border-ivory-200 bg-ivory-100 text-left shadow-sm hover:border-gold" aria-label={`Open ${it.title}`}>
                  {isImage(it.mime) && thumbs[it.id]
                    ? <img src={thumbs[it.id]} alt="" loading={shown.indexOf(it) < 12 ? "eager" : "lazy"} decoding="async" className="h-full w-full object-cover transition group-hover:scale-[1.03]" />
                    : <span className="grid h-full w-full place-items-center text-charcoal/35"><FileText size={42} /></span>}
                  {it.paths.length > 1 && <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-charcoal/75 px-2 py-0.5 text-[11px] text-white"><Images size={11} /> {it.paths.length}</span>}
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-charcoal/85 via-charcoal/45 to-transparent px-2.5 pb-2 pt-8 text-white">
                    <span className="block truncate text-sm font-medium">{it.title}</span>
                    <span className="flex justify-between text-[11px] text-white/80"><span>{fmtDate(it.date)}</span>{it.totalCents != null && <b>{fmt(it.totalCents)}</b>}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {missing > 0 && <p className="text-xs text-charcoal/55">{missing} receipt{missing === 1 ? " has" : "s have"} no picture yet. Add one on the <button className="text-teal-700 underline" onClick={onGoReceipts}>Receipts tab</button>.</p>}

      {idx >= 0 && <Viewer items={shown} index={idx} onIndex={(i) => setOpenId(shown[i].id)} onClose={() => setOpenId(null)} onOpenExpense={(id) => { setOpenId(null); onOpenExpense(id); }} />}
    </div>
  );
}

/** Signed thumbnail links for the grid (private bucket), one call. */
function useThumbs(items: GalleryItem[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = items.filter((i) => isImage(i.mime)).map((i) => i.id).join(",");
  useEffect(() => {
    const list = items.filter((i) => isImage(i.mime)).slice(0, 80);
    if (!list.length) return;
    let live = true;
    void supabase.storage.from("receipts").createSignedUrls(list.map((i) => i.paths[0]), 900).then(({ data }) => {
      if (!live || !data) return;
      const map: Record<string, string> = {};
      data.forEach((d, i) => { if (d.signedUrl) map[list[i].id] = d.signedUrl; });
      setUrls(map);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

function Viewer({ items, index, onIndex, onClose, onOpenExpense }: { items: GalleryItem[]; index: number; onIndex: (i: number) => void; onClose: () => void; onOpenExpense: (id: string) => void }) {
  const it = items[index];
  const [urls, setUrls] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  useEffect(() => {
    let live = true; setUrls([]); setPage(0);
    void supabase.storage.from("receipts").createSignedUrls(it.paths, 600).then(({ data }) => { if (live && data) setUrls(data.map((d) => d.signedUrl ?? "")); });
    return () => { live = false; };
  }, [it.id, it.paths]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex]);
  const url = urls[page] ?? "";
  const pageIsImage = isImage(it.mime) || /\.(png|jpe?g|webp)$/i.test(it.paths[page] ?? "");

  return (
    <Modal open onClose={onClose} title={it.title} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-charcoal/65">{fmtDate(it.date)}{it.totalCents != null ? ` · ` : ""}{it.totalCents != null && <b className="text-charcoal">{fmt(it.totalCents)}</b>} · {index + 1} of {items.length}</span>
          <span className="flex gap-2">
            <button className="btn-ghost btn-sm" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Previous receipt"><ChevronLeft size={15} /></button>
            <button className="btn-ghost btn-sm" disabled={index >= items.length - 1} onClick={() => onIndex(index + 1)} aria-label="Next receipt"><ChevronRight size={15} /></button>
          </span>
        </div>
        {it.paths.length > 1 && <div className="flex flex-wrap gap-2">{it.paths.map((_, i) => <button key={i} onClick={() => setPage(i)} className={`rounded-lg px-3 py-1 text-xs ${page === i ? "bg-teal-800 text-white" : "bg-ivory-100 text-charcoal/70"}`}>Page {i + 1}</button>)}</div>}
        <div className="grid min-h-[40vh] place-items-center rounded-lg border border-ivory-200 bg-ivory-50 p-2">
          {!url ? <Skeleton rows={4} className="w-full" /> : pageIsImage
            ? <img src={url} alt={`${it.title} receipt, page ${page + 1}`} className="max-h-[68vh] w-auto max-w-full rounded object-contain" />
            : <iframe src={url} title={`${it.title} PDF`} className="h-[68vh] w-full rounded" />}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {it.expenseId && <button className="btn-gold btn-sm" onClick={() => onOpenExpense(it.expenseId!)}>Open the expense</button>}
          {url && <a className="btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open full size</a>}
          {url && <a className="btn-ghost btn-sm" href={url} download><Download size={14} /> Download</a>}
        </div>
      </div>
    </Modal>
  );
}
