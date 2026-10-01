-- ============================================================================
-- 0056_expense_insights.sql : budgets, bills coming up, ingredient price jumps, weekly summary.
--
--  * expense_budgets    : an optional monthly limit per category
--  * budget_status()    : spent this month vs the limit (split-aware, from expense_tax_view)
--  * upcoming_bills()   : the next due dates of every subscription / fixed cost (one source for the
--                         dashboard card and the Telegram summary)
--  * ingredient_price_jumps() : the same ingredient bought from the same store, now clearly dearer
--  * weekly_summary()   : everything the Monday Telegram message says, as one JSON object
-- ============================================================================

create table if not exists expense_budgets (
  category_id    uuid primary key references expense_categories(id) on delete cascade,
  monthly_limit  numeric(12,2) not null check (monthly_limit > 0),
  updated_at     timestamptz not null default now()
);
alter table expense_budgets enable row level security;
drop policy if exists expense_budgets_all on expense_budgets;
create policy expense_budgets_all on expense_budgets for all to authenticated using (is_admin()) with check (is_admin());
drop trigger if exists expense_budgets_updated on expense_budgets;
create trigger expense_budgets_updated before update on expense_budgets for each row execute function set_updated_at();

-- ------------------------------------------------------------------ budgets vs spending (one calendar month)
create or replace function budget_status(p_month date default current_date)
returns table (category_id uuid, category text, spent numeric, monthly_limit numeric, pct numeric)
language sql stable security invoker set search_path = public as $$
  select b.category_id, c.name,
         coalesce((select sum(v.total_amount) from expense_tax_view v
                    where v.category_id = b.category_id
                      and v.expense_date >= date_trunc('month', p_month)::date
                      and v.expense_date < (date_trunc('month', p_month) + interval '1 month')::date), 0) as spent,
         b.monthly_limit,
         round(coalesce((select sum(v.total_amount) from expense_tax_view v
                    where v.category_id = b.category_id
                      and v.expense_date >= date_trunc('month', p_month)::date
                      and v.expense_date < (date_trunc('month', p_month) + interval '1 month')::date), 0) / b.monthly_limit * 100, 1) as pct
    from expense_budgets b join expense_categories c on c.id = b.category_id
   order by 5 desc
$$;
grant execute on function budget_status(date) to authenticated;

-- ------------------------------------------------------------------ bills coming up
-- Every subscription / fixed cost template, walked forward from its last generated charge.
create or replace function upcoming_bills(p_days int default 30)
returns table (vendor text, description text, amount numeric, due date, recurrence text, expense_id uuid)
language plpgsql stable security invoker set search_path = public as $$
declare t record; v_last date; v_next date; v_end date := current_date + p_days; n int;
begin
  for t in select * from expenses ex where ex.recurring_parent_id is null and ex.recurrence <> 'none' and ex.deleted_at is null loop
    select greatest(t.expense_date, coalesce(max(c.expense_date), t.expense_date)) into v_last
      from expenses c where c.recurring_parent_id = t.id and c.deleted_at is null;
    n := 0;
    loop
      v_next := case t.recurrence
        when 'weekly'    then v_last + 7
        when 'monthly'   then (v_last + interval '1 month')::date
        when 'quarterly' then (v_last + interval '3 months')::date
        when 'annual'    then (v_last + interval '1 year')::date end;
      exit when v_next > v_end or n >= 60;
      vendor := t.vendor; description := t.description; amount := t.total_amount; due := v_next; recurrence := t.recurrence; expense_id := t.id;
      return next;
      v_last := v_next; n := n + 1;
    end loop;
  end loop;
end $$;
grant execute on function upcoming_bills(int) to authenticated;

-- ------------------------------------------------------------------ ingredient price jumps
-- The latest purchase of an item is compared with the one before it, SAME store only (stores differ naturally).
create or replace function ingredient_price_jumps(p_days int default 14, p_min numeric default 0.15)
returns table (item text, store text, old_price numeric, new_price numeric, pct numeric, bought_on date)
language sql stable security invoker set search_path = public as $$
  with items as (
    select item_key(i.description) as k, i.description, i.unit_price, e.expense_date, e.vendor, e.id as eid,
           row_number() over (partition by item_key(i.description), normalize_vendor(e.vendor) order by e.expense_date desc, e.created_at desc) as rn
      from expense_items i
      join expenses e on e.id = i.expense_id and e.deleted_at is null
      join expense_categories c on c.id = i.category_id and c.name = 'Ingredients'
     where i.is_business and i.unit_price > 0 and item_key(i.description) <> '')
  select a.description, a.vendor, b.unit_price, a.unit_price, round((a.unit_price - b.unit_price) / b.unit_price, 3), a.expense_date
    from items a join items b on b.k = a.k and normalize_vendor(b.vendor) = normalize_vendor(a.vendor) and a.rn = 1 and b.rn = 2 and a.eid <> b.eid
   where a.expense_date >= current_date - p_days and (a.unit_price - b.unit_price) / b.unit_price >= p_min
   order by 5 desc
$$;
grant execute on function ingredient_price_jumps(int, numeric) to authenticated;

-- ------------------------------------------------------------------ the Monday summary (previous Monday..Sunday)
create or replace function weekly_summary(p_to date default current_date - 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := p_to - 6; v_pfrom date := p_to - 13; v_pto date := p_to - 7;
  v_spent numeric; v_prev numeric; v_sales numeric; v_top jsonb; v_big jsonb; v_budgets jsonb; v_bills jsonb; v_jumps jsonb;
begin
  select coalesce(sum(total_amount), 0) into v_spent from expenses where deleted_at is null and auto_source is distinct from 'order_cost' and expense_date between v_from and p_to;
  select coalesce(sum(total_amount), 0) into v_prev  from expenses where deleted_at is null and auto_source is distinct from 'order_cost' and expense_date between v_pfrom and v_pto;
  select coalesce(sum(net_product_sales + delivery_revenue), 0) into v_sales from order_financials
   where deleted_at is null and status in ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed')
     and (created_at at time zone 'America/Chicago')::date between v_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('name', category_name, 'amount', amt) order by amt desc), '[]'::jsonb) into v_top from (
    select category_name, sum(total_amount) as amt from expense_tax_view
     where expense_date between v_from and p_to and category_name <> 'Personal (not business)' group by 1 order by 2 desc limit 3) x;

  select jsonb_build_object('vendor', vendor, 'amount', total_amount, 'date', expense_date) into v_big from expenses
   where deleted_at is null and auto_source is distinct from 'order_cost' and expense_date between v_from and p_to order by total_amount desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('category', category, 'spent', spent, 'limit', monthly_limit, 'pct', pct) order by pct desc), '[]'::jsonb) into v_budgets
    from budget_status(p_to) where pct >= 80;

  select coalesce(jsonb_agg(jsonb_build_object('vendor', vendor, 'amount', amount, 'due', due) order by due), '[]'::jsonb) into v_bills
    from (select * from upcoming_bills(7)) b;

  select coalesce(jsonb_agg(jsonb_build_object('item', item, 'store', store, 'old', old_price, 'new', new_price, 'pct', pct) order by pct desc), '[]'::jsonb) into v_jumps
    from (select * from ingredient_price_jumps(14, 0.15) limit 5) j;

  return jsonb_build_object(
    'from', v_from, 'to', p_to, 'spent', v_spent, 'prev_spent', v_prev, 'sales', v_sales, 'profit', v_sales - v_spent,
    'top_categories', v_top, 'biggest', v_big, 'budgets', v_budgets, 'bills', v_bills, 'price_jumps', v_jumps,
    'possible_duplicates', (select count(*) from expenses where deleted_at is null and review_status = 'possible_duplicate'),
    'needs_receipt', (select count(*) from needs_receipt_view),
    'waiting_receipts', (select count(*) from receipt_files where status in ('failed', 'waiting_key'))
  );
end $$;
revoke all on function weekly_summary(date) from public, anon, authenticated;
