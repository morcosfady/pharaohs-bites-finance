-- ============================================================================
-- 0082_pharaohs_rolls.sql : add Pharaoh's Rolls (2 for $30) (menu change, 2026-11)
-- Mirrors assets/js/data.js on the customer website. Already applied to the live
-- database. Two flaky feteer rolls stuffed with plant-based ground beef, mixed
-- vegetables and mozzarella. tax_status 'taxable' like the stuffed feteer.
-- ingredient_cost is 0 until the owner types what the two rolls cost (Menu & Profit).
-- Allergen / Arabic-name / safe-handling lists live in supabase/functions/_shared/notify.ts.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, other_direct_cost)
select 'pharaohs-rolls', 'Pharaoh''s Rolls (2 for $30)', 'رول الفراعنة', c.id,
       'Two golden, flaky feteer rolls stuffed with seasoned plant-based ground beef, mixed vegetables and melted mozzarella, baked until the top turns crisp and bubbly. 2 rolls for $30.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/pharaohs-rolls.webp',
       30.00, 'taxable', 0, 0
from product_categories c where c.name = 'Feteer'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar, description = excluded.description,
  image_url = excluded.image_url, selling_price = excluded.selling_price, is_active = true, deleted_at = null;
