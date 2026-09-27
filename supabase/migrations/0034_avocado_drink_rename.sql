-- ============================================================================
-- 0034_avocado_drink_rename.sql : rename, real photo, rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($8).
-- Renamed from "Avocado Shake with Nuts" — the owner's new photo and
-- description don't have nuts, so the name dropped the nuts reference too.
-- ============================================================================

update products set
  name = 'Avocado Drink',
  name_ar = 'عصير أفوكادو',
  description = 'Creamy avocado blended with milk and white honey for a smooth, naturally sweet drink.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/avocado-drink.webp'
where slug = 'avocado-drink';
