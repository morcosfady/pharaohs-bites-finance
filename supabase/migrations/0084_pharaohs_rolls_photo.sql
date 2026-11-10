-- ============================================================================
-- 0084_pharaohs_rolls_photo.sql : Pharaoh's Rolls photo shown in full (square), new file name (2026-11)
-- Mirrors assets/js/data.js on the customer website. Already applied to the live database.
-- ============================================================================

update products set image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/pharaohs-rolls-full.webp'
 where slug = 'pharaohs-rolls';
