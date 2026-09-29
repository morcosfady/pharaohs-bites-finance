-- ============================================================================
-- 0038_diet_coke.sql : add Diet Coke 12 oz (menu change, 2026-09-29)
-- Mirrors assets/js/data.js on the customer website. Sells for $2.50; the
-- owner's cost is 63 cents per can, held in ingredient_cost (the "type what
-- it costs you" field) since a can has no recipe. tax_status stays 'review'
-- like the other items until the owner confirms how it is taxed.
-- Photo: "Diet-Coke-Can.jpg" by Evan-Amos, public domain (Wikimedia Commons).
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, other_direct_cost)
select 'diet-coke', 'Diet Coke 12 oz', 'دايت كوكاكولا', c.id,
       'Ice-cold Diet Coke, a classic 12 oz can. The perfect partner for feteer and trays.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/diet-coke.webp',
       2.50, 'review', 0.63, 0
from product_categories c where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, image_url = excluded.image_url,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  other_direct_cost = excluded.other_direct_cost, is_active = true, deleted_at = null;
