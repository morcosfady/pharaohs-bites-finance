-- 0057: "no receipt on file" only counts purchases from a threshold up. Default $75, the line the IRS itself
-- draws for documentary evidence. It is a setting (Expenses -> Tax -> Tax settings) and an "Ask accountant"
-- topic, not a rule hidden in code. A charge below it still has its bank record as evidence of payment.
-- Also: an expense split across categories is counted once, not once per category line.

alter table expense_settings add column if not exists receipt_min_amount numeric(10,2) not null default 75 check (receipt_min_amount >= 0);

create or replace function tax_data_quality(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'needs_review',         (select count(*) from expense_tax_view where expense_date between p_from and p_to and review_status = 'needs_review'),
    'possible_duplicates',  (select count(*) from expense_tax_view where expense_date between p_from and p_to and review_status = 'possible_duplicate'),
    'uncategorized',        (select count(*) from expense_tax_view where expense_date between p_from and p_to and category_name = 'Uncategorized'),
    'missing_receipts',     (select count(distinct e.id) from expenses e
                              where e.deleted_at is null and e.auto_source is distinct from 'order_cost'
                                and e.expense_date between p_from and p_to and e.receipt_path = ''
                                and e.total_amount >= (select receipt_min_amount from expense_settings limit 1)
                                and not exists (select 1 from expense_sources s where s.expense_id = e.id and s.source_type in ('receipt', 'email', 'stripe', 'subscription'))),
    'receipt_min',          (select receipt_min_amount from expense_settings limit 1),
    'money_in_unclassified',(select count(*) from bank_transactions where kind = 'money_in' and posted_on between p_from and p_to),
    'mileage_without_rate', (select count(*) from mileage_log_view where counted and trip_date between p_from and p_to and deduction is null),
    'mileage_estimated',    (select count(*) from mileage_log_view where counted and estimated and trip_date between p_from and p_to),
    'ask_accountant',       (select count(*) from expense_tax_view where expense_date between p_from and p_to and ask_reason is not null)
  )
$$;
grant execute on function tax_data_quality(date, date) to authenticated;
