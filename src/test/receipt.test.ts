import { describe, it, expect } from "vitest";
import { fileProblem, receiptStatus, safeName, sha256Hex } from "../lib/receiptUpload";
import { buildSystemPrompt, parseModelJson, normalizeParsed, totalsAddUp, friendlyApiError } from "../../supabase/functions/_shared/receiptSchema";

const CATS = ["Ingredients", "Packaging", "Kitchen supplies", "Other"];

describe("receipt reading helpers", () => {
  it("tells the model the exact categories and the store hints", () => {
    const p = buildSystemPrompt(CATS);
    expect(p).toContain("Ingredients | Packaging | Kitchen supplies | Other");
    expect(p).toMatch(/Costco/); expect(p).toMatch(/Walmart/); expect(p).toMatch(/WebstaurantStore/);
  });

  it("extracts JSON even with a code fence or a sentence around it", () => {
    expect(parseModelJson('```json\n{"total": 5}\n```')).toEqual({ total: 5 });
    expect(parseModelJson('Here you go: {"total": 7} thanks')).toEqual({ total: 7 });
    expect(() => parseModelJson("no json here")).toThrow();
  });

  it("forces the reply into the shape the database expects", () => {
    const p = normalizeParsed({
      vendor: "  Costco  ", date: "2026-10-01", total: "$99.05", tax: "7.55", payment_method: "VISA",
      items: [{ name: "KS flour", qty: 2, unit_price: 5, category: "ingredients" }, { name: "", total: 3 }, { name: "Foil", total: 12, category: "Not a real one", personal: true }],
    }, CATS);
    expect(p.vendor).toBe("Costco"); expect(p.total).toBe(99.05); expect(p.tax).toBe(7.55);
    expect(p.payment_method).toBe("other");
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ name: "KS flour", total: 10, category: "Ingredients" });
    expect(p.items[1]).toMatchObject({ category: "Other", personal: true });
  });

  it("rejects bad dates and keeps refunds positive", () => {
    expect(normalizeParsed({ date: "October 1st", total: -20, is_refund: true }, CATS)).toMatchObject({ date: null, total: 20, is_refund: true });
  });

  it("survives garbage without throwing", () => {
    expect(normalizeParsed(null, CATS)).toMatchObject({ vendor: "", total: 0, items: [] });
    expect(normalizeParsed({ items: "nope", total: "abc" }, CATS).total).toBe(0);
  });

  it("checks that items plus tax equal the total", () => {
    const base = normalizeParsed({ total: 35, tax: 0, items: [{ name: "a", total: 20 }, { name: "b", total: 10 }, { name: "c", total: 5 }] }, CATS);
    expect(totalsAddUp(base)).toBe(true);
    expect(totalsAddUp({ ...base, total: 40 })).toBe(false);
    expect(totalsAddUp({ ...base, total: 37.5, tax: 2.5 })).toBe(true);
    expect(totalsAddUp({ ...base, items: [] })).toBe(true);
  });

  it("explains API problems in plain words", () => {
    expect(friendlyApiError(401, "")).toMatch(/key was rejected/);
    expect(friendlyApiError(400, "Your credit balance is too low")).toMatch(/no credit/);
    expect(friendlyApiError(429, "")).toMatch(/busy/);
    expect(friendlyApiError(529, "")).toMatch(/temporary/);
  });
});

describe("receipt upload helpers", () => {
  it("refuses files that cannot be read, with a reason in plain words", () => {
    expect(fileProblem({ type: "image/jpeg", size: 2_000_000, name: "a.jpg" })).toBeNull();
    expect(fileProblem({ type: "application/pdf", size: 1_000, name: "a.pdf" })).toBeNull();
    expect(fileProblem({ type: "image/heic", size: 1_000, name: "a.heic" })).toMatch(/HEIC/);
    expect(fileProblem({ type: "", size: 1_000, name: "IMG_1.HEIC" })).toMatch(/HEIC/);
    expect(fileProblem({ type: "application/zip", size: 1_000, name: "a.zip" })).toMatch(/photo/);
    expect(fileProblem({ type: "image/png", size: 80_000_000, name: "huge.png" })).toMatch(/too large/);
  });
  it("makes safe storage names", () => {
    expect(safeName("My Receipt (1).jpg")).toBe("My-Receipt-1-.jpg");
    expect(safeName("///")).toBe("receipt");
  });
  it("gives the same fingerprint for the same bytes and a different one otherwise", async () => {
    const a = await sha256Hex(new Blob(["same photo"])), b = await sha256Hex(new Blob(["same photo"])), c = await sha256Hex(new Blob(["other photo"]));
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a).toHaveLength(64);
  });
  it("labels every receipt state for the owner", () => {
    expect(receiptStatus({ status: "waiting_key", outcome: "", totals_ok: null }).text).toMatch(/key/);
    expect(receiptStatus({ status: "failed", outcome: "", totals_ok: null }).tone).toBe("bad");
    expect(receiptStatus({ status: "parsed", outcome: "linked", totals_ok: true }).text).toMatch(/Matched/);
    expect(receiptStatus({ status: "parsed", outcome: "created", totals_ok: false }).text).toMatch(/Check items/);
    expect(receiptStatus({ status: "parsed", outcome: "possible_duplicate", totals_ok: true }).tone).toBe("bad");
  });
});
