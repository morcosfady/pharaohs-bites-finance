-- Kitchen calendar: days the owner has switched off. The website greys them out in red
-- ("Fully booked") and create-order refuses orders for them.
-- The website reads only the day column (anon); the private reason stays admin-only.
create table if not exists closed_days (
  day        date primary key,
  reason     text not null default '',
  created_at timestamptz not null default now()
);
alter table closed_days enable row level security;
revoke all on closed_days from anon, authenticated;
grant select (day) on closed_days to anon;
grant select, insert, update, delete on closed_days to authenticated;
drop policy if exists closed_days_public_read on closed_days;
create policy closed_days_public_read on closed_days for select to anon using (true);
drop policy if exists closed_days_admin on closed_days;
create policy closed_days_admin on closed_days for all to authenticated using (is_admin()) with check (is_admin());
