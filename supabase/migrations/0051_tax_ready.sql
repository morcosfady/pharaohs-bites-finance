-- ============================================================================
-- 0051_tax_ready.sql : Expenses rebuild, phase 5 (tax-ready).
--
-- Bookkeeping support for the accountant (IRS Schedule C, sole proprietor).
-- THIS IS NOT TAX ADVICE: the Schedule C mapping below is a DRAFT, and anything
-- uncertain is flagged "Ask accountant" instead of guessed.
--
--  * expense_categories get a Schedule C line + a treatment (cogs / deductible / excluded)
--  * expenses get business_pct and an owner "ask accountant" flag
--  * expense_settings: business start date, asset threshold, startup limit
--  * expense_tax_view : every counted expense with its line, deductible amount and flags
--  * tax_summary(from,to)       : totals by Schedule C line (startup kept in its own bucket)
--  * tax_data_quality(from,to)  : what must be fixed before handing the pack over
--  * tax_extras(from,to)        : money that is NOT an expense or income (personal, owner, payouts)
-- Totals come from `expenses` only. Recipe-based order cost (auto_source = 'order_cost')
-- is excluded: real purchases are the cost of goods, counting both would double count.
-- ============================================================================

-- ------------------------------------------------------------------ columns
alter table expense_categories add column if not exists schedule_c_line text;
alter table expense_categories add column if not exists treatment text not null default 'deductible'
  check (treatment in ('cogs', 'deductible', 'excluded'));
alter table expense_categories add column if not exists always_ask boolean not null default false;
alter table expense_categories add column if not exists ask_note text not null default '';

alter table expenses add column if not exists business_pct numeric(5,2) not null default 100 check (business_pct between 0 and 100);
alter table expenses add column if not exists ask_accountant boolean not null default false;
alter table expenses add column if not exists ask_note text not null default '';

alter table expense_settings add column if not exists business_start_date date not null default '2026-10-01';
alter table expense_settings add column if not exists asset_threshold numeric(10,2) not null default 500 check (asset_threshold >= 0);
alter table expense_settings add column if not exists startup_limit numeric(10,2) not null default 5000 check (startup_limit >= 0);

-- categories the brief lists that did not exist yet
insert into expense_categories (name, cost_type, sort_order) values
  ('Professional services', 'operating', 20),
  ('Phone & internet', 'operating', 21),
  ('Home office', 'operating', 22)
on conflict (name) do nothing;

-- ------------------------------------------------------------------ draft Schedule C mapping
update expense_categories c set schedule_c_line = m.line, treatment = m.tr, always_ask = m.ask, ask_note = m.note
from (values
  ('Ingredients',              'cogs_purchases', 'cogs',       false, ''),
  ('Packaging',                'cogs_purchases', 'cogs',       false, 'Packaging can be cost of goods or supplies.'),
  ('Pizza boxes',              'cogs_purchases', 'cogs',       false, ''),
  ('Cake boxes',               'cogs_purchases', 'cogs',       false, ''),
  ('Dessert cups',             'cogs_purchases', 'cogs',       false, ''),
  ('Logo stickers',            'cogs_purchases', 'cogs',       false, ''),
  ('Kitchen supplies',         'l22_supplies',   'deductible', false, ''),
  ('Equipment',                'l22_supplies',   'deductible', true,  'Equipment may need depreciating (Line 13) instead of expensing.'),
  ('Delivery',                 'l27a_other',     'deductible', true,  'Delivery costs: confirm the right line (and not double counted with mileage).'),
  ('Gas / mileage',            'l9_car',         'deductible', false, 'With the standard mileage rate, gas is NOT deducted on top.'),
  ('Marketing',                'l8_advertising', 'deductible', false, ''),
  ('Website / technology',     'l18_office',     'deductible', false, 'Software and hosting: Line 18 office expense or 27a other.'),
  ('Licenses and permits',     'l23_taxes',      'deductible', false, 'Licenses can also be legal fees or startup costs.'),
  ('Training',                 'l27a_other',     'deductible', false, 'Education / training.'),
  ('Payment processing fees',  'l10_commissions','deductible', false, ''),
  ('Bank / payment fees',      'l27a_other',     'deductible', false, 'Bank fees.'),
  ('Refunds',                  'refunds',        'excluded',   true,  'Refunds to customers reduce sales (returns and allowances); they are not an expense.'),
  ('Utilities',                'l25_utilities',  'deductible', true,  'Only the business share is deductible: set Business use %.'),
  ('Repairs',                  'l21_repairs',    'deductible', false, ''),
  ('Other',                    'l27a_other',     'deductible', true,  'Uncategorized "Other": say what it is.'),
  ('Professional services',    'l17_legal_prof', 'deductible', false, 'Accountant, legal.'),
  ('Phone & internet',         'l25_utilities',  'deductible', true,  'Only the business share is deductible: set Business use %.'),
  ('Home office',              'l30_home',       'deductible', true,  'Home office needs Form 8829 or the simplified method.')
) as m(name, line, tr, ask, note)
where c.name = m.name;

-- ------------------------------------------------------------------ the tax view
create or replace view expense_tax_view with (security_invoker = true) as
with s as (select * from expense_settings limit 1),
     m as (select * from mileage_settings limit 1)
select
  e.id as expense_id, e.expense_date, e.vendor, e.description, e.category_id,
  coalesce(c.name, 'Uncategorized') as category_name,
  e.total_amount, e.business_pct, e.receipt_path, e.review_status, e.auto_source,
  (e.expense_date < s.business_start_date) as is_startup,
  case
    when e.expense_date < s.business_start_date then 'startup'
    when c.id is null then 'uncategorized'
    else coalesce(c.schedule_c_line, 'l27a_other')
  end as line_key,
  coalesce(c.treatment, 'deductible') as treatment,
  (c.name = 'Gas / mileage' and m.method = 'standard') as gas_excluded,
  (e.total_amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date) as asset_candidate,
  case
    when coalesce(c.treatment, 'deductible') = 'excluded' then 0
    when c.name = 'Gas / mileage' and m.method = 'standard' then 0
    else round(e.total_amount * e.business_pct / 100, 2)
  end as deductible_amount,
  nullif(concat_ws(' ',
    case when e.ask_accountant then coalesce(nullif(e.ask_note, ''), 'Owner flagged this.') end,
    case when c.always_ask then c.ask_note end,
    case when c.id is null then 'No category yet.' end,
    case when c.name = 'Gas / mileage' and m.method = 'standard' then 'Gas excluded because standard mileage is selected.' end,
    case when e.total_amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date
         then 'Possible asset over ' || s.asset_threshold::text || ': depreciate or expense?' end,
    case when e.expense_date < s.business_start_date then 'Before the business start date: startup cost (election and limit to confirm).' end,
    case when e.business_pct < 100 then 'Business use ' || e.business_pct::text || '%.' end
  ), '') as ask_reason
from expenses e
cross join s cross join m
left join expense_categories c on c.id = e.category_id
where e.deleted_at is null and e.auto_source is distinct from 'order_cost';

-- ------------------------------------------------------------------ totals by Schedule C line
create or replace function tax_summary(p_from date, p_to date)
returns table (line_key text, entries bigint, total numeric, deductible numeric)
language sql stable security invoker set search_path = public as $$
  select v.line_key, count(*), coalesce(sum(v.total_amount), 0), coalesce(sum(v.deductible_amount), 0)
    from expense_tax_view v
   where v.expense_date between p_from and p_to
   group by v.line_key
   order by v.line_key
$$;
grant execute on function tax_summary(date, date) to authenticated;

-- ------------------------------------------------------------------ data quality
create or replace function tax_data_quality(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'needs_review',         (select count(*) from expense_tax_view where expense_date between p_from and p_to and review_status = 'needs_review'),
    'possible_duplicates',  (select count(*) from expense_tax_view where expense_date between p_from and p_to and review_status = 'possible_duplicate'),
    'uncategorized',        (select count(*) from expense_tax_view where expense_date between p_from and p_to and category_name = 'Uncategorized'),
    'missing_receipts',     (select count(*) from expense_tax_view v where v.expense_date between p_from and p_to and v.receipt_path = ''
                               and not exists (select 1 from expense_sources s where s.expense_id = v.expense_id and s.source_type in ('receipt', 'email', 'stripe', 'subscription'))),
    'money_in_unclassified',(select count(*) from bank_transactions where kind = 'money_in' and posted_on between p_from and p_to),
    'mileage_without_rate', (select count(*) from mileage_log_view where counted and trip_date between p_from and p_to and deduction is null),
    'mileage_estimated',    (select count(*) from mileage_log_view where counted and estimated and trip_date between p_from and p_to),
    'ask_accountant',       (select count(*) from expense_tax_view where expense_date between p_from and p_to and ask_reason is not null)
  )
$$;
grant execute on function tax_data_quality(date, date) to authenticated;

-- ------------------------------------------------------------------ money that is neither expense nor income
create or replace function tax_extras(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'personal_total',     (select coalesce(sum(amount), 0) from bank_transactions where kind = 'personal' and posted_on between p_from and p_to),
    'personal_count',     (select count(*) from bank_transactions where kind = 'personal' and posted_on between p_from and p_to),
    'owner_contributions',(select coalesce(sum(-amount), 0) from bank_transactions where kind = 'owner_contribution' and posted_on between p_from and p_to),
    'stripe_payouts',     (select coalesce(sum(-amount), 0) from bank_transactions where kind = 'payout' and posted_on between p_from and p_to),
    'transfers',          (select coalesce(sum(abs(amount)), 0) from bank_transactions where kind = 'transfer' and posted_on between p_from and p_to)
  )
$$;
grant execute on function tax_extras(date, date) to authenticated;
