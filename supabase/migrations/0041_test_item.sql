-- ============================================================================
-- 0041_test_item.sql : TEMPORARY 1-cent test drink for checking live payments.
-- Remove it afterwards with 0042 (sets is_active = false, deleted_at = now()).
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, other_direct_cost)
select 'test-item', 'TEST ITEM (1 cent)', 'تجربة', c.id,
       'Temporary test item for checking payments. Not a real dish.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/diet-coke.webp',
       0.01, 'review', 0, 0
from product_categories c where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, selling_price = excluded.selling_price,
  is_active = true, deleted_at = null;
