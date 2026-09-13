-- ============================================================================
-- 0008_product_costs.sql : owner's per-unit ingredient costs, 2026-09-13
-- Flat costs worked out from the owner's raw-material prices and recipes.
-- They live in ingredient_cost (the "type what it costs you" field) until a
-- recipe is entered, at which point recalc_product_cost takes over.
-- The three flat costs previously parked in other_direct_cost move here too.
-- ============================================================================

update products set ingredient_cost = v.cost, other_direct_cost = 0
from (values
  ('feteer-meshaltet',    4.39), ('feteer-beef',        14.24), ('macarona-bechamel', 14.53),
  ('goulash-beef',       12.82), ('meatballs-spaghetti', 11.75), ('kofta-tray',        13.00),
  ('goulash-nuts',        5.63), ('chocolate-pudding',    2.79), ('banana-pudding',     2.79),
  ('creme-caramel',       2.79), ('round-cake',           4.00), ('white-cheese',       3.00),
  ('avocado-drink',       3.00)
) as v(slug, cost)
where products.slug = v.slug
  and not exists (select 1 from recipes r where r.product_id = products.id);
