/**
 * Money helpers. All arithmetic is done in integer cents to avoid
 * floating-point drift; the database stores numeric(12,2).
 */
export type Cents = number;

export function toCents(value: number | string | null | undefined): Cents {
  if (value == null || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function fromCents(c: Cents): number {
  return Math.round(c) / 100;
}

export function fmt(c: Cents, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const n = fromCents(c);
  const abs = Math.abs(n);
  const s = opts.compact && abs >= 10_000
    ? "$" + (abs / 1000).toFixed(1).replace(/\.0$/, "") + "k"
    : abs.toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (n < 0) return "-" + s;
  return opts.sign && n > 0 ? "+" + s : s;
}

/** Format a decimal dollar amount straight from the database. */
export function money(value: number | string | null | undefined): string {
  return fmt(toCents(value));
}

export function pct(ratio: number | null | undefined, digits = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return (ratio * 100).toFixed(digits) + "%";
}

/** Safe ratio: returns null when the denominator is zero. */
export function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/** Percentage change between two values (null when previous is 0). */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

/** Sum a list of cents values. */
export function sum(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Allocate a discount proportionally across lines (largest remainder so the
 * cents add up exactly).
 */
export function allocate(total: Cents, weights: Cents[]): Cents[] {
  const w = sum(weights);
  if (w === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((x) => (total * x) / w);
  const floors = raw.map(Math.floor);
  let remainder = total - sum(floors);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

/** Estimated sales tax on a taxable base at a rate (0.0825 = 8.25%). */
export function taxOn(taxableBase: Cents, rate: number): Cents {
  if (taxableBase <= 0 || rate <= 0) return 0;
  return Math.round(taxableBase * rate);
}
