-- ============================================================================
-- 0016_macarona_bechamel_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($30).
-- ============================================================================

update products set
  description = 'Tender penne layered with savory plant-based beef and creamy béchamel, baked until golden and served in hearty squares. Comes in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/macarona-bechamel.webp'
where slug = 'macarona-bechamel';
