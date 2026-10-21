-- 0080: Texas sales tax, delivery zones and driver tips (2026-10-21).
-- The business holds a Texas Sales and Use Tax Permit (first business date 2026-10-01).
-- Location: City of Dallas + Dallas MTA (DART), combined rate 8.25% (6.25% state + 1% city + 1% transit).
--
-- What changes:
--  * products.tax_status: 'nontaxable' is renamed 'exempt' (bakery items sold without utensils).
--    'review' is CHARGED AS TAXABLE (safe side) until the owner decides.
--  * tax_settings: tax_enabled, tax_delivery_mode ('none' | 'proportional' | 'all'), tax_start_date.
--    The rate stays in tax_settings.default_tax_rate (editable on the dashboard; the only place it lives).
--  * orders: integer-cent tax columns (taxable_subtotal_cents, item_tax_cents, delivery_tax_cents, tax_cents),
--    tip columns (tip_cents, tip_percent, tip_type, tip_paid_out). tax_rate_applied stays the frozen rate.
--    total = greatest(subtotal - discount, 0) + delivery_fee + tax + tip, kept by the triggers below.
--  * order_items: tax_status and tax_cents snapshotted at order time (later product edits never rewrite history).
--  * calc_order_tax() mirrors supabase/functions/_shared/tax.ts line for line (integer cents, half-up rounding).
--    create-order checks that the TypeScript and SQL numbers agree before an order is confirmed.
--  * Tips are a pass-through to the driver: never taxed, never in net_product_sales / delivery_revenue, so they
--    never count towards revenue, profit or the $150,000 cottage-food sales total (weekly_summary and the
--    dashboard read net_product_sales + delivery_revenue only).
--
-- Delivery zones (0-5 mi $5, 5-10 mi $8, 10-15 mi $12, beyond +$1.50 per started mile) live only in
-- supabase/functions/_shared/delivery.ts; the fee reaches the database as orders.delivery_fee.

-- ---------------------------------------------------------------- 1. tax status values
alter type tax_status rename value 'nontaxable' to 'exempt';

-- ---------------------------------------------------------------- 2. settings
alter table tax_settings
  add column if not exists tax_enabled        boolean not null default true,
  add column if not exists tax_delivery_mode  text    not null default 'proportional',
  add column if not exists tax_start_date     date    not null default '2026-10-01';
alter table tax_settings drop constraint if exists tax_settings_delivery_mode_chk;
alter table tax_settings add constraint tax_settings_delivery_mode_chk check (tax_delivery_mode in ('none', 'proportional', 'all'));
update tax_settings set default_tax_rate = 0.0825, tax_enabled = true, tax_delivery_mode = 'proportional', tax_start_date = '2026-10-01',
  jurisdiction_note = 'City of Dallas + Dallas MTA (DART): 6.25% state + 1% city + 1% transit = 8.25%. Permit first business date 2026-10-01. Confirm the feteer exemption and the delivery-tax mode with the Texas Comptroller (800-252-5555).'
where id = 1;

-- ---------------------------------------------------------------- 3. columns
alter table orders
  add column if not exists taxable_subtotal_cents int not null default 0,
  add column if not exists item_tax_cents         int not null default 0,
  add column if not exists delivery_tax_cents     int not null default 0,
  add column if not exists tax_cents              int not null default 0,
  add column if not exists tip_cents              int not null default 0,
  add column if not exists tip_percent            int,
  add column if not exists tip_type               text not null default 'none',
  add column if not exists tip_paid_out           boolean not null default false,
  add column if not exists tip_paid_out_at        timestamptz;
alter table orders drop constraint if exists orders_tip_cents_chk;
alter table orders add constraint orders_tip_cents_chk check (tip_cents >= 0);
alter table orders drop constraint if exists orders_tip_type_chk;
alter table orders add constraint orders_tip_type_chk check (tip_type in ('none', 'percent', 'custom'));
alter table orders drop constraint if exists orders_tip_percent_chk;
alter table orders add constraint orders_tip_percent_chk check (tip_percent is null or tip_percent in (10, 15, 20));

alter table order_items
  add column if not exists tax_status tax_status,
  add column if not exists tax_cents  int not null default 0;

-- mirror columns for the orders placed before this migration (tax was 0 on all of them)
update orders set tax_cents = round(tax_amount * 100)::int, item_tax_cents = round(tax_amount * 100)::int where tax_cents = 0 and tax_amount <> 0;

-- ---------------------------------------------------------------- 4. the tax formula (same as _shared/tax.ts)
-- num / den rounded half-up for non-negative integers (exact, no floating point)
create or replace function div_half_up(p_num bigint, p_den bigint) returns bigint
language sql immutable as $$
  select case when coalesce(p_den, 0) <= 0 or coalesce(p_num, 0) <= 0 then 0 else (p_num * 2 + p_den) / (p_den * 2) end
$$;

-- All inputs in cents. p_taxable_cents = dishes that are taxable or 'review'. Returns the base the item
-- tax was charged on (taxable dishes after their share of the discount), the item tax and the delivery tax.
create or replace function calc_order_tax(p_sub_cents bigint, p_taxable_cents bigint, p_discount_cents bigint, p_delivery_cents bigint,
                                          p_rate numeric, p_mode text, p_enabled boolean,
                                          out net_taxable_cents bigint, out item_tax_cents bigint, out delivery_tax_cents bigint)
language plpgsql immutable as $$
declare
  v_bp bigint := greatest(0, round(coalesce(p_rate, 0) * 10000))::bigint;   -- 0.0825 -> 825 basis points
  v_disc bigint; v_share bigint; v_net_sub bigint;
begin
  net_taxable_cents := 0; item_tax_cents := 0; delivery_tax_cents := 0;
  if not coalesce(p_enabled, true) or v_bp = 0 or coalesce(p_taxable_cents, 0) <= 0 then return; end if;
  v_disc := least(greatest(coalesce(p_discount_cents, 0), 0), coalesce(p_sub_cents, 0));
  v_share := case when p_sub_cents > 0 then div_half_up(v_disc * p_taxable_cents, p_sub_cents) else 0 end;
  net_taxable_cents := greatest(0, p_taxable_cents - v_share);
  v_net_sub := greatest(0, p_sub_cents - v_disc);
  item_tax_cents := div_half_up(net_taxable_cents * v_bp, 10000);
  if coalesce(p_delivery_cents, 0) > 0 and net_taxable_cents > 0 then
    if p_mode = 'all' then delivery_tax_cents := div_half_up(p_delivery_cents * v_bp, 10000);
    elsif p_mode = 'proportional' and v_net_sub > 0 then delivery_tax_cents := div_half_up(p_delivery_cents * v_bp * net_taxable_cents, 10000 * v_net_sub);
    end if;
  end if;
end $$;

-- Every money number of one order from its lines + the given discount / fee / rate / tip. Used by
-- recalc_order (items or payments changed) and orders_before_update (discount, fee, rate or tip edited).
create or replace function order_money(p_order_id uuid, p_discount numeric, p_delivery_fee numeric, p_rate numeric,
                                       p_manual boolean, p_manual_tax numeric, p_incl boolean, p_tip_cents int,
                                       out subtotal numeric, out taxable_subtotal_cents int, out item_tax_cents int, out delivery_tax_cents int,
                                       out tax_cents int, out tax_amount numeric, out total numeric)
language plpgsql stable as $$
declare v_sub_c bigint; v_tax_c bigint; v_mode text; v_enabled boolean; v_nt bigint; v_it bigint; v_dt bigint;
begin
  select coalesce(sum(round(line_total * 100)), 0)::bigint, coalesce(sum(case when is_taxable then round(line_total * 100) else 0 end), 0)::bigint
    into v_sub_c, v_tax_c from order_items where order_id = p_order_id;
  select tax_delivery_mode, tax_enabled into v_mode, v_enabled from tax_settings where id = 1;
  if coalesce(p_manual, false) then
    v_nt := v_tax_c; v_it := round(coalesce(p_manual_tax, 0) * 100)::bigint; v_dt := 0;     -- owner typed the tax by hand
  elsif coalesce(p_incl, false) then
    v_nt := 0; v_it := 0; v_dt := 0;                                                       -- tax inside the price: reported, not added
  else
    select c.net_taxable_cents, c.item_tax_cents, c.delivery_tax_cents into v_nt, v_it, v_dt
      from calc_order_tax(v_sub_c, v_tax_c, round(coalesce(p_discount, 0) * 100)::bigint, round(coalesce(p_delivery_fee, 0) * 100)::bigint,
                          p_rate, coalesce(v_mode, 'proportional'), coalesce(v_enabled, true)) c;
  end if;
  subtotal := v_sub_c / 100.0;
  taxable_subtotal_cents := v_nt; item_tax_cents := v_it; delivery_tax_cents := v_dt; tax_cents := v_it + v_dt;
  tax_amount := (v_it + v_dt) / 100.0;
  total := greatest(subtotal - coalesce(p_discount, 0), 0) + coalesce(p_delivery_fee, 0) + tax_amount + coalesce(p_tip_cents, 0) / 100.0;
end $$;

-- Per-line share of the item tax (records only): proportional to the line price, rounding difference on the largest taxable line.
create or replace function split_line_tax(p_order_id uuid) returns void language plpgsql as $$
declare v_item bigint; v_taxable bigint; v_sum bigint; v_big uuid;
begin
  select item_tax_cents into v_item from orders where id = p_order_id;
  select coalesce(sum(case when is_taxable then round(line_total * 100) else 0 end), 0)::bigint into v_taxable from order_items where order_id = p_order_id;
  update order_items set tax_cents = case when is_taxable and v_taxable > 0 then div_half_up(coalesce(v_item, 0) * round(line_total * 100)::bigint, v_taxable) else 0 end::int
   where order_id = p_order_id;
  select coalesce(sum(tax_cents), 0) into v_sum from order_items where order_id = p_order_id;
  if v_sum <> coalesce(v_item, 0) then
    select id into v_big from order_items where order_id = p_order_id and is_taxable order by line_total desc, id limit 1;
    if v_big is not null then update order_items set tax_cents = tax_cents + (coalesce(v_item, 0) - v_sum)::int where id = v_big; end if;
  end if;
end $$;

-- ---------------------------------------------------------------- 5. order totals (replaces 0001 recalc_order / orders_before_update)
create or replace function recalc_order(p_order_id uuid)
returns void language plpgsql as $$
declare
  v_o orders%rowtype; m record; v_paid numeric; v_refunded numeric; v_pstatus payment_status;
begin
  select * into v_o from orders where id = p_order_id;
  if not found then return; end if;
  select * into m from order_money(p_order_id, v_o.discount, v_o.delivery_fee, v_o.tax_rate_applied, v_o.tax_manually_set, v_o.tax_amount, v_o.prices_include_tax, v_o.tip_cents);
  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order_id and voided_at is null;
  select coalesce(sum(amount), 0) into v_refunded from refunds where order_id = p_order_id and voided_at is null;

  update orders set
    subtotal = m.subtotal, taxable_subtotal_cents = m.taxable_subtotal_cents, item_tax_cents = m.item_tax_cents,
    delivery_tax_cents = m.delivery_tax_cents, tax_cents = m.tax_cents, tax_amount = m.tax_amount, total = m.total,
    amount_paid = v_paid, amount_refunded = v_refunded
  where id = p_order_id;
  perform split_line_tax(p_order_id);

  -- derive payment status unless it has been set to a "special" state by hand
  select * into v_o from orders where id = p_order_id;
  if v_o.payment_status = 'disputed' then return; end if;
  if v_refunded > 0 and v_refunded >= v_paid then v_pstatus := 'refunded';
  elsif v_refunded > 0 then v_pstatus := 'partially_refunded';
  elsif v_paid <= 0 then v_pstatus := 'unpaid';
  elsif v_paid >= v_o.total then v_pstatus := 'paid';
  elsif v_o.payment_status = 'deposit_received' then v_pstatus := 'deposit_received';
  else v_pstatus := 'partially_paid';
  end if;
  update orders set payment_status = v_pstatus where id = p_order_id and payment_status is distinct from v_pstatus;
end $$;

-- split_line_tax writes order_items.tax_cents; the items trigger must not fire on that write (it would loop),
-- so it now lists the columns that change the money.
drop trigger if exists order_items_recalc on order_items;
create trigger order_items_recalc after insert or delete or update of quantity, unit_price, line_total, is_taxable, tax_status, product_id
  on order_items for each row execute function order_items_changed();

create or replace function orders_before_update()
returns trigger language plpgsql as $$
declare m record;
begin
  if new.discount is distinct from old.discount or new.delivery_fee is distinct from old.delivery_fee
     or new.tax_rate_applied is distinct from old.tax_rate_applied or new.tax_amount is distinct from old.tax_amount
     or new.tax_manually_set is distinct from old.tax_manually_set or new.prices_include_tax is distinct from old.prices_include_tax
     or new.tip_cents is distinct from old.tip_cents then
    select * into m from order_money(new.id, new.discount, new.delivery_fee, new.tax_rate_applied, new.tax_manually_set, new.tax_amount, new.prices_include_tax, new.tip_cents);
    new.subtotal := m.subtotal; new.taxable_subtotal_cents := m.taxable_subtotal_cents; new.item_tax_cents := m.item_tax_cents;
    new.delivery_tax_cents := m.delivery_tax_cents; new.tax_cents := m.tax_cents; new.tax_amount := m.tax_amount; new.total := m.total;
  end if;
  if new.tip_paid_out and not old.tip_paid_out and new.tip_paid_out_at is null then new.tip_paid_out_at := now(); end if;
  if not new.tip_paid_out then new.tip_paid_out_at := null; end if;

  -- status bookkeeping
  if new.status is distinct from old.status then
    insert into order_status_history (order_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
    if new.status = 'confirmed' and new.confirmed_at is null then new.confirmed_at := now(); end if;
    if new.status = 'completed' and new.completed_at is null then new.completed_at := now(); end if;
    if new.status = 'cancelled' and new.cancelled_at is null then new.cancelled_at := now(); end if;
  end if;
  return new;
end $$;

-- after the item tax changed (discount or fee edited on the dashboard), refresh the per-line split
create or replace function orders_after_update() returns trigger language plpgsql as $$
begin
  if new.item_tax_cents is distinct from old.item_tax_cents then perform split_line_tax(new.id); end if;
  return null;
end $$;
drop trigger if exists orders_after_update_trg on orders;
create trigger orders_after_update_trg after update on orders for each row execute function orders_after_update();

-- ---------------------------------------------------------------- 6. intake and manual add snapshot the tax status
create or replace function intake_website_order(p_token text, p_customer jsonb, p_items jsonb)
returns text
language plpgsql
security definer set search_path = public as $$
declare
  v_order_id uuid;
  v_number text;
  v_customer_id uuid;
  v_it jsonb;
  v_p products%rowtype;
  v_rate numeric; v_incl boolean; v_enabled boolean; v_labor_rate numeric;
  v_phone_digits text := coalesce(p_customer->>'phone_digits', '');
begin
  select order_number into v_number from orders where checkout_token = p_token;
  if found then return v_number; end if;

  for v_it in select * from jsonb_array_elements(p_items) loop
    perform 1 from products where slug = v_it->>'slug' and is_active and deleted_at is null;
    if not found then raise exception 'PRODUCT_NOT_FOUND: %', v_it->>'slug'; end if;
  end loop;

  select default_tax_rate, prices_include_tax, tax_enabled into v_rate, v_incl, v_enabled from tax_settings where id = 1;
  select default_labor_rate_per_hour into v_labor_rate from business_settings where id = 1;

  if v_phone_digits <> '' then
    select id into v_customer_id from customers
    where phone_normalized = v_phone_digits and deleted_at is null
    order by created_at limit 1;
  end if;
  if v_customer_id is null then
    insert into customers (name, phone, phone_normalized)
    values (p_customer->>'name', p_customer->>'phone', v_phone_digits)
    returning id into v_customer_id;
  end if;
  update customer_addresses set is_default = false where customer_id = v_customer_id;
  insert into customer_addresses (customer_id, street, apt, city, state, zip, instructions, is_default)
  values (v_customer_id, p_customer->>'street', coalesce(p_customer->>'apt', ''), p_customer->>'city',
          p_customer->>'state', p_customer->>'zip', coalesce(p_customer->>'instructions', ''), true);

  v_number := next_order_number();

  -- the rate is frozen on the order; 0 when tax is switched off in the dashboard
  insert into orders (order_number, checkout_token, source, customer_id, customer_name, customer_phone,
                      delivery_method, address_street, address_apt, address_city, address_state, address_zip,
                      delivery_instructions, requested_at, tax_rate_applied, prices_include_tax)
  values (v_number, p_token, 'website', v_customer_id, p_customer->>'name', p_customer->>'phone',
          'delivery', p_customer->>'street', coalesce(p_customer->>'apt', ''), p_customer->>'city',
          p_customer->>'state', p_customer->>'zip', coalesce(p_customer->>'instructions', ''),
          nullif(p_customer->>'requested_at', '')::timestamptz,
          case when coalesce(v_enabled, true) then coalesce(v_rate, 0) else 0 end, coalesce(v_incl, false))
  returning id into v_order_id;

  for v_it in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products where slug = v_it->>'slug';
    -- 'review' is charged as taxable (safe side) until the owner decides
    insert into order_items (order_id, product_id, product_name, options, quantity, unit_price, line_total, is_taxable, tax_status,
                             unit_ingredient_cost, unit_packaging_cost, unit_labor_cost, unit_other_cost)
    values (v_order_id, v_p.id, v_p.name, coalesce(v_it->>'options', ''), (v_it->>'quantity')::int, v_p.selling_price, 0,
            v_p.tax_status <> 'exempt', v_p.tax_status,
            v_p.ingredient_cost, v_p.packaging_cost, round(v_p.labor_minutes / 60.0 * coalesce(v_labor_rate, 0), 4), v_p.other_direct_cost);
  end loop;

  perform recalc_order(v_order_id);
  return v_number;
end $$;
revoke all on function intake_website_order(text, jsonb, jsonb) from public, anon, authenticated;

create or replace function add_order_item(p_order_id uuid, p_product_id uuid, p_quantity int, p_options text default '')
returns uuid language plpgsql security invoker as $$
declare v_p products%rowtype; v_rate numeric; v_id uuid;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  select * into v_p from products where id = p_product_id and deleted_at is null;
  if not found then raise exception 'product not found'; end if;
  select default_labor_rate_per_hour into v_rate from business_settings where id = 1;
  insert into order_items (order_id, product_id, product_name, options, quantity, unit_price, line_total, is_taxable, tax_status,
                           unit_ingredient_cost, unit_packaging_cost, unit_labor_cost, unit_other_cost)
  values (p_order_id, v_p.id, v_p.name, coalesce(p_options, ''), p_quantity, v_p.selling_price, 0,
          v_p.tax_status <> 'exempt', v_p.tax_status,
          v_p.ingredient_cost, v_p.packaging_cost, round(v_p.labor_minutes / 60.0 * coalesce(v_rate, 0), 4), v_p.other_direct_cost)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- 7. the financial view: tax detail and the tip (new columns at the end)
-- Revenue (net_product_sales, delivery_revenue) never includes sales tax or tips.
create or replace view order_financials as
select
  o.id, o.order_number, o.created_at, o.completed_at, o.status, o.payment_status, o.payment_method,
  o.delivery_method, o.customer_id, o.customer_name, o.customer_phone,
  o.subtotal                                                   as gross_product_revenue,
  o.discount,
  o.subtotal - o.discount                                      as net_product_sales,
  case when o.delivery_fee_customer_paid then o.delivery_fee else 0 end as delivery_revenue,
  o.tax_amount,
  o.total,
  o.amount_paid,
  o.amount_refunded,
  o.total - o.amount_paid + o.amount_refunded                  as balance_due,
  coalesce(i.cogs, 0)                                          as cogs,
  coalesce(i.packaging_cost, 0)                                as packaging_cost,
  coalesce(i.labor_cost, 0)                                    as labor_cost,
  coalesce(d.actual_cost, 0)                                   as delivery_cost,
  coalesce(i.items_count, 0)                                   as items_count,
  (o.subtotal - o.discount) - coalesce(i.cogs, 0)              as gross_profit,
  (o.subtotal - o.discount)
    + case when o.delivery_fee_customer_paid then o.delivery_fee else 0 end
    - coalesce(i.cogs, 0) - coalesce(d.actual_cost, 0)         as contribution_profit,
  o.deleted_at,
  o.taxable_subtotal_cents, o.item_tax_cents, o.delivery_tax_cents, o.tax_cents, o.tax_rate_applied,
  o.tip_cents, o.tip_percent, o.tip_type, o.tip_paid_out, o.tip_paid_out_at, o.delivery_fee
from orders o
left join (
  select order_id,
         sum(quantity)                                               as items_count,
         sum(quantity * (unit_ingredient_cost + unit_packaging_cost + unit_other_cost)) as cogs,
         sum(quantity * unit_packaging_cost)                          as packaging_cost,
         sum(quantity * unit_labor_cost)                              as labor_cost
  from order_items group by order_id
) i on i.order_id = o.id
left join delivery_records d on d.order_id = o.id;
alter view order_financials set (security_invoker = on);

-- ---------------------------------------------------------------- 8. initial tax status per product (OWNER TO CONFIRM)
-- Taxable: hot/prepared meals and trays, soup, puddings, creme caramel, Om Ali, white cheese, dips, tahini, honeys, drinks.
update products set tax_status = 'taxable' where slug in (
  'feteer-beef', 'macarona-bechamel', 'goulash-beef', 'kofta-tray', 'meatballs-spaghetti', 'koshary',
  'lentil-soup',
  'chocolate-pudding', 'banana-pudding', 'rice-pudding', 'creme-caramel', 'om-ali',
  'white-cheese', 'hummus', 'baba-ganoush', 'tahini', 'black-honey', 'white-honey',
  'diet-coke', 'protein-shake', 'protein-shake-almond', 'avocado-drink', 'avocado-drink-almond'
);
-- Exempt: bakery items sold without eating utensils (Texas Tax Code 151.314(c)).
update products set tax_status = 'exempt' where slug in ('feteer-meshaltet', 'round-cake', 'goulash-nuts');
-- Combos: taxable when ANY item inside can be taxable. Every current combo bundles at least one prepared dish,
-- dip, pudding or drink, so all of them are taxable in full (a bundle is one taxable sale).
update products set tax_status = 'taxable' where slug in (
  'egyptian-breakfast', 'family-feast', 'meal-for-one', 'party-tray', 'pick-3-puddings', 'feteer-dip-trio', 'feteer-and-dip-trio'
);
-- Everything else (orzo-soup, koshary-sauce, retired items) stays 'review' = charged as taxable until the owner decides.
