-- 0063: four new combos, a choices system for every "pick your own" combo, combo packaging.
-- Approved by the owner 2026-10-01. Pricing worked out in docs/COMBO-PRICING.md.
-- Packaging is a PLACEHOLDER of $0.50 per item in the combo (owner will replace it from receipts;
-- it is editable per product in the dashboard). ingredient_cost is the WORST CASE across the choices.
--
-- Pick Any 3 Puddings goes to full price ($15, no discount) because puddings alone cannot reach a 50% margin.

-- Which options a customer may choose for each choice slot of a combo. The create-order function checks the
-- customer's picks against this table, so a tampered browser cannot invent a choice.
create table if not exists combo_slots (
  combo_slug     text not null,
  slot_key       text not null,
  label          text not null,
  pick_count     int  not null check (pick_count between 1 and 12),
  distinct_items boolean not null default false,
  allowed        text[] not null,
  sort_order     int  not null default 0,
  primary key (combo_slug, slot_key)
);
alter table combo_slots enable row level security;

insert into combo_slots (combo_slug, slot_key, label, pick_count, distinct_items, allowed, sort_order) values
  ('pick-3-puddings',    'puddings', 'Puddings', 3, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 1),
  ('family-feast',       'main',     'Main',     1, false, array['macarona-bechamel','kofta-tray'], 1),
  ('family-feast',       'sides',    'Sides',    2, true,  array['white-cheese','black-honey','white-honey','tahini','baba-ganoush','hummus'], 2),
  ('family-feast',       'puddings', 'Puddings', 2, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 3),
  ('egyptian-breakfast', 'shake',    'Shake',    1, false, array['protein-shake','avocado-drink'], 1),
  ('meal-for-one',       'side',     'Side',     1, false, array['white-cheese','black-honey','white-honey','tahini','baba-ganoush','hummus'], 1),
  ('meal-for-one',       'pudding',  'Pudding',  1, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 2),
  ('party-tray',         'main',     'Main',     1, false, array['macarona-bechamel','kofta-tray'], 1),
  ('party-tray',         'puddings', 'Puddings', 4, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 2)
on conflict (combo_slug, slot_key) do update set label = excluded.label, pick_count = excluded.pick_count,
  distinct_items = excluded.distinct_items, allowed = excluded.allowed, sort_order = excluded.sort_order;

-- New combos
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, packaging_cost, tax_status)
select v.slug, v.name, v.name_ar, c.id, v.descr, v.img, v.price, v.cost, v.pkg, 'review'
from product_categories c,
(values
  ('egyptian-breakfast', 'Egyptian Breakfast', 'فطار مصري',
   'Feteer Meshaltet with Egyptian White Cheese, Black Honey and Tahini, plus a shake of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 39.50, 9.69, 2.50),
  ('family-feast', 'Family Feast', 'عزومة العيلة',
   'Feteer Meshaltet, plus one main (Macarona Béchamel or Kofta Tray), two sides and two puddings of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 69.00, 26.70, 3.00),
  ('meal-for-one', 'Meal for One', 'وجبة لفرد',
   'Feteer Meshaltet with one side and one pudding of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 30.50, 8.38, 1.50),
  ('party-tray', 'Party Tray', 'صينية الحفلة',
   'Feteer Meshaltet, one main (Macarona Béchamel or Kofta Tray), the full Sides Platter and four puddings of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 89.50, 35.48, 3.50)
) as v(slug, name, name_ar, descr, img, price, cost, pkg)
where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar, description = excluded.description,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost, packaging_cost = excluded.packaging_cost,
  is_active = true, deleted_at = null;

-- Existing combos: placeholder packaging, and Pick Any 3 Puddings at full price
update products set packaging_cost = 2.00 where slug = 'feteer-and-dip-trio';
update products set packaging_cost = 3.00 where slug = 'feteer-dip-trio';
update products set packaging_cost = 1.50, selling_price = 15 where slug = 'pick-3-puddings';
