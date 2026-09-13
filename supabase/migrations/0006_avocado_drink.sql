-- ============================================================================
-- 0006_avocado_drink.sql : add the avocado shake (menu change, 2026-09-13)
-- Mirrors assets/js/data.js on the customer site. The owner's stated cost is
-- $3 per drink; it lives in other_direct_cost until a recipe is entered.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, other_direct_cost)
select 'avocado-drink', 'Avocado Shake with Nuts', 'عصير أفوكادو بالمكسرات', c.id,
       'Ripe avocado blended with cold milk until it''s thick and smooth, topped with crushed nuts.',
       'https://images.unsplash.com/photo-1693042442021-41423615ce89?auto=format&fit=crop&w=900&q=80',
       8, 'review', 3
from product_categories c where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

-- Crepes were removed from the customer menu on 2026-09-13. Deactivate rather
-- than delete so past orders and reports keep their product references.
update products set is_active = false
where slug in ('crepe-beef', 'crepe-nutella', 'crepe-pistachio');
