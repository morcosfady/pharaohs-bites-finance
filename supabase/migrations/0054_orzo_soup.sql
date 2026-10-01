-- ============================================================================
-- 0054_orzo_soup.sql : add Egyptian Orzo Soup (menu change, 2026-09-30)
-- Mirrors assets/js/data.js on the customer website. Owner-supplied figures:
-- sells for $6, costs $2 to make.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'orzo-soup', 'Egyptian Orzo Soup', 'لسان العصفور', c.id,
       'Tender toasted orzo pasta simmered in a warm, savory broth, Egyptian comfort in every spoonful.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/orzo-soup.webp',
       6, 2, 'review'
from product_categories c where c.name = 'Soups'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;
