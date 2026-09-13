-- ============================================================================
-- 0007_price_update.sql : owner's price revision, 2026-09-13
-- Mirrors assets/js/data.js on the customer site. The Edge Function charges
-- these prices, so they must match what the website displays.
-- Kofta and cake also received owner-stated flat costs (no recipe yet).
-- ============================================================================

update products set selling_price = v.price
from (values
  ('feteer-meshaltet', 25), ('feteer-beef', 40), ('macarona-bechamel', 30),
  ('goulash-beef', 35), ('meatballs-spaghetti', 30), ('kofta-tray', 40),
  ('goulash-nuts', 25), ('round-cake', 13), ('white-cheese', 5), ('protein-shake', 12)
) as v(slug, price)
where products.slug = v.slug;

update products set other_direct_cost = 13 where slug = 'kofta-tray'  and ingredient_cost = 0;
update products set other_direct_cost = 4  where slug = 'round-cake' and ingredient_cost = 0;
