-- ============================================================================
-- Receipt / email / split / refund tests (migration 0053). Runs inside ONE transaction that is
-- ROLLED BACK, so it is safe on the live project:
--   supabase db query --linked -f supabase/tests/receipts.sql
-- A clean run ends with {"result": "ALL RECEIPT TESTS PASSED"}.
-- ============================================================================
begin;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('00000000-0000-0000-0000-00000000dd04', 'receipts@test.local', 'x', now(), '{}', '{}', 'authenticated', 'authenticated');
insert into admin_profiles (user_id, full_name) values ('00000000-0000-0000-0000-00000000dd04', 'Receipt Tester');
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000dd04', 'role', 'authenticated')::text, true);

insert into bank_items (id, plaid_item_id, access_token) values ('00000000-0000-0000-0000-0000000000a4', 'rcpt-item', 'x');
insert into bank_accounts (id, item_id, plaid_account_id, name, mask)
values ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a4', 'rcpt-acct', 'Test', '0');

create or replace function _expect(p_label text, p_actual numeric, p_expected numeric) returns void language plpgsql as $$
begin if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if; end $$;

create or replace function _bank(p_id text, p_name text, p_amount numeric, p_date date) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into bank_transactions (account_id, plaid_transaction_id, posted_on, name, merchant_name, amount, pending)
  values ('00000000-0000-0000-0000-0000000000b4', p_id, p_date, p_name, '', p_amount, false)
  on conflict (plaid_transaction_id) do update set amount = excluded.amount returning id into v;
  perform apply_bank_transaction(v);
  return v;
end $$;

-- a receipt photo (source=upload) or an order email (source=email); returns what apply_parsed_receipt said
create or replace function _rcpt(p_sha text, p_src text, p_parsed jsonb) returns jsonb language plpgsql as $$
declare f uuid;
begin
  insert into receipt_files (sha256, source, email_message_id, original_name, storage_path)
  values (p_sha, p_src, case when p_src = 'email' then 'msg-' || p_sha end, 'photo-' || p_sha || '.jpg', case when p_src = 'upload' then 'test/' || p_sha else '' end)
  returning id into f;
  return apply_parsed_receipt(f, p_parsed);
end $$;

create or replace function _live() returns numeric language sql as $$ select count(*) from expenses where deleted_at is null $$;
create or replace function _srcs(p_exp uuid, p_type text) returns numeric language sql as $$ select count(*) from expense_sources where expense_id = p_exp and source_type = p_type $$;
create or replace function _exp_of(p jsonb) returns uuid language sql as $$ select (p->>'expense_id')::uuid $$;

-- ---- case 2: bank charge first, receipt later -> attach receipt + items to the existing expense ----
do $$
declare b uuid; e uuid; r jsonb; before_n numeric;
begin
  b := _bank('r-c2', 'COSTCO WHSE #112 DALLAS TX', 100, '2026-11-02');
  select expense_id into e from bank_transactions where id = b;
  before_n := _live();
  r := _rcpt('sha-c2', 'upload', '{"vendor":"Costco Wholesale","date":"2026-11-02","total":100,"tax":0,"items":[{"name":"Flour 25lb","total":60,"category":"Ingredients"},{"name":"Foil trays","total":40,"category":"Packaging"}]}');
  perform _expect('case2: no new expense', _live(), before_n);
  perform _expect('case2: receipt attached to the bank expense', (_exp_of(r) = e)::int, 1);
  perform _expect('case2: items stored', (select count(*) from expense_items where expense_id = e), 2);
  perform _expect('case2: bank + receipt evidence', _srcs(e, 'bank') + _srcs(e, 'receipt'), 2);
end $$;

-- ---- case 1: receipt first, bank charge 3 days later -> still ONE expense ----
do $$
declare r jsonb; e uuid; b uuid; before_n numeric;
begin
  r := _rcpt('sha-c1', 'upload', '{"vendor":"Walmart","date":"2026-11-03","total":50,"tax":0,"items":[{"name":"Butter","total":50,"category":"Ingredients"}]}');
  e := _exp_of(r); before_n := _live();
  perform _expect('case1: receipt created one expense', (r->>'outcome' = 'created')::int, 1);
  b := _bank('r-c1', 'WAL-MART #1234 DALLAS TX', 50, '2026-11-06');
  perform _expect('case1: bank charge did not add an expense', _live(), before_n);
  perform _expect('case1: bank linked to the receipt expense', (select (expense_id = e)::int from bank_transactions where id = b), 1);
end $$;

-- ---- case 3: email + receipt photo + bank = ONE expense with three kinds of evidence ----
do $$
declare r1 jsonb; r2 jsonb; e uuid; b uuid; before_n numeric;
begin
  r1 := _rcpt('sha-c3a', 'email', '{"vendor":"Amazon.com","date":"2026-11-04","total":30,"tax":2,"items":[{"name":"Mixing bowl","total":28,"category":"Equipment"}]}');
  e := _exp_of(r1); before_n := _live();
  r2 := _rcpt('sha-c3b', 'upload', '{"vendor":"Amazon","date":"2026-11-04","total":30,"tax":2,"items":[{"name":"Mixing bowl","total":28,"category":"Equipment"}]}');
  b := _bank('r-c3', 'AMZN Mktp US*2A12', 30, '2026-11-05');
  perform _expect('case3: still one expense', _live(), before_n);
  perform _expect('case3: photo joined the email expense', (_exp_of(r2) = e)::int, 1);
  perform _expect('case3: email + receipt + bank', _srcs(e, 'email') + _srcs(e, 'receipt') + _srcs(e, 'bank'), 3);
end $$;

-- ---- case 4: the same photo / the same email twice is refused by the database ----
do $$
begin
  perform _rcpt('sha-c4', 'upload', '{"vendor":"Aldi","date":"2026-11-05","total":12,"items":[]}');
  begin
    insert into receipt_files (sha256, source) values ('sha-c4', 'upload');
    raise exception 'FAIL [case4]: the same photo was accepted twice';
  exception when unique_violation then null; end;
  begin
    insert into receipt_files (sha256, source, email_message_id) values ('another-sha', 'email', 'msg-sha-c3a');
    raise exception 'FAIL [case4b]: the same email was accepted twice';
  exception when unique_violation then null; end;
end $$;

-- ---- re-reading a receipt never doubles items or evidence ----
do $$
declare f uuid; e uuid; n_items numeric; before_n numeric;
begin
  select id, expense_id into f, e from receipt_files where sha256 = 'sha-c2';
  select count(*) into n_items from expense_items where expense_id = e; before_n := _live();
  perform apply_parsed_receipt(f, (select parsed from receipt_files where id = f));
  perform apply_parsed_receipt(f, (select parsed from receipt_files where id = f));
  perform _expect('re-read: items not doubled', (select count(*) from expense_items where expense_id = e), n_items);
  perform _expect('re-read: no new expense', _live(), before_n);
  perform _expect('re-read: one receipt evidence row', _srcs(e, 'receipt'), 1);
end $$;

-- ---- case 6: ONE order email, several smaller card charges (split shipments) ----
do $$
declare r jsonb; e uuid; before_n numeric; b4 uuid; q jsonb;
begin
  r := _rcpt('sha-c6', 'email', '{"vendor":"Walmart","date":"2026-11-10","total":100,"tax":0,"items":[{"name":"Rice","total":100,"category":"Ingredients"}]}');
  e := _exp_of(r); before_n := _live();
  perform _bank('r-c6a', 'WALMART.COM 800-966', 40, '2026-11-11');
  perform _bank('r-c6b', 'WALMART.COM 800-966', 35, '2026-11-12');
  q := expense_integrity();
  perform _expect('case6: partial charges flagged while the order is incomplete', ((q->>'partial_bank_coverage')::numeric >= 1)::int, 1);
  perform _bank('r-c6c', 'WALMART.COM 800-966', 25, '2026-11-13');
  perform _expect('case6: three charges, still one expense', _live(), before_n);
  perform _expect('case6: charges add up to the order total', (select sum(amount) from expense_sources where expense_id = e and source_type = 'bank'), 100);
  perform _expect('case6: three bank evidence rows', _srcs(e, 'bank'), 3);
  -- a fourth charge would overshoot the order: it must become its own expense, not be forced in
  b4 := _bank('r-c6d', 'WALMART.COM 800-966', 20, '2026-11-14');
  perform _expect('case6: an overshooting charge is its own expense', (select (expense_id <> e)::int from bank_transactions where id = b4), 1);
  perform _expect('case6: no bank mismatch', (expense_integrity()->>'bank_amount_mismatch')::numeric, 0);
end $$;

-- ---- reverse of 6: ONE bank charge, two receipts (many-to-one) ----
do $$
declare b uuid; e uuid; before_n numeric;
begin
  b := _bank('r-c6m', 'RESTAURANT DEPOT #9', 100, '2026-11-15');
  select expense_id into e from bank_transactions where id = b; before_n := _live();
  perform _rcpt('sha-c6m1', 'upload', '{"vendor":"Restaurant Depot","date":"2026-11-15","total":60,"items":[{"name":"Oil","total":60,"category":"Ingredients"}]}');
  perform _rcpt('sha-c6m2', 'upload', '{"vendor":"Restaurant Depot","date":"2026-11-15","total":40,"items":[{"name":"Gloves","total":40,"category":"Kitchen supplies"}]}');
  perform _expect('many-to-one: still one expense', _live(), before_n);
  perform _expect('many-to-one: both receipts on the bank expense', _srcs(e, 'receipt'), 2);
  perform _expect('many-to-one: items from both receipts', (select count(*) from expense_items where expense_id = e), 2);
end $$;

-- ---- case 7: refunds reduce the original and are never income ----
do $$
declare b uuid; e uuid; rb uuid; r jsonb; before_n numeric;
begin
  b := _bank('r-c7', 'COSTCO WHSE #55', 80, '2026-11-16');
  select expense_id into e from bank_transactions where id = b; before_n := _live();
  rb := _bank('r-c7r', 'COSTCO WHSE #55 REFUND', -30, '2026-11-20');
  perform _expect('case7: refund is classified as a refund', (select (kind = 'refund')::int from bank_transactions where id = rb), 1);
  perform _expect('case7: original reduced by the refund', (select total_amount from expenses where id = e), 50);
  perform _expect('case7: no new expense and no income', _live(), before_n);
  perform apply_bank_transaction(rb); perform apply_bank_transaction(rb);
  perform _expect('case7: re-sync does not reduce twice', (select total_amount from expenses where id = e), 50);
  -- a refund the bank re-sends as the ORIGINAL charge being modified keeps the reduction
  perform apply_bank_transaction(b);
  perform _expect('case7: re-applying the original keeps the refund taken off', (select total_amount from expenses where id = e), 50);
  -- a refund receipt / email
  r := _rcpt('sha-c7e', 'email', '{"vendor":"Costco","date":"2026-11-21","total":20,"is_refund":true,"items":[]}');
  perform _expect('case7: refund email reduces it again', (select total_amount from expenses where id = e), 30);
  -- an unrelated deposit is still owner money
  perform _bank('r-dep', 'MOBILE DEPOSIT', -75, '2026-11-22');
  perform _expect('case7: unrelated deposit stays owner money', (select count(*) from bank_transactions where plaid_transaction_id = 'r-dep' and kind = 'owner_contribution'), 1);
end $$;

-- ---- a refund reported by BOTH an email and the bank counts once (either order) ----
do $$
declare b uuid; e uuid; rb uuid; e2 uuid; rb2 uuid;
begin
  -- email first, bank deposit later
  b := _bank('r-rf1', 'SPROUTS FARMERS #12', 90, '2026-11-24');
  select expense_id into e from bank_transactions where id = b;
  perform _rcpt('sha-rf1', 'email', '{"vendor":"Sprouts Farmers","date":"2026-11-25","total":25,"is_refund":true,"items":[]}');
  perform _expect('double refund (email first): reduced once', (select total_amount from expenses where id = e), 65);
  rb := _bank('r-rf1r', 'SPROUTS FARMERS #12 CREDIT', -25, '2026-11-27');
  perform _expect('double refund (email first): the deposit is the same refund', (select (kind = 'refund' and expense_id = e)::int from bank_transactions where id = rb), 1);
  perform _expect('double refund (email first): NOT reduced twice', (select total_amount from expenses where id = e), 65);
  -- bank deposit first, email later
  b := _bank('r-rf2', 'TRADER JOES #77', 70, '2026-11-24');
  select expense_id into e2 from bank_transactions where id = b;
  rb2 := _bank('r-rf2r', 'TRADER JOES #77 CREDIT', -10, '2026-11-26');
  perform _expect('double refund (bank first): reduced once', (select total_amount from expenses where id = e2), 60);
  perform _rcpt('sha-rf2', 'email', '{"vendor":"Trader Joes","date":"2026-11-26","total":10,"is_refund":true,"items":[]}');
  perform _expect('double refund (bank first): NOT reduced twice', (select total_amount from expenses where id = e2), 60);
  perform _expect('double refund: no mismatch flagged', (expense_integrity()->>'bank_amount_mismatch')::numeric, 0);
end $$;

-- ---- case 9: cash purchase, receipt only ----
do $$
declare r jsonb; e uuid;
begin
  r := _rcpt('sha-c9', 'upload', '{"vendor":"Corner Spice Shop","date":"2026-11-23","total":18.5,"tax":0,"payment_method":"cash","items":[{"name":"Spices","total":18.5,"category":"Ingredients"}]}');
  e := _exp_of(r);
  perform _expect('case9: cash receipt becomes one expense', (r->>'outcome' = 'created')::int, 1);
  perform _expect('case9: marked as paid cash', (select (payment_method = 'cash')::int from expenses where id = e), 1);
end $$;

-- ---- mixed cart: split across categories in the tax view; personal item is excluded ----
do $$
declare r jsonb; e uuid;
begin
  r := _rcpt('sha-mix', 'upload', '{"vendor":"Sam''s Club","date":"2027-02-10","total":35,"tax":0,"items":[{"name":"Flour","total":20,"category":"Ingredients"},{"name":"Foil trays","total":10,"category":"Packaging"},{"name":"Candy bar","total":5,"personal":true}]}');
  e := _exp_of(r);
  perform _expect('split: the Expenses list still has ONE expense', (select count(*) from expenses where id = e), 1);
  perform _expect('split: cost of goods = flour + foil', (select coalesce(sum(deductible_amount), 0) from expense_tax_view where expense_id = e and line_key = 'cogs_purchases'), 30);
  perform _expect('split: the expense shows only the business money (flour + foil)', (select total_amount from expenses where id = e), 30);
  perform _expect('split: the personal candy bar is remembered, not counted', (select personal_amount from expenses where id = e), 5);
  perform _expect('split: the lines add up to the business total', (select sum(total_amount) from expense_tax_view where expense_id = e), 30);
  perform _expect('split: no personal line in the tax view', (select count(*) from expense_tax_view where expense_id = e and line_key = 'personal'), 0);
end $$;

-- ---- a personal item in the basket: bank charge still matches, totals exclude it, tax is shared out ----
do $$
declare r jsonb; e uuid; b uuid; before_n numeric;
begin
  r := _rcpt('sha-pers', 'upload', '{"vendor":"Costco Wholesale","date":"2027-03-01","total":99.48,"tax":2.55,"items":[
        {"name":"Rice 10 lb","total":50,"category":"Ingredients"},{"name":"Foil","total":42.26,"category":"Kitchen supplies"},
        {"name":"Breyers ice cream","total":4.67,"category":"Ingredients","personal":true}]}');
  e := _exp_of(r);
  perform _expect('personal: the business total leaves out the ice cream and its share of the tax', (select total_amount from expenses where id = e), 94.69);
  perform _expect('personal: the personal part is kept (4.67 + 0.12 tax)', (select personal_amount from expenses where id = e), 4.79);
  before_n := _live();
  b := _bank('r-pers', 'COSTCO WHSE #684 W PLANO TX', 99.48, '2027-03-02');
  perform _expect('personal: the full 99.48 bank charge attaches to the SAME expense', (select (expense_id = e)::int from bank_transactions where id = b), 1);
  perform _expect('personal: no second expense', _live(), before_n);
  perform apply_bank_transaction(b);
  perform _expect('personal: a bank re-sync keeps the personal part out', (select total_amount from expenses where id = e), 94.69);
  perform _expect('personal: no bank mismatch flagged', (expense_integrity()->>'bank_amount_mismatch')::numeric, 0);
  -- the owner flips the item to business later: the expense grows back, by itself
  update expense_items set is_business = true, category_id = (select id from expense_categories where name = 'Ingredients') where expense_id = e and description = 'Breyers ice cream';
  perform _expect('personal: marking it business adds it back', (select total_amount from expenses where id = e), 99.48);
  perform _expect('personal: and nothing is personal any more', (select personal_amount from expenses where id = e), 0);
  update expense_items set is_business = false where expense_id = e and description = 'Breyers ice cream';
  perform _expect('personal: marking it personal again takes it out', (select total_amount from expenses where id = e), 94.69);
end $$;

-- ---- items that do not add up: flagged, and the tax lines still equal the total ----
do $$
declare r jsonb; e uuid;
begin
  r := _rcpt('sha-bad', 'upload', '{"vendor":"Kroger","date":"2027-02-11","total":40,"tax":0,"items":[{"name":"Milk","total":10,"category":"Ingredients"}]}');
  e := _exp_of(r);
  perform _expect('mismatch: flagged', (select (totals_ok is false)::int from receipt_files where sha256 = 'sha-bad'), 1);
  perform _expect('mismatch: tax lines still add up to the total', (select sum(total_amount) from expense_tax_view where expense_id = e), 40);
end $$;

-- ---- an owner correction is remembered for next time ----
do $$
declare pack uuid; r jsonb; e uuid;
begin
  select id into pack from expense_categories where name = 'Packaging';
  perform remember_item_category('KING ARTHUR FLOUR 5LB', pack, true);
  r := _rcpt('sha-mem', 'upload', '{"vendor":"HEB","date":"2027-02-12","total":9,"items":[{"name":"king arthur flour 10 lb","total":9,"category":"Ingredients"}]}');
  e := _exp_of(r);
  perform _expect('memory: the owner''s category wins over the AI guess', (select (category_id = pack)::int from expense_items where expense_id = e), 1);
end $$;

-- ---- a total that cannot be read fails safely ----
do $$
declare r jsonb;
begin
  r := _rcpt('sha-nototal', 'upload', '{"vendor":"Blurry","items":[]}');
  perform _expect('unreadable: reported as failed, no expense made', (r->>'outcome' = 'failed')::int, 1);
  perform _expect('unreadable: file is marked failed', (select (status = 'failed')::int from receipt_files where sha256 = 'sha-nototal'), 1);
end $$;

-- ---- medium confidence: same amount, different store name -> flagged, not merged ----
do $$
declare before_n numeric; r jsonb;
begin
  insert into expenses (expense_date, vendor, amount_before_tax) values ('2026-12-01', 'Some Hardware Store', 61.25);
  before_n := _live();
  r := _rcpt('sha-med', 'upload', '{"vendor":"Totally Different Shop","date":"2026-12-02","total":61.25,"items":[]}');
  perform _expect('medium: a new expense is created', _live(), before_n + 1);
  perform _expect('medium: flagged as a possible duplicate', (r->>'outcome' = 'possible_duplicate')::int, 1);
end $$;

-- ---- needs a receipt: a store charge with none after N days, until one arrives ----
do $$
declare b uuid; e uuid;
begin
  b := _bank('r-need', 'ALDI #44', 27.4, current_date - 10);
  select expense_id into e from bank_transactions where id = b;
  perform _expect('needs receipt: listed', (select count(*) from needs_receipt_view where expense_id = e), 1);
  perform _rcpt('sha-need', 'upload', format('{"vendor":"Aldi","date":"%s","total":27.4,"items":[]}', (current_date - 10)::text)::jsonb);
  perform _expect('needs receipt: gone once the receipt is attached', (select count(*) from needs_receipt_view where expense_id = e), 0);
end $$;

-- ---- global invariants ----
do $$
declare q jsonb := expense_integrity();
begin
  perform _expect('invariant: every expense has evidence', (q->>'expenses_without_source')::numeric, 0);
  perform _expect('invariant: no bank txn linked as the first charge of two expenses', (q->>'duplicate_bank_links')::numeric, 0);
  perform _expect('invariant: no bank mismatch', (q->>'bank_amount_mismatch')::numeric, 0);
end $$;

rollback;
select 'ALL RECEIPT TESTS PASSED' as result;
