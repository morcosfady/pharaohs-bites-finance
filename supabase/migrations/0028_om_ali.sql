-- ============================================================================
-- 0028_om_ali.sql : add Om Ali (menu change, 2026-09-27)
-- Mirrors assets/js/data.js on the customer website. Price set by the owner
-- to match the other tray desserts ($25). Cost not yet supplied, so
-- tax_status stays 'review' like the other not-yet-costed desserts.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'om-ali', 'Om Ali', 'أم علي', c.id,
       'Warm Egyptian Om Ali with flaky pastry baked in sweet, creamy milk, finished with a golden top and mixed nuts. Served in a half-size foil tray.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/om-ali.webp',
       25, 'review'
from product_categories c where c.name = 'Desserts'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;
