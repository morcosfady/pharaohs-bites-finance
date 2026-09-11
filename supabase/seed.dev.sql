-- ============================================================================
-- DEVELOPMENT SAMPLE DATA — DO NOT RUN ON PRODUCTION
-- ----------------------------------------------------------------------------
-- Run only against a throwaway/dev Supabase project or a local instance:
--   supabase db reset            (applies migrations, then this file if
--                                 configured in config.toml) or
--   psql "$DEV_DB_URL" -f supabase/seed.dev.sql
-- Every row is tagged with "[SAMPLE]" in a notes/description field so it can
-- be recognised and removed: delete from orders where internal_notes like '[SAMPLE]%';
-- ============================================================================

-- guard: refuse to run if real website orders already exist
do $$ begin
  if exists (select 1 from orders where source = 'website' and internal_notes not like '[SAMPLE]%') then
    raise exception 'Refusing to seed: real orders exist in this database.';
  end if;
end $$;

-- ---- ingredients + recipe for Feteer Meshaltet ------------------------------
insert into ingredients (name, supplier, package_size, package_unit, package_price, waste_pct, notes) values
  ('All-purpose flour', 'Costco', 25, 'lb', 12.99, 0.02, '[SAMPLE]'),
  ('Ghee', 'Sam''s Club', 32, 'oz', 14.50, 0.01, '[SAMPLE]'),
  ('Plant-based ground beef', 'Kroger', 16, 'oz', 6.99, 0.03, '[SAMPLE]'),
  ('Mozzarella', 'Costco', 5, 'lb', 16.49, 0.02, '[SAMPLE]'),
  ('Red lentils', 'Halal market', 4, 'lb', 6.00, 0, '[SAMPLE]'),
  ('Pistachios', 'Halal market', 1, 'lb', 12.00, 0, '[SAMPLE]')
on conflict do nothing;

insert into recipes (product_id, ingredient_id, quantity, unit)
select p.id, i.id, q.qty, q.unit
from (values
  ('feteer-meshaltet', 'All-purpose flour', 1.0, 'lb'),
  ('feteer-meshaltet', 'Ghee', 4.0, 'oz'),
  ('feteer-beef', 'All-purpose flour', 1.0, 'lb'),
  ('feteer-beef', 'Ghee', 4.0, 'oz'),
  ('feteer-beef', 'Plant-based ground beef', 8.0, 'oz'),
  ('feteer-beef', 'Mozzarella', 6.0, 'oz'),
  ('lentil-soup', 'Red lentils', 0.5, 'lb')
) as q(slug, ing, qty, unit)
join products p on p.slug = q.slug
join ingredients i on i.name = q.ing
on conflict do nothing;

update products set packaging_cost = 1.25, labor_minutes = 20, tax_status = 'taxable' where slug in ('feteer-meshaltet', 'feteer-beef');
update products set packaging_cost = 0.60, labor_minutes = 5, tax_status = 'taxable' where slug = 'lentil-soup';
update products set packaging_cost = 2.00, labor_minutes = 25, tax_status = 'nontaxable' where slug = 'round-cake';
update products set packaging_cost = 1.50, labor_minutes = 15, tax_status = 'taxable' where slug = 'goulash-nuts';

-- ---- customers ---------------------------------------------------------------
insert into customers (name, phone, phone_normalized, status, internal_notes) values
  ('Yasmine F.', '+1 (214) 555-0101', '12145550101', 'vip', '[SAMPLE] Regular, loves feteer'),
  ('Mark Whitfield', '+1 (469) 555-0102', '14695550102', 'active', '[SAMPLE]'),
  ('Dina M.', '+1 (972) 555-0103', '19725550103', 'active', '[SAMPLE]');

-- ---- orders (helper) ---------------------------------------------------------
create or replace function _seed_order(p_customer text, p_days_ago int, p_status order_status, p_items jsonb, p_delivery numeric, p_paid numeric, p_method payment_method)
returns uuid language plpgsql as $$
declare v_id uuid; v_c customers%rowtype; v_it jsonb; v_p products%rowtype; v_rate numeric;
begin
  select * into v_c from customers where name = p_customer;
  select default_tax_rate into v_rate from tax_settings;
  insert into orders (order_number, source, customer_id, customer_name, customer_phone, address_street, address_city, address_state, address_zip,
                      status, delivery_fee, tax_rate_applied, internal_notes, created_at, payment_method)
  values (next_order_number(), 'website', v_c.id, v_c.name, v_c.phone, '1234 Elm St', 'Dallas', 'TX', '75201',
          'pending_whatsapp_confirmation', p_delivery, v_rate, '[SAMPLE] seeded order', now() - (p_days_ago || ' days')::interval, p_method)
  returning id into v_id;
  for v_it in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products where slug = v_it->>'slug';
    insert into order_items (order_id, product_id, product_name, quantity, unit_price, line_total, is_taxable, unit_ingredient_cost, unit_packaging_cost, unit_labor_cost)
    values (v_id, v_p.id, v_p.name, (v_it->>'qty')::int, v_p.selling_price, 0, v_p.tax_status = 'taxable', v_p.ingredient_cost, v_p.packaging_cost, round(v_p.labor_minutes / 60.0 * 15, 4));
  end loop;
  if p_delivery > 0 then
    insert into delivery_records (order_id, distance_miles, fee_charged, actual_cost, provider, status)
    values (v_id, 6.5, p_delivery, 4.35, 'owner', case when p_status = 'completed' then 'delivered' else 'not_started' end);
  end if;
  update orders set status = p_status where id = v_id;
  if p_paid > 0 then
    insert into payments (order_id, amount, method, reference, notes) values (v_id, p_paid, p_method, 'SEED-' || left(v_id::text, 6), '[SAMPLE]');
  end if;
  return v_id;
end $$;

select _seed_order('Yasmine F.', 20, 'completed', '[{"slug":"feteer-meshaltet","qty":2},{"slug":"lentil-soup","qty":1}]', 8, 46.89, 'zelle');
select _seed_order('Mark Whitfield', 14, 'completed', '[{"slug":"feteer-beef","qty":1},{"slug":"goulash-nuts","qty":1}]', 10, 45.72, 'venmo');
select _seed_order('Dina M.', 9, 'completed', '[{"slug":"round-cake","qty":1}]', 0, 12, 'cash');
select _seed_order('Yasmine F.', 5, 'confirmed', '[{"slug":"feteer-meshaltet","qty":3}]', 8, 20, 'zelle');   -- partially paid
select _seed_order('Mark Whitfield', 2, 'cancelled', '[{"slug":"feteer-beef","qty":2}]', 0, 0, null);
select _seed_order('Dina M.', 1, 'pending_whatsapp_confirmation', '[{"slug":"lentil-soup","qty":2},{"slug":"goulash-nuts","qty":1}]', 0, 0, null);
select _seed_order('Yasmine F.', 0, 'pending_whatsapp_confirmation', '[{"slug":"feteer-meshaltet","qty":1}]', 0, 0, null);

-- a refunded order
do $$ declare v uuid; begin
  v := _seed_order('Mark Whitfield', 7, 'completed', '[{"slug":"round-cake","qty":2}]', 5, 29, 'venmo');
  insert into refunds (order_id, amount, method, reason) values (v, 12, 'venmo', '[SAMPLE] one cake damaged');
  update orders set status = 'refunded' where id = v;
end $$;

drop function _seed_order(text, int, order_status, jsonb, numeric, numeric, payment_method);

-- ---- expenses ----------------------------------------------------------------
insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid, payment_method, cost_type)
select d, v, c.id, '[SAMPLE] ' || descr, amt, tax, pm::payment_method, c.cost_type
from (values
  (current_date - 18, 'Costco', 'Ingredients', 'Flour, ghee, mozzarella', 61.40, 0.00, 'card'),
  (current_date - 15, 'Uline', 'Pizza boxes', '50 x 14in boxes', 42.00, 3.47, 'card'),
  (current_date - 12, 'Amazon', 'Logo stickers', '500 round stickers', 18.99, 1.57, 'card'),
  (current_date - 10, 'Shell', 'Gas / mileage', 'Delivery fuel', 35.00, 0.00, 'cash'),
  (current_date - 6, 'Meta', 'Marketing', 'Instagram promotion', 25.00, 0.00, 'card'),
  (current_date - 3, 'GitHub', 'Website / technology', 'Hosting', 0.00, 0.00, 'other')
) as e(d, v, cat, descr, amt, tax, pm)
join expense_categories c on c.name = e.cat;
