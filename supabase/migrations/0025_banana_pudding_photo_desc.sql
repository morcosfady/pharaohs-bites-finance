-- ============================================================================
-- 0025_banana_pudding_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- The old description described a layered trifle with biscuit; dropped
-- since the real photo shows a smooth, uniform pudding.
-- ============================================================================

update products set
  description = 'Smooth, creamy banana pudding served chilled in a small dessert cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/banana-pudding.webp'
where slug = 'banana-pudding';
