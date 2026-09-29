-- ============================================================================
-- 0039_goulash_beef_photo.sql : correct photo for the Goulash Tray with Plant-Based Beef, 2026-09-29
-- The owner supplied the right photo (tray with beef, olive and green pepper
-- filling). The image file was replaced on the customer website; the version
-- tag makes browsers fetch the new picture instead of the cached old one.
-- ============================================================================

update products set
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/goulash-beef.webp?v=2'
where slug = 'goulash-beef';
