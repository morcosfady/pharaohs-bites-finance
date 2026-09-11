-- ============================================================================
-- Database tests: RLS, intake, totals.
-- Run against a DEV project after migrations (never production):
--   psql "$DEV_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_and_calculations.sql
-- Every block raises if an expectation fails; a clean run prints "ALL TESTS PASSED".
-- ============================================================================
begin;

-- --- fixtures ------------------------------------------------------------------
-- two auth users: one admin, one plain authenticated user
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('00000000-0000-0000-0000-00000000aaaa', 'admin@test.local', 'x', now(), '{}', '{}', 'authenticated', 'authenticated'),
       ('00000000-0000-0000-0000-00000000bbbb', 'nobody@test.local', 'x', now(), '{}', '{}', 'authenticated', 'authenticated')
on conflict do nothing;
insert into admin_profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000aaaa', 'Test Admin') on conflict do nothing;

-- helper to impersonate a JWT the way PostgREST does
create or replace function _as(p_role text, p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end $$;

-- --- 1. anon sees nothing -------------------------------------------------------
do $$ declare n int; begin
  perform _as('anon', null);
  begin
    select count(*) into n from orders;
    raise exception 'FAIL: anon could select orders';
  exception when insufficient_privilege then null;   -- expected: no grant
  end;
  reset role;
end $$;

-- --- 2. authenticated non-admin sees nothing ------------------------------------
do $$ declare n int; begin
  perform _as('authenticated', '00000000-0000-0000-0000-00000000bbbb');
  select count(*) into n from orders;
  if n <> 0 then raise exception 'FAIL: non-admin saw % orders', n; end if;
  select count(*) into n from customers;
  if n <> 0 then raise exception 'FAIL: non-admin saw customers'; end if;
  begin
    insert into expenses (vendor, amount_before_tax) values ('hack', 1);
    raise exception 'FAIL: non-admin inserted an expense';
  exception when insufficient_privilege or check_violation then null;
  end;
  reset role;
end $$;

-- --- 3. intake creates an order with server-side prices ------------------------
do $$ declare v_num text; v_o orders%rowtype; v_price numeric; begin
  reset role;
  v_num := intake_website_order('tok_test_000000000001',
    '{"name":"Test Buyer","phone":"+1 214 555 0199","phone_digits":"12145550199","street":"1 Main","apt":"","city":"Dallas","state":"TX","zip":"75201","instructions":""}',
    '[{"slug":"feteer-meshaltet","quantity":2,"options":""},{"slug":"lentil-soup","quantity":1,"options":""}]');
  if v_num !~ '^PB-\d{4}-\d{5}$' then raise exception 'FAIL: bad order number %', v_num; end if;
  select * into v_o from orders where order_number = v_num;
  select selling_price into v_price from products where slug = 'feteer-meshaltet';
  if v_o.subtotal <> v_price * 2 + (select selling_price from products where slug = 'lentil-soup') then
    raise exception 'FAIL: subtotal % not computed from catalogue', v_o.subtotal;
  end if;
  if v_o.status <> 'pending_whatsapp_confirmation' then raise exception 'FAIL: wrong initial status'; end if;
  -- idempotent
  if intake_website_order('tok_test_000000000001', '{}', '[]') <> v_num then raise exception 'FAIL: duplicate token created new order'; end if;
  if (select count(*) from orders where checkout_token = 'tok_test_000000000001') <> 1 then raise exception 'FAIL: duplicate order rows'; end if;
end $$;

-- --- 4. unknown / inactive product rejected -------------------------------------
do $$ begin
  begin
    perform intake_website_order('tok_test_000000000002', '{"name":"x","phone":"1","phone_digits":"1","street":"s","city":"c","state":"TX","zip":"75201"}', '[{"slug":"does-not-exist","quantity":1}]');
    raise exception 'FAIL: unknown product accepted';
  exception when others then
    if sqlerrm not like 'PRODUCT_NOT_FOUND%' then raise; end if;
  end;
  update products set is_active = false where slug = 'tahini';
  begin
    perform intake_website_order('tok_test_000000000003', '{"name":"x","phone":"1","phone_digits":"1","street":"s","city":"c","state":"TX","zip":"75201"}', '[{"slug":"tahini","quantity":1}]');
    raise exception 'FAIL: inactive product accepted';
  exception when others then
    if sqlerrm not like 'PRODUCT_NOT_FOUND%' then raise; end if;
  end;
  update products set is_active = true where slug = 'tahini';
  if exists (select 1 from orders where checkout_token in ('tok_test_000000000002', 'tok_test_000000000003')) then
    raise exception 'FAIL: partial order written after rejection';
  end if;
end $$;

-- --- 5. admin can read, discount/tax/delivery/payments recompute ----------------
do $$ declare v_o orders%rowtype; v_id uuid; begin
  perform _as('authenticated', '00000000-0000-0000-0000-00000000aaaa');
  select id into v_id from orders where checkout_token = 'tok_test_000000000001';
  if v_id is null then raise exception 'FAIL: admin cannot see order'; end if;
  update order_items set is_taxable = true where order_id = v_id;
  update orders set discount = 5, delivery_fee = 8, tax_rate_applied = 0.0825 where id = v_id;
  select * into v_o from orders where id = v_id;
  -- subtotal 35, taxable 35, discount 5 -> taxable base 30 -> tax 2.48; total = 30 + 8 + 2.48
  if v_o.tax_amount <> 2.48 then raise exception 'FAIL: tax % expected 2.48', v_o.tax_amount; end if;
  if v_o.total <> 40.48 then raise exception 'FAIL: total % expected 40.48', v_o.total; end if;
  insert into payments (order_id, amount, method) values (v_id, 20, 'zelle');
  select * into v_o from orders where id = v_id;
  if v_o.payment_status <> 'partially_paid' or v_o.amount_paid <> 20 then raise exception 'FAIL: partial payment status %', v_o.payment_status; end if;
  insert into payments (order_id, amount, method) values (v_id, 20.48, 'venmo');
  select * into v_o from orders where id = v_id;
  if v_o.payment_status <> 'paid' then raise exception 'FAIL: paid status %', v_o.payment_status; end if;
  insert into refunds (order_id, amount, method) values (v_id, 10, 'zelle');
  select * into v_o from orders where id = v_id;
  if v_o.payment_status <> 'partially_refunded' then raise exception 'FAIL: refund status %', v_o.payment_status; end if;
  -- status history + audit written
  if (select count(*) from order_status_history where order_id = v_id) < 1 then raise exception 'FAIL: no status history'; end if;
  update orders set status = 'completed' where id = v_id;
  if (select count(*) from order_status_history where order_id = v_id and to_status = 'completed') <> 1 then raise exception 'FAIL: status change not logged'; end if;
  if (select count(*) from audit_logs where table_name = 'payments') < 2 then raise exception 'FAIL: audit log missing'; end if;
  -- admin cannot hard-delete a payment
  begin
    delete from payments where order_id = v_id;
    if (select count(*) from payments where order_id = v_id) <> 2 then raise exception 'FAIL: admin hard-deleted payments'; end if;
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- --- 6. financial view excludes tax from revenue ----------------------------------
do $$ declare r record; begin
  perform _as('authenticated', '00000000-0000-0000-0000-00000000aaaa');
  select * into r from order_financials where order_number = (select order_number from orders where checkout_token = 'tok_test_000000000001');
  if r.net_product_sales <> 30 then raise exception 'FAIL: net product sales %', r.net_product_sales; end if;
  if r.delivery_revenue <> 8 then raise exception 'FAIL: delivery revenue %', r.delivery_revenue; end if;
  if r.balance_due <> r.total - r.amount_paid + r.amount_refunded then raise exception 'FAIL: balance'; end if;
  reset role;
end $$;

-- --- 7. order numbers are sequential and unique under concurrency (simulated) -----
do $$ declare a text; b text; begin
  reset role;
  a := next_order_number(); b := next_order_number();
  if a = b then raise exception 'FAIL: duplicate order number'; end if;
  if substring(b from '\d{5}$')::int <> substring(a from '\d{5}$')::int + 1 then raise exception 'FAIL: not sequential % %', a, b; end if;
end $$;

do $$ begin raise notice 'ALL TESTS PASSED'; end $$;
rollback;
