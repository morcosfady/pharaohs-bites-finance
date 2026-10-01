// Delivery address normalisation, used so "123 Main Street, Apt 4" and "123 main st #4" count as the
// same address (promo codes are once per address). The unit number is kept, so two different
// apartments in one building are different addresses.
const WORDS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct",
  circle: "cir", parkway: "pkwy", place: "pl", highway: "hwy", terrace: "ter", trail: "trl",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};
const UNIT_WORDS = new Set(["apt", "apartment", "unit", "suite", "ste", "no", "number"]);

function tokens(v: string): string[] {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

export function normAddress(street: string, apt: string, zip: string): string {
  const st = tokens(street).filter((w) => !UNIT_WORDS.has(w)).map((w) => WORDS[w] ?? w).join(" ");
  const unit = tokens(apt).filter((w) => !UNIT_WORDS.has(w)).join("");
  return `${st}|${unit}|${zip.replace(/\D/g, "").slice(0, 5)}`;
}
