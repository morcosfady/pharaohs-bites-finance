-- ============================================================================
-- 0049_mileage.sql : Expenses rebuild, phase 3 (mileage).
--
--  * orders.delivery_miles : miles of the delivery quote, saved at order time
--  * mileage_logs          : one row per trip. Delivery trips are created
--                            automatically when an order is completed
--                            (unique per order, so never twice).
--  * irs_mileage_rates     : official rate by DATE RANGE (the 2026 rate changed
--                            on July 1). Rows start unconfirmed; the owner confirms.
--  * mileage_places        : saved supply-run destinations (one-tap trips)
--  * mileage_settings      : standard vs actual method, round trip, vehicle
--  * mileage_log_view      : each trip priced with the rate in force on its date
--
-- Mileage is a tax DEDUCTION, not money spent, so it never enters `expenses`
-- totals. It is reported next to them (Overview, Tax Pack).
-- ============================================================================

alter table orders add column if not exists delivery_miles numeric(8,1);

create table if not exists mileage_settings (
  id                   boolean primary key default true check (id),
  method               text not null default 'standard' check (method in ('standard', 'actual')),
  method_confirmed     boolean not null default false,       -- owner/accountant confirmed the choice
  delivery_round_trip  boolean not null default true,        -- a delivery counts there AND back
  vehicle              text not null default 'Personal vehicle',
  updated_at           timestamptz not null default now()
);
insert into mileage_settings (id) values (true) on conflict do nothing;

create table if not exists irs_mileage_rates (
  id              uuid primary key default gen_random_uuid(),
  effective_from  date not null unique,
  effective_to    date not null,
  cents_per_mile  numeric(5,1) not null check (cents_per_mile > 0),
  confirmed       boolean not null default false,
  source          text not null default 'IRS Notice 2026-10 and its July 2026 update (irs.gov/tax-professionals/standard-mileage-rates)',
  check (effective_to >= effective_from)
);
-- 2026: 72.5 cents Jan 1 - Jun 30, raised to 76 cents Jul 1 - Dec 31 (checked on irs.gov 2026-10-01).
insert into irs_mileage_rates (effective_from, effective_to, cents_per_mile) values
  ('2026-01-01', '2026-06-30', 72.5),
  ('2026-07-01', '2026-12-31', 76.0)
on conflict do nothing;

create table if not exists mileage_places (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  address         text not null default '',
  one_way_miles   numeric(8,1) not null check (one_way_miles > 0),
  created_at      timestamptz not null default now()
);

create table if not exists mileage_logs (
  id                 uuid primary key default gen_random_uuid(),
  trip_date          date not null default current_date,
  kind               text not null default 'other' check (kind in ('delivery', 'supply', 'other')),
  purpose            text not null default '',
  from_label         text not null default '',
  to_label           text not null default '',
  miles              numeric(8,1) not null check (miles > 0),
  order_id           uuid references orders(id),
  vehicle            text not null default '',
  notes              text not null default '',
  estimated          boolean not null default false,   -- miles come from the fee formula, not an odometer
  auto               boolean not null default false,   -- created by the system
  route_id           uuid references mileage_logs(id), -- set on trips folded into a combined route
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by_system  boolean not null default false
);
-- one trip per order, EVEN IF it was deleted: a deleted delivery trip never comes back by itself
create unique index if not exists mileage_logs_order_uniq on mileage_logs (order_id) where order_id is not null;
create index if not exists mileage_logs_date_idx on mileage_logs (trip_date desc);
create trigger mileage_logs_updated before update on mileage_logs for each row execute function set_updated_at();
create trigger mileage_logs_audit after insert or update or delete on mileage_logs for each row execute function audit_row();

alter table mileage_settings  enable row level security;
alter table irs_mileage_rates enable row level security;
alter table mileage_places    enable row level security;
alter table mileage_logs      enable row level security;
drop policy if exists mileage_settings_rw on mileage_settings;
drop policy if exists irs_mileage_rates_rw on irs_mileage_rates;
drop policy if exists mileage_places_rw on mileage_places;
drop policy if exists mileage_logs_select on mileage_logs;
drop policy if exists mileage_logs_insert on mileage_logs;
drop policy if exists mileage_logs_update on mileage_logs;
create policy mileage_settings_rw  on mileage_settings  for all to authenticated using (is_admin()) with check (is_admin());
create policy irs_mileage_rates_rw on irs_mileage_rates for all to authenticated using (is_admin()) with check (is_admin());
create policy mileage_places_rw    on mileage_places    for all to authenticated using (is_admin()) with check (is_admin());
create policy mileage_logs_select  on mileage_logs for select to authenticated using (is_admin());
create policy mileage_logs_insert  on mileage_logs for insert to authenticated with check (is_admin());
create policy mileage_logs_update  on mileage_logs for update to authenticated using (is_admin()) with check (is_admin());
-- no delete policy: trips are soft-deleted (deleted_at)

-- ------------------------------------------------------------------ priced view
-- counted = a real, live trip that is not folded into a combined route.
create or replace view mileage_log_view with (security_invoker = true) as
select l.*,
       r.cents_per_mile,
       r.confirmed as rate_confirmed,
       case when r.cents_per_mile is null then null else round(l.miles * r.cents_per_mile) / 100 end as deduction,
       (l.deleted_at is null and l.route_id is null) as counted
  from mileage_logs l
  left join irs_mileage_rates r on l.trip_date between r.effective_from and r.effective_to;

-- ------------------------------------------------------------------ automatic delivery trips
create or replace function sync_delivery_mileage(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; s mileage_settings%rowtype; v_miles numeric; v_day date;
begin
  select * into o from orders where id = p_order_id;
  if not found then return; end if;
  select * into s from mileage_settings limit 1;

  -- a cancelled / refunded / deleted order has no trip; the system retires its own entry
  if o.status in ('cancelled', 'refunded') or o.deleted_at is not null or is_test_order_name(o.customer_name) then
    update mileage_logs set deleted_at = now(), deleted_by_system = true
     where order_id = p_order_id and auto and deleted_at is null;
    return;
  end if;

  if o.status <> 'completed' or o.delivery_method <> 'delivery' or coalesce(o.delivery_miles, 0) <= 0 then return; end if;

  v_miles := round(o.delivery_miles * case when s.delivery_round_trip then 2 else 1 end, 1);
  v_day := (coalesce(o.completed_at, now()) at time zone 'America/Chicago')::date;

  insert into mileage_logs (trip_date, kind, purpose, from_label, to_label, miles, order_id, vehicle, notes, estimated, auto)
  values (v_day, 'delivery', 'Delivery ' || o.order_number, 'Kitchen',
          coalesce(nullif(o.address_city, ''), 'Customer') || ' (order ' || o.order_number || ')',
          v_miles, p_order_id, s.vehicle,
          case when s.delivery_round_trip then 'Round trip. ' else '' end ||
          'Miles come from the delivery quote (straight line x 1.3), not an odometer. Ask accountant if an estimate is acceptable.',
          true, true)
  on conflict (order_id) where order_id is not null do nothing;

  -- the order was cancelled earlier, then restored: bring back the entry the SYSTEM retired
  update mileage_logs set deleted_at = null, deleted_by_system = false
   where order_id = p_order_id and auto and deleted_by_system;
end $$;
revoke all on function sync_delivery_mileage(uuid) from public, anon, authenticated;

create or replace function orders_mileage_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin perform sync_delivery_mileage(new.id); return new; end $$;
drop trigger if exists orders_mileage on orders;
create trigger orders_mileage after insert or update of status, delivery_miles, delivery_method, deleted_at on orders
  for each row execute function orders_mileage_trigger();

-- ------------------------------------------------------------------ combine several drops into one route
-- Several deliveries driven in one outing are not additive: the owner enters the
-- real total for the route; the individual trips stay (history) but stop counting.
create or replace function combine_mileage_route(p_trip_ids uuid[], p_total_miles numeric, p_purpose text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_day date; v_n int; v_veh text;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  if p_total_miles is null or p_total_miles <= 0 then raise exception 'route miles must be above zero'; end if;
  select count(*), min(trip_date), min(vehicle) into v_n, v_day, v_veh from mileage_logs
   where id = any(p_trip_ids) and deleted_at is null and route_id is null and kind = 'delivery';
  if v_n < 2 then raise exception 'pick at least two delivery trips that are not already in a route'; end if;
  if (select count(distinct trip_date) from mileage_logs where id = any(p_trip_ids)) > 1 then raise exception 'a route is one day: pick trips from the same day'; end if;
  insert into mileage_logs (trip_date, kind, purpose, from_label, to_label, miles, vehicle, notes)
  values (v_day, 'delivery', coalesce(nullif(p_purpose, ''), 'Delivery route (' || v_n || ' orders)'), 'Kitchen', 'Several customers', round(p_total_miles, 1), v_veh,
          'Combined route. Miles entered by the owner.')
  returning id into v_id;
  update mileage_logs set route_id = v_id where id = any(p_trip_ids) and deleted_at is null and route_id is null and kind = 'delivery';
  return v_id;
end $$;
grant execute on function combine_mileage_route(uuid[], numeric, text) to authenticated;

create or replace function split_mileage_route(p_route_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  update mileage_logs set route_id = null where route_id = p_route_id;
  update mileage_logs set deleted_at = now() where id = p_route_id and deleted_at is null;
end $$;
grant execute on function split_mileage_route(uuid) to authenticated;
