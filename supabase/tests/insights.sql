-- ============================================================================
-- Budgets, bills coming up, ingredient price jumps, weekly summary (migration 0056).
-- Runs inside ONE transaction that is ROLLED BACK:  supabase db query --linked -f supabase/tests/insights.sql
-- A clean run ends with {"result": "ALL INSIGHT TESTS PASSED"}.
-- ============================================================================
begin;

create or replace function _expect(p_label text, p_actual numeric, p_expected numeric) returns void language plpgsql as $$
begin if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if; end $$;

-- isolate from live data
update expenses set expense_date = '1999-01-01';
update expenses set recurrence = 'none', recurring_parent_id = null where recurrence <> 'none';

create or replace function _cat(p text) returns uuid language sql as $$ select id from expense_categories where name = p $$;
create or replace function _exp(p_date date, p_vendor text, p_cat text, p_amt numeric, p_rec expense_recurrence default 'none') returns uuid language plpgsql as $$
declare v uuid;
begin insert into expenses (expense_date, vendor, category_id, amount_before_tax, recurrence) values (p_date, p_vendor, _cat(p_cat), p_amt, p_rec) returning id into v; return v; end $$;

-- ---- budgets: spent vs limit, this month only ----
do $$
declare r record;
begin
  insert into expense_budgets (category_id, monthly_limit) values (_cat('Marketing'), 100);
  perform _exp(date_trunc('month', current_date)::date, 'Meta', 'Marketing', 60);
  perform _exp(date_trunc('month', current_date)::date, 'Vistaprint', 'Marketing', 25);
  perform _exp((date_trunc('month', current_date) - interval '1 day')::date, 'Meta last month', 'Marketing', 500);
  select * into r from budget_status(current_date) where category = 'Marketing';
  perform _expect('budget: only this month counts', r.spent, 85);
  perform _expect('budget: percent of the limit', r.pct, 85);
  perform _expect('budget: a category without a limit is not listed', (select count(*) from budget_status(current_date) where category = 'Ingredients'), 0);
end $$;

-- ---- bills coming up ----
do $$
declare a uuid; n int;
begin
  perform _exp(current_date - 20, 'Anthropic', 'Website / technology', 100, 'monthly');           -- next due in ~10 days
  perform _exp(current_date - 3, 'Weekly thing', 'Other', 10, 'weekly');                          -- next in 4 days, then +7...
  perform _exp(current_date - 100, 'Yearly license', 'Licenses and permits', 300, 'annual');      -- due in ~265 days
  perform _expect('monthly bill appears once in 30 days', (select count(*) from upcoming_bills(30) where vendor = 'Anthropic'), 1);
  perform _expect('the due date is a month after the last charge', (select (due = (current_date - 20 + interval '1 month')::date)::int from upcoming_bills(30) where vendor = 'Anthropic'), 1);
  perform _expect('weekly bill appears several times', (select count(*) from upcoming_bills(30) where vendor = 'Weekly thing'), 4);
  perform _expect('an annual bill far away is not listed', (select count(*) from upcoming_bills(30) where vendor = 'Yearly license'), 0);
  perform _expect('a longer horizon finds it', (select count(*) from upcoming_bills(400) where vendor = 'Yearly license'), 1);
  -- when the monthly charge is generated, the NEXT one moves forward (no repeat)
  select id into a from expenses where vendor = 'Anthropic' and recurring_parent_id is null and recurrence = 'monthly';
  insert into expenses (expense_date, vendor, category_id, amount_before_tax, recurrence, recurring_parent_id)
    values ((current_date - 20 + interval '1 month')::date, 'Anthropic', _cat('Website / technology'), 100, 'monthly', a);
  perform _expect('after it is charged the next due date moves a month on', (select (due = (current_date - 20 + interval '2 months')::date)::int from upcoming_bills(60) where vendor = 'Anthropic' order by due limit 1), 1);
end $$;

-- ---- ingredient price jumps: same item, same store, clearly dearer ----
do $$
declare e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; n int;
begin
  e1 := _exp(current_date - 40, 'Costco', 'Ingredients', 5);  insert into expense_items (expense_id, description, quantity, unit_price, line_total, category_id, is_business) values (e1, 'Kerrygold butter 8oz', 1, 5.00, 5.00, _cat('Ingredients'), true);
  e2 := _exp(current_date - 3,  'Costco', 'Ingredients', 6);  insert into expense_items (expense_id, description, quantity, unit_price, line_total, category_id, is_business) values (e2, 'KERRYGOLD BUTTER 8 OZ', 1, 6.00, 6.00, _cat('Ingredients'), true);
  e3 := _exp(current_date - 40, 'Walmart', 'Ingredients', 5); insert into expense_items (expense_id, description, quantity, unit_price, line_total, category_id, is_business) values (e3, 'Kerrygold butter 8oz', 1, 5.00, 5.00, _cat('Ingredients'), true);
  e4 := _exp(current_date - 40, 'Aldi', 'Ingredients', 2);    insert into expense_items (expense_id, description, quantity, unit_price, line_total, category_id, is_business) values (e4, 'Plain flour 5 lb', 1, 2.00, 2.00, _cat('Ingredients'), true);
  e5 := _exp(current_date - 3,  'Aldi', 'Ingredients', 2.1);  insert into expense_items (expense_id, description, quantity, unit_price, line_total, category_id, is_business) values (e5, 'Plain flour 5 lb', 1, 2.10, 2.10, _cat('Ingredients'), true);
  perform _expect('a 20% rise at the same store is flagged', (select count(*) from ingredient_price_jumps(14, 0.15) where item ilike '%butter%' and store = 'Costco'), 1);
  perform _expect('the percentage is right', (select pct from ingredient_price_jumps(14, 0.15) where item ilike '%butter%'), 0.2);
  perform _expect('a different store is not compared (Walmart has only one purchase)', (select count(*) from ingredient_price_jumps(14, 0.15) where store = 'Walmart'), 0);
  perform _expect('a 5% rise is not flagged', (select count(*) from ingredient_price_jumps(14, 0.15) where item ilike '%flour%'), 0);
  perform _expect('a lower threshold flags it', (select count(*) from ingredient_price_jumps(14, 0.04) where item ilike '%flour%'), 1);
  perform _expect('an old rise is not news', (select count(*) from ingredient_price_jumps(1, 0.15) where item ilike '%butter%'), 0);
end $$;

-- ---- the weekly summary ----
do $$
declare s jsonb;
begin
  perform _exp(current_date - 2, 'Costco', 'Ingredients', 120);
  s := weekly_summary(current_date);
  perform _expect('summary: this week spent includes the new charges', ((s->>'spent')::numeric >= 120)::int, 1);
  perform _expect('summary: top categories are listed', (jsonb_array_length(s->'top_categories') >= 1)::int, 1);
  perform _expect('summary: the budget at 85% is flagged', (select count(*) from jsonb_array_elements(s->'budgets') b where b->>'category' = 'Marketing'), 1);
  perform _expect('summary: bills in the next 7 days are listed', ((select count(*) from jsonb_array_elements(s->'bills') b where b->>'vendor' = 'Weekly thing') >= 1)::int, 1);
  perform _expect('summary: price jumps are listed', (select count(*) from jsonb_array_elements(s->'price_jumps') j where j->>'item' ilike '%butter%'), 1);
  perform _expect('summary: profit = sales - spent', ((s->>'profit')::numeric = (s->>'sales')::numeric - (s->>'spent')::numeric)::int, 1);
end $$;

rollback;
select 'ALL INSIGHT TESTS PASSED' as result;
