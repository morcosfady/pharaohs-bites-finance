-- ============================================================================
-- 0031_baba_ganoush_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($5).
-- ============================================================================

update products set
  description = 'Smoky Egyptian baba ganoush made with roasted eggplant and tahini, served in a small cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/baba-ganoush.webp'
where slug = 'baba-ganoush';
