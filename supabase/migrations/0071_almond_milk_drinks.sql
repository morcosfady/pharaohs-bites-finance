-- ============================================================================
-- 0071_almond_milk_drinks.sql : almond-milk versions of the two drinks (2026-10-02)
-- The website asks "whole milk or almond milk?" when a customer adds a drink; almond
-- adds $1. Each is its own product so price, cost and sales are tracked separately.
-- Avocado Drink (Almond Milk): made with no honey, so it is vegan.
-- Ingredient cost $3.50 each ($0.50 more than the whole-milk version).
-- ============================================================================
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, packaging_cost, other_direct_cost)
select v.slug, v.name, v.name_ar, c.id, v.description, v.image_url, v.price, 'review', 3.50, 0, 0
from product_categories c,
(values
  ('avocado-drink-almond', 'Avocado Drink (Almond Milk)', 'عصير أفوكادو بحليب اللوز',
   'Creamy avocado blended with almond milk, no honey. 100% vegan.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/avocado-drink.webp', 9.00),
  ('protein-shake-almond', 'Special Chocolate Protein Shake (Almond Milk)', 'مشروب البروتين بالشوكولاتة بحليب اللوز',
   'A rich, creamy chocolate 22g protein shake blended smooth with almond milk and served chilled.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/protein-shake.webp', 10.00)
) as v(slug, name, name_ar, description, image_url, price)
where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, image_url = excluded.image_url,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  is_active = true, deleted_at = null;
