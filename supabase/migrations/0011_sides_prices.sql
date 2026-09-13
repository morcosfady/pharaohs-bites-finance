-- ============================================================================
-- 0011_sides_prices.sql : owner's side-dish price revision, 2026-09-13
-- Mirrors assets/js/data.js on the customer site. The Edge Function charges
-- these prices, so they must match what the website displays.
-- ============================================================================

update products set selling_price = v.price
from (values
  ('white-cheese', 2.99), ('black-honey', 2.49), ('white-honey', 2.49), ('tahini', 2.49)
) as v(slug, price)
where products.slug = v.slug;
