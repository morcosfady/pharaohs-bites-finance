-- ============================================================================
-- 0017_goulash_beef_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($35).
-- ============================================================================

update products set
  description = 'Crisp, golden layers of Egyptian goulash filled with seasoned plant-based ground beef, green peppers, onions, and olives. Cut into squares and served in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/goulash-beef.webp'
where slug = 'goulash-beef';
