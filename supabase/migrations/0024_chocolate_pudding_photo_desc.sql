-- ============================================================================
-- 0024_chocolate_pudding_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- ============================================================================

update products set
  description = 'Smooth, rich chocolate pudding served chilled in a small dessert cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/chocolate-pudding.webp'
where slug = 'chocolate-pudding';
