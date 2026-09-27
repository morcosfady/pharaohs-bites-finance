-- ============================================================================
-- 0012_baba_ganoush_hummus.sql : add Baba Ganoush and Hummus (menu change, 2026-09-27)
-- Mirrors assets/js/data.js on the customer website. Prices set by the owner:
-- Baba Ganoush $5, Hummus $2. Cost not yet supplied, so tax_status stays
-- 'review' and cost fields stay at their defaults, same as the other
-- not-yet-costed sides.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'baba-ganoush', 'Baba Ganoush', 'بابا غنوج', c.id,
       'Smoky roasted eggplant, blended smooth with tahini, garlic and lemon.',
       'https://images.pexels.com/photos/14774982/pexels-photo-14774982.jpeg?auto=compress&cs=tinysrgb&w=900',
       5, 'review'
from product_categories c where c.name = 'Sides'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'hummus', 'Hummus', 'حمص', c.id,
       'Chickpeas blended smooth with tahini, lemon and garlic, finished with olive oil.',
       'https://images.pexels.com/photos/6327663/pexels-photo-6327663.jpeg?auto=compress&cs=tinysrgb&w=900',
       2, 'review'
from product_categories c where c.name = 'Sides'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;
