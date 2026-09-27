-- ============================================================================
-- 0033_honey_tahini_price_photo_desc.sql : price rise + real photos, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Owner raised Black
-- Honey, White Honey and Tahini from $2.49 to $5 each, and sent real
-- reference photos and new copy for all three.
-- ============================================================================

update products set
  selling_price = 5,
  description = 'Rich Egyptian sugarcane molasses with a deep, bold sweetness.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/black-honey.webp'
where slug = 'black-honey';

update products set
  selling_price = 5,
  description = 'Golden bee honey with a smooth, natural sweetness.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/white-honey.webp'
where slug = 'white-honey';

update products set
  selling_price = 5,
  description = 'Smooth, creamy sesame paste with a rich, nutty flavor.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/tahini.webp'
where slug = 'tahini';
