-- ============================================================================
-- Expense de-duplication tests (migration 0046).
-- Everything runs inside ONE transaction that is ROLLED BACK at the end, so it
-- is safe to run against the live project:
--   supabase db query --linked -f supabase/tests/expense_dedup.sql
-- Any failed expectation raises an exception. A clean run ends with the row
-- {"result": "ALL EXPENSE DEDUP TESTS PASSED"}.
-- ============================================================================
begin;

-- fixtures: an admin (merge/unmerge need one), one bank item + tracked account
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('00000000-0000-0000-0000-00000000dd01', 'dedup@test.local', 'x', now(), '{}', '{}', 'authenticated', 'authenticated');
insert into admin_profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000dd01', 'Dedup Tester');
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000dd01', 'role', 'authenticated')::text, true);

insert into bank_items (id, plaid_item_id, access_token) values ('00000000-0000-0000-0000-0000000000a1', 'test-item', 'x');
insert into bank_accounts (id, item_id, plaid_account_id, name, mask)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'test-acct', 'Test checking', '0000');

create temp table _t (n text);   -- readable failure messages

create or replace function _bank(p_id text, p_name text, p_amount numeric, p_date date, p_pending boolean default false)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into bank_transactions (account_id, plaid_transaction_id, posted_on, name, merchant_name, amount, pending)
  values ('00000000-0000-0000-0000-0000000000b1', p_id, p_date, p_name, '', p_amount, p_pending)
  on conflict (plaid_transaction_id) do update set posted_on = excluded.posted_on, name = excluded.name, amount = excluded.amount, pending = excluded.pending
  returning id into v;
  perform apply_bank_transaction(v);
  return v;
end $$;

create or replace function _count(p_sql text) returns bigint language plpgsql as $$
declare n bigint; begin execute p_sql into n; return n; end $$;

create or replace function _expect(p_label text, p_actual bigint, p_expected bigint) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
end $$;

-- ---- 0. vendor normalisation -------------------------------------------------
do $$ begin
  perform _expect('WAL-MART #1234 = walmart', (normalize_vendor('WAL-MART #1234') = 'walmart')::int, 1);
  perform _expect('WM SUPERCENTER = walmart', (normalize_vendor('WM SUPERCENTER #5') = 'walmart')::int, 1);
  perform _expect('WALMART.COM = walmart', (normalize_vendor('WALMART.COM 800-966') = 'walmart')::int, 1);
  perform _expect('COSTCO WHSE = costco', (normalize_vendor('COSTCO WHSE #112') = normalize_vendor('COSTCO.COM'))::int, 1);
  perform _expect('AMZN Mktp = amazon', (normalize_vendor('AMZN Mktp US*2A') = normalize_vendor('AMAZON.COM'))::int, 1);
  perform _expect('different vendors differ', (normalize_vendor('Costco') <> normalize_vendor('Walmart'))::int, 1);
end $$;

-- ---- case 1: manual entry first, bank charge 3 days later -> ONE expense -----
do $$
declare m uuid; b uuid;
begin
  insert into expenses (expense_date, vendor, amount_before_tax, description) values ('2026-10-02', 'Walmart', 100, 'groceries') returning id into m;
  b := _bank('t-c1', 'WAL-MART #1234 DALLAS TX', 100, '2026-10-05');
  perform _expect('case1: single expense', _count($q$select count(*) from expenses where deleted_at is null and vendor in ('Walmart') and amount_before_tax = 100 and expense_date between '2026-10-01' and '2026-10-06'$q$), 1);
  perform _expect('case1: bank linked to manual row', (select (expense_id = m)::int from bank_transactions where id = b), 1);
  perform _expect('case1: two evidence rows', _count(format('select count(*) from expense_sources where expense_id = %L', m)), 2);
end $$;

-- ---- idempotency: re-applying and re-importing the same transaction ------------
do $$
declare before_n bigint; after_n bigint; b uuid;
begin
  select count(*) into before_n from expenses where deleted_at is null;
  b := _bank('t-c1', 'WAL-MART #1234 DALLAS TX', 100, '2026-10-05');
  perform apply_bank_transaction(b); perform apply_bank_transaction(b);
  select count(*) into after_n from expenses where deleted_at is null;
  perform _expect('idempotent: no new expense after 3 applies', after_n, before_n);
  perform _expect('idempotent: evidence rows still unique', _count($q$select count(*) from expense_sources where source_ref = 't-c1'$q$), 1);
end $$;

-- ---- case 5: pending then posted -> still one expense ---------------------------
do $$
declare b uuid;
begin
  b := _bank('t-c5p', 'COSTCO WHSE #1', 55.5, '2026-10-06', true);
  perform _expect('case5: pending makes no expense', _count($q$select count(*) from expenses where vendor = 'COSTCO WHSE #1' or description like 'COSTCO WHSE #1%'$q$), 0);
  -- Plaid replaces the pending row: same row, new id, no longer pending
  update bank_transactions set plaid_transaction_id = 't-c5', pending = false where id = b;
  perform apply_bank_transaction(b);
  perform apply_bank_transaction(b);
  perform _expect('case5: posted makes exactly one expense', _count($q$select count(*) from expenses where deleted_at is null and amount_before_tax = 55.5$q$), 1);
end $$;

-- ---- case 8: two identical purchases, same day, both real -> TWO expenses -------
do $$
begin
  perform _bank('t-c8a', 'KROGER #55', 42.10, '2026-10-07');
  perform _bank('t-c8b', 'KROGER #55', 42.10, '2026-10-07');
  perform _expect('case8: identical bank charges stay separate', _count($q$select count(*) from expenses where deleted_at is null and amount_before_tax = 42.10$q$), 2);
end $$;

-- ---- case 11: subscription charge from the bank links to the subscription row ---
do $$
declare s uuid; b uuid;
begin
  insert into expenses (expense_date, vendor, amount_before_tax, recurrence) values ('2026-10-08', 'Anthropic', 100, 'monthly') returning id into s;
  b := _bank('t-c11', 'ANTHROPIC, SAN FRANCISCO CA', 100, '2026-10-09');
  perform _expect('case11: no second Anthropic expense', _count($q$select count(*) from expenses where deleted_at is null and amount_before_tax = 100 and vendor ilike 'anthropic%' and expense_date >= '2026-10-08'$q$), 1);
  perform _expect('case11: linked to the subscription', (select (expense_id = s)::int from bank_transactions where id = b), 1);
  perform _expect('case11: subscription keeps its vendor/date', (select (vendor = 'Anthropic' and expense_date = '2026-10-08')::int from expenses where id = s), 1);
end $$;

-- ---- medium confidence: amount matches, vendor does not -> flagged, not merged ---
do $$
declare m uuid; b uuid; e uuid;
begin
  insert into expenses (expense_date, vendor, amount_before_tax) values ('2026-10-10', 'Some corner store', 33.33) returning id into m;
  b := _bank('t-med', 'ZELLE PAYMENT TO JOE 123', 33.33, '2026-10-11');
  select expense_id into e from bank_transactions where id = b;
  perform _expect('medium: new expense created', (e is distinct from m)::int, 1);
  perform _expect('medium: flagged possible_duplicate', (select (review_status = 'possible_duplicate' and duplicate_of = m)::int from expenses where id = e), 1);
end $$;

-- ---- merge + unmerge are reversible -------------------------------------------
do $$
declare m uuid; e uuid; n_before bigint; n_merged bigint; n_after bigint;
begin
  select id into m from expenses where vendor = 'Some corner store' and amount_before_tax = 33.33;
  select id into e from expenses where review_status = 'possible_duplicate' and duplicate_of = m;
  select count(*) into n_before from expenses where deleted_at is null;
  perform merge_expenses(m, e);
  select count(*) into n_merged from expenses where deleted_at is null;
  perform _expect('merge: one fewer live expense', n_merged, n_before - 1);
  perform _expect('merge: bank evidence moved to the kept expense', _count(format($q$select count(*) from expense_sources where expense_id = %L and source_type = 'bank'$q$, m)), 1);
  perform unmerge_expense(e);
  select count(*) into n_after from expenses where deleted_at is null;
  perform _expect('unmerge: restored', n_after, n_before);
  perform _expect('unmerge: evidence returned', _count(format($q$select count(*) from expense_sources where expense_id = %L and source_type = 'bank'$q$, e)), 1);
end $$;

-- ---- case 12: Zelle from the owner is an owner contribution, never an expense ----
do $$
declare b uuid; before_n bigint;
begin
  select count(*) into before_n from expenses where deleted_at is null;
  b := _bank('t-c12', 'Zelle payment from FADY MORCOS WFCT99', -75, '2026-10-12');
  perform _expect('case12: kind', (select (kind = 'owner_contribution')::int from bank_transactions where id = b), 1);
  perform _expect('case12: no expense', _count('select count(*) from expenses where deleted_at is null'), before_n);
end $$;

-- ---- case 13: Stripe payout is a payout, not income, not an expense ---------------
do $$
declare b uuid; before_n bigint;
begin
  select count(*) into before_n from expenses where deleted_at is null;
  b := _bank('t-c13', 'STRIPE TRANSFER ST-ABC123', -250, '2026-10-13');
  perform _expect('case13: kind payout', (select (kind = 'payout')::int from bank_transactions where id = b), 1);
  perform _expect('case13: no expense', _count('select count(*) from expenses where deleted_at is null'), before_n);
end $$;

-- ---- unclassified money in is held for review, never an expense -------------------
do $$
declare b uuid; before_n bigint;
begin
  select count(*) into before_n from expenses where deleted_at is null;
  b := _bank('t-in', 'DEPOSIT ID NUMBER 999', -20, '2026-10-14');
  perform _expect('money in with no rule is owner money (never income, never an expense)', (select (kind = 'owner_contribution')::int from bank_transactions where id = b), 1);
  perform _expect('money in: no expense', _count('select count(*) from expenses where deleted_at is null'), before_n);
end $$;

-- ---- card payments / transfers are skipped -------------------------------------------
do $$
declare b uuid; before_n bigint;
begin
  select count(*) into before_n from expenses where deleted_at is null;
  b := _bank('t-xfer', 'CHASE CREDIT CRD AUTOPAY', 300, '2026-10-14');
  perform _expect('transfer: kind', (select (kind = 'transfer')::int from bank_transactions where id = b), 1);
  perform _expect('transfer: no expense', _count('select count(*) from expenses where deleted_at is null'), before_n);
end $$;

-- ---- a rule change that turns a charge into a transfer archives only bank-owned rows
do $$
declare b uuid; e uuid;
begin
  b := _bank('t-rule', 'ALDI 77', 12.34, '2026-10-15');
  select expense_id into e from bank_transactions where id = b;
  perform _expect('rule: expense created', (e is not null)::int, 1);
  update bank_rules set action = 'personal' where match_text = 'ALDI';
  perform apply_bank_transaction(b);
  perform _expect('rule: bank-owned expense archived when it becomes personal', (select (deleted_at is not null)::int from expenses where id = e), 1);
  perform _expect('rule: personal kind kept for the tax pack', (select (kind = 'personal')::int from bank_transactions where id = b), 1);
end $$;

-- ---- Stripe fee: one row per payment, exact replaces estimate ------------------------
do $$
declare a uuid; b uuid;
begin
  a := record_stripe_fee('pi_test_1', 1.20, '2026-10-16', null, true);
  b := record_stripe_fee('pi_test_1', 1.20, '2026-10-16', null, true);
  perform _expect('stripe: same payment twice = one expense', (a = b)::int, 1);
  perform _expect('stripe: one evidence row', _count($q$select count(*) from expense_sources where source_ref = 'pi_test_1'$q$), 1);
  perform record_stripe_fee('pi_test_1', 1.31, '2026-10-16', null, false);
  perform _expect('stripe: exact fee replaces estimate', (select (amount_before_tax = 1.31)::int from expenses where id = a), 1);
  perform record_stripe_fee('pi_test_1', 9.99, '2026-10-16', null, true);
  perform _expect('stripe: a later estimate never overwrites an exact fee', (select (amount_before_tax = 1.31)::int from expenses where id = a), 1);
end $$;

-- ---- evidence uniqueness is enforced by the database ----------------------------------
do $$
begin
  begin
    insert into expense_sources (source_type, source_ref) values ('email', 'msg-1'), ('email', 'msg-1');
    raise exception 'FAIL [unique]: duplicate email evidence was accepted';
  exception when unique_violation then null; end;
end $$;

-- ---- fewer questions: names that share a word merge on their own; an unrelated name is still asked; deposits are not asked ----
do $$
declare e1 uuid; e2 uuid; b uuid; b2 uuid; b3 uuid; n0 bigint;
begin
  insert into expenses (expense_date, vendor, description, amount_before_tax, sales_tax_paid, cost_type)
  values ('2027-03-01', 'Nextdoor Ads', 'ads', 90, 0, 'operating') returning id into e1;
  b := _bank('fq-1', 'NEXTDOOR ADS SAN FRANCISCO CA', 90, '2027-03-02');
  perform _expect('fewer questions: shared word merges by itself', (select expense_id = e1 from bank_transactions where id = b)::int, 1);
  insert into expenses (expense_date, vendor, description, amount_before_tax, sales_tax_paid, cost_type)
  values ('2027-03-05', 'Sunrise Bakery', 'x', 33, 0, 'operating') returning id into e2;
  b2 := _bank('fq-2', 'ZZQ HOLDINGS', 33, '2027-03-06');
  perform _expect('fewer questions: unrelated name is still asked', (select count(*) from expenses where id = (select expense_id from bank_transactions where id = b2) and review_status = 'possible_duplicate'), 1);
  b3 := _bank('fq-3', 'ODD DEPOSIT FROM SOMEONE', -12, '2027-03-07');
  perform _expect('fewer questions: unexplained deposit is not asked', (select count(*) from bank_transactions where id = b3 and kind <> 'money_in'), 1);
end $$;

-- ---- global invariants ---------------------------------------------------------------------
do $$
declare r jsonb := expense_integrity();
begin
  perform _expect('invariant: every expense has evidence', (r->>'expenses_without_source')::bigint, 0);
  perform _expect('invariant: no bank txn linked to two expenses', (r->>'duplicate_bank_links')::bigint, 0);
  perform _expect('invariant: bank amounts equal expense totals', (r->>'bank_amount_mismatch')::bigint, 0);
end $$;

rollback;
select 'ALL EXPENSE DEDUP TESTS PASSED' as result;
