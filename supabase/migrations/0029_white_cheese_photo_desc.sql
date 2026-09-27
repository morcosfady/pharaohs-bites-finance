-- ============================================================================
-- 0029_white_cheese_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($2.99).
-- ============================================================================

update products set
  description = 'Homemade Egyptian white cheese.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/white-cheese.webp'
where slug = 'white-cheese';
