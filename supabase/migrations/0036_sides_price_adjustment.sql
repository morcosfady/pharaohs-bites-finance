-- ============================================================================
-- 0036_sides_price_adjustment.sql : rebalance side prices, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. The owner adjusted
-- these after comparing against a nearby Egyptian restaurant's pricing,
-- with white cheese set to $4 rather than the $3 that comparison suggested.
--   Egyptian White Cheese  $2.99 -> $4
--   Black Honey            $5    -> $3.50
--   White Honey            $5    -> $4
--   Tahini                 $5    -> $3
--   Baba Ganoush           $5    -> $4
--   Hummus                 $2    -> $3
-- ============================================================================

update products set selling_price = v.price
from (values
  ('white-cheese', 4.00),
  ('black-honey', 3.50),
  ('white-honey', 4.00),
  ('tahini', 3.00),
  ('baba-ganoush', 4.00),
  ('hummus', 3.00)
) as v(slug, price)
where products.slug = v.slug;
