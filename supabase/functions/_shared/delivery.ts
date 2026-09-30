// Delivery pricing: $5 + $1.75 per mile from the kitchen.
// Miles = straight-line distance x 1.3 (approximate road distance). The address is
// looked up with the free US Census geocoder. Kitchen coordinates live in the
// KITCHEN_LAT / KITCHEN_LON secrets so the address is not in the public repo.
export const FEE_BASE = 5;
export const FEE_PER_MILE = 1.75;
export const ROAD_FACTOR = 1.3;

async function geocode(address: string): Promise<{ lat: number; lon: number } | null | "error"> {
  try {
    const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(address);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "error";
    const m = (await res.json())?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lon: m.coordinates.x } : null;
  } catch { return "error"; }
}

function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => d * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export type Quote = { ok: true; fee: number; miles: number } | { ok: false; status: number; error: string };

export async function quoteDelivery(street: string, city: string, state: string, zip: string): Promise<Quote> {
  const kLat = Number(Deno.env.get("KITCHEN_LAT")), kLon = Number(Deno.env.get("KITCHEN_LON"));
  if (!isFinite(kLat) || !isFinite(kLon) || !kLat || !kLon) return { ok: false, status: 503, error: "delivery pricing is not configured" };
  const where = await geocode(`${street}, ${city}, ${state} ${zip}`);
  if (where === "error") return { ok: false, status: 503, error: "could not check the delivery address, please try again" };
  if (!where) return { ok: false, status: 400, error: "we could not find that address, please check the street, city and ZIP" };
  const miles = Math.round(haversineMiles({ lat: kLat, lon: kLon }, where) * ROAD_FACTOR * 10) / 10;
  const fee = Math.round((FEE_BASE + FEE_PER_MILE * miles) * 100) / 100;
  return { ok: true, fee, miles };
}
