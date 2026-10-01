-- ============================================================================
-- 0058_price_cost_update_and_combos.sql : menu price/cost rebalance, 2026-10-01
-- Mirrors assets/js/data.js on the customer website.
--
-- Price changes:
--   Macarona Béchamel Tray  $30   -> $35
--   Small Round Cake        $8    -> $10
--   Rice Pudding            $5.50 -> $6
--   Hummus                  $3    -> $4
-- (Special Chocolate Protein Shake, Egyptian Orzo Soup, Lentil Soup were
--  already correct — verified, not touched.)
--
-- Cost changes (ingredient_cost):
--   Om Ali                  none  -> $5.00
--   Rice Pudding            none  -> $2.50
--   Egyptian White Cheese   $3.00 -> $1.00
--   Baba Ganoush            none  -> $1.00 (est.)
--   Hummus                  none  -> $0.90 (est.)
--   Tahini                  none  -> $0.70 (est.)
--   Black Honey             none  -> $0.60 (est.)
--   White Honey             none  -> $1.20 (est.)
--
-- The five sides marked (est.) above are estimated ingredient costs, not
-- measured. The products table has no is-estimate flag to set, so this
-- comment is the record of which ones are estimates until a real column
-- exists for it.
--
-- New "Combos" category and products, with the same owner-estimated cost
-- caveat noted per item below.
-- ============================================================================

-- Price changes
update products set selling_price = v.price
from (values
  ('macarona-bechamel', 35.00),
  ('round-cake', 10.00),
  ('rice-pudding', 6.00),
  ('hummus', 4.00)
) as v(slug, price)
where products.slug = v.slug;

-- Cost changes
update products set ingredient_cost = v.cost
from (values
  ('om-ali', 5.00),
  ('rice-pudding', 2.50),
  ('white-cheese', 1.00),
  ('baba-ganoush', 1.00),   -- est.
  ('hummus', 0.90),         -- est.
  ('tahini', 0.70),         -- est.
  ('black-honey', 0.60),    -- est.
  ('white-honey', 1.20)     -- est.
) as v(slug, cost)
where products.slug = v.slug;

-- New category
insert into product_categories (name, sort_order) values ('Combos', 11)
on conflict (name) do nothing;

-- New combo products. Costs are the owner's estimates (sum of component
-- costs), not yet measured.
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'feteer-dip-trio', 'Feteer Dip Trio', 'ثلاثية الإضافات', c.id,
       'Black Honey, Egyptian White Cheese and Tahini together, at a bundled price.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/white-cheese.webp',
       10, 2.30, 'review'
from product_categories c where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'feteer-and-dip-trio', 'Feteer + Dip Trio', 'فطير مع ثلاثية الإضافات', c.id,
       'A whole Feteer Meshaltet with the Feteer Dip Trio — Black Honey, Egyptian White Cheese and Tahini — bundled together.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg',
       32, 6.69, 'review'
from product_categories c where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'pick-3-puddings', 'Pick Any 3 Puddings', 'اختر ٣ بودينج', c.id,
       'Any three: Banana Pudding, Chocolate Pudding, Crème Caramel Flan or Rice Pudding. Tell us which three when you order.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/chocolate-pudding.webp',
       14, 8.37, 'review'
from product_categories c where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;
