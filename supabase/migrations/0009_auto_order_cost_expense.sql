-- ============================================================================
-- 0009_auto_order_cost_expense.sql : every real order writes its own
-- ingredient/packaging cost into the Expenses tab automatically.
--
--  * Source of truth is the cost snapshot already stored on order_items, so
--    the number equals the order's COGS shown on the order page.
--  * Test orders (customer name "test", "Test 1", "test2", ...) are skipped.
--  * Cancelled or deleted orders archive their expense; un-cancelling brings
--    it back. Zero-cost orders (no costs entered yet) create nothing.
--  * The row is tagged auto_source = 'order_cost'. The dashboard treats these
--    as read-only and excludes them from "other variable costs" so the
--    order's cost is never counted twice (COGS already includes it).
-- ============================================================================

alter table expenses add column if not exists auto_source text;
create index if not exists expenses_auto_order_idx on expenses(order_id) where auto_source = 'order_cost';

create or replace function is_test_order_name(p_name text)
returns boolean language sql immutable as $$
  select coalesce(p_name, '') ~* '^\s*test(\s|\d|$)'
$$;

create or replace function sync_order_cost_expense(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_o      orders%rowtype;
  v_cost   numeric(12,2);
  v_cat    uuid;
  v_exp_id uuid;
  v_skip   boolean;
begin
  select * into v_o from orders where id = p_order_id;
  if not found then return; end if;

  select coalesce(sum(quantity * (unit_ingredient_cost + unit_packaging_cost + unit_other_cost)), 0)
    into v_cost from order_items where order_id = p_order_id;

  v_skip := is_test_order_name(v_o.customer_name)
         or v_o.status = 'cancelled'
         or v_o.deleted_at is not null
         or v_cost <= 0;

  select id into v_exp_id from expenses where order_id = p_order_id and auto_source = 'order_cost' limit 1;

  if v_skip then
    if v_exp_id is not null then
      update expenses set deleted_at = now() where id = v_exp_id and deleted_at is null;
    end if;
    return;
  end if;

  select id into v_cat from expense_categories where name = 'Ingredients' limit 1;

  if v_exp_id is null then
    insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                          cost_type, order_id, notes, auto_source, created_by)
    values ((v_o.created_at at time zone 'America/Chicago')::date, 'Kitchen', v_cat,
            'Ingredients & packaging for order ' || v_o.order_number || ' (' || v_o.customer_name || ')',
            v_cost, 0, 'direct_product', p_order_id,
            'Calculated automatically from the order''s cost snapshot. Edit the order, not this row.',
            'order_cost', v_o.created_by);
  else
    update expenses
       set expense_date = (v_o.created_at at time zone 'America/Chicago')::date,
           description = 'Ingredients & packaging for order ' || v_o.order_number || ' (' || v_o.customer_name || ')',
           amount_before_tax = v_cost, sales_tax_paid = 0, cost_type = 'direct_product',
           category_id = coalesce(category_id, v_cat), deleted_at = null
     where id = v_exp_id;
  end if;
end $$;

-- items change (website intake, manual add/edit/remove) -> recompute
create or replace function trg_order_items_cost_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform sync_order_cost_expense(coalesce(new.order_id, old.order_id));
  return coalesce(new, old);
end $$;
drop trigger if exists order_items_cost_expense on order_items;
create trigger order_items_cost_expense
  after insert or update or delete on order_items
  for each row execute function trg_order_items_cost_expense();

-- order renamed / cancelled / restored / deleted -> recompute
create or replace function trg_orders_cost_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform sync_order_cost_expense(new.id);
  return new;
end $$;
drop trigger if exists orders_cost_expense on orders;
create trigger orders_cost_expense
  after update of status, customer_name, deleted_at, created_at, order_number on orders
  for each row execute function trg_orders_cost_expense();

-- backfill every existing order once
select sync_order_cost_expense(id) from orders;
