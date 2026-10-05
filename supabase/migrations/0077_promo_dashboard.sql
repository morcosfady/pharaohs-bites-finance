-- ============================================================================
-- 0077_promo_dashboard.sql : promo codes managed from the dashboard "Promos" tab (2026-10-05)
-- * promo_codes gets a name (label), notes, a start date, an expiry date and a total-uses
--   limit (max_uses). The website refuses a code before it starts, after it expires, and once
--   it has been used max_uses times (checkPromo in _shared/promo.ts).
-- * The signed-in admin can READ promo_codes + promo_redemptions and CREATE / UPDATE codes
--   (never delete: a code is paused instead, so its history stays). The website and the
--   Edge Functions keep using the service role.
-- ============================================================================
alter table promo_codes add column if not exists label       text not null default '';
alter table promo_codes add column if not exists notes       text not null default '';
alter table promo_codes add column if not exists starts_at   timestamptz;
alter table promo_codes add column if not exists expires_at  timestamptz;
alter table promo_codes add column if not exists max_uses    integer check (max_uses is null or max_uses > 0);
alter table promo_codes add column if not exists created_at  timestamptz not null default now();

update promo_codes set label = 'Welcome code' where code = 'FIRSTBITE' and label = '';
update promo_codes set label = 'Rebelle Creative' where code = 'REBELLECREATIVE' and label = '';

revoke all on promo_codes, promo_redemptions from anon, authenticated;
grant select, insert, update on promo_codes to authenticated;
grant select on promo_redemptions to authenticated;
drop policy if exists promo_codes_admin_read   on promo_codes;
drop policy if exists promo_codes_admin_insert on promo_codes;
drop policy if exists promo_codes_admin_update on promo_codes;
drop policy if exists promo_redemptions_admin_read on promo_redemptions;
create policy promo_codes_admin_read   on promo_codes for select to authenticated using (is_admin());
create policy promo_codes_admin_insert on promo_codes for insert to authenticated with check (is_admin());
create policy promo_codes_admin_update on promo_codes for update to authenticated using (is_admin()) with check (is_admin());
create policy promo_redemptions_admin_read on promo_redemptions for select to authenticated using (is_admin());
