-- ============================================================================
-- 0018_goulash_nuts_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($25).
-- ============================================================================

update products set
  description = 'Crisp, golden layers of sweet Egyptian goulash filled with mixed nuts and finished with a light syrup glaze. Cut into squares and served in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/goulash-nuts.webp'
where slug = 'goulash-nuts';
