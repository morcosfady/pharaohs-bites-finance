// Delivery pricing: distance zones from the kitchen (owner can change the prices here, in ONE place).
//   0 to 5 mi $5 | over 5 to 10 mi $8 | over 10 to 15 mi $12 | beyond 15 mi: $12 + $1.50 per extra mile or part
// No maximum, no "free over $X". FIRSTBITE (free delivery within 10 miles) is handled by promo.ts.
// The website never keeps its own copy of this table: delivery-quote sends it (action "config").
// Miles = straight-line distance x 1.3 (approximate road distance). The address is looked up
// with the free US Census geocoder. Kitchen coordinates live in the KITCHEN_LAT / KITCHEN_LON
// secrets so the address is not in the public repo.
export const DELIVERY_ZONES: ReadonlyArray<{ upToMiles: number; feeCents: number }> = [
  { upToMiles: 5, feeCents: 500 },
  { upToMiles: 10, feeCents: 800 },
  { upToMiles: 15, feeCents: 1200 },
];
export const BEYOND_PER_MILE_CENTS = 150;
export const ROAD_FACTOR = 1.3;

/** Fee in cents for an estimated road distance. Pure, unit tested from src/test/delivery.test.ts. */
export function feeCentsForMiles(miles: number): number {
  const m = Math.max(0, Number(miles) || 0);
  for (const z of DELIVERY_ZONES) if (m <= z.upToMiles) return z.feeCents;
  const last = DELIVERY_ZONES[DELIVERY_ZONES.length - 1];
  // every started mile beyond the last zone counts (15.2 mi -> 1 extra mile); rounded to 1/1000 first so 15.1 - 15 is not 0.0999...
  const extra = Math.ceil(Math.round((m - last.upToMiles) * 1000) / 1000);
  return last.feeCents + extra * BEYOND_PER_MILE_CENTS;
}

/** 0-based zone index (DELIVERY_ZONES.length = beyond the last zone), for highlighting on the website */
export function zoneIndexForMiles(miles: number): number {
  const m = Math.max(0, Number(miles) || 0);
  const i = DELIVERY_ZONES.findIndex((z) => m <= z.upToMiles);
  return i < 0 ? DELIVERY_ZONES.length : i;
}

/** What the website is allowed to know (sent by delivery-quote so there is no second copy that can drift). */
export function publicDeliveryConfig() {
  return { zones: DELIVERY_ZONES.map((z) => ({ up_to_miles: z.upToMiles, fee_cents: z.feeCents })), beyond_per_mile_cents: BEYOND_PER_MILE_CENTS };
}

async function geocode(address: string): Promise<{ lat: number; lon: number } | null | "error"> {
  try {
    const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(address);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "error";
    const m = (await res.json())?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lon: m.coordinates.x } : null;
  } catch { return "error"; }
}

// Backup lookup (OpenStreetMap/Photon) for when the Census service is down or has no match.
async function geocodeBackup(address: string): Promise<{ lat: number; lon: number } | null | "error"> {
  try {
    const url = "https://photon.komoot.io/api/?limit=1&q=" + encodeURIComponent(address);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "PharaohsBites-delivery-quote/1.0 (fady.ashraaf@gmail.com)" } });
    if (!res.ok) return "error";
    const c = (await res.json())?.features?.[0]?.geometry?.coordinates;
    return c ? { lat: Number(c[1]), lon: Number(c[0]) } : null;
  } catch { return "error"; }
}

// Last resort: the middle of the customer's ZIP code, so a lookup outage never blocks an order.
async function geocodeZip(zip: string): Promise<{ lat: number; lon: number } | null | "error"> {
  try {
    const res = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(zip.slice(0, 5)), { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (!res.ok) return "error";
    const p = (await res.json())?.places?.[0];
    return p ? { lat: Number(p.latitude), lon: Number(p.longitude) } : null;
  } catch { return "error"; }
}

function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => d * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export type Quote = { ok: true; fee: number; feeCents: number; miles: number; zone: number } | { ok: false; status: number; error: string };

export async function quoteDelivery(street: string, city: string, state: string, zip: string): Promise<Quote> {
  // read through globalThis so the pure pricing functions above can be unit tested under Node (vitest)
  const env = (globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  const kLat = Number(env?.get("KITCHEN_LAT")), kLon = Number(env?.get("KITCHEN_LON"));
  if (!isFinite(kLat) || !isFinite(kLon) || !kLat || !kLon) return { ok: false, status: 503, error: "delivery pricing is not configured" };
  const address = `${street}, ${city}, ${state} ${zip}`;
  let where = await geocode(address);
  if (where === "error" || !where) {
    const backup = await geocodeBackup(address);
    if (backup) where = backup;
    else if (where === "error" || backup === "error") where = await geocodeBackup(`${street}, ${city}, ${state}`);
  }
  if (where === "error" || !where) {
    const z = await geocodeZip(zip);
    if (z) where = z;
  }
  if (where === "error") return { ok: false, status: 503, error: "could not check the delivery address, please try again" };
  if (!where) return { ok: false, status: 400, error: "we could not find that address, please check the street, city and ZIP" };
  const miles = Math.round(haversineMiles({ lat: kLat, lon: kLon }, where) * ROAD_FACTOR * 10) / 10;
  const feeCents = feeCentsForMiles(miles);
  return { ok: true, fee: feeCents / 100, feeCents, miles, zone: zoneIndexForMiles(miles) };
}
