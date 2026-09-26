-- ============================================================================
-- 0010_bank_feed.sql : Plaid bank feed -> Expenses
--
-- One Plaid "item" is one bank login (Chase). Each item has one or more
-- accounts, and every account has transactions. Money leaving the account
-- becomes an expense automatically; deposits are stored but never become
-- expenses (income is handled by orders, not here).
--
-- SECURITY: bank_items holds the Plaid access token. No policy grants any
-- authenticated user access to that table -- only the service role (the Edge
-- Functions) can read it. The browser never sees a token. Everything the
-- dashboard needs to display lives in bank_accounts / bank_transactions,
-- which admins can read.
-- ============================================================================

create table bank_items (
  id                 uuid primary key default gen_random_uuid(),
  plaid_item_id      text not null unique,
  access_token       text not null,                  -- service-role only
  institution_id     text not null default '',
  institution_name   text not null default '',
  cursor             text,                           -- /transactions/sync cursor
  status             text not null default 'active', -- active | needs_reauth | disconnected
  last_error         text not null default '',
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger bank_items_updated before update on bank_items for each row execute function set_updated_at();

create table bank_accounts (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references bank_items(id) on delete cascade,
  plaid_account_id   text not null unique,
  name               text not null default '',
  official_name      text not null default '',
  mask               text not null default '',       -- last 4 only; never the full number
  type               text not null default '',
  subtype            text not null default '',
  current_balance    numeric(14,2),
  available_balance  numeric(14,2),
  is_tracked         boolean not null default true,  -- untick to ignore an account
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index bank_accounts_item_idx on bank_accounts(item_id);
create trigger bank_accounts_updated before update on bank_accounts for each row execute function set_updated_at();

create table bank_transactions (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references bank_accounts(id) on delete cascade,
  plaid_transaction_id  text not null unique,         -- the dedupe key
  posted_on             date not null,
  name                  text not null default '',
  merchant_name         text not null default '',
  -- Plaid convention: positive = money OUT of the account, negative = money in.
  amount                numeric(14,2) not null,
  iso_currency_code     text not null default 'USD',
  pending               boolean not null default false,
  plaid_category        text not null default '',
  payment_channel       text not null default '',
  expense_id            uuid references expenses(id) on delete set null,
  ignored               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index bank_transactions_account_idx on bank_transactions(account_id);
create index bank_transactions_date_idx on bank_transactions(posted_on desc);
create index bank_transactions_expense_idx on bank_transactions(expense_id);
create trigger bank_transactions_updated before update on bank_transactions for each row execute function set_updated_at();

-- Vendor rules: first matching pattern wins (lowest sort_order).
create table bank_rules (
  id           uuid primary key default gen_random_uuid(),
  match_text   text not null,                         -- case-insensitive substring of the transaction name
  vendor       text not null default '',              -- rewrite the messy bank description to this
  category_id  uuid references expense_categories(id),
  cost_type    cost_type not null default 'operating',
  skip         boolean not null default false,        -- true = never create an expense (transfers, card payments)
  sort_order   int not null default 100,
  created_at   timestamptz not null default now()
);
create index bank_rules_order_idx on bank_rules(sort_order);

alter table expenses add column if not exists bank_transaction_id uuid references bank_transactions(id) on delete set null;
create index if not exists expenses_bank_txn_idx on expenses(bank_transaction_id) where bank_transaction_id is not null;

-- ---------------------------------------------------------------- RLS
alter table bank_items        enable row level security;
alter table bank_accounts     enable row level security;
alter table bank_transactions enable row level security;
alter table bank_rules        enable row level security;

-- bank_items: deliberately NO policies. Access tokens are service-role only.

create policy bank_accounts_select on bank_accounts for select to authenticated using (is_admin());
create policy bank_accounts_update on bank_accounts for update to authenticated using (is_admin()) with check (is_admin());

create policy bank_transactions_select on bank_transactions for select to authenticated using (is_admin());
create policy bank_transactions_update on bank_transactions for update to authenticated using (is_admin()) with check (is_admin());

create policy bank_rules_select on bank_rules for select to authenticated using (is_admin());
create policy bank_rules_insert on bank_rules for insert to authenticated with check (is_admin());
create policy bank_rules_update on bank_rules for update to authenticated using (is_admin()) with check (is_admin());
create policy bank_rules_delete on bank_rules for delete to authenticated using (is_admin());

create trigger bank_transactions_audit after insert or update or delete on bank_transactions for each row execute function audit_row();
create trigger bank_rules_audit after insert or update or delete on bank_rules for each row execute function audit_row();

-- ------------------------------------------------- transaction -> expense
-- Called by the sync function for each posted debit. Idempotent: a second
-- call for the same transaction updates the existing expense instead of
-- creating another. Deposits, pending rows, ignored rows and rows matching a
-- skip rule never produce an expense.
create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype;
  r bank_rules%rowtype;
  v_vendor text;
  v_cat uuid;
  v_cost_type cost_type;
  v_expense_id uuid;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;

  -- first matching rule wins
  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
   order by sort_order, created_at limit 1;

  if t.ignored or t.pending or t.amount <= 0 or coalesce(r.skip, false)
     or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then
    -- no expense should exist for this transaction
    if t.expense_id is not null then
      update expenses set deleted_at = now() where id = t.expense_id and deleted_at is null;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');

  if t.expense_id is null then
    insert into expenses (expense_date, vendor, category_id, description, amount_before_tax,
                          sales_tax_paid, cost_type, notes, auto_source, bank_transaction_id)
    values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
            'Imported from the bank feed. Edit the rule, not this row.', 'bank', t.id)
    returning id into v_expense_id;
    update bank_transactions set expense_id = v_expense_id where id = t.id;
  else
    update expenses
       set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
           amount_before_tax = t.amount, category_id = v_cat, cost_type = v_cost_type, deleted_at = null
     where id = t.expense_id
    returning id into v_expense_id;
  end if;
  return v_expense_id;
end $$;

-- Re-apply every transaction (used after the rules change).
create or replace function reapply_bank_rules()
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; rec record;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  for rec in select id from bank_transactions loop
    perform apply_bank_transaction(rec.id);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function reapply_bank_rules() to authenticated;

-- Starter rules. Transfers and card payments are money moving between the
-- owner's own accounts, not costs, so they are skipped by default.
insert into bank_rules (match_text, vendor, category_id, cost_type, skip, sort_order) values
  ('CHASE CREDIT CRD',  '', null, 'operating', true, 10),
  ('Payment Thank You', '', null, 'operating', true, 10),
  ('ONLINE TRANSFER',   '', null, 'operating', true, 10),
  ('ZELLE',             '', null, 'operating', true, 15),
  ('ATM WITHDRAWAL',    '', null, 'operating', true, 15);

insert into bank_rules (match_text, vendor, category_id, cost_type, sort_order)
select v.m, v.vend, c.id, v.ct::cost_type, v.so
from (values
  ('COSTCO',    'Costco',        'Ingredients',          'direct_product', 20),
  ('SAM''S CLUB','Sam''s Club',  'Ingredients',          'direct_product', 20),
  ('WALMART',   'Walmart',       'Ingredients',          'direct_product', 20),
  ('KROGER',    'Kroger',        'Ingredients',          'direct_product', 20),
  ('ALDI',      'Aldi',          'Ingredients',          'direct_product', 20),
  ('RESTAURANT DEPOT', 'Restaurant Depot', 'Ingredients','direct_product', 20),
  ('WEBSTAURANT','WebstaurantStore','Packaging',         'direct_product', 25),
  ('ULINE',     'Uline',         'Packaging',            'direct_product', 25),
  ('SHELL',     'Shell',         'Gas / mileage',        'operating',      30),
  ('EXXON',     'Exxon',         'Gas / mileage',        'operating',      30),
  ('CHEVRON',   'Chevron',       'Gas / mileage',        'operating',      30),
  ('QUIKTRIP',  'QuikTrip',      'Gas / mileage',        'operating',      30),
  ('ANTHROPIC', 'Anthropic',     'Website / technology', 'operating',      40),
  ('GOOGLE',    'Google',        'Website / technology', 'operating',      40),
  ('GITHUB',    'GitHub',        'Website / technology', 'operating',      40),
  ('META PLATFORMS', 'Meta',     'Marketing',            'operating',      45),
  ('FACEBK',    'Meta',          'Marketing',            'operating',      45),
  ('INSTAGRAM', 'Meta',          'Marketing',            'operating',      45),
  ('TIKTOK',    'TikTok',        'Marketing',            'operating',      45),
  ('ONCOR',     'Oncor',         'Utilities',            'operating',      50),
  ('ATMOS',     'Atmos Energy',  'Utilities',            'operating',      50),
  ('CITY OF DALLAS', 'City of Dallas', 'Licenses and permits', 'operating', 55)
) as v(m, vend, cat, ct, so)
join expense_categories c on c.name = v.cat;
