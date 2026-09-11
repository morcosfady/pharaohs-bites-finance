-- ============================================================================
-- 0005_intake.sql : website order intake (called by the create-order Edge
-- Function with the service role). Runs as one transaction: order + items +
-- customer upsert either all succeed or nothing is written.
-- Prices, tax status and cost snapshots come from the products table only.
-- ============================================================================

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
  v_rate numeric; v_incl boolean; v_labor_rate numeric;
  v_phone_digits text := coalesce(p_customer->>'phone_digits', '');
begin
  -- Idempotency (belt and braces: the Edge Function also checks first)
  select order_number into v_number from orders where checkout_token = p_token;
  if found then return v_number; end if;

  -- Validate every product BEFORE writing anything
  for v_it in select * from jsonb_array_elements(p_items) loop
    perform 1 from products where slug = v_it->>'slug' and is_active and deleted_at is null;
    if not found then raise exception 'PRODUCT_NOT_FOUND: %', v_it->>'slug'; end if;
  end loop;

  select default_tax_rate, prices_include_tax into v_rate, v_incl from tax_settings where id = 1;
  select default_labor_rate_per_hour into v_labor_rate from business_settings where id = 1;

  -- Match or create the customer by normalised phone
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
  -- keep the latest address on file (one default)
  update customer_addresses set is_default = false where customer_id = v_customer_id;
  insert into customer_addresses (customer_id, street, apt, city, state, zip, instructions, is_default)
  values (v_customer_id, p_customer->>'street', coalesce(p_customer->>'apt', ''), p_customer->>'city',
          p_customer->>'state', p_customer->>'zip', coalesce(p_customer->>'instructions', ''), true);

  v_number := next_order_number();

  insert into orders (order_number, checkout_token, source, customer_id, customer_name, customer_phone,
                      delivery_method, address_street, address_apt, address_city, address_state, address_zip,
                      delivery_instructions, requested_at, tax_rate_applied, prices_include_tax)
  values (v_number, p_token, 'website', v_customer_id, p_customer->>'name', p_customer->>'phone',
          'delivery', p_customer->>'street', coalesce(p_customer->>'apt', ''), p_customer->>'city',
          p_customer->>'state', p_customer->>'zip', coalesce(p_customer->>'instructions', ''),
          nullif(p_customer->>'requested_at', '')::timestamptz, coalesce(v_rate, 0), coalesce(v_incl, false))
  returning id into v_order_id;

  for v_it in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products where slug = v_it->>'slug';
    insert into order_items (order_id, product_id, product_name, options, quantity, unit_price, line_total, is_taxable,
                             unit_ingredient_cost, unit_packaging_cost, unit_labor_cost, unit_other_cost)
    values (v_order_id, v_p.id, v_p.name, coalesce(v_it->>'options', ''), (v_it->>'quantity')::int, v_p.selling_price, 0,
            v_p.tax_status = 'taxable',
            v_p.ingredient_cost, v_p.packaging_cost, round(v_p.labor_minutes / 60.0 * coalesce(v_labor_rate, 0), 4), v_p.other_direct_cost);
  end loop;

  perform recalc_order(v_order_id);
  return v_number;
end $$;

-- Only the service role may call it (the Edge Function). Not the browser.
revoke all on function intake_website_order(text, jsonb, jsonb) from public, anon, authenticated;
