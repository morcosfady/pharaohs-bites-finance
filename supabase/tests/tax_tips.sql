-- ============================================================================
-- Sales tax, delivery zones and tips: database tests (migration 0080).
-- Safe on the live database: everything runs inside one transaction that is ROLLED BACK.
--   supabase db query --linked -f supabase/tests/tax_tips.sql
-- Every block raises if an expectation fails; a clean run ends with "ALL TAX/TIP TESTS PASSED".
-- ============================================================================
begin;

-- --- 1. the formula --------------------------------------------------------------
do $$ declare r record; begin
  -- all taxable: $35 at 8.25% = 288.75 -> 289 (half-up)
  select * into r from calc_order_tax(3500, 3500, 0, 0, 0.0825, 'proportional', true);
  if r.item_tax_cents <> 289 or r.delivery_tax_cents <> 0 or r.net_taxable_cents <> 3500 then raise exception 'FAIL 1a: %', r; end if;
  -- all exempt
  select * into r from calc_order_tax(2500, 0, 0, 800, 0.0825, 'proportional', true);
  if r.item_tax_cents <> 0 or r.delivery_tax_cents <> 0 then raise exception 'FAIL 1b: %', r; end if;
  -- mixed $25 exempt + $35 taxable, delivery $8 proportional: 8 * .0825 * 35/60 = 0.385 -> 39
  select * into r from calc_order_tax(6000, 3500, 0, 800, 0.0825, 'proportional', true);
  if r.item_tax_cents <> 289 or r.delivery_tax_cents <> 39 then raise exception 'FAIL 1c: %', r; end if;
  -- same, mode all: 8 * .0825 = 0.66
  select * into r from calc_order_tax(6000, 3500, 0, 800, 0.0825, 'all', true);
  if r.delivery_tax_cents <> 66 then raise exception 'FAIL 1d: %', r; end if;
  -- same, mode none
  select * into r from calc_order_tax(6000, 3500, 0, 800, 0.0825, 'none', true);
  if r.delivery_tax_cents <> 0 or r.item_tax_cents <> 289 then raise exception 'FAIL 1e: %', r; end if;
  -- FIRSTBITE: free delivery -> no delivery tax
  select * into r from calc_order_tax(6000, 3500, 0, 0, 0.0825, 'all', true);
  if r.delivery_tax_cents <> 0 then raise exception 'FAIL 1f: %', r; end if;
  -- rounding exactly at .005: $10.00 * 8.25% = 82.5 -> 83
  select * into r from calc_order_tax(1000, 1000, 0, 0, 0.0825, 'proportional', true);
  if r.item_tax_cents <> 83 then raise exception 'FAIL 1g: %', r; end if;
  -- tax switched off
  select * into r from calc_order_tax(3500, 3500, 0, 800, 0.0825, 'proportional', false);
  if r.item_tax_cents <> 0 or r.delivery_tax_cents <> 0 then raise exception 'FAIL 1h: %', r; end if;
  -- 50% off the dishes: taxable share of the discount comes off first (35 - 17.50 = 17.50 -> 1.44)
  select * into r from calc_order_tax(6000, 3500, 3000, 800, 0.0825, 'proportional', true);
  if r.net_taxable_cents <> 1750 or r.item_tax_cents <> 144 then raise exception 'FAIL 1i: %', r; end if;
  -- div_half_up
  if div_half_up(5, 10) <> 1 or div_half_up(4, 10) <> 0 or div_half_up(15, 10) <> 2 then raise exception 'FAIL 1j'; end if;
end $$;

-- --- 2. an order through the real intake path adds up ---------------------------
do $$ declare v_num text; v_o orders%rowtype; v_sum_lines int; v_fm numeric; v_fb numeric; begin
  update tax_settings set tax_enabled = true, tax_delivery_mode = 'proportional', default_tax_rate = 0.0825 where id = 1;
  select selling_price into v_fm from products where slug = 'feteer-meshaltet';
  select selling_price into v_fb from products where slug = 'feteer-beef';
  v_num := intake_website_order('tok_tax_test_000000001',
    '{"name":"Tax Tester","phone":"+1 214 555 0100","phone_digits":"12145550100","street":"1 Test St","apt":"","city":"Dallas","state":"TX","zip":"75201","instructions":""}',
    '[{"slug":"feteer-meshaltet","quantity":1,"options":""},{"slug":"feteer-beef","quantity":1,"options":""}]');
  select * into v_o from orders where order_number = v_num;
  -- delivery $8 (zone 2) and a 15% tip on the dishes, set the way create-order does
  update orders set delivery_fee = 8, tip_cents = round((v_fm + v_fb) * 100 * 15 / 100)::int, tip_percent = 15, tip_type = 'percent' where id = v_o.id;
  select * into v_o from orders where id = v_o.id;
  if v_o.subtotal <> v_fm + v_fb then raise exception 'FAIL 2a: subtotal %', v_o.subtotal; end if;
  -- feteer meshaltet is exempt, feteer beef taxable
  if v_o.taxable_subtotal_cents <> round(v_fb * 100) then raise exception 'FAIL 2b: taxable %', v_o.taxable_subtotal_cents; end if;
  if v_o.item_tax_cents <> div_half_up(round(v_fb * 100)::bigint * 825, 10000) then raise exception 'FAIL 2c: item tax %', v_o.item_tax_cents; end if;
  if v_o.delivery_tax_cents <> div_half_up(800 * 825 * round(v_fb * 100)::bigint, 10000 * round((v_fm + v_fb) * 100)::bigint) then raise exception 'FAIL 2d: delivery tax %', v_o.delivery_tax_cents; end if;
  if v_o.tax_cents <> v_o.item_tax_cents + v_o.delivery_tax_cents then raise exception 'FAIL 2e'; end if;
  if v_o.tax_amount <> v_o.tax_cents / 100.0 then raise exception 'FAIL 2f: tax_amount % vs %', v_o.tax_amount, v_o.tax_cents; end if;
  if v_o.tax_rate_applied <> 0.0825 then raise exception 'FAIL 2g: rate %', v_o.tax_rate_applied; end if;
  -- total = subtotal + delivery + tax + tip
  if v_o.total <> v_o.subtotal - v_o.discount + v_o.delivery_fee + v_o.tax_amount + v_o.tip_cents / 100.0 then raise exception 'FAIL 2h: total %', v_o.total; end if;
  -- per-line snapshot: statuses copied, line taxes add up to the item tax
  select coalesce(sum(tax_cents), 0) into v_sum_lines from order_items where order_id = v_o.id;
  if v_sum_lines <> v_o.item_tax_cents then raise exception 'FAIL 2i: lines % vs %', v_sum_lines, v_o.item_tax_cents; end if;
  if (select tax_status from order_items where order_id = v_o.id and product_id = (select id from products where slug = 'feteer-meshaltet')) <> 'exempt' then raise exception 'FAIL 2j'; end if;
  if (select tax_cents from order_items where order_id = v_o.id and product_id = (select id from products where slug = 'feteer-meshaltet')) <> 0 then raise exception 'FAIL 2k'; end if;
  -- the tip is not in the view's revenue columns
  if (select net_product_sales + delivery_revenue from order_financials where id = v_o.id) <> v_o.subtotal + 8 then raise exception 'FAIL 2l'; end if;
  if (select tip_cents from order_financials where id = v_o.id) <> v_o.tip_cents then raise exception 'FAIL 2m'; end if;
  -- changing a product later never rewrites the order's snapshot
  update products set tax_status = 'exempt' where slug = 'feteer-beef';
  if (select tax_status from order_items where order_id = v_o.id and product_id = (select id from products where slug = 'feteer-beef')) <> 'taxable' then raise exception 'FAIL 2n'; end if;
  -- free delivery (FIRSTBITE): no delivery tax, item tax unchanged
  update orders set delivery_fee = 0 where id = v_o.id;
  select * into v_o from orders where id = v_o.id;
  if v_o.delivery_tax_cents <> 0 or v_o.item_tax_cents <> div_half_up(round(v_fb * 100)::bigint * 825, 10000) then raise exception 'FAIL 2o: %', v_o.delivery_tax_cents; end if;
  -- tip paid out stamps the time
  update orders set tip_paid_out = true where id = v_o.id;
  if (select tip_paid_out_at from orders where id = v_o.id) is null then raise exception 'FAIL 2p'; end if;
  -- a payment of the full total marks the order paid (tip included)
  insert into payments (order_id, amount, method, reference) values (v_o.id, v_o.total, 'card', 'stripe:test_tax');
  if (select payment_status from orders where id = v_o.id) <> 'paid' then raise exception 'FAIL 2q'; end if;
end $$;

-- --- 3. tax switched off: a new order has rate 0 and no tax --------------------
do $$ declare v_num text; v_o orders%rowtype; begin
  update tax_settings set tax_enabled = false where id = 1;
  v_num := intake_website_order('tok_tax_test_000000002',
    '{"name":"Tax Tester","phone":"+1 214 555 0100","phone_digits":"12145550100","street":"1 Test St","apt":"","city":"Dallas","state":"TX","zip":"75201","instructions":""}',
    '[{"slug":"kofta-tray","quantity":1,"options":""}]');
  select * into v_o from orders where order_number = v_num;
  if v_o.tax_rate_applied <> 0 or v_o.tax_cents <> 0 then raise exception 'FAIL 3a: % %', v_o.tax_rate_applied, v_o.tax_cents; end if;
  update tax_settings set tax_enabled = true where id = 1;
end $$;

-- --- 4. the review status is charged as taxable ------------------------------------
do $$ declare v_num text; v_o orders%rowtype; begin
  update products set tax_status = 'review' where slug = 'kofta-tray';
  v_num := intake_website_order('tok_tax_test_000000003',
    '{"name":"Tax Tester","phone":"+1 214 555 0100","phone_digits":"12145550100","street":"1 Test St","apt":"","city":"Dallas","state":"TX","zip":"75201","instructions":""}',
    '[{"slug":"kofta-tray","quantity":2,"options":""}]');
  select * into v_o from orders where order_number = v_num;
  if v_o.item_tax_cents <> div_half_up(round(v_o.subtotal * 100)::bigint * 825, 10000) then raise exception 'FAIL 4a: %', v_o.item_tax_cents; end if;
  if (select tax_status from order_items where order_id = v_o.id limit 1) <> 'review' then raise exception 'FAIL 4b'; end if;
end $$;

-- --- 5. constraints ------------------------------------------------------------------
do $$ declare v_id uuid; begin
  select id into v_id from orders where checkout_token = 'tok_tax_test_000000001';
  begin
    update orders set tip_cents = -1 where id = v_id;
    raise exception 'FAIL 5a: negative tip accepted';
  exception when check_violation then null;
  end;
  begin
    update orders set tip_type = 'gift' where id = v_id;
    raise exception 'FAIL 5b: bad tip type accepted';
  exception when check_violation then null;
  end;
  begin
    update tax_settings set tax_delivery_mode = 'half' where id = 1;
    raise exception 'FAIL 5c: bad delivery mode accepted';
  exception when check_violation then null;
  end;
end $$;

do $$ begin raise notice 'ALL TAX/TIP TESTS PASSED'; end $$;
rollback;
