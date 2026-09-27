-- ============================================================================
-- 0030_creme_caramel_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($8).
-- ============================================================================

update products set
  description = 'Silky crème caramel custard topped with golden caramel sauce, served chilled in a small dessert cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/creme-caramel.webp'
where slug = 'creme-caramel';
