-- ============================================================================
-- 0014_feteer_beef_photo.sql : real photo for feteer with beef & mozzarella, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price and description
-- unchanged ($40) — only the stock photo is replaced with the owner's own
-- reference photo, hosted on the customer site.
-- ============================================================================

update products set
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-beef-mozzarella.webp'
where slug = 'feteer-beef';
