// Pick-your-choices combos: checks a customer's picks against the combo_slots table and
// turns them into the readable "options" line that follows the order everywhere
// (Telegram, receipt email, dashboard order detail). Pure functions, no Deno or network calls,
// so they are unit tested from src/test/combos.test.ts.

export type ComboSlot = { combo_slug: string; slot_key: string; label: string; pick_count: number; distinct_items: boolean; allowed: string[]; sort_order: number };
export type Choices = Record<string, string[]>;

export const MAX_OPTIONS_LEN = 400;

// Normalises the untrusted `choices` value from the browser. Returns null when the shape is wrong.
export function parseChoices(raw: unknown): Choices | null {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Choices = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,30}$/.test(k) || !Array.isArray(v) || v.length > 12) return null;
    if (!v.every((s) => typeof s === "string" && /^[a-z0-9-]{1,80}$/.test(s))) return null;
    out[k] = v as string[];
  }
  return out;
}

// slots: this combo's rows from combo_slots. names: product slug -> display name.
export function resolveChoices(slots: ComboSlot[], choices: Choices, names: Map<string, string>): { ok: true; options: string } | { ok: false; error: string } {
  const ordered = [...slots].sort((a, b) => a.sort_order - b.sort_order);
  for (const key of Object.keys(choices)) {
    if (!ordered.some((s) => s.slot_key === key)) return { ok: false, error: `unknown choice "${key}"` };
  }
  const parts: string[] = [];
  for (const s of ordered) {
    const picks = choices[s.slot_key] ?? [];
    if (picks.length !== s.pick_count) return { ok: false, error: `choose ${s.pick_count} for ${s.label}` };
    for (const p of picks) if (!s.allowed.includes(p)) return { ok: false, error: `${p} is not an option for ${s.label}` };
    if (s.distinct_items && new Set(picks).size !== picks.length) return { ok: false, error: `${s.label} must all be different` };
    const counts = new Map<string, number>();
    for (const p of picks) counts.set(p, (counts.get(p) ?? 0) + 1);
    const text = [...counts].map(([slug, n]) => `${names.get(slug) ?? slug}${n > 1 ? ` x${n}` : ""}`).join(", ");
    parts.push(`${s.label}: ${text}`);
  }
  const options = parts.join(" | ");
  if (options.length > MAX_OPTIONS_LEN) return { ok: false, error: "choices too long" };
  return { ok: true, options };
}
