-- ============================================================================
-- 0046_expense_pipeline.sql : Expenses rebuild, phase 1.
--
--  * expenses  = one row per real money event (the only thing totals count)
--  * expense_sources = evidence (bank, receipt, email, stripe, manual,
--    subscription, mileage). (source_type, source_ref) is UNIQUE so the same
--    evidence can never be imported twice.
--  * one SQL matching function (find_expense_match) decides whether new
--    evidence belongs to an existing expense. Used by the bank sync now and by
--    receipts / emails later, so the rule lives in exactly one place.
--  * bank rules get actions (expense / transfer / owner_contribution /
--    personal / payout) and a direction; money that is not a business cost is
--    classified, never turned into an expense.
--  * merge / unmerge tools, an integrity report, a nightly integrity log.
--  * Stripe processing fees become expenses (unique per payment).
--  * bank_items status becomes readable (the token column stays hidden).
-- ============================================================================

-- ------------------------------------------------------------------ 1. bank_items status visible
-- The access_token column is NOT granted, so it can never be selected from the browser.
revoke all on bank_items from anon, authenticated;
grant select (id, institution_id, institution_name, status, last_error, last_synced_at, created_at) on bank_items to authenticated;
drop policy if exists bank_items_select_status on bank_items;
create policy bank_items_select_status on bank_items for select to authenticated using (is_admin());

-- ------------------------------------------------------------------ 2. settings
create table if not exists expense_settings (
  id                 boolean primary key default true check (id),
  match_window_days  int not null default 5 check (match_window_days between 0 and 30),
  amount_tolerance   numeric(8,2) not null default 0 check (amount_tolerance >= 0),
  updated_at         timestamptz not null default now()
);
insert into expense_settings (id) values (true) on conflict do nothing;
alter table expense_settings enable row level security;
drop policy if exists expense_settings_select on expense_settings;
drop policy if exists expense_settings_update on expense_settings;
create policy expense_settings_select on expense_settings for select to authenticated using (is_admin());
create policy expense_settings_update on expense_settings for update to authenticated using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------------ 3. vendor aliases
create table if not exists vendor_aliases (
  id         uuid primary key default gen_random_uuid(),
  pattern    text not null,                 -- case-insensitive substring of a vendor / bank description
  canonical  text not null,                 -- the one name we use everywhere
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);
create unique index if not exists vendor_aliases_pattern_uniq on vendor_aliases (lower(pattern));
alter table vendor_aliases enable row level security;
drop policy if exists vendor_aliases_all on vendor_aliases;
create policy vendor_aliases_all on vendor_aliases for all to authenticated using (is_admin()) with check (is_admin());

insert into vendor_aliases (pattern, canonical, sort_order) values
  ('WAL-MART', 'Walmart', 10), ('WAL MART', 'Walmart', 10), ('WM SUPERCENTER', 'Walmart', 10),
  ('WALMART', 'Walmart', 10),
  ('COSTCO', 'Costco', 10),
  ('WEBSTAURANT', 'WebstaurantStore', 10),
  ('AMZN', 'Amazon', 10), ('AMAZON', 'Amazon', 10),
  ('SAM''S CLUB', 'Sam''s Club', 10), ('SAMS CLUB', 'Sam''s Club', 10), ('SAMSCLUB', 'Sam''s Club', 10),
  ('RESTAURANT DEPOT', 'Restaurant Depot', 10),
  ('H-E-B', 'H-E-B', 10),
  ('KROGER', 'Kroger', 10),
  ('ALDI', 'Aldi', 10),
  ('ULINE', 'Uline', 10),
  ('ANTHROPIC', 'Anthropic', 10), ('CLAUDE.AI', 'Anthropic', 10),
  ('STRIPE', 'Stripe', 10),
  ('GITHUB', 'GitHub', 10),
  ('GOOGLE', 'Google', 20)
on conflict do nothing;

-- Lower-case canonical vendor used ONLY for comparing two names.
create or replace function normalize_vendor(p_text text)
returns text language plpgsql stable set search_path = public as $$
declare v_canon text; v_clean text;
begin
  if coalesce(trim(p_text), '') = '' then return ''; end if;
  select canonical into v_canon from vendor_aliases
   where position(upper(pattern) in upper(p_text)) > 0
   order by sort_order, length(pattern) desc limit 1;
  if v_canon is not null then return lower(v_canon); end if;
  -- no alias: strip store numbers, punctuation and noise words
  v_clean := lower(p_text);
  v_clean := regexp_replace(v_clean, '[#*]\s*\d+', ' ', 'g');
  v_clean := regexp_replace(v_clean, '[^a-z ]', ' ', 'g');
  v_clean := regexp_replace(v_clean, '\m(llc|inc|co|corp|ltd|the|tx|dtx|pos|purchase|debit|card)\M', ' ', 'g');
  return trim(regexp_replace(v_clean, '\s+', ' ', 'g'));
end $$;

-- ------------------------------------------------------------------ 4. expenses columns
alter table expenses add column if not exists review_status text not null default 'ok'
  check (review_status in ('ok', 'needs_review', 'possible_duplicate'));
alter table expenses add column if not exists duplicate_of uuid references expenses(id) on delete set null;
alter table expenses add column if not exists merged_into  uuid references expenses(id) on delete set null;
create index if not exists expenses_review_idx on expenses(review_status) where review_status <> 'ok' and deleted_at is null;

-- ------------------------------------------------------------------ 5. evidence tables
create table if not exists expense_sources (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid references expenses(id) on delete set null,   -- null until matched
  source_type  text not null check (source_type in ('bank', 'receipt', 'email', 'stripe', 'manual', 'subscription', 'mileage')),
  source_ref   text not null,                                      -- external unique id
  amount       numeric(12,2),                                      -- signed: refunds are negative
  occurred_on  date,
  raw          jsonb not null default '{}'::jsonb,
  parsed       jsonb not null default '{}'::jsonb,
  confidence   numeric(5,2),
  merged_from  uuid,                                               -- expense this evidence belonged to before a merge
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists expense_sources_ref_uniq on expense_sources (source_type, source_ref);
create index if not exists expense_sources_expense_idx on expense_sources (expense_id);
create trigger expense_sources_updated before update on expense_sources for each row execute function set_updated_at();

create table if not exists expense_items (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid not null references expenses(id) on delete cascade,
  source_id    uuid references expense_sources(id) on delete set null,
  description  text not null default '',
  quantity     numeric(12,3) not null default 1,
  unit_price   numeric(12,4) not null default 0,
  line_total   numeric(12,2) not null default 0,
  tax_amount   numeric(12,2) not null default 0,
  category_id  uuid references expense_categories(id),
  is_business  boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists expense_items_expense_idx on expense_items (expense_id);

alter table expense_sources enable row level security;
alter table expense_items   enable row level security;
drop policy if exists expense_sources_select on expense_sources;
drop policy if exists expense_sources_update on expense_sources;
drop policy if exists expense_items_all on expense_items;
create policy expense_sources_select on expense_sources for select to authenticated using (is_admin());
create policy expense_sources_update on expense_sources for update to authenticated using (is_admin()) with check (is_admin());
create policy expense_items_all on expense_items for all to authenticated using (is_admin()) with check (is_admin());
create trigger expense_sources_audit after insert or update or delete on expense_sources for each row execute function audit_row();
create trigger expense_items_audit after insert or update or delete on expense_items for each row execute function audit_row();

-- ------------------------------------------------------------------ 6. bank rules: actions + direction
alter table bank_rules add column if not exists action text not null default 'expense'
  check (action in ('expense', 'transfer', 'owner_contribution', 'personal', 'payout'));
alter table bank_rules add column if not exists direction text not null default 'any'
  check (direction in ('any', 'out', 'in'));
-- previous "skip" rules were transfers
update bank_rules set action = 'transfer' where skip and action = 'expense';

create or replace function bank_rules_sync_skip() returns trigger language plpgsql as $$
begin new.skip := (new.action <> 'expense'); return new; end $$;
drop trigger if exists bank_rules_skip_sync on bank_rules;
create trigger bank_rules_skip_sync before insert or update on bank_rules for each row execute function bank_rules_sync_skip();
update bank_rules set skip = (action <> 'expense');

alter table bank_transactions add column if not exists kind text not null default 'unclassified'
  check (kind in ('unclassified', 'expense', 'transfer', 'owner_contribution', 'personal', 'payout', 'money_in', 'pending', 'ignored'));
alter table bank_transactions add column if not exists pending_transaction_id text;
alter table bank_transactions add column if not exists rule_id uuid references bank_rules(id) on delete set null;

-- Zelle is no longer skipped wholesale: money from the owner is an owner contribution,
-- money to someone else is an expense that needs a category.
delete from bank_rules where match_text = 'ZELLE';
insert into bank_rules (match_text, vendor, action, direction, sort_order) values
  ('ZELLE PAYMENT FROM FADY', '', 'owner_contribution', 'in', 12),
  ('STRIPE', 'Stripe', 'payout', 'in', 12)
on conflict do nothing;
insert into bank_rules (match_text, vendor, category_id, cost_type, sort_order)
select 'STRIPE', 'Stripe', c.id, 'operating', 41 from expense_categories c where c.name = 'Bank / payment fees'
on conflict do nothing;

-- ------------------------------------------------------------------ 7. matching engine
-- Candidates for "this new evidence is probably an expense we already have".
-- p_source_type: the kind of evidence arriving. A candidate that already has
-- evidence of the same kind is NOT a candidate (two bank charges are never merged).
create or replace function find_expense_match(
  p_vendor text, p_amount numeric, p_date date, p_source_type text, p_exclude uuid default null
) returns table (expense_id uuid, score int, vendor_match boolean)
language plpgsql stable security definer set search_path = public as $$
declare s expense_settings%rowtype; v_norm text := normalize_vendor(p_vendor);
begin
  select * into s from expense_settings limit 1;
  return query
  select e.id,
         (40
          + case when v_norm <> '' and normalize_vendor(e.vendor) = v_norm then 40 else 0 end
          + (20 * (1 - abs(e.expense_date - p_date)::numeric / greatest(s.match_window_days, 1)))::int
         ) as sc,
         (v_norm <> '' and normalize_vendor(e.vendor) = v_norm)
    from expenses e
   where e.deleted_at is null
     and e.auto_source is distinct from 'order_cost'
     and e.id is distinct from p_exclude
     and abs(e.total_amount - abs(p_amount)) <= s.amount_tolerance
     and abs(e.expense_date - p_date) <= s.match_window_days
     and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = p_source_type)
   order by sc desc, abs(e.expense_date - p_date), e.created_at
   limit 5;
end $$;
revoke all on function find_expense_match(text, numeric, date, text, uuid) from public, anon;
grant execute on function find_expense_match(text, numeric, date, text, uuid) to authenticated;

-- attach / detach evidence ---------------------------------------------------
create or replace function link_source(p_type text, p_ref text, p_expense uuid, p_amount numeric, p_date date, p_parsed jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on, parsed)
  values (p_type, p_ref, p_expense, p_amount, p_date, coalesce(p_parsed, '{}'::jsonb))
  on conflict (source_type, source_ref)
  do update set expense_id = excluded.expense_id, amount = excluded.amount, occurred_on = excluded.occurred_on
  returning id into v_id;
  return v_id;
end $$;
revoke all on function link_source(text, text, uuid, numeric, date, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ 8. bank transaction -> expense
create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype;
  r bank_rules%rowtype;
  e expenses%rowtype;
  v_vendor text; v_cat uuid; v_cost_type cost_type;
  v_expense_id uuid; v_kind text; v_match record; v_review text := 'ok'; v_dup uuid;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;

  -- first matching rule wins (direction aware)
  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
     and (direction = 'any' or (direction = 'out' and t.amount > 0) or (direction = 'in' and t.amount < 0))
   order by sort_order, created_at limit 1;

  -- 1. decide what this transaction is
  if t.ignored or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then
    v_kind := 'ignored';
  elsif t.pending then
    v_kind := 'pending';
  elsif r.id is not null and r.action <> 'expense' then
    v_kind := r.action;
  elsif t.amount <= 0 then
    v_kind := 'money_in';          -- deposits / refunds: never an expense, owner classifies
  else
    v_kind := 'expense';
  end if;

  update bank_transactions set kind = v_kind, rule_id = r.id where id = t.id and (kind is distinct from v_kind or rule_id is distinct from r.id);

  -- 2. not a business cost: make sure no expense is counted for it
  if v_kind <> 'expense' then
    if t.expense_id is not null then
      select * into e from expenses where id = t.expense_id;
      if e.auto_source = 'bank' then
        update expenses set deleted_at = now() where id = e.id and deleted_at is null;
      else
        update expenses set bank_transaction_id = null where id = e.id;   -- adopted manual expense stays
      end if;
      delete from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');

  -- 3a. already linked: refresh amount/date for rows the bank sync owns
  if t.expense_id is not null then
    select * into e from expenses where id = t.expense_id;
    if e.auto_source = 'bank' then
      update expenses
         set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
             amount_before_tax = t.amount, category_id = coalesce(v_cat, category_id),
             cost_type = case when v_cat is not null then v_cost_type else cost_type end, deleted_at = null
       where id = e.id;
    end if;
    perform link_source('bank', t.plaid_transaction_id, t.expense_id, t.amount, t.posted_on);
    return t.expense_id;
  end if;

  -- 3b. try to attach to an expense we already have (manual entry, subscription, receipt)
  select * into v_match from find_expense_match(v_vendor || ' ' || t.name, t.amount, t.posted_on, 'bank') limit 1;
  if v_match.expense_id is not null and v_match.vendor_match then
    update expenses set bank_transaction_id = t.id where id = v_match.expense_id;
    update bank_transactions set expense_id = v_match.expense_id where id = t.id;
    perform link_source('bank', t.plaid_transaction_id, v_match.expense_id, t.amount, t.posted_on);
    return v_match.expense_id;
  elsif v_match.expense_id is not null then
    v_review := 'possible_duplicate'; v_dup := v_match.expense_id;
  end if;

  -- 3c. a genuinely new expense
  if v_review = 'ok' and v_cat is null then v_review := 'needs_review'; end if;
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, notes, auto_source, bank_transaction_id, review_status, duplicate_of)
  values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
          'Imported from the bank feed.', 'bank', t.id, v_review, v_dup)
  returning id into v_expense_id;
  update bank_transactions set expense_id = v_expense_id where id = t.id;
  perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
  return v_expense_id;
end $$;

-- a transaction Plaid says no longer exists
create or replace function remove_bank_transactions(p_plaid_ids text[])
returns int language plpgsql security definer set search_path = public as $$
declare rec record; n int := 0;
begin
  for rec in select bt.id, bt.expense_id, bt.plaid_transaction_id, e.auto_source
               from bank_transactions bt left join expenses e on e.id = bt.expense_id
              where bt.plaid_transaction_id = any(p_plaid_ids)
  loop
    if rec.expense_id is not null then
      if rec.auto_source = 'bank' then
        update expenses set deleted_at = now() where id = rec.expense_id and deleted_at is null;
      else
        update expenses set bank_transaction_id = null where id = rec.expense_id;
      end if;
    end if;
    delete from expense_sources where source_type = 'bank' and source_ref = rec.plaid_transaction_id;
    delete from bank_transactions where id = rec.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function remove_bank_transactions(text[]) from public, anon, authenticated;

-- ------------------------------------------------------------------ 9. every expense has evidence
-- Manual entries and generated subscription charges record themselves as evidence.
create or replace function expense_default_source() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.auto_source is null then
    if new.recurring_parent_id is not null then
      insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
      values ('subscription', new.recurring_parent_id::text || ':' || to_char(new.expense_date, 'YYYY-MM-DD'), new.id, new.total_amount, new.expense_date)
      on conflict (source_type, source_ref) do nothing;
    elsif new.recurrence <> 'none' then
      insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
      values ('subscription', new.id::text || ':' || to_char(new.expense_date, 'YYYY-MM-DD'), new.id, new.total_amount, new.expense_date)
      on conflict (source_type, source_ref) do nothing;
    else
      insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
      values ('manual', new.id::text, new.id, new.total_amount, new.expense_date)
      on conflict (source_type, source_ref) do nothing;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists expenses_default_source on expenses;
create trigger expenses_default_source after insert on expenses for each row execute function expense_default_source();

-- ------------------------------------------------------------------ 10. merge / unmerge (reversible, audited)
create or replace function merge_expenses(p_keep uuid, p_drop uuid)
returns void language plpgsql security definer set search_path = public as $$
declare k expenses%rowtype; d expenses%rowtype;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  if p_keep = p_drop then raise exception 'cannot merge an expense into itself'; end if;
  select * into k from expenses where id = p_keep and deleted_at is null;
  select * into d from expenses where id = p_drop and deleted_at is null;
  if k.id is null or d.id is null then raise exception 'expense not found'; end if;

  -- the bank transaction wins if only the dropped row had one
  if d.bank_transaction_id is not null and k.bank_transaction_id is null then
    update expenses set bank_transaction_id = d.bank_transaction_id where id = k.id;
  end if;
  update bank_transactions set expense_id = k.id where expense_id = d.id;
  update expense_sources set merged_from = d.id, expense_id = k.id where expense_id = d.id;
  update expense_items set expense_id = k.id where expense_id = d.id;
  if k.receipt_path = '' and d.receipt_path <> '' then update expenses set receipt_path = d.receipt_path where id = k.id; end if;
  update expenses set deleted_at = now(), merged_into = k.id, bank_transaction_id = null, review_status = 'ok' where id = d.id;
  update expenses set review_status = 'ok', duplicate_of = null where id = k.id;
end $$;
grant execute on function merge_expenses(uuid, uuid) to authenticated;

create or replace function unmerge_expense(p_drop uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d expenses%rowtype; v_bank uuid;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  select * into d from expenses where id = p_drop and merged_into is not null;
  if d.id is null then raise exception 'this expense was not merged'; end if;
  -- give the evidence back
  update expense_sources set expense_id = d.id, merged_from = null where merged_from = d.id;
  select bt.id into v_bank from expense_sources s join bank_transactions bt on bt.plaid_transaction_id = s.source_ref
   where s.source_type = 'bank' and s.expense_id = d.id limit 1;
  if v_bank is not null then
    update bank_transactions set expense_id = d.id where id = v_bank;
    update expenses set bank_transaction_id = v_bank where id = d.id;
    update expenses set bank_transaction_id = null where id = d.merged_into and bank_transaction_id = v_bank;
  end if;
  update expenses set deleted_at = null, merged_into = null where id = d.id;
end $$;
grant execute on function unmerge_expense(uuid) to authenticated;

-- "Keep both": the owner says these are two real purchases
create or replace function keep_both_expenses(p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  update expenses set review_status = case when category_id is null then 'needs_review' else 'ok' end, duplicate_of = null where id = p_expense;
end $$;
grant execute on function keep_both_expenses(uuid) to authenticated;

-- ------------------------------------------------------------------ 11. integrity report
create or replace function expense_integrity()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'possible_duplicates', (select count(*) from expenses where deleted_at is null and review_status = 'possible_duplicate'),
    'needs_review',        (select count(*) from expenses where deleted_at is null and review_status = 'needs_review'),
    'expenses_without_source', (select count(*) from expenses e where e.deleted_at is null and e.auto_source is distinct from 'order_cost'
                                  and not exists (select 1 from expense_sources s where s.expense_id = e.id)),
    'bank_amount_mismatch', (select count(*) from expenses e join bank_transactions b on b.id = e.bank_transaction_id
                              where e.deleted_at is null and abs(e.total_amount - b.amount) > (select amount_tolerance from expense_settings limit 1)),
    'money_in_unclassified', (select count(*) from bank_transactions where kind = 'money_in'),
    'duplicate_bank_links', (select count(*) from (select bank_transaction_id from expenses where deleted_at is null and bank_transaction_id is not null
                              group by 1 having count(*) > 1) x)
  )
$$;
grant execute on function expense_integrity() to authenticated;

create table if not exists expense_integrity_log (
  id        uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default now(),
  result    jsonb not null
);
alter table expense_integrity_log enable row level security;
drop policy if exists expense_integrity_log_select on expense_integrity_log;
create policy expense_integrity_log_select on expense_integrity_log for select to authenticated using (is_admin());

select cron.schedule('expense-integrity-nightly', '30 7 * * *',
  $$insert into expense_integrity_log (result) select expense_integrity()$$)
 where not exists (select 1 from cron.job where jobname = 'expense-integrity-nightly');

-- ------------------------------------------------------------------ 12. Stripe processing fees
insert into expense_categories (name, cost_type, sort_order) values ('Payment processing fees', 'operating', 15)
on conflict (name) do nothing;

-- One fee expense per Stripe payment. Idempotent: calling it again for the same
-- payment never adds a row; an exact fee replaces an earlier estimate.
create or replace function record_stripe_fee(p_ref text, p_fee numeric, p_date date, p_order_id uuid, p_estimated boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_src expense_sources%rowtype; v_cat uuid; v_name text;
begin
  if p_fee is null or p_fee <= 0 then return null; end if;
  select customer_name into v_name from orders where id = p_order_id;
  if v_name is not null and is_test_order_name(v_name) then return null; end if;

  select * into v_src from expense_sources where source_type = 'stripe' and source_ref = p_ref;
  if found then
    if not p_estimated and v_src.expense_id is not null then
      update expenses set amount_before_tax = p_fee, notes = 'Stripe processing fee (exact).' where id = v_src.expense_id;
      update expense_sources set amount = p_fee, parsed = jsonb_build_object('estimated', false) where id = v_src.id;
    end if;
    return v_src.expense_id;
  end if;

  select id into v_cat from expense_categories where name = 'Payment processing fees';
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, order_id, notes, auto_source)
  values (p_date, 'Stripe', v_cat, 'Card processing fee', p_fee, 0, 'operating', p_order_id,
          case when p_estimated then 'Stripe processing fee (estimated 2.9% + 30 cents; replaced by the exact fee when available).' else 'Stripe processing fee (exact).' end,
          'stripe')
  returning id into v_id;
  insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on, parsed)
  values ('stripe', p_ref, v_id, p_fee, p_date, jsonb_build_object('estimated', p_estimated));
  return v_id;
end $$;
revoke all on function record_stripe_fee(text, numeric, date, uuid, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------------ 13. map the rows that already exist
-- bank imports
insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
select 'bank', bt.plaid_transaction_id, e.id, bt.amount, bt.posted_on
  from expenses e join bank_transactions bt on bt.id = e.bank_transaction_id
 where e.deleted_at is null
on conflict (source_type, source_ref) do nothing;
-- manual + subscription rows (the insert trigger only covers new rows)
insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
select case when e.recurrence <> 'none' or e.recurring_parent_id is not null then 'subscription' else 'manual' end,
       case when e.recurring_parent_id is not null then e.recurring_parent_id::text || ':' || to_char(e.expense_date, 'YYYY-MM-DD')
            when e.recurrence <> 'none' then e.id::text || ':' || to_char(e.expense_date, 'YYYY-MM-DD')
            else e.id::text end,
       e.id, e.total_amount, e.expense_date
  from expenses e
 where e.deleted_at is null and e.auto_source is null
on conflict (source_type, source_ref) do nothing;

-- classify the bank transactions that were already imported
update bank_transactions set kind = 'expense' where expense_id is not null;
do $$ declare rec record; begin
  for rec in select id from bank_transactions where expense_id is null loop
    perform apply_bank_transaction(rec.id);
  end loop;
end $$;

-- ------------------------------------------------------------------ 14. daily bank sync (Chicago morning)
create extension if not exists pg_net with schema extensions;
-- The cron job itself is created by hand after deploy because it embeds the shared
-- secret (see docs/HANDOFF-3-expenses.md). Nothing secret is stored in this file.
