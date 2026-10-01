-- ============================================================================
-- Combo tests (migration 0063). Runs inside a transaction that is ROLLED BACK:
--   supabase db query --linked -f supabase/tests/combos.sql
-- Proves an order for a combo is priced from the products table (a price sent by the browser is ignored),
-- keeps the customer's picks in options, and snapshots cost + packaging. A clean run ends with
-- {"result": "ALL COMBO TESTS PASSED"}.
-- ============================================================================
begin;

do $$
declare
  v_num text; v_id uuid; r record;
begin
  v_num := intake_website_order('combotest0123456789abc',
    '{"name":"Combo Test","phone":"2145550123","phone_digits":"2145550123","street":"1 Main","apt":"","city":"Dallas","state":"TX","zip":"75201","instructions":"","requested_at":"2030-01-01T18:00:00Z"}'::jsonb,
    '[{"slug":"family-feast","quantity":2,"options":"Main: Kofta Tray | Sides: Tahini, Hummus | Puddings: Banana Pudding x2","unit_price":0.01,"price":0.01}]'::jsonb);
  select id into v_id from orders where order_number = v_num;
  select * into r from order_items where order_id = v_id;
  if r.unit_price <> 69 then raise exception 'FAIL price: got % (a browser price must be ignored)', r.unit_price; end if;
  if r.line_total <> 138 then raise exception 'FAIL line total: got %', r.line_total; end if;
  if r.options not like 'Main: Kofta Tray%' then raise exception 'FAIL options not kept: %', r.options; end if;
  if r.unit_ingredient_cost <> 26.70 then raise exception 'FAIL ingredient cost snapshot: %', r.unit_ingredient_cost; end if;
  if r.unit_packaging_cost <> 3.00 then raise exception 'FAIL packaging snapshot: %', r.unit_packaging_cost; end if;
  if (select count(*) from combo_slots where combo_slug in ('family-feast','party-tray','meal-for-one','egyptian-breakfast','pick-3-puddings')) <> 9 then raise exception 'FAIL combo_slots rows'; end if;
end $$;

select 'ALL COMBO TESTS PASSED' as result;
rollback;
