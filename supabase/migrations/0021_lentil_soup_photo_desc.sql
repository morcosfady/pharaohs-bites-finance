-- ============================================================================
-- 0021_lentil_soup_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- The old description promised bread on the side; dropped since bread isn't
-- a menu item and the owner's own description doesn't mention it.
-- ============================================================================

update products set
  description = 'Warm, velvety Egyptian creamy lentil soup, gently seasoned and served in a generous paper bowl.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/lentil-soup.webp'
where slug = 'lentil-soup';
