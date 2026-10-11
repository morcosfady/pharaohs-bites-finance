-- ============================================================================
-- 0079_flat_delivery_promo.sql : promo kind "flat_delivery" + code AHMAD (2026-10-11)
-- flat_delivery = delivery costs delivery_flat dollars, no matter how far (never more than the
-- normal fee, so a close address that would pay less keeps paying less).
-- AHMAD: delivery $10, one-time code (the first paid order uses it up), any distance.
-- ============================================================================
alter table promo_codes drop constraint if exists promo_codes_kind_check;
alter table promo_codes add constraint promo_codes_kind_check check (kind in ('free_delivery', 'free_order', 'percent_off', 'flat_delivery'));
alter table promo_codes add column if not exists delivery_flat numeric check (delivery_flat is null or delivery_flat >= 0);

insert into promo_codes (code, kind, delivery_flat, single_use, max_miles, label, welcome_message)
values ('AHMAD', 'flat_delivery', 10, true, null, 'Ahmad',
        '🎉 Code AHMAD applied: delivery is only $10, no matter how far. Enjoy! 💚')
on conflict (code) do update set kind = 'flat_delivery', delivery_flat = 10, single_use = true,
  max_miles = null, active = true, label = 'Ahmad', welcome_message = excluded.welcome_message;
