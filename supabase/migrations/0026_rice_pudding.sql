-- ============================================================================
-- 0026_rice_pudding.sql : add Rice Pudding (menu change, 2026-09-27)
-- Mirrors assets/js/data.js on the customer website. Price set by the owner
-- to match the other puddings ($7). Cost not yet supplied, so tax_status
-- stays 'review' like the other not-yet-costed desserts.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'rice-pudding', 'Rice Pudding', 'رز باللبن', c.id,
       'Creamy Egyptian rice pudding with tender rice in a rich, milky base, served chilled in a small dessert cup.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/rice-pudding.webp',
       7, 'review'
from product_categories c where c.name = 'Pudding'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;
