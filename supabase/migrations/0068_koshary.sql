-- ============================================================================
-- 0068_koshary.sql : add Koshary Tray + its extra tomato sauce (menu change, 2026-10-02)
-- Mirrors assets/js/data.js on the customer website.
-- Koshary Tray: $25, half-size foil tray, vegan. Ingredients $9.40, foil tray + lid $1.30.
-- Extra Tomato Sauce: $1, sold only as an add-on to a Koshary Tray (the website offers it
-- in a prompt after Koshary is added, and create-order refuses it without a Koshary).
-- The sauce cost is not set yet (0): the owner can type it in on the Products page.
-- tax_status stays 'review' like the other items.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, packaging_cost, other_direct_cost)
select 'koshary', 'Koshary Tray', 'كشري', c.id,
       'Egypt''s favorite street food, made fresh at home. Layers of rice, lentils and macaroni topped with chickpeas, our rich tomato sauce, tangy garlic-vinegar sauce and golden crispy onions. 100% vegan. Half-size foil tray, feeds 6 to 8.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/koshary.webp',
       25.00, 'review', 9.40, 1.30, 0
from product_categories c where c.name = 'Feteer & Trays'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, image_url = excluded.image_url,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  packaging_cost = excluded.packaging_cost, other_direct_cost = excluded.other_direct_cost,
  is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, packaging_cost, other_direct_cost)
select 'koshary-sauce', 'Extra Tomato Sauce (for Koshary)', 'صلصة طماطم إضافية', c.id,
       'A cup of extra tomato sauce on the side for your Koshary Tray. Vegan.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/koshary-sauce.webp',
       1.00, 'review', 0, 0, 0
from product_categories c where c.name = 'Sides'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, image_url = excluded.image_url,
  selling_price = excluded.selling_price, is_active = true, deleted_at = null;
