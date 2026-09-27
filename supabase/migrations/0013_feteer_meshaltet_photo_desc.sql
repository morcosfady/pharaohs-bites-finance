-- ============================================================================
-- 0013_feteer_meshaltet_photo_desc.sql : real photo + updated copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price is unchanged ($25).
-- The old image was a stock photo that didn't look like real feteer
-- meshaltet; it's now the owner's own reference photo, hosted on the
-- customer site. The description also dropped "ghee" for "homemade butter"
-- to match the brand's wording rule.
-- ============================================================================

update products set
  description = 'Flaky, buttery, pull-apart layers. Paper-thin dough stretched by hand, folded again and again with homemade butter between every layer, then baked until the top shatters.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg'
where slug = 'feteer-meshaltet';
