-- ============================================================================
-- 0069_mix90_promo.sql : one-time promo code MIX90 for the DJ "dadomix90" (2026-10-02)
-- Free delivery, ONE use in total: once any order with it is paid / confirmed, nobody
-- (not even the same person) can use it again. No distance limit, and a friendly message
-- shows on the order page when it is applied.
-- New promo_codes columns:
--   single_use       true -> the whole code works once, for anyone
--   max_miles        free-delivery distance cap (default 5 like FIRSTBITE); null = no cap
--   welcome_message  shown instead of the standard "applied" line
-- ============================================================================
alter table promo_codes add column if not exists single_use boolean not null default false;
alter table promo_codes add column if not exists max_miles numeric default 5;
alter table promo_codes add column if not exists welcome_message text;

-- Database-level guarantee: only one used redemption can ever exist for MIX90.
create unique index if not exists promo_used_once_mix90 on promo_redemptions(code) where used_at is not null and code = 'MIX90';

insert into promo_codes (code, kind, single_use, max_miles, welcome_message)
values ('MIX90', 'free_delivery', true, null,
        'Welcome, Mix90! 💛 Thank you for supporting Pharaoh''s Bites. Your delivery is on us. Enjoy every bite!')
on conflict (code) do update set single_use = true, max_miles = null, active = true,
  welcome_message = excluded.welcome_message;
