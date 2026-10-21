// Delivery zones (supabase/functions/_shared/delivery.ts). The module reads Deno only inside
// quoteDelivery, so the pure pricing functions import cleanly under Node.
import { describe, expect, it } from "vitest";
import { BEYOND_PER_MILE_CENTS, DELIVERY_ZONES, feeCentsForMiles, publicDeliveryConfig, zoneIndexForMiles } from "../../supabase/functions/_shared/delivery";
import { PROMO_MAX_MILES } from "../../supabase/functions/_shared/promo";

describe("delivery zones", () => {
  it("has the agreed table and no maximum", () => {
    expect(DELIVERY_ZONES).toEqual([{ upToMiles: 5, feeCents: 500 }, { upToMiles: 10, feeCents: 800 }, { upToMiles: 15, feeCents: 1200 }]);
    expect(BEYOND_PER_MILE_CENTS).toBe(150);
  });
  it.each([
    [0, 500], [4.99, 500], [5, 500],
    [5.01, 800], [10, 800],
    [10.01, 1200], [15, 1200],
    [15.01, 1350], [15.2, 1350], [19.99, 1950], [20, 1950], [25.4, 2850], [30, 3450],
  ])("%s miles costs %s cents", (miles, fee) => {
    expect(feeCentsForMiles(miles)).toBe(fee);
  });
  it("counts every started mile beyond 15 (ceil)", () => {
    expect(feeCentsForMiles(16)).toBe(1350);
    expect(feeCentsForMiles(16.1)).toBe(1500);
    expect(feeCentsForMiles(100)).toBe(1200 + 85 * 150);
  });
  it("never goes below the first zone and ignores bad input", () => {
    expect(feeCentsForMiles(-3)).toBe(500);
    expect(feeCentsForMiles(NaN)).toBe(500);
  });
  it("reports the zone index for highlighting on the website", () => {
    expect(zoneIndexForMiles(2)).toBe(0);
    expect(zoneIndexForMiles(7.3)).toBe(1);
    expect(zoneIndexForMiles(15)).toBe(2);
    expect(zoneIndexForMiles(18)).toBe(3);
  });
  it("publishes the same table the server charges from (no second copy)", () => {
    const c = publicDeliveryConfig();
    expect(c.zones).toEqual([{ up_to_miles: 5, fee_cents: 500 }, { up_to_miles: 10, fee_cents: 800 }, { up_to_miles: 15, fee_cents: 1200 }]);
    expect(c.beyond_per_mile_cents).toBe(150);
  });
});

describe("FIRSTBITE with the zones", () => {
  // FIRSTBITE = free delivery within PROMO_MAX_MILES (promo_codes.max_miles = 10). Inside: fee 0 and so delivery tax 0.
  // Outside: checkPromo refuses the code, the normal zone fee applies.
  const feeWith = (miles: number, maxMiles: number) => (miles > maxMiles ? feeCentsForMiles(miles) : 0);
  it("inside 10 miles the fee is waived", () => {
    expect(feeWith(7.3, PROMO_MAX_MILES)).toBe(0);
    expect(feeWith(10, PROMO_MAX_MILES)).toBe(0);
  });
  it("at 10.5 miles the code is refused and the $12 zone is charged", () => {
    expect(feeWith(10.5, PROMO_MAX_MILES)).toBe(1200);
  });
});
