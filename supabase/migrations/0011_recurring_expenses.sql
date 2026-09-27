-- ============================================================================
-- 0011_recurring_expenses.sql : recurring expenses actually recur.
--
-- Until now, "Recurring: monthly" on an expense was informational only --
-- the Subscriptions & fixed costs panel annualised it, but no new row was
-- ever created, so a subscription only counted toward Total expenses in the
-- one month it happened to be dated. This makes it real:
--
--  * The first row with a given recurrence (recurring_parent_id is null) is
--    the "template". Its vendor, category, amount etc. are whatever the
--    owner last edited them to.
--  * generate_due_recurring_expenses() walks every template and, catching up
--    if it has been a while, inserts one new expense per elapsed period,
--    each linked back via recurring_parent_id and using the template's
--    CURRENT values -- so editing the template's price changes future
--    charges without touching past ones.
--  * A daily pg_cron job calls it automatically. Safe to also call by hand
--    (nothing is generated twice: each period only generates once, keyed by
--    date).
-- ============================================================================

create or replace function generate_due_recurring_expenses()
returns int language plpgsql security definer set search_path = public as $$
declare
  t record;
  v_last date;
  v_next date;
  v_created int := 0;
begin
  for t in
    select * from expenses
    where recurring_parent_id is null
      and recurrence <> 'none'
      and deleted_at is null
  loop
    select greatest(t.expense_date, coalesce(max(expense_date), t.expense_date))
      into v_last
      from expenses where recurring_parent_id = t.id and deleted_at is null;

    loop
      v_next := case t.recurrence
        when 'weekly'    then v_last + interval '7 days'
        when 'monthly'   then v_last + interval '1 month'
        when 'quarterly' then v_last + interval '3 months'
        when 'annual'    then v_last + interval '1 year'
      end;
      exit when v_next > current_date;

      insert into expenses (expense_date, vendor, category_id, description, amount_before_tax,
                            sales_tax_paid, payment_method, cost_type, notes, recurrence, recurring_parent_id)
      values (v_next, t.vendor, t.category_id, t.description, t.amount_before_tax,
              t.sales_tax_paid, t.payment_method, t.cost_type,
              'Generated automatically from the recurring subscription. Edit the original entry to change future amounts.',
              t.recurrence, t.id);

      v_created := v_created + 1;
      v_last := v_next;
    end loop;
  end loop;
  return v_created;
end $$;

-- Owners can trigger a catch-up by hand (e.g. right after adding a
-- subscription with a past start date) without waiting for the cron job.
grant execute on function generate_due_recurring_expenses() to authenticated;
revoke execute on function generate_due_recurring_expenses() from anon;

create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'generate-recurring-expenses',
  '0 6 * * *',   -- once a day; the loop above catches up on anything missed
  $$select generate_due_recurring_expenses()$$
) where not exists (select 1 from cron.job where jobname = 'generate-recurring-expenses');

-- Run once immediately so anything already due (unlikely today, but future
-- migrations replaying this file should not have to wait for the cron tick).
select generate_due_recurring_expenses();
