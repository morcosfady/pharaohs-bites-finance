-- ============================================================================
-- Tax pack tests (migration 0051). Runs inside a transaction that is ROLLED BACK:
--   supabase db query --linked -f supabase/tests/tax_pack.sql
-- A clean run ends with {"result": "ALL TAX PACK TESTS PASSED"}.
-- ============================================================================
begin;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('00000000-0000-0000-0000-00000000dd03', 'tax@test.local', 'x', now(), '{}', '{}', 'authenticated', 'authenticated');
insert into admin_profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000dd03', 'Tax Tester');
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000dd03', 'role', 'authenticated')::text, true);

-- isolate from the live rows: park them outside the test year
update expenses set expense_date = '1999-01-01';

create or replace function _expect(p_label text, p_actual numeric, p_expected numeric) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if;
end $$;

create or replace function _exp(p_date date, p_vendor text, p_cat text, p_amount numeric, p_pct numeric default 100) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into expenses (expense_date, vendor, category_id, amount_before_tax, business_pct)
  values (p_date, p_vendor, (select id from expense_categories where name = p_cat), p_amount, p_pct) returning id into v;
  return v;
end $$;

create or replace function _ln(p_line text) returns numeric language sql as $$
  select coalesce((select deductible from tax_summary('2027-01-01', '2027-12-31') where line_key = p_line), 0)
$$;

update expense_settings set business_start_date = '2026-10-01', asset_threshold = 500, startup_limit = 5000;
update mileage_settings set method = 'standard';

-- ---- every category in use is mapped to a line ---------------------------------------
do $$ begin
  perform _expect('all categories mapped to a Schedule C line', (select count(*) from expense_categories where schedule_c_line is null), 0);
end $$;

-- ---- categories land on the right line ---------------------------------------------------
do $$ begin
  perform _exp('2027-02-01', 'Costco', 'Ingredients', 200);
  perform _exp('2027-02-02', 'Uline', 'Packaging', 50);
  perform _exp('2027-02-03', 'Meta', 'Marketing', 80);
  perform _exp('2027-02-04', 'Stripe', 'Payment processing fees', 12.5);
  perform _exp('2027-02-05', 'City', 'Licenses and permits', 30);
  perform _expect('COGS purchases = ingredients + packaging', _ln('cogs_purchases'), 250);
  perform _expect('advertising line 8', _ln('l8_advertising'), 80);
  perform _expect('commissions and fees line 10', _ln('l10_commissions'), 12.5);
  perform _expect('taxes and licenses line 23', _ln('l23_taxes'), 30);
end $$;

-- ---- business % scales the deduction, the total stays whole --------------------------------
do $$
declare e uuid;
begin
  e := _exp('2027-03-01', 'Verizon', 'Phone & internet', 100, 40);
  perform _expect('phone 40% deductible', (select deductible_amount from expense_tax_view where expense_id = e), 40);
  perform _expect('phone total unchanged', (select total_amount from expense_tax_view where expense_id = e), 100);
  perform _expect('phone is flagged for the accountant', (select (ask_reason is not null)::int from expense_tax_view where expense_id = e), 1);
end $$;

-- ---- standard mileage: gas is not deducted on top; actual method brings it back ----------------
do $$
declare g uuid;
begin
  g := _exp('2027-03-02', 'Shell', 'Gas / mileage', 60);
  perform _expect('gas excluded with standard mileage', (select deductible_amount from expense_tax_view where expense_id = g), 0);
  perform _expect('gas excluded: flagged', (select (ask_reason like '%standard mileage%')::int from expense_tax_view where expense_id = g), 1);
  update mileage_settings set method = 'actual';
  perform _expect('gas deductible with the actual method', (select deductible_amount from expense_tax_view where expense_id = g), 60);
  update mileage_settings set method = 'standard';
end $$;

-- ---- refunds to customers are not an expense -----------------------------------------------------
do $$
declare r uuid;
begin
  r := _exp('2027-03-03', 'Customer refund', 'Refunds', 25);
  perform _expect('refund is not deducted', (select deductible_amount from expense_tax_view where expense_id = r), 0);
end $$;

-- ---- startup bucket: before the business start date ------------------------------------------------
do $$
declare s uuid;
begin
  s := _exp('2026-09-20', 'County clerk', 'Licenses and permits', 40);
  perform _expect('startup row lands in the startup bucket', (select (line_key = 'startup')::int from expense_tax_view where expense_id = s), 1);
  perform _expect('startup is NOT inside Line 23', (select coalesce(sum(deductible), 0) from tax_summary('2026-01-01', '2026-12-31') where line_key = 'l23_taxes'), 0);
  perform _expect('startup total', (select coalesce(sum(total), 0) from tax_summary('2026-01-01', '2026-12-31') where line_key = 'startup'), 40);
end $$;

-- ---- possible asset over the threshold ----------------------------------------------------------------
do $$
declare a uuid; b uuid;
begin
  a := _exp('2027-04-01', 'Webstaurant', 'Equipment', 899);
  b := _exp('2027-04-02', 'Walmart', 'Equipment', 120);
  perform _expect('mixer is a possible asset', (select asset_candidate::int from expense_tax_view where expense_id = a), 1);
  perform _expect('whisk is not', (select asset_candidate::int from expense_tax_view where expense_id = b), 0);
  update expense_settings set asset_threshold = 100;
  perform _expect('threshold is a setting', (select asset_candidate::int from expense_tax_view where expense_id = b), 1);
  update expense_settings set asset_threshold = 500;
end $$;

-- ---- recipe-based order cost is never in the tax view (no double counting) -----------------------------
do $$
declare x uuid;
begin
  insert into expenses (expense_date, vendor, category_id, amount_before_tax, auto_source)
  values ('2027-05-01', 'Kitchen', (select id from expense_categories where name = 'Ingredients'), 999, 'order_cost') returning id into x;
  perform _expect('order_cost rows are excluded', (select count(*) from expense_tax_view where expense_id = x), 0);
end $$;

-- ---- archived expenses never count --------------------------------------------------------------------
do $$
declare d uuid; before_n numeric; after_n numeric;
begin
  select coalesce(sum(deductible), 0) into before_n from tax_summary('2027-01-01', '2027-12-31');
  d := _exp('2027-06-01', 'Oops', 'Ingredients', 77);
  update expenses set deleted_at = now() where id = d;
  select coalesce(sum(deductible), 0) into after_n from tax_summary('2027-01-01', '2027-12-31');
  perform _expect('deleted expense is not in the totals', after_n, before_n);
end $$;

-- ---- data quality + extras ---------------------------------------------------------------------------------
do $$
declare q jsonb; x jsonb;
begin
  insert into expenses (expense_date, vendor, amount_before_tax) values ('2027-07-01', 'Mystery', 10);
  q := tax_data_quality('2027-01-01', '2027-12-31');
  perform _expect('uncategorized is counted', (q->>'uncategorized')::numeric, 1);
  perform _expect('manual expenses without a receipt are counted', ((q->>'missing_receipts')::numeric >= 1)::int, 1);
  insert into bank_items (id, plaid_item_id, access_token) values ('00000000-0000-0000-0000-0000000000a9', 'tax-item', 'x');
  insert into bank_accounts (id, item_id, plaid_account_id, name, mask) values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000a9', 'tax-acct', 't', '0');
  insert into bank_transactions (account_id, plaid_transaction_id, posted_on, name, amount, kind) values
    ('00000000-0000-0000-0000-0000000000b9', 'tx-owner', '2027-08-01', 'Zelle from owner', -300, 'owner_contribution'),
    ('00000000-0000-0000-0000-0000000000b9', 'tx-pers', '2027-08-02', 'Netflix', 15, 'personal'),
    ('00000000-0000-0000-0000-0000000000b9', 'tx-pay', '2027-08-03', 'Stripe', -500, 'payout');
  x := tax_extras('2027-01-01', '2027-12-31');
  perform _expect('owner contributions listed, not income', (x->>'owner_contributions')::numeric, 300);
  perform _expect('personal spending listed, excluded', (x->>'personal_total')::numeric, 15);
  perform _expect('Stripe payouts listed, not income', (x->>'stripe_payouts')::numeric, 500);
end $$;

rollback;
select 'ALL TAX PACK TESTS PASSED' as result;
