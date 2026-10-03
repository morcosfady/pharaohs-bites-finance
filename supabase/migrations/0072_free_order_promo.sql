-- ============================================================================
-- 0072_free_order_promo.sql : promo kind "free_order" + one-time code SPARKLY_SVATZ (2026-10-03)
-- free_order = the WHOLE order is free (food, delivery, tax): the order is saved with a
-- discount equal to its subtotal and no delivery fee, so its total is $0, it is confirmed
-- straight away (no card step) and the kitchen is alerted as usual.
-- SPARKLY_SVATZ works once in total (database-enforced), anywhere in the service area.
-- ============================================================================
alter table promo_codes drop constraint if exists promo_codes_kind_check;
alter table promo_codes add constraint promo_codes_kind_check check (kind in ('free_delivery', 'free_order'));

create unique index if not exists promo_used_once_sparkly on promo_redemptions(code) where used_at is not null and code = 'SPARKLY_SVATZ';

insert into promo_codes (code, kind, single_use, max_miles, welcome_message)
values ('SPARKLY_SVATZ', 'free_order', true, null,
        '🎉 Surprise! Your whole order is on us, food and delivery. Thank you for being our customer, enjoy every bite! 💚')
on conflict (code) do update set kind = 'free_order', single_use = true, max_miles = null, active = true,
  welcome_message = excluded.welcome_message;
