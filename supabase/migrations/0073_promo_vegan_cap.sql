-- ============================================================================
-- 0073_promo_vegan_cap.sql : promo limits for SPARKLY_SVATZ (2026-10-03)
-- products.vegan marks the vegan dishes. A promo can now be limited to vegan items only
-- (vegan_only) and to a maximum order value (max_subtotal). SPARKLY_SVATZ: vegan items
-- only, up to $100 of food, one use in total.
-- ============================================================================
alter table products add column if not exists vegan boolean not null default false;
update products set vegan = true
 where slug in ('koshary', 'koshary-sauce', 'kofta-tray', 'meatballs-spaghetti', 'lentil-soup', 'orzo-soup', 'avocado-drink-almond');

alter table promo_codes add column if not exists vegan_only boolean not null default false;
alter table promo_codes add column if not exists max_subtotal numeric;

update promo_codes set vegan_only = true, max_subtotal = 100,
  welcome_message = '🌱 Surprise! Your vegan order is on us (up to $100), delivery included. Thank you for being our customer, enjoy every bite! 💚'
where code = 'SPARKLY_SVATZ';
