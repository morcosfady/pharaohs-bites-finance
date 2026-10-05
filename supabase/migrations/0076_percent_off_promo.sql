-- ============================================================================
-- 0076_percent_off_promo.sql : promo kind "percent_off" + code REBELLECREATIVE (2026-10-05)
-- percent_off = that % off the DISHES (delivery is charged as usual). Saved as the order's
-- discount, so the card payment is the reduced total.
-- first_order_only = the customer must have no earlier order (matched by phone or email).
-- REBELLECREATIVE: 50% off the dishes of a customer's first order, once per phone / email /
-- delivery address (same rules as the other codes), any distance.
-- ============================================================================
alter table promo_codes drop constraint if exists promo_codes_kind_check;
alter table promo_codes add constraint promo_codes_kind_check check (kind in ('free_delivery', 'free_order', 'percent_off'));
alter table promo_codes add column if not exists percent_off numeric check (percent_off is null or (percent_off > 0 and percent_off <= 100));
alter table promo_codes add column if not exists first_order_only boolean not null default false;

insert into promo_codes (code, kind, percent_off, first_order_only, single_use, max_miles, welcome_message)
values ('REBELLECREATIVE', 'percent_off', 50, true, false, null,
        '🎉 Welcome! 50% off your dishes is applied to your first order. Enjoy every bite! 💚')
on conflict (code) do update set kind = 'percent_off', percent_off = 50, first_order_only = true,
  single_use = false, max_miles = null, active = true, welcome_message = excluded.welcome_message;
