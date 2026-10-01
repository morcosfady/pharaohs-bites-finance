/* Browser-side helpers for receipt uploads: fingerprint the file (so the same photo twice is refused
   before it is even uploaded), shrink big photos, and word the status for the owner. */
import type { ReceiptFile } from "./types";

export const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 10 * 1024 * 1024;

/** SHA-256 of the ORIGINAL file bytes, as hex. The database refuses a second receipt with the same hash. */
export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why a file cannot be used, in plain words; null when it is fine. */
export function fileProblem(f: { type: string; size: number; name: string }): string | null {
  if (/heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name)) return "This is an iPhone HEIC photo. Take the picture again with the app's Take photo button, or share it as JPG.";
  if (!ALLOWED_TYPES.includes(f.type)) return "Use a photo (JPG, PNG) or a PDF.";
  if (f.size > MAX_BYTES * 3) return "This file is too large. Use a smaller picture or a PDF under 10 MB.";
  return null;
}

/** Big phone photos are shrunk (longest side 2000 px, JPEG) so they upload fast and Claude can read them. */
export async function shrinkImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.size < 1_200_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }
}

export const safeName = (name: string) => name.replace(/[^a-zA-Z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(-60) || "receipt";

export interface StatusLabel { text: string; tone: "good" | "wait" | "bad" | "info" }

/** One short label per receipt for the gallery. */
export function receiptStatus(r: Pick<ReceiptFile, "status" | "outcome" | "totals_ok">): StatusLabel {
  if (r.status === "waiting_key") return { text: "Waiting for AI key", tone: "wait" };
  if (r.status === "uploaded" || r.status === "parsing") return { text: "Reading…", tone: "wait" };
  if (r.status === "failed") return { text: "Needs attention", tone: "bad" };
  if (r.totals_ok === false) return { text: "Check items", tone: "bad" };
  switch (r.outcome) {
    case "linked": return { text: "Matched to a charge", tone: "good" };
    case "partial": return { text: "Part of a charge", tone: "good" };
    case "refund": return { text: "Refund recorded", tone: "info" };
    case "possible_duplicate": return { text: "Maybe a duplicate", tone: "bad" };
    case "created": return { text: "New expense", tone: "good" };
    default: return { text: "Done", tone: "good" };
  }
}
