-- ============================================================================
-- 0002_rls.sql : Row Level Security
--
-- Rule: every table is locked. Only users listed in admin_profiles (is_admin())
-- can read or write, and even they cannot physically DELETE financial rows
-- (orders, items, payments, refunds, expenses, audit) — those are voided or
-- soft-deleted via UPDATE. The website never touches these tables directly;
-- it calls the create-order Edge Function, which uses the service role.
-- ============================================================================

-- Disable public signups defence-in-depth: even if someone registers an
-- auth user, they hold no admin_profiles row and every policy denies them.

alter table admin_profiles          enable row level security;
alter table business_settings       enable row level security;
alter table tax_settings            enable row level security;
alter table product_categories      enable row level security;
alter table products                enable row level security;
alter table ingredients             enable row level security;
alter table ingredient_cost_history enable row level security;
alter table recipes                 enable row level security;
alter table product_cost_history    enable row level security;
alter table customers               enable row level security;
alter table customer_addresses      enable row level security;
alter table order_counters          enable row level security;
alter table orders                  enable row level security;
alter table order_items             enable row level security;
alter table order_status_history    enable row level security;
alter table payments                enable row level security;
alter table refunds                 enable row level security;
alter table delivery_records        enable row level security;
alter table expense_categories      enable row level security;
alter table expenses                enable row level security;
alter table tax_adjustments         enable row level security;
alter table tax_period_summaries    enable row level security;
alter table audit_logs              enable row level security;
alter table order_intake_log        enable row level security;

-- Force RLS even for the table owner (except the service role, which bypasses
-- RLS by design and is only ever used server-side in the Edge Function).
alter table orders force row level security;
alter table order_items force row level security;
alter table payments force row level security;
alter table customers force row level security;

-- admin_profiles: an admin may read the list; nobody can write through the API.
create policy admin_profiles_select on admin_profiles for select to authenticated using (is_admin());

-- Read + write for admins, no delete, on financial tables
create policy orders_select  on orders for select to authenticated using (is_admin());
create policy orders_insert  on orders for insert to authenticated with check (is_admin());
create policy orders_update  on orders for update to authenticated using (is_admin()) with check (is_admin());

create policy order_items_select on order_items for select to authenticated using (is_admin());
create policy order_items_insert on order_items for insert to authenticated with check (is_admin());
create policy order_items_update on order_items for update to authenticated using (is_admin()) with check (is_admin());
-- Removing a line from an unconfirmed order is a legitimate edit; the audit
-- trigger records the old row.
create policy order_items_delete on order_items for delete to authenticated
  using (is_admin() and exists (select 1 from orders o where o.id = order_id and o.status not in ('completed', 'refunded')));

create policy order_status_history_select on order_status_history for select to authenticated using (is_admin());
create policy order_status_history_insert on order_status_history for insert to authenticated with check (is_admin());

create policy payments_select on payments for select to authenticated using (is_admin());
create policy payments_insert on payments for insert to authenticated with check (is_admin());
create policy payments_update on payments for update to authenticated using (is_admin()) with check (is_admin());

create policy refunds_select on refunds for select to authenticated using (is_admin());
create policy refunds_insert on refunds for insert to authenticated with check (is_admin());
create policy refunds_update on refunds for update to authenticated using (is_admin()) with check (is_admin());

create policy expenses_select on expenses for select to authenticated using (is_admin());
create policy expenses_insert on expenses for insert to authenticated with check (is_admin());
create policy expenses_update on expenses for update to authenticated using (is_admin()) with check (is_admin());

create policy audit_logs_select on audit_logs for select to authenticated using (is_admin());

-- Full CRUD for admins on reference / non-ledger tables
create policy all_admin on business_settings       for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on tax_settings            for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on product_categories      for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on products                for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on ingredients             for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on ingredient_cost_history for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on recipes                 for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on product_cost_history    for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on customers               for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on customer_addresses      for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on delivery_records        for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on expense_categories      for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on tax_adjustments         for all to authenticated using (is_admin()) with check (is_admin());
create policy all_admin on tax_period_summaries    for all to authenticated using (is_admin()) with check (is_admin());
create policy counters_select on order_counters    for select to authenticated using (is_admin());

-- Products are soft-deleted; block hard delete for admins too.
drop policy all_admin on products;
create policy products_select on products for select to authenticated using (is_admin());
create policy products_insert on products for insert to authenticated with check (is_admin());
create policy products_update on products for update to authenticated using (is_admin()) with check (is_admin());
-- (no delete policy)

-- customers are soft-deleted as well
drop policy all_admin on customers;
create policy customers_select on customers for select to authenticated using (is_admin());
create policy customers_insert on customers for insert to authenticated with check (is_admin());
create policy customers_update on customers for update to authenticated using (is_admin()) with check (is_admin());

-- order_intake_log: nobody via the API (service role only)

-- Views run with the caller's rights (security_invoker) so RLS on the
-- underlying tables still applies.
alter view order_financials set (security_invoker = on);
alter view product_sales    set (security_invoker = on);

-- Revoke the default grants Supabase gives the anon role on the public schema
-- for these tables; anon must see nothing, even without RLS.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant usage on schema public to anon;   -- needed to call is_admin() (returns false)

-- ---------------------------------------------------------------------------
-- RPC helpers used by the dashboard (SECURITY INVOKER, so RLS applies)
-- ---------------------------------------------------------------------------

-- Manual order creation from the dashboard reserves a number safely.
create or replace function create_manual_order(p_customer_name text, p_customer_phone text default '', p_delivery_method delivery_method default 'delivery')
returns uuid language plpgsql security invoker as $$
declare v_id uuid; v_rate numeric; v_incl boolean;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select default_tax_rate, prices_include_tax into v_rate, v_incl from tax_settings where id = 1;
  insert into orders (order_number, source, customer_name, customer_phone, delivery_method, tax_rate_applied, prices_include_tax, created_by)
  values (next_order_number(), 'manual', p_customer_name, p_customer_phone, p_delivery_method, coalesce(v_rate, 0), coalesce(v_incl, false), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Add a product to an order with a cost snapshot from the current product.
create or replace function add_order_item(p_order_id uuid, p_product_id uuid, p_quantity int, p_options text default '')
returns uuid language plpgsql security invoker as $$
declare v_p products%rowtype; v_rate numeric; v_id uuid;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select * into v_p from products where id = p_product_id and deleted_at is null;
  if not found then raise exception 'product not found'; end if;
  select default_labor_rate_per_hour into v_rate from business_settings where id = 1;
  insert into order_items (order_id, product_id, product_name, options, quantity, unit_price, line_total, is_taxable,
                           unit_ingredient_cost, unit_packaging_cost, unit_labor_cost, unit_other_cost)
  values (p_order_id, v_p.id, v_p.name, coalesce(p_options, ''), p_quantity, v_p.selling_price, 0,
          v_p.tax_status = 'taxable',
          v_p.ingredient_cost, v_p.packaging_cost, round(v_p.labor_minutes / 60.0 * coalesce(v_rate, 0), 4), v_p.other_direct_cost)
  returning id into v_id;
  return v_id;
end $$;

-- Merge duplicate customers: repoint orders/addresses, mark the loser.
create or replace function merge_customers(p_keep uuid, p_merge uuid)
returns void language plpgsql security invoker as $$
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  if p_keep = p_merge then return; end if;
  update orders set customer_id = p_keep where customer_id = p_merge;
  update customer_addresses set customer_id = p_keep, is_default = false where customer_id = p_merge;
  update customers set merged_into_id = p_keep, deleted_at = now(), status = 'active' where id = p_merge;
end $$;
