-- ============================================================================
-- 0020_meatballs_spaghetti_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($30).
-- The old description mentioned parmesan; dropped since the menu is
-- 100% plant-based and the owner's own description doesn't mention it.
-- ============================================================================

update products set
  description = 'Tender spaghetti tossed in a rich tomato sauce and topped with seasoned plant-based meatballs. Served in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/meatballs-spaghetti.webp'
where slug = 'meatballs-spaghetti';
