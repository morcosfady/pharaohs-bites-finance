-- ============================================================================
-- 0023_round_cake_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($13).
-- The old description promised icing and a rotating flavor of the day;
-- dropped since the real photo and the owner's own description show a
-- plain, un-iced cake.
-- ============================================================================

update products set
  description = 'A small, freshly baked plain cake with a golden crust and soft, fluffy crumb.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/round-cake.webp'
where slug = 'round-cake';
