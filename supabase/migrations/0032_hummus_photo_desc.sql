-- ============================================================================
-- 0032_hummus_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($2).
-- ============================================================================

update products set
  description = 'Creamy hummus, a blend of chickpeas and tahini, served in a small cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/hummus.webp'
where slug = 'hummus';
