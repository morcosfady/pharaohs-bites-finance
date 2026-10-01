-- ============================================================================
-- Stripe fee tests (migration 0054). Runs inside ONE transaction that is ROLLED BACK:
--   supabase db query --linked -f supabase/tests/stripe_fees.sql
-- A clean run ends with {"result": "ALL STRIPE FEE TESTS PASSED"}.
-- ============================================================================
begin;

create or replace function _expect(p_label text, p_actual numeric, p_expected numeric) returns void language plpgsql as $$
begin if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if; end $$;

create or replace function _paid(p_num text, p_name text, p_amount numeric, p_ref text, p_deleted boolean default false) returns uuid language plpgsql as $$
declare o uuid;
begin
  insert into orders (order_number, customer_name, customer_phone, delivery_method, source, deleted_at)
  values (p_num, p_name, '2145550101', 'delivery', 'manual', case when p_deleted then now() end) returning id into o;
  insert into payments (order_id, amount, method, reference) values (o, p_amount, 'card', p_ref);
  return o;
end $$;

update expense_settings set stripe_fee_pct = 2.9, stripe_fee_fixed = 0.30;

-- ---- a paid Stripe order with no fee gets one: 2.9% + 30 cents ----
do $$
declare n int;
begin
  perform _paid('PB-TEST-F1', 'Real Customer', 100, 'stripe:pi_f1');
  n := backfill_stripe_fees();
  perform _expect('one fee created', n, 1);
  perform _expect('fee = 2.9% of 100 + 30c = 3.20', (select amount_before_tax from expenses e join expense_sources s on s.expense_id = e.id where s.source_type = 'stripe' and s.source_ref = 'pi_f1'), 3.20);
end $$;

-- ---- running it again never adds a second fee ----
do $$
begin
  perform _expect('second run adds nothing', backfill_stripe_fees(), 0);
  perform _expect('still one evidence row', (select count(*) from expense_sources where source_type = 'stripe' and source_ref = 'pi_f1'), 1);
end $$;

-- ---- the rate is a setting ----
do $$
begin
  update expense_settings set stripe_fee_pct = 3.5, stripe_fee_fixed = 0.50;
  perform _paid('PB-TEST-F2', 'Another Customer', 40, 'stripe:pi_f2');
  perform backfill_stripe_fees();
  perform _expect('fee uses the new rate: 40 x 3.5% + 0.50 = 1.90', (select amount_before_tax from expenses e join expense_sources s on s.expense_id = e.id where s.source_ref = 'pi_f2'), 1.90);
  update expense_settings set stripe_fee_pct = 2.9, stripe_fee_fixed = 0.30;
end $$;

-- ---- no fee for test orders, deleted orders, voided payments, or non-Stripe payments ----
do $$
declare v uuid;
begin
  perform _paid('PB-TEST-F3', 'test 1', 50, 'stripe:pi_f3');
  perform _paid('PB-TEST-F4', 'Deleted Customer', 50, 'stripe:pi_f4', true);
  v := _paid('PB-TEST-F5', 'Voided Customer', 50, 'stripe:pi_f5');
  update payments set voided_at = now() where order_id = v;
  perform _paid('PB-TEST-F6', 'Zelle Customer', 50, 'zelle-123');
  perform backfill_stripe_fees();
  perform _expect('test, deleted, voided and non-Stripe get no fee', (select count(*) from expense_sources where source_ref in ('pi_f3', 'pi_f4', 'pi_f5', 'zelle-123')), 0);
end $$;

-- ---- an exact fee from Stripe replaces the estimate and the backfill never overwrites it ----
do $$
declare e uuid;
begin
  select expense_id into e from expense_sources where source_ref = 'pi_f1';
  perform record_stripe_fee('pi_f1', 3.31, current_date, null, false);
  perform backfill_stripe_fees();
  perform _expect('exact fee kept', (select amount_before_tax from expenses where id = e), 3.31);
end $$;

-- ---- new rules classify the usual suspects ----
do $$
declare b uuid; a uuid; ia uuid;
begin
  insert into bank_items (id, plaid_item_id, access_token) values ('00000000-0000-0000-0000-0000000000a7', 'sf-item', 'x');
  insert into bank_accounts (id, item_id, plaid_account_id, name, mask) values ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000a7', 'sf-acct', 't', '0');
  insert into bank_transactions (account_id, plaid_transaction_id, posted_on, name, amount) values
    ('00000000-0000-0000-0000-0000000000b7', 'sf-toll', '2026-11-01', 'NTTA TOLL TAG', 12.5),
    ('00000000-0000-0000-0000-0000000000b7', 'sf-ins',  '2026-11-01', 'NEXT INSURANCE', 40),
    ('00000000-0000-0000-0000-0000000000b7', 'sf-irs',  '2026-11-01', 'IRS USATAXPYMT', 300),
    ('00000000-0000-0000-0000-0000000000b7', 'sf-fee',  '2026-11-01', 'MONTHLY SERVICE FEE', 12);
  perform apply_bank_transaction(id) from bank_transactions where plaid_transaction_id like 'sf-%';
  perform _expect('toll is Parking & tolls', (select count(*) from bank_transactions bt join expenses e on e.id = bt.expense_id join expense_categories c on c.id = e.category_id where bt.plaid_transaction_id = 'sf-toll' and c.name = 'Parking & tolls'), 1);
  perform _expect('insurance is Insurance', (select count(*) from bank_transactions bt join expenses e on e.id = bt.expense_id join expense_categories c on c.id = e.category_id where bt.plaid_transaction_id = 'sf-ins' and c.name = 'Insurance'), 1);
  perform _expect('income-tax payment is personal, not an expense', (select count(*) from bank_transactions where plaid_transaction_id = 'sf-irs' and kind = 'personal' and expense_id is null), 1);
  perform _expect('bank fee is Bank / payment fees', (select count(*) from bank_transactions bt join expenses e on e.id = bt.expense_id join expense_categories c on c.id = e.category_id where bt.plaid_transaction_id = 'sf-fee' and c.name = 'Bank / payment fees'), 1);
end $$;

-- ---- tolls are deductible even with the standard mileage rate; gas is not ----
do $$
declare tl uuid; gs uuid;
begin
  update mileage_settings set method = 'standard';
  select e.id into tl from bank_transactions bt join expenses e on e.id = bt.expense_id where bt.plaid_transaction_id = 'sf-toll';
  update expenses set expense_date = '2027-03-01' where id = tl;
  perform _expect('toll stays deductible with standard mileage', (select deductible_amount from expense_tax_view where expense_id = tl), 12.5);
end $$;

rollback;
select 'ALL STRIPE FEE TESTS PASSED' as result;
