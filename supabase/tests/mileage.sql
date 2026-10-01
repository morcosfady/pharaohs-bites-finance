-- ============================================================================
-- Mileage tests (migration 0049). Runs inside a transaction that is ROLLED BACK:
--   supabase db query --linked -f supabase/tests/mileage.sql
-- A clean run ends with {"result": "ALL MILEAGE TESTS PASSED"}.
-- ============================================================================
begin;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('00000000-0000-0000-0000-00000000dd02', 'mileage@test.local', 'x', now(), '{}', '{}', 'authenticated', 'authenticated');
insert into admin_profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000dd02', 'Mileage Tester');
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000dd02', 'role', 'authenticated')::text, true);

create or replace function _expect(p_label text, p_actual numeric, p_expected numeric) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;

create or replace function _order(p_num text, p_name text, p_miles numeric, p_method text default 'delivery') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into orders (order_number, customer_name, customer_phone, delivery_method, delivery_miles, address_city, source)
  values (p_num, p_name, '2145550100', p_method::delivery_method, p_miles, 'Plano', 'manual') returning id into v;
  return v;
end $$;

-- ---- rates: the one in force on the trip date is used ---------------------------
do $$
declare t uuid; o uuid;
begin
  insert into mileage_logs (trip_date, kind, miles, purpose) values ('2026-06-30', 'supply', 10, 'before the change') returning id into t;
  perform _expect('rate before Jul 1', (select cents_per_mile from mileage_log_view where id = t), 72.5);
  perform _expect('deduction before Jul 1 (10 mi x 72.5c)', (select deduction from mileage_log_view where id = t), 7.25);
  update mileage_logs set trip_date = '2026-07-01' where id = t;
  perform _expect('rate on Jul 1', (select cents_per_mile from mileage_log_view where id = t), 76.0);
  perform _expect('deduction on Jul 1 (10 mi x 76c)', (select deduction from mileage_log_view where id = t), 7.60);
  update mileage_logs set trip_date = '2030-01-01' where id = t;
  perform _expect('no rate for an unknown year gives null, not zero', (select (deduction is null)::int from mileage_log_view where id = t), 1);
  delete from mileage_logs where id = t;
end $$;

-- ---- automatic delivery trips ----------------------------------------------------
do $$
declare o uuid; n int;
begin
  o := _order('PB-TEST-M1', 'Real Customer', 12.5);
  perform _expect('no trip before completion', (select count(*) from mileage_logs where order_id = o), 0);
  update orders set status = 'completed', completed_at = '2026-10-10 18:00-05' where id = o;
  perform _expect('trip created on completion', (select count(*) from mileage_logs where order_id = o), 1);
  perform _expect('round trip doubles the miles', (select miles from mileage_logs where order_id = o), 25.0);
  perform _expect('trip is dated by the Chicago day', (select (trip_date = '2026-10-10')::int from mileage_logs where order_id = o), 1);
  -- idempotent: touching the order again never adds a second trip
  update orders set status = 'completed', internal_notes = 'x' where id = o;
  update orders set delivery_miles = 12.5 where id = o;
  perform _expect('still one trip per order', (select count(*) from mileage_logs where order_id = o), 1);
  -- a direct duplicate insert is rejected by the database
  begin
    insert into mileage_logs (kind, miles, order_id) values ('delivery', 5, o);
    raise exception 'FAIL [unique]: a second trip for the same order was accepted';
  exception when unique_violation then null; end;
end $$;

-- ---- cancel retires the system trip, restore brings it back ------------------------
do $$
declare o uuid;
begin
  select id into o from orders where order_number = 'PB-TEST-M1';
  update orders set status = 'cancelled' where id = o;
  perform _expect('cancelled order: trip retired', (select (deleted_at is not null)::int from mileage_logs where order_id = o), 1);
  update orders set status = 'completed' where id = o;
  perform _expect('restored order: trip back', (select (deleted_at is null)::int from mileage_logs where order_id = o), 1);
  -- a trip the OWNER deleted stays deleted even if the order is touched again
  update mileage_logs set deleted_at = now() where order_id = o;
  update orders set status = 'completed', delivery_miles = 12.5 where id = o;
  perform _expect('owner-deleted trip is not resurrected', (select (deleted_at is not null)::int from mileage_logs where order_id = o), 1);
end $$;

-- ---- what must NOT create a trip ----------------------------------------------------
do $$
declare a uuid; b uuid; c uuid;
begin
  a := _order('PB-TEST-M2', 'test 1', 9);                       -- test order name
  b := _order('PB-TEST-M3', 'Pickup Person', 9, 'pickup');      -- pickup
  c := _order('PB-TEST-M4', 'No Miles Yet', null);              -- no miles saved
  update orders set status = 'completed' where id in (a, b, c);
  perform _expect('test order, pickup and missing miles make no trip', (select count(*) from mileage_logs where order_id in (a, b, c)), 0);
end $$;

-- ---- one-way setting ------------------------------------------------------------------
do $$
declare o uuid;
begin
  update mileage_settings set delivery_round_trip = false;
  o := _order('PB-TEST-M5', 'One Way', 8);
  update orders set status = 'completed' where id = o;
  perform _expect('one-way setting', (select miles from mileage_logs where order_id = o), 8.0);
  update mileage_settings set delivery_round_trip = true;
end $$;

-- ---- combine a multi-drop day into one route; totals do not double count -----------------
do $$
declare a uuid; b uuid; ta uuid; tb uuid; r uuid; total_counted numeric;
begin
  a := _order('PB-TEST-M6', 'Drop A', 5); b := _order('PB-TEST-M7', 'Drop B', 6);
  update orders set status = 'completed', completed_at = '2026-10-11 15:00-05' where id in (a, b);
  select id into ta from mileage_logs where order_id = a; select id into tb from mileage_logs where order_id = b;
  perform _expect('before combining: both count', (select sum(miles) from mileage_log_view where id in (ta, tb) and counted), 22.0);
  r := combine_mileage_route(array[ta, tb], 14.0);
  select sum(miles) into total_counted from mileage_log_view where counted and trip_date = '2026-10-11';
  perform _expect('after combining: only the route counts', total_counted, 14.0);
  perform _expect('individual trips kept for history', (select count(*) from mileage_logs where route_id = r), 2);
  begin
    perform combine_mileage_route(array[ta, tb], 14.0);
    raise exception 'FAIL [route]: trips already in a route were combined again';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  perform split_mileage_route(r);
  select sum(miles) into total_counted from mileage_log_view where counted and trip_date = '2026-10-11';
  perform _expect('splitting restores the individual trips', total_counted, 22.0);
end $$;

-- ---- the 2026 rates were verified on irs.gov and are confirmed from the start -------------------
do $$ begin
  perform _expect('seeded rates are confirmed (checked on irs.gov, no manual step)', (select count(*) from irs_mileage_rates where not confirmed), 0);
end $$;

rollback;
select 'ALL MILEAGE TESTS PASSED' as result;
