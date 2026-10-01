/* Gallery of original receipts: only receipts that have a picture, newest first, grouped by month. Pure helpers. */
import type { ReceiptFile } from "./types";
import { toCents } from "./money";

export interface GalleryMember { id: string; label: string; totalCents: number | null; expenseId: string | null }
export interface GalleryItem {
  id: string; title: string; date: string; totalCents: number | null; mime: string; paths: string[]; expenseId: string | null; source: ReceiptFile["source"];
  /** the receipts that share this picture (an Amazon order page covering several items); one entry for a normal receipt */
  members: GalleryMember[];
}
export interface GalleryMonth { key: string; label: string; items: GalleryItem[]; totalCents: number }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const isImage = (mime: string) => mime.startsWith("image/");

/** Receipts with at least one stored picture. A receipt can have several pages (main picture first). */
export function toGalleryItems(files: Pick<ReceiptFile, "id" | "storage_path" | "extra_paths" | "mime" | "parsed" | "email_subject" | "original_name" | "created_at" | "expense_id" | "source">[]): GalleryItem[] {
  return files.filter((f) => f.storage_path).map((f) => ({
    id: f.id,
    title: (f.parsed?.vendor || "").trim() || f.email_subject || f.original_name || "Receipt",
    date: (f.parsed?.date || f.created_at).slice(0, 10),
    totalCents: f.parsed?.total ? toCents(f.parsed.total) : null,
    mime: f.mime, paths: [f.storage_path, ...(f.extra_paths ?? [])], expenseId: f.expense_id, source: f.source,
    members: [{ id: f.id, label: (f.original_name || "").replace(/^[^:]{1,20}:\s*/, "") || (f.parsed?.vendor || "Receipt"), totalCents: f.parsed?.total ? toCents(f.parsed.total) : null, expenseId: f.expense_id }],
  })).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

export function groupByMonth(items: GalleryItem[]): GalleryMonth[] {
  const m = new Map<string, GalleryItem[]>();
  for (const it of items) { const k = it.date.slice(0, 7); m.set(k, [...(m.get(k) ?? []), it]); }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, list]) => ({
    key, label: monthLabel(key), items: list, totalCents: list.reduce((s, i) => s + (i.totalCents ?? 0), 0),
  }));
}

export interface GalleryFilter { q: string; month: string; kind: "all" | "photos" | "pdf" }

export function filterGallery(items: GalleryItem[], f: GalleryFilter): GalleryItem[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((i) =>
    (!q || i.title.toLowerCase().includes(q)) &&
    (!f.month || i.date.startsWith(f.month)) &&
    (f.kind === "all" || (f.kind === "photos" ? isImage(i.mime) : !isImage(i.mime))));
}

/** The months that have pictures, for the month picker. */
export const monthsOf = (items: GalleryItem[]) => [...new Set(items.map((i) => i.date.slice(0, 7)))].sort().reverse();


/** One tile per PICTURE: receipts that point at the same main picture (several Amazon items on one order page) become one
 *  tile that lists its items, instead of the same picture repeated. */
export function mergeByPicture(items: GalleryItem[]): GalleryItem[] {
  const byPath = new Map<string, GalleryItem>();
  const out: GalleryItem[] = [];
  for (const it of items) {
    const first = byPath.get(it.paths[0]);
    if (!first) { const copy = { ...it, members: [...it.members] }; byPath.set(it.paths[0], copy); out.push(copy); continue; }
    first.members.push(...it.members);
    first.totalCents = (first.totalCents ?? 0) + (it.totalCents ?? 0);
    if (it.date > first.date) first.date = it.date;
    first.expenseId = null;                      // several expenses: pick one from the list
    for (const p of it.paths) if (!first.paths.includes(p)) first.paths.push(p);
  }
  for (const it of out) if (it.members.length > 1) it.title = `${it.title} · ${it.members.length} items`;
  return out;
}
