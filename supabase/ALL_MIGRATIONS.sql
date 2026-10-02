-- ===== 0001_schema.sql =====
-- ============================================================================
-- Pharaoh's Bites — Finance Dashboard
-- 0001_schema.sql : core schema, sequences, triggers
--
-- Money is numeric(12,2). Percentages/rates are numeric(7,4) (0.0825 = 8.25%).
-- Every important financial record is soft-deleted (deleted_at / voided_at),
-- never physically deleted by the dashboard user.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type order_status as enum (
  'pending_whatsapp_confirmation',
  'contacted',
  'delivery_fee_pending',
  'awaiting_customer_approval',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
  'refunded'
);

create type payment_status as enum (
  'unpaid',
  'deposit_received',
  'partially_paid',
  'paid',
  'refunded',
  'partially_refunded',
  'disputed'
);

create type payment_method as enum ('zelle', 'venmo', 'cash', 'card', 'other');
create type delivery_method as enum ('delivery', 'pickup');
create type delivery_provider as enum ('owner', 'uber', 'third_party', 'customer_pickup', 'other');
create type delivery_status as enum ('not_started', 'scheduled', 'out_for_delivery', 'delivered', 'failed', 'picked_up');
create type tax_status as enum ('taxable', 'nontaxable', 'review');
create type customer_status as enum ('active', 'vip', 'trouble_maker', 'blocked');
create type cost_type as enum ('direct_product', 'operating');
create type order_source as enum ('website', 'manual', 'import');
create type tax_filing_frequency as enum ('monthly', 'quarterly', 'annual');
create type expense_recurrence as enum ('none', 'weekly', 'monthly', 'quarterly', 'annual');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Admin profiles: the ONLY users allowed to read financial data.
-- Rows are inserted manually (see README "Create the first administrator").
-- ---------------------------------------------------------------------------
create table admin_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  role        text not null default 'owner' check (role in ('owner', 'manager')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- SECURITY DEFINER so RLS policies can call it without recursion.
create or replace function is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admin_profiles
    where user_id = auth.uid() and is_active
  );
$$;
revoke all on function is_admin() from public;
grant execute on function is_admin() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Settings (single-row tables)
-- ---------------------------------------------------------------------------
create table business_settings (
  id                        int primary key default 1 check (id = 1),
  business_name             text not null default 'Pharaoh''s Bites',
  owner_name                text not null default '',
  address                   text not null default '',
  phone                     text not null default '+1 787-968-4078',
  whatsapp_number           text not null default '17879684078',
  email                     text not null default '',
  logo_url                  text not null default '',
  currency                  text not null default 'USD',
  timezone                  text not null default 'America/Chicago',
  order_number_prefix       text not null default 'PB',
  default_delivery_rate_per_mile numeric(8,2) not null default 1.50,
  default_mileage_cost_per_mile  numeric(8,2) not null default 0.67,
  default_labor_rate_per_hour    numeric(8,2) not null default 15.00,
  include_owner_labor       boolean not null default false,
  advanced_mode             boolean not null default false,   -- UI: show every tab/field, or the simple set
  low_margin_warning_pct    numeric(7,4) not null default 0.30,
  minimum_order_amount      numeric(12,2) not null default 20.00,
  default_whatsapp_message  text not null default 'Hi {name}, this is Pharaoh''s Bites about order {order_number}. Your delivery fee is {delivery_fee} and the final total is {total}. Please confirm and we will start baking!',
  cancellation_rules        text not null default 'Orders can be cancelled free of charge until preparation starts.',
  updated_at                timestamptz not null default now()
);
insert into business_settings (id) values (1);
create trigger business_settings_updated before update on business_settings for each row execute function set_updated_at();

create table tax_settings (
  id                      int primary key default 1 check (id = 1),
  default_tax_rate        numeric(7,4) not null default 0.0825,   -- Dallas, TX combined
  prices_include_tax      boolean not null default false,
  filing_frequency        tax_filing_frequency not null default 'quarterly',
  next_due_date           date,
  reminder_days_before    int not null default 14,
  jurisdiction_note       text not null default 'Texas Comptroller — rate and filing schedule must be confirmed by the owner.',
  updated_at              timestamptz not null default now()
);
insert into tax_settings (id) values (1);
create trigger tax_settings_updated before update on tax_settings for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table product_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table products (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique,           -- matches the customer website's item id
  name                  text not null,
  name_ar               text not null default '',
  category_id           uuid references product_categories(id),
  description           text not null default '',
  image_url             text not null default '',
  selling_price         numeric(12,2) not null check (selling_price >= 0),
  is_active             boolean not null default true,
  tax_status            tax_status not null default 'review',
  packaging_cost        numeric(12,2) not null default 0 check (packaging_cost >= 0),
  labor_minutes         numeric(8,2) not null default 0 check (labor_minutes >= 0),
  other_direct_cost     numeric(12,2) not null default 0 check (other_direct_cost >= 0),
  ingredient_cost       numeric(12,4) not null default 0,   -- cached from recipes (see recalc_product_cost)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create index products_category_idx on products(category_id);
create index products_active_idx on products(is_active) where deleted_at is null;
create trigger products_updated before update on products for each row execute function set_updated_at();

create table ingredients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  supplier        text not null default '',
  package_size    numeric(12,4) not null check (package_size > 0),
  package_unit    text not null,
  package_price   numeric(12,2) not null check (package_price >= 0),
  waste_pct       numeric(7,4) not null default 0 check (waste_pct >= 0 and waste_pct < 1),
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create trigger ingredients_updated before update on ingredients for each row execute function set_updated_at();

-- Price history so historical product costs can be reconstructed.
create table ingredient_cost_history (
  id              uuid primary key default gen_random_uuid(),
  ingredient_id   uuid not null references ingredients(id) on delete cascade,
  package_size    numeric(12,4) not null,
  package_unit    text not null,
  package_price   numeric(12,2) not null,
  effective_from  timestamptz not null default now()
);
create index ingredient_cost_history_idx on ingredient_cost_history(ingredient_id, effective_from desc);

create or replace function log_ingredient_cost()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.package_price is distinct from old.package_price
     or new.package_size is distinct from old.package_size
     or new.package_unit is distinct from old.package_unit then
    insert into ingredient_cost_history (ingredient_id, package_size, package_unit, package_price)
    values (new.id, new.package_size, new.package_unit, new.package_price);
  end if;
  return new;
end $$;
create trigger ingredients_cost_log after insert or update on ingredients for each row execute function log_ingredient_cost();

create table recipes (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references products(id) on delete cascade,
  ingredient_id   uuid not null references ingredients(id),
  quantity        numeric(12,4) not null check (quantity > 0),
  unit            text not null,
  waste_pct       numeric(7,4) not null default 0 check (waste_pct >= 0 and waste_pct < 1),
  created_at      timestamptz not null default now(),
  unique (product_id, ingredient_id)
);

-- Unit conversion to a base unit per family. Mass -> grams, volume -> ml,
-- count -> each. Unknown units fall back to 1:1 (same unit assumed).
create or replace function unit_to_base(u text)
returns numeric language sql immutable as $$
  select case lower(trim(u))
    when 'g' then 1
    when 'kg' then 1000
    when 'oz' then 28.3495
    when 'lb' then 453.592
    when 'ml' then 1
    when 'l' then 1000
    when 'tsp' then 4.92892
    when 'teaspoon' then 4.92892
    when 'tbsp' then 14.7868
    when 'tablespoon' then 14.7868
    when 'cup' then 236.588
    when 'pint' then 473.176
    when 'quart' then 946.353
    when 'gallon' then 3785.41
    when 'piece' then 1
    when 'package' then 1
    else 1
  end;
$$;

-- Cost of one recipe line = package_price * (qty_in_base / package_size_in_base) * (1 + waste)
create or replace function recipe_line_cost(p_quantity numeric, p_unit text, p_pkg_size numeric, p_pkg_unit text, p_pkg_price numeric, p_waste numeric)
returns numeric language sql immutable as $$
  select round(
    p_pkg_price * ((p_quantity * unit_to_base(p_unit)) / nullif(p_pkg_size * unit_to_base(p_pkg_unit), 0)) * (1 + coalesce(p_waste, 0)),
    4);
$$;

create table product_cost_history (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references products(id) on delete cascade,
  ingredient_cost   numeric(12,4) not null,
  packaging_cost    numeric(12,2) not null,
  labor_cost        numeric(12,4) not null,
  other_direct_cost numeric(12,2) not null,
  total_unit_cost   numeric(12,4) not null,
  effective_from    timestamptz not null default now()
);
create index product_cost_history_idx on product_cost_history(product_id, effective_from desc);

create or replace function recalc_product_cost(p_product_id uuid)
returns void language plpgsql as $$
declare
  v_ing numeric := 0;
  v_p products%rowtype;
  v_labor numeric;
  v_rate numeric;
begin
  -- Products without recipe lines keep the ingredient cost typed by hand.
  if exists (select 1 from recipes where product_id = p_product_id) then
    select coalesce(sum(recipe_line_cost(r.quantity, r.unit, i.package_size, i.package_unit, i.package_price, greatest(r.waste_pct, i.waste_pct))), 0)
      into v_ing
    from recipes r join ingredients i on i.id = r.ingredient_id
    where r.product_id = p_product_id and i.deleted_at is null;
    update products set ingredient_cost = v_ing where id = p_product_id returning * into v_p;
  else
    select * into v_p from products where id = p_product_id;
    v_ing := v_p.ingredient_cost;
  end if;
  select default_labor_rate_per_hour into v_rate from business_settings where id = 1;
  v_labor := round(v_p.labor_minutes / 60.0 * coalesce(v_rate, 0), 4);

  insert into product_cost_history (product_id, ingredient_cost, packaging_cost, labor_cost, other_direct_cost, total_unit_cost)
  values (p_product_id, v_ing, v_p.packaging_cost, v_labor, v_p.other_direct_cost, v_ing + v_p.packaging_cost + v_labor + v_p.other_direct_cost);
end $$;

create or replace function recipes_changed()
returns trigger language plpgsql as $$
begin
  perform recalc_product_cost(coalesce(new.product_id, old.product_id));
  return coalesce(new, old);
end $$;
create trigger recipes_recalc after insert or update or delete on recipes for each row execute function recipes_changed();

create or replace function ingredient_changed()
returns trigger language plpgsql as $$
declare r record;
begin
  for r in select distinct product_id from recipes where ingredient_id = new.id loop
    perform recalc_product_cost(r.product_id);
  end loop;
  return new;
end $$;
create trigger ingredients_recalc after update of package_price, package_size, package_unit, waste_pct on ingredients
  for each row execute function ingredient_changed();

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
create table customers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone             text not null default '',
  phone_normalized  text not null default '',  -- digits only, used for matching
  email             text not null default '',
  status            customer_status not null default 'active',
  internal_notes    text not null default '',
  merged_into_id    uuid references customers(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index customers_phone_idx on customers(phone_normalized) where deleted_at is null;
create trigger customers_updated before update on customers for each row execute function set_updated_at();

create table customer_addresses (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete cascade,
  street        text not null,
  apt           text not null default '',
  city          text not null,
  state         text not null,
  zip           text not null,
  instructions  text not null default '',
  is_default    boolean not null default true,
  created_at    timestamptz not null default now()
);
create index customer_addresses_customer_idx on customer_addresses(customer_id);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
-- Per-year counter. next_order_number() locks the row so concurrent checkouts
-- never receive the same number.
create table order_counters (
  year      int primary key,
  last_seq  int not null default 0
);

create or replace function next_order_number()
returns text language plpgsql as $$
declare
  v_year int := extract(year from now() at time zone 'America/Chicago')::int;
  v_seq int;
  v_prefix text;
begin
  select order_number_prefix into v_prefix from business_settings where id = 1;
  insert into order_counters (year, last_seq) values (v_year, 0) on conflict (year) do nothing;
  update order_counters set last_seq = last_seq + 1 where year = v_year returning last_seq into v_seq;
  return coalesce(v_prefix, 'PB') || '-' || v_year || '-' || lpad(v_seq::text, 5, '0');
end $$;

create table orders (
  id                        uuid primary key default gen_random_uuid(),
  order_number              text not null unique,
  checkout_token            text unique,                 -- idempotency key from the website
  source                    order_source not null default 'website',
  customer_id               uuid references customers(id),
  -- snapshot of who/where at the time of ordering
  customer_name             text not null,
  customer_phone            text not null default '',
  delivery_method           delivery_method not null default 'delivery',
  address_street            text not null default '',
  address_apt               text not null default '',
  address_city              text not null default '',
  address_state             text not null default '',
  address_zip               text not null default '',
  delivery_instructions     text not null default '',
  requested_at              timestamptz,
  status                    order_status not null default 'pending_whatsapp_confirmation',
  payment_status            payment_status not null default 'unpaid',
  payment_method            payment_method,
  -- money
  subtotal                  numeric(12,2) not null default 0,   -- sum of line totals (before discount)
  discount                  numeric(12,2) not null default 0 check (discount >= 0),
  discount_reason           text not null default '',
  delivery_fee              numeric(12,2) not null default 0 check (delivery_fee >= 0),
  delivery_fee_customer_paid boolean not null default true,
  delivery_subsidy          numeric(12,2) not null default 0 check (delivery_subsidy >= 0),
  tax_rate_applied          numeric(7,4) not null default 0,
  tax_amount                numeric(12,2) not null default 0 check (tax_amount >= 0),
  tax_manually_set          boolean not null default false,
  prices_include_tax        boolean not null default false,
  total                     numeric(12,2) not null default 0,   -- subtotal - discount + delivery_fee + tax
  amount_paid               numeric(12,2) not null default 0,   -- maintained by trigger from payments/refunds
  amount_refunded           numeric(12,2) not null default 0,
  internal_notes            text not null default '',
  customer_notes            text not null default '',
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  confirmed_at              timestamptz,
  completed_at              timestamptz,
  cancelled_at              timestamptz,
  deleted_at                timestamptz      -- void
);
create index orders_created_idx on orders(created_at desc);
create index orders_status_idx on orders(status);
create index orders_customer_idx on orders(customer_id);
create index orders_phone_idx on orders(customer_phone);
create trigger orders_updated before update on orders for each row execute function set_updated_at();

create table order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete cascade,
  product_id            uuid references products(id),
  product_name          text not null,             -- snapshot
  options               text not null default '',
  quantity              int not null check (quantity > 0),
  unit_price            numeric(12,2) not null check (unit_price >= 0),
  line_total            numeric(12,2) not null,
  is_taxable            boolean not null default true,
  -- cost snapshot at time of sale (historical cost is preserved)
  unit_ingredient_cost  numeric(12,4) not null default 0,
  unit_packaging_cost   numeric(12,2) not null default 0,
  unit_labor_cost       numeric(12,4) not null default 0,
  unit_other_cost       numeric(12,2) not null default 0,
  refunded_qty          int not null default 0 check (refunded_qty >= 0),
  created_at            timestamptz not null default now()
);
create index order_items_order_idx on order_items(order_id);
create index order_items_product_idx on order_items(product_id);

create table order_status_history (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  from_status  order_status,
  to_status    order_status not null,
  changed_by   uuid,
  note         text not null default '',
  created_at   timestamptz not null default now()
);
create index order_status_history_idx on order_status_history(order_id, created_at);

create table payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  paid_at       timestamptz not null default now(),
  amount        numeric(12,2) not null check (amount > 0),
  method        payment_method not null,
  reference     text not null default '',
  notes         text not null default '',
  created_by    uuid,
  created_at    timestamptz not null default now(),
  voided_at     timestamptz
);
create index payments_order_idx on payments(order_id);
create index payments_paid_idx on payments(paid_at desc);

create table refunds (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  payment_id    uuid references payments(id),
  refunded_at   timestamptz not null default now(),
  amount        numeric(12,2) not null check (amount > 0),
  tax_portion   numeric(12,2) not null default 0 check (tax_portion >= 0),
  method        payment_method not null,
  reason        text not null default '',
  created_by    uuid,
  created_at    timestamptz not null default now(),
  voided_at     timestamptz
);
create index refunds_order_idx on refunds(order_id);

create table delivery_records (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null unique references orders(id) on delete cascade,
  distance_miles  numeric(8,2) not null default 0 check (distance_miles >= 0),
  fee_charged     numeric(12,2) not null default 0,
  actual_cost     numeric(12,2) not null default 0 check (actual_cost >= 0),
  provider        delivery_provider not null default 'owner',
  driver          text not null default '',
  tracking_ref    text not null default '',
  status          delivery_status not null default 'not_started',
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger delivery_records_updated before update on delivery_records for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------
create table expense_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  cost_type   cost_type not null default 'operating',
  sort_order  int not null default 0
);

create table expenses (
  id                  uuid primary key default gen_random_uuid(),
  expense_date        date not null default current_date,
  vendor              text not null default '',
  category_id         uuid references expense_categories(id),
  description         text not null default '',
  amount_before_tax   numeric(12,2) not null default 0 check (amount_before_tax >= 0),
  sales_tax_paid      numeric(12,2) not null default 0 check (sales_tax_paid >= 0),
  total_amount        numeric(12,2) generated always as (amount_before_tax + sales_tax_paid) stored,
  payment_method      payment_method,
  receipt_path        text not null default '',     -- storage object path in bucket "receipts"
  cost_type           cost_type not null default 'operating',
  product_id          uuid references products(id),
  order_id            uuid references orders(id),
  notes               text not null default '',
  recurrence          expense_recurrence not null default 'none',
  recurring_parent_id uuid references expenses(id),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create index expenses_date_idx on expenses(expense_date desc);
create index expenses_category_idx on expenses(category_id);
create trigger expenses_updated before update on expenses for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Tax
-- ---------------------------------------------------------------------------
create table tax_adjustments (
  id            uuid primary key default gen_random_uuid(),
  adjusted_on   date not null default current_date,
  amount        numeric(12,2) not null,   -- negative reduces liability
  reason        text not null default '',
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create table tax_period_summaries (
  id                uuid primary key default gen_random_uuid(),
  period_start      date not null,
  period_end        date not null,
  total_sales       numeric(12,2) not null default 0,
  taxable_sales     numeric(12,2) not null default 0,
  nontaxable_sales  numeric(12,2) not null default 0,
  tax_collected     numeric(12,2) not null default 0,
  adjustments       numeric(12,2) not null default 0,
  estimated_due     numeric(12,2) not null default 0,
  filed_at          timestamptz,
  notes             text not null default '',
  created_at        timestamptz not null default now(),
  unique (period_start, period_end)
);

-- ---------------------------------------------------------------------------
-- Audit log (generic row-change trigger)
-- ---------------------------------------------------------------------------
create table audit_logs (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   text not null,
  action      text not null,
  changed_by  uuid,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_record_idx on audit_logs(table_name, record_id, created_at desc);

create or replace function audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (table_name, record_id, action, changed_by, old_data, new_data)
  values (tg_table_name,
          coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, ''),
          tg_op, auth.uid(),
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger orders_audit after insert or update or delete on orders for each row execute function audit_row();
create trigger order_items_audit after insert or update or delete on order_items for each row execute function audit_row();
create trigger payments_audit after insert or update or delete on payments for each row execute function audit_row();
create trigger refunds_audit after insert or update or delete on refunds for each row execute function audit_row();
create trigger expenses_audit after insert or update or delete on expenses for each row execute function audit_row();
create trigger products_audit after insert or update or delete on products for each row execute function audit_row();
create trigger customers_audit after insert or update or delete on customers for each row execute function audit_row();
create trigger settings_audit after update on business_settings for each row execute function audit_row();
create trigger tax_settings_audit after update on tax_settings for each row execute function audit_row();

-- ---------------------------------------------------------------------------
-- Order totals: kept consistent server-side. The browser never sets totals.
-- ---------------------------------------------------------------------------
create or replace function recalc_order(p_order_id uuid)
returns void language plpgsql as $$
declare
  v_sub numeric := 0;
  v_taxable numeric := 0;
  v_o orders%rowtype;
  v_tax numeric;
  v_paid numeric;
  v_refunded numeric;
  v_pstatus payment_status;
begin
  select * into v_o from orders where id = p_order_id;
  if not found then return; end if;

  select coalesce(sum(line_total), 0),
         coalesce(sum(case when is_taxable then line_total else 0 end), 0)
    into v_sub, v_taxable
  from order_items where order_id = p_order_id;

  -- Estimated tax on taxable goods after a proportional share of the discount.
  if v_o.tax_manually_set then
    v_tax := v_o.tax_amount;
  elsif v_o.prices_include_tax then
    v_tax := 0;   -- tax is inside the price; reported separately, not added
  else
    v_tax := round(greatest(v_taxable - (case when v_sub > 0 then v_o.discount * v_taxable / v_sub else 0 end), 0) * v_o.tax_rate_applied, 2);
  end if;

  select coalesce(sum(amount), 0) into v_paid from payments where order_id = p_order_id and voided_at is null;
  select coalesce(sum(amount), 0) into v_refunded from refunds where order_id = p_order_id and voided_at is null;

  update orders set
    subtotal = v_sub,
    tax_amount = v_tax,
    total = greatest(v_sub - discount, 0) + delivery_fee + v_tax,
    amount_paid = v_paid,
    amount_refunded = v_refunded
  where id = p_order_id;

  -- derive payment status unless it has been set to a "special" state by hand
  select * into v_o from orders where id = p_order_id;
  if v_o.payment_status = 'disputed' then
    return;
  end if;
  if v_refunded > 0 and v_refunded >= v_paid then v_pstatus := 'refunded';
  elsif v_refunded > 0 then v_pstatus := 'partially_refunded';
  elsif v_paid <= 0 then v_pstatus := 'unpaid';
  elsif v_paid >= v_o.total then v_pstatus := 'paid';
  elsif v_o.payment_status = 'deposit_received' then v_pstatus := 'deposit_received';
  else v_pstatus := 'partially_paid';
  end if;
  update orders set payment_status = v_pstatus where id = p_order_id and payment_status is distinct from v_pstatus;
end $$;

create or replace function order_items_changed()
returns trigger language plpgsql as $$
begin
  perform recalc_order(coalesce(new.order_id, old.order_id));
  return coalesce(new, old);
end $$;
create trigger order_items_recalc after insert or update or delete on order_items for each row execute function order_items_changed();

create or replace function payments_changed()
returns trigger language plpgsql as $$
begin
  perform recalc_order(coalesce(new.order_id, old.order_id));
  return coalesce(new, old);
end $$;
create trigger payments_recalc after insert or update or delete on payments for each row execute function payments_changed();
create trigger refunds_recalc after insert or update or delete on refunds for each row execute function payments_changed();

-- line_total is always quantity * unit_price
create or replace function order_item_line_total()
returns trigger language plpgsql as $$
begin
  new.line_total := round(new.quantity * new.unit_price, 2);
  return new;
end $$;
create trigger order_items_line_total before insert or update on order_items for each row execute function order_item_line_total();

-- when discount / delivery / rate / manual tax changes, recompute
create or replace function orders_before_update()
returns trigger language plpgsql as $$
declare
  v_sub numeric; v_taxable numeric; v_tax numeric;
begin
  if new.discount is distinct from old.discount or new.delivery_fee is distinct from old.delivery_fee
     or new.tax_rate_applied is distinct from old.tax_rate_applied or new.tax_amount is distinct from old.tax_amount
     or new.tax_manually_set is distinct from old.tax_manually_set or new.prices_include_tax is distinct from old.prices_include_tax then
    select coalesce(sum(line_total), 0), coalesce(sum(case when is_taxable then line_total else 0 end), 0)
      into v_sub, v_taxable from order_items where order_id = new.id;
    if new.tax_manually_set then v_tax := new.tax_amount;
    elsif new.prices_include_tax then v_tax := 0;
    else v_tax := round(greatest(v_taxable - (case when v_sub > 0 then new.discount * v_taxable / v_sub else 0 end), 0) * new.tax_rate_applied, 2);
    end if;
    new.subtotal := v_sub;
    new.tax_amount := v_tax;
    new.total := greatest(v_sub - new.discount, 0) + new.delivery_fee + v_tax;
  end if;

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
create trigger orders_before_update_trg before update on orders for each row execute function orders_before_update();

create or replace function orders_after_insert()
returns trigger language plpgsql as $$
begin
  insert into order_status_history (order_id, from_status, to_status, changed_by, note)
  values (new.id, null, new.status, auth.uid(), 'Order created (' || new.source || ')');
  return new;
end $$;
create trigger orders_after_insert_trg after insert on orders for each row execute function orders_after_insert();

-- ---------------------------------------------------------------------------
-- Website intake rate limiting (service role only; anon has no access)
-- ---------------------------------------------------------------------------
create table order_intake_log (
  id          bigint generated always as identity primary key,
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);
create index order_intake_log_idx on order_intake_log(ip_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- Financial view: one row per order with cost and profit.
-- Revenue never includes sales tax. Delivery fee is revenue only when the
-- customer pays it. COGS uses the cost snapshot stored on each line.
-- ---------------------------------------------------------------------------
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
  o.deleted_at
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

-- Product performance view (completed, non-cancelled orders only)
create or replace view product_sales as
select
  oi.product_id,
  p.name as product_name,
  p.category_id,
  o.created_at,
  o.completed_at,
  o.status,
  oi.quantity,
  oi.refunded_qty,
  oi.line_total,
  oi.quantity * (oi.unit_ingredient_cost + oi.unit_packaging_cost + oi.unit_other_cost) as line_cost,
  oi.quantity * oi.unit_labor_cost as line_labor_cost,
  -- proportional share of the order discount
  case when o.subtotal > 0 then round(o.discount * oi.line_total / o.subtotal, 2) else 0 end as line_discount,
  o.id as order_id
from order_items oi
join orders o on o.id = oi.order_id
left join products p on p.id = oi.product_id
where o.deleted_at is null;

-- Realtime: the dashboard subscribes to order changes so a website order
-- appears immediately. RLS still applies to what each subscriber receives.
alter publication supabase_realtime add table orders;

-- ===== 0002_rls.sql =====
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

-- ===== 0003_catalog.sql =====
-- ============================================================================
-- 0003_catalog.sql : real product catalogue (mirrors the customer website)
-- This is business reference data, not sample data. Prices match
-- assets/js/data.js on the customer site; the Edge Function validates every
-- website order against this table and never trusts browser prices.
-- ============================================================================

insert into product_categories (name, sort_order) values
  ('Feteer', 1), ('Feteer & Trays', 2), ('Soups', 3), ('Cakes', 4), ('Desserts', 5),
  ('Pudding', 6), ('Sides', 7), ('Drinks', 8), ('Seasonal Products', 9), ('Other', 10)
on conflict (name) do nothing;

with rows(slug, name, name_ar, category, description, image_url, selling_price) as (values
  ('feteer-meshaltet', 'Feteer Meshaltet', 'فطير مشلتت', 'Feteer', 'The original. Paper-thin dough stretched by hand, folded again and again with ghee between every layer, then baked until the top shatters.', 'https://images.unsplash.com/photo-1787690376659-e5e7cd2ae452?auto=format&fit=crop&w=900&q=80', 14),
  ('feteer-beef', 'Feteer with Plant-Based Beef & Mozzarella', 'فطير محشي لحمة', 'Feteer', 'The same hand-stretched layers, stuffed with seasoned plant-based ground beef and melted mozzarella, sealed and returned to the oven.', 'https://images.unsplash.com/photo-1631875962715-e36c2d5189ca?auto=format&fit=crop&w=900&q=80', 18),
  ('macarona-bechamel', 'Macarona Béchamel Tray', 'صينية مكرونة بشاميل', 'Feteer & Trays', 'Penne baked under a thick blanket of béchamel with plant-based ground beef through the middle, browned on top and cut into squares.', 'https://images.unsplash.com/photo-1620041631703-45ddcef3dae0?auto=format&fit=crop&w=900&q=80', 16),
  ('goulash-beef', 'Goulash Tray with Plant-Based Beef', 'صينية جلاش باللحمة', 'Feteer & Trays', 'Sheet after sheet of thin pastry layered with spiced plant-based ground beef and onion, brushed with ghee and baked golden.', 'https://images.unsplash.com/photo-1617806501736-fc7cab7c05bf?auto=format&fit=crop&w=900&q=80', 16),
  ('crepe-beef', 'Crepe with Ground Beef & Mozzarella', 'كريب باللحمة والموتزاريلا', 'Feteer & Trays', 'A soft crepe rolled around seasoned ground beef and mozzarella, griddled until the cheese pulls.', 'https://images.unsplash.com/photo-1776820620219-c5079240a997?auto=format&fit=crop&w=900&q=80', 13),
  ('kofta-tray', 'Plant-Based Kofta Tray with Salsa & Rice', 'صينية كفتة بالصلصة والأرز', 'Feteer & Trays', 'Hand-shaped plant-based kofta baked in a rich tomato salsa with onion and garlic, served over a bed of Egyptian rice. Feeds a table.', 'https://images.unsplash.com/photo-1763647818263-62a9256f097c?auto=format&fit=crop&w=900&q=80', 35),
  ('meatballs-spaghetti', 'Plant-Based Meatballs & Spaghetti', 'كرات لحم نباتية بالمكرونة', 'Feteer & Trays', 'Plant-based meatballs simmered in tomato sauce and tossed through spaghetti, finished with a little parmesan.', 'https://images.unsplash.com/photo-1622973536968-3ead9e780960?auto=format&fit=crop&w=900&q=80', 25),
  ('lentil-soup', 'Lentil Soup', 'شوربة عدس', 'Soups', 'Red lentils cooked down with onion, carrot and cumin until smooth, finished with lemon. Comes with bread on the side.', 'https://images.unsplash.com/photo-1642497394078-4794e837019c?auto=format&fit=crop&w=900&q=80', 7),
  ('goulash-nuts', 'Goulash Tray with Nuts', 'صينية جلاش بالمكسرات', 'Desserts', 'Layered pastry packed with walnut, almond and pistachio, baked crisp and soaked in syrup the moment it leaves the oven.', 'https://images.unsplash.com/photo-1594981449006-3bb015dd305a?auto=format&fit=crop&w=900&q=80', 15),
  ('mini-feteer-sweet', 'Mini Feteer, Nutella or Pistachio', 'فطير صغير حلو', 'Feteer', 'A palm-sized feteer with all its layers intact, finished with Nutella or pistachio sauce. Choose when you order.', 'https://images.unsplash.com/photo-1669630367800-b2c3ae70528e?auto=format&fit=crop&w=900&q=80', 11),
  ('crepe-nutella', 'Crepe with Nutella', 'كريب بالنوتيلا', 'Desserts', 'Warm crepe folded over Nutella until it melts through.', 'https://images.unsplash.com/photo-1723029343498-b061d6594a42?auto=format&fit=crop&w=900&q=80', 9),
  ('crepe-pistachio', 'Crepe with Pistachio Sauce', 'كريب بالفستق', 'Desserts', 'The same warm crepe with a thick pistachio cream, dusted with crushed pistachio.', 'https://images.unsplash.com/photo-1777891258086-52a41e4477f6?auto=format&fit=crop&w=900&q=80', 10),
  ('round-cake', 'Small Round Cake', 'كيكة صغيرة', 'Cakes', 'A small home-style cake, baked fresh and iced simply. Ask what today''s is.', 'https://images.unsplash.com/photo-1602351447937-745cb720612f?auto=format&fit=crop&w=900&q=80', 12),
  ('chocolate-pudding', 'Chocolate Pudding', 'بودينج شوكولاتة', 'Pudding', 'Set dark chocolate pudding, chilled, with cream folded through the top.', 'https://images.unsplash.com/photo-1673551494277-92204546b504?auto=format&fit=crop&w=900&q=80', 7),
  ('banana-pudding', 'Banana Pudding', 'بودينج موز', 'Pudding', 'Layers of vanilla cream, banana and biscuit, left to soften overnight.', 'https://images.unsplash.com/photo-1639330842151-8a92eb332b2d?auto=format&fit=crop&w=900&q=80', 7),
  ('creme-caramel', 'Crème Caramel Flan', 'كريم كراميل', 'Pudding', 'Baked custard turned out under its own caramel. Cold, wobbling, and gone in a minute.', 'https://images.unsplash.com/photo-1653988354010-39637252a2db?auto=format&fit=crop&w=900&q=80', 8),
  ('white-cheese', 'Egyptian White Cheese', 'جبنة بيضاء', 'Sides', 'Salty, crumbling domiati — the thing every Egyptian reaches for the moment the feteer is torn open.', 'https://images.unsplash.com/photo-1559561853-08451507cbe7?auto=format&fit=crop&w=900&q=80', 6),
  ('black-honey', 'Black Honey', 'عسل أسود', 'Sides', 'Sugarcane molasses, dark and mineral. The oldest sweet in the country, and the right partner for plain feteer.', 'https://images.unsplash.com/photo-1779120708355-7a41581b4584?auto=format&fit=crop&w=900&q=80', 5),
  ('white-honey', 'White Honey', 'عسل أبيض', 'Sides', 'Clear wildflower honey, poured cold over hot layers so it runs straight through.', 'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?auto=format&fit=crop&w=900&q=80', 5),
  ('tahini', 'Tahini', 'طحينة', 'Sides', 'Stone-ground sesame, loosened with lemon. Best stirred into the black honey until the two go pale.', 'https://images.unsplash.com/photo-1747932984398-dd52d84886d6?auto=format&fit=crop&w=900&q=80', 5),
  ('protein-shake', 'House Special Protein Shake', 'مشروب البروتين', 'Drinks', 'Twenty-five grams of protein, blended thick and cold. Our own recipe — nothing about it tastes like a supplement.', 'https://images.unsplash.com/photo-1542444592-0d5997f202eb?auto=format&fit=crop&w=900&q=80', 9)
)
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select r.slug, r.name, r.name_ar, c.id, r.description, r.image_url, r.selling_price, 'review'
from rows r left join product_categories c on c.name = r.category
on conflict (slug) do update set name = excluded.name, selling_price = excluded.selling_price, image_url = excluded.image_url;

insert into expense_categories (name, cost_type, sort_order) values
  ('Ingredients', 'direct_product', 1),
  ('Packaging', 'direct_product', 2),
  ('Pizza boxes', 'direct_product', 3),
  ('Cake boxes', 'direct_product', 4),
  ('Dessert cups', 'direct_product', 5),
  ('Logo stickers', 'direct_product', 6),
  ('Kitchen supplies', 'operating', 7),
  ('Equipment', 'operating', 8),
  ('Delivery', 'operating', 9),
  ('Gas / mileage', 'operating', 10),
  ('Marketing', 'operating', 11),
  ('Website / technology', 'operating', 12),
  ('Licenses and permits', 'operating', 13),
  ('Training', 'operating', 14),
  ('Bank / payment fees', 'operating', 15),
  ('Refunds', 'operating', 16),
  ('Utilities', 'operating', 17),
  ('Repairs', 'operating', 18),
  ('Other', 'operating', 19)
on conflict (name) do nothing;

-- ===== 0004_storage.sql =====
-- ============================================================================
-- 0004_storage.sql : private bucket for expense receipts
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy receipts_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and is_admin());
create policy receipts_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and is_admin());
create policy receipts_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and is_admin());
create policy receipts_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and is_admin());

-- ===== 0005_intake.sql =====
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

-- ============================================================================
-- 0006_avocado_drink.sql : add the avocado shake (menu change, 2026-09-13)
-- Mirrors assets/js/data.js on the customer site. The owner's stated cost is
-- $3 per drink; it lives in other_direct_cost until a recipe is entered.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, other_direct_cost)
select 'avocado-drink', 'Avocado Shake with Nuts', 'عصير أفوكادو بالمكسرات', c.id,
       'Ripe avocado blended with cold milk until it''s thick and smooth, topped with crushed nuts.',
       'https://images.unsplash.com/photo-1693042442021-41423615ce89?auto=format&fit=crop&w=900&q=80',
       8, 'review', 3
from product_categories c where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

-- Crepes were removed from the customer menu on 2026-09-13. Deactivate rather
-- than delete so past orders and reports keep their product references.
update products set is_active = false
where slug in ('crepe-beef', 'crepe-nutella', 'crepe-pistachio');
-- ============================================================================
-- 0007_price_update.sql : owner's price revision, 2026-09-13
-- Mirrors assets/js/data.js on the customer site. The Edge Function charges
-- these prices, so they must match what the website displays.
-- Kofta and cake also received owner-stated flat costs (no recipe yet).
-- ============================================================================

update products set selling_price = v.price
from (values
  ('feteer-meshaltet', 25), ('feteer-beef', 40), ('macarona-bechamel', 30),
  ('goulash-beef', 35), ('meatballs-spaghetti', 30), ('kofta-tray', 40),
  ('goulash-nuts', 25), ('round-cake', 13), ('white-cheese', 5), ('protein-shake', 12)
) as v(slug, price)
where products.slug = v.slug;

update products set other_direct_cost = 13 where slug = 'kofta-tray'  and ingredient_cost = 0;
update products set other_direct_cost = 4  where slug = 'round-cake' and ingredient_cost = 0;
-- ============================================================================
-- 0008_product_costs.sql : owner's per-unit ingredient costs, 2026-09-13
-- Flat costs worked out from the owner's raw-material prices and recipes.
-- They live in ingredient_cost (the "type what it costs you" field) until a
-- recipe is entered, at which point recalc_product_cost takes over.
-- The three flat costs previously parked in other_direct_cost move here too.
-- ============================================================================

update products set ingredient_cost = v.cost, other_direct_cost = 0
from (values
  ('feteer-meshaltet',    4.39), ('feteer-beef',        14.24), ('macarona-bechamel', 14.53),
  ('goulash-beef',       12.82), ('meatballs-spaghetti', 11.75), ('kofta-tray',        13.00),
  ('goulash-nuts',        5.63), ('chocolate-pudding',    2.79), ('banana-pudding',     2.79),
  ('creme-caramel',       2.79), ('round-cake',           4.00), ('white-cheese',       3.00),
  ('avocado-drink',       3.00)
) as v(slug, cost)
where products.slug = v.slug
  and not exists (select 1 from recipes r where r.product_id = products.id);
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

-- ============================================================================
-- 0010_order_counter_start.sql : start public order numbers at 101.
--
-- The website's first live orders should not read PB-2026-00001; the owner
-- wants the sequence to continue from 100 orders already made. Only moves
-- the counter forward, never back, so re-running is harmless.
-- ============================================================================

insert into order_counters (year, last_seq) values (2026, 100)
on conflict (year) do update set last_seq = greatest(order_counters.last_seq, 100);

-- ============================================================================
-- 0011_sides_prices.sql : owner's side-dish price revision, 2026-09-13
-- Mirrors assets/js/data.js on the customer site. The Edge Function charges
-- these prices, so they must match what the website displays.
-- ============================================================================

update products set selling_price = v.price
from (values
  ('white-cheese', 2.99), ('black-honey', 2.49), ('white-honey', 2.49), ('tahini', 2.49)
) as v(slug, price)
where products.slug = v.slug;
-- ============================================================================
-- 0010_bank_feed.sql : Plaid bank feed -> Expenses
--
-- One Plaid "item" is one bank login (Chase). Each item has one or more
-- accounts, and every account has transactions. Money leaving the account
-- becomes an expense automatically; deposits are stored but never become
-- expenses (income is handled by orders, not here).
--
-- SECURITY: bank_items holds the Plaid access token. No policy grants any
-- authenticated user access to that table -- only the service role (the Edge
-- Functions) can read it. The browser never sees a token. Everything the
-- dashboard needs to display lives in bank_accounts / bank_transactions,
-- which admins can read.
-- ============================================================================

create table bank_items (
  id                 uuid primary key default gen_random_uuid(),
  plaid_item_id      text not null unique,
  access_token       text not null,                  -- service-role only
  institution_id     text not null default '',
  institution_name   text not null default '',
  cursor             text,                           -- /transactions/sync cursor
  status             text not null default 'active', -- active | needs_reauth | disconnected
  last_error         text not null default '',
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger bank_items_updated before update on bank_items for each row execute function set_updated_at();

create table bank_accounts (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references bank_items(id) on delete cascade,
  plaid_account_id   text not null unique,
  name               text not null default '',
  official_name      text not null default '',
  mask               text not null default '',       -- last 4 only; never the full number
  type               text not null default '',
  subtype            text not null default '',
  current_balance    numeric(14,2),
  available_balance  numeric(14,2),
  is_tracked         boolean not null default true,  -- untick to ignore an account
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index bank_accounts_item_idx on bank_accounts(item_id);
create trigger bank_accounts_updated before update on bank_accounts for each row execute function set_updated_at();

create table bank_transactions (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references bank_accounts(id) on delete cascade,
  plaid_transaction_id  text not null unique,         -- the dedupe key
  posted_on             date not null,
  name                  text not null default '',
  merchant_name         text not null default '',
  -- Plaid convention: positive = money OUT of the account, negative = money in.
  amount                numeric(14,2) not null,
  iso_currency_code     text not null default 'USD',
  pending               boolean not null default false,
  plaid_category        text not null default '',
  payment_channel       text not null default '',
  expense_id            uuid references expenses(id) on delete set null,
  ignored               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index bank_transactions_account_idx on bank_transactions(account_id);
create index bank_transactions_date_idx on bank_transactions(posted_on desc);
create index bank_transactions_expense_idx on bank_transactions(expense_id);
create trigger bank_transactions_updated before update on bank_transactions for each row execute function set_updated_at();

-- Vendor rules: first matching pattern wins (lowest sort_order).
create table bank_rules (
  id           uuid primary key default gen_random_uuid(),
  match_text   text not null,                         -- case-insensitive substring of the transaction name
  vendor       text not null default '',              -- rewrite the messy bank description to this
  category_id  uuid references expense_categories(id),
  cost_type    cost_type not null default 'operating',
  skip         boolean not null default false,        -- true = never create an expense (transfers, card payments)
  sort_order   int not null default 100,
  created_at   timestamptz not null default now()
);
create index bank_rules_order_idx on bank_rules(sort_order);

alter table expenses add column if not exists bank_transaction_id uuid references bank_transactions(id) on delete set null;
create index if not exists expenses_bank_txn_idx on expenses(bank_transaction_id) where bank_transaction_id is not null;

-- ---------------------------------------------------------------- RLS
alter table bank_items        enable row level security;
alter table bank_accounts     enable row level security;
alter table bank_transactions enable row level security;
alter table bank_rules        enable row level security;

-- bank_items: deliberately NO policies. Access tokens are service-role only.

create policy bank_accounts_select on bank_accounts for select to authenticated using (is_admin());
create policy bank_accounts_update on bank_accounts for update to authenticated using (is_admin()) with check (is_admin());

create policy bank_transactions_select on bank_transactions for select to authenticated using (is_admin());
create policy bank_transactions_update on bank_transactions for update to authenticated using (is_admin()) with check (is_admin());

create policy bank_rules_select on bank_rules for select to authenticated using (is_admin());
create policy bank_rules_insert on bank_rules for insert to authenticated with check (is_admin());
create policy bank_rules_update on bank_rules for update to authenticated using (is_admin()) with check (is_admin());
create policy bank_rules_delete on bank_rules for delete to authenticated using (is_admin());

create trigger bank_transactions_audit after insert or update or delete on bank_transactions for each row execute function audit_row();
create trigger bank_rules_audit after insert or update or delete on bank_rules for each row execute function audit_row();

-- ------------------------------------------------- transaction -> expense
-- Called by the sync function for each posted debit. Idempotent: a second
-- call for the same transaction updates the existing expense instead of
-- creating another. Deposits, pending rows, ignored rows and rows matching a
-- skip rule never produce an expense.
create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype;
  r bank_rules%rowtype;
  v_vendor text;
  v_cat uuid;
  v_cost_type cost_type;
  v_expense_id uuid;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;

  -- first matching rule wins
  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
   order by sort_order, created_at limit 1;

  if t.ignored or t.pending or t.amount <= 0 or coalesce(r.skip, false)
     or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then
    -- no expense should exist for this transaction
    if t.expense_id is not null then
      update expenses set deleted_at = now() where id = t.expense_id and deleted_at is null;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');

  if t.expense_id is null then
    insert into expenses (expense_date, vendor, category_id, description, amount_before_tax,
                          sales_tax_paid, cost_type, notes, auto_source, bank_transaction_id)
    values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
            'Imported from the bank feed. Edit the rule, not this row.', 'bank', t.id)
    returning id into v_expense_id;
    update bank_transactions set expense_id = v_expense_id where id = t.id;
  else
    update expenses
       set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
           amount_before_tax = t.amount, category_id = v_cat, cost_type = v_cost_type, deleted_at = null
     where id = t.expense_id
    returning id into v_expense_id;
  end if;
  return v_expense_id;
end $$;

-- Re-apply every transaction (used after the rules change).
create or replace function reapply_bank_rules()
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; rec record;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  for rec in select id from bank_transactions loop
    perform apply_bank_transaction(rec.id);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function reapply_bank_rules() to authenticated;

-- Starter rules. Transfers and card payments are money moving between the
-- owner's own accounts, not costs, so they are skipped by default.
insert into bank_rules (match_text, vendor, category_id, cost_type, skip, sort_order) values
  ('CHASE CREDIT CRD',  '', null, 'operating', true, 10),
  ('Payment Thank You', '', null, 'operating', true, 10),
  ('ONLINE TRANSFER',   '', null, 'operating', true, 10),
  ('ZELLE',             '', null, 'operating', true, 15),
  ('ATM WITHDRAWAL',    '', null, 'operating', true, 15);

insert into bank_rules (match_text, vendor, category_id, cost_type, sort_order)
select v.m, v.vend, c.id, v.ct::cost_type, v.so
from (values
  ('COSTCO',    'Costco',        'Ingredients',          'direct_product', 20),
  ('SAM''S CLUB','Sam''s Club',  'Ingredients',          'direct_product', 20),
  ('WALMART',   'Walmart',       'Ingredients',          'direct_product', 20),
  ('KROGER',    'Kroger',        'Ingredients',          'direct_product', 20),
  ('ALDI',      'Aldi',          'Ingredients',          'direct_product', 20),
  ('RESTAURANT DEPOT', 'Restaurant Depot', 'Ingredients','direct_product', 20),
  ('WEBSTAURANT','WebstaurantStore','Packaging',         'direct_product', 25),
  ('ULINE',     'Uline',         'Packaging',            'direct_product', 25),
  ('SHELL',     'Shell',         'Gas / mileage',        'operating',      30),
  ('EXXON',     'Exxon',         'Gas / mileage',        'operating',      30),
  ('CHEVRON',   'Chevron',       'Gas / mileage',        'operating',      30),
  ('QUIKTRIP',  'QuikTrip',      'Gas / mileage',        'operating',      30),
  ('ANTHROPIC', 'Anthropic',     'Website / technology', 'operating',      40),
  ('GOOGLE',    'Google',        'Website / technology', 'operating',      40),
  ('GITHUB',    'GitHub',        'Website / technology', 'operating',      40),
  ('META PLATFORMS', 'Meta',     'Marketing',            'operating',      45),
  ('FACEBK',    'Meta',          'Marketing',            'operating',      45),
  ('INSTAGRAM', 'Meta',          'Marketing',            'operating',      45),
  ('TIKTOK',    'TikTok',        'Marketing',            'operating',      45),
  ('ONCOR',     'Oncor',         'Utilities',            'operating',      50),
  ('ATMOS',     'Atmos Energy',  'Utilities',            'operating',      50),
  ('CITY OF DALLAS', 'City of Dallas', 'Licenses and permits', 'operating', 55)
) as v(m, vend, cat, ct, so)
join expense_categories c on c.name = v.cat;
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

-- ============================================================================
-- 0012_baba_ganoush_hummus.sql : add Baba Ganoush and Hummus (menu change, 2026-09-27)
-- Mirrors assets/js/data.js on the customer website. Prices set by the owner:
-- Baba Ganoush $5, Hummus $2. Cost not yet supplied, so tax_status stays
-- 'review' and cost fields stay at their defaults, same as the other
-- not-yet-costed sides.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'baba-ganoush', 'Baba Ganoush', 'بابا غنوج', c.id,
       'Smoky roasted eggplant, blended smooth with tahini, garlic and lemon.',
       'https://images.pexels.com/photos/14774982/pexels-photo-14774982.jpeg?auto=compress&cs=tinysrgb&w=900',
       5, 'review'
from product_categories c where c.name = 'Sides'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'hummus', 'Hummus', 'حمص', c.id,
       'Chickpeas blended smooth with tahini, lemon and garlic, finished with olive oil.',
       'https://images.pexels.com/photos/6327663/pexels-photo-6327663.jpeg?auto=compress&cs=tinysrgb&w=900',
       2, 'review'
from product_categories c where c.name = 'Sides'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

-- ============================================================================
-- 0013_feteer_meshaltet_photo_desc.sql : real photo + updated copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price is unchanged ($25).
-- The old image was a stock photo that didn't look like real feteer
-- meshaltet; it's now the owner's own reference photo, hosted on the
-- customer site. The description also dropped "ghee" for "homemade butter"
-- to match the brand's wording rule.
-- ============================================================================

update products set
  description = 'Flaky, buttery, pull-apart layers. Paper-thin dough stretched by hand, folded again and again with homemade butter between every layer, then baked until the top shatters.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg'
where slug = 'feteer-meshaltet';

-- ============================================================================
-- 0014_feteer_beef_photo.sql : real photo for feteer with beef & mozzarella, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price and description
-- unchanged ($40) — only the stock photo is replaced with the owner's own
-- reference photo, hosted on the customer site.
-- ============================================================================

update products set
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-beef-mozzarella.webp'
where slug = 'feteer-beef';

-- ============================================================================
-- 0015_feteer_beef_description.sql : mention the mixed vegetables, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($40) —
-- the owner clarified the filling also has green pepper, olives and onions.
-- ============================================================================

update products set
  description = 'The same hand-stretched layers, stuffed with seasoned plant-based ground beef, melted mozzarella and a mix of vegetables — green pepper, olives and onions — then sealed and returned to the oven.'
where slug = 'feteer-beef';

-- ============================================================================
-- 0016_macarona_bechamel_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($30).
-- ============================================================================

update products set
  description = 'Tender penne layered with savory plant-based beef and creamy béchamel, baked until golden and served in hearty squares. Comes in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/macarona-bechamel.webp'
where slug = 'macarona-bechamel';

-- ============================================================================
-- 0017_goulash_beef_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($35).
-- ============================================================================

update products set
  description = 'Crisp, golden layers of Egyptian goulash filled with seasoned plant-based ground beef, green peppers, onions, and olives. Cut into squares and served in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/goulash-beef.webp'
where slug = 'goulash-beef';

-- ============================================================================
-- 0018_goulash_nuts_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($25).
-- ============================================================================

update products set
  description = 'Crisp, golden layers of sweet Egyptian goulash filled with mixed nuts and finished with a light syrup glaze. Cut into squares and served in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/goulash-nuts.webp'
where slug = 'goulash-nuts';

-- ============================================================================
-- 0019_kofta_tray_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($40).
-- ============================================================================

update products set
  description = 'Seasoned plant-based kofta baked in a rich Egyptian tomato salsa and served in a half-size foil tray, with a separate tray of Egyptian rice with toasted vermicelli.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/kofta-tray.webp'
where slug = 'kofta-tray';

-- ============================================================================
-- 0020_meatballs_spaghetti_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($30).
-- The old description mentioned parmesan; dropped since the menu is
-- 100% plant-based and the owner's own description doesn't mention it.
-- ============================================================================

update products set
  description = 'Tender spaghetti tossed in a rich tomato sauce and topped with seasoned plant-based meatballs. Served in a half-size foil tray.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/meatballs-spaghetti.webp'
where slug = 'meatballs-spaghetti';

-- ============================================================================
-- 0021_lentil_soup_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- The old description promised bread on the side; dropped since bread isn't
-- a menu item and the owner's own description doesn't mention it.
-- ============================================================================

update products set
  description = 'Warm, velvety Egyptian creamy lentil soup, gently seasoned and served in a generous paper bowl.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/lentil-soup.webp'
where slug = 'lentil-soup';

-- ============================================================================
-- 0022_remove_mini_feteer.sql : Mini Feteer removed from the menu, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Deactivated rather than
-- deleted so past orders and reports keep their product reference, same
-- treatment as the crepes removed earlier (migration 0006).
-- ============================================================================

update products set is_active = false
where slug = 'mini-feteer-sweet';

-- ============================================================================
-- 0023_round_cake_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($13).
-- The old description promised icing and a rotating flavor of the day;
-- dropped since the real photo and the owner's own description show a
-- plain, un-iced cake.
-- ============================================================================

update products set
  description = 'A small, freshly baked plain cake with a golden crust and soft, fluffy crumb.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/round-cake.webp'
where slug = 'round-cake';

-- ============================================================================
-- 0024_chocolate_pudding_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- ============================================================================

update products set
  description = 'Smooth, rich chocolate pudding served chilled in a small dessert cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/chocolate-pudding.webp'
where slug = 'chocolate-pudding';

-- ============================================================================
-- 0025_banana_pudding_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- The old description described a layered trifle with biscuit; dropped
-- since the real photo shows a smooth, uniform pudding.
-- ============================================================================

update products set
  description = 'Smooth, creamy banana pudding served chilled in a small dessert cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/banana-pudding.webp'
where slug = 'banana-pudding';

-- ============================================================================
-- 0026_rice_pudding.sql : add Rice Pudding (menu change, 2026-09-27)
-- Mirrors assets/js/data.js on the customer website. Price set by the owner
-- to match the other puddings ($7). Cost not yet supplied, so tax_status
-- stays 'review' like the other not-yet-costed desserts.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'rice-pudding', 'Rice Pudding', 'رز باللبن', c.id,
       'Creamy Egyptian rice pudding with tender rice in a rich, milky base, served chilled in a small dessert cup.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/rice-pudding.webp',
       7, 'review'
from product_categories c where c.name = 'Pudding'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

-- ============================================================================
-- 0027_rice_pudding_description.sql : owner sent a better photo/description, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- The image_url is unchanged (same filename, new file); only the wording
-- changed to mention the optional mixed nuts topping shown in the new photo.
-- ============================================================================

update products set
  description = 'Creamy Egyptian rice pudding topped with mixed nuts (optional), served chilled in a small dessert cup.'
where slug = 'rice-pudding';

-- ============================================================================
-- 0028_om_ali.sql : add Om Ali (menu change, 2026-09-27)
-- Mirrors assets/js/data.js on the customer website. Price set by the owner
-- to match the other tray desserts ($25). Cost not yet supplied, so
-- tax_status stays 'review' like the other not-yet-costed desserts.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select 'om-ali', 'Om Ali', 'أم علي', c.id,
       'Warm Egyptian Om Ali with flaky pastry baked in sweet, creamy milk, finished with a golden top and mixed nuts. Served in a half-size foil tray.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/om-ali.webp',
       25, 'review'
from product_categories c where c.name = 'Desserts'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, image_url = excluded.image_url, is_active = true, deleted_at = null;

-- ============================================================================
-- 0029_white_cheese_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($2.99).
-- ============================================================================

update products set
  description = 'Homemade Egyptian white cheese.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/white-cheese.webp'
where slug = 'white-cheese';

-- ============================================================================
-- 0030_creme_caramel_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($8).
-- ============================================================================

update products set
  description = 'Silky crème caramel custard topped with golden caramel sauce, served chilled in a small dessert cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/creme-caramel.webp'
where slug = 'creme-caramel';

-- ============================================================================
-- 0031_baba_ganoush_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($5).
-- ============================================================================

update products set
  description = 'Smoky Egyptian baba ganoush made with roasted eggplant and tahini, served in a small cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/baba-ganoush.webp'
where slug = 'baba-ganoush';

-- ============================================================================
-- 0032_hummus_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($2).
-- ============================================================================

update products set
  description = 'Creamy hummus, a blend of chickpeas and tahini, served in a small cup.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/hummus.webp'
where slug = 'hummus';

-- ============================================================================
-- 0033_honey_tahini_price_photo_desc.sql : price rise + real photos, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Owner raised Black
-- Honey, White Honey and Tahini from $2.49 to $5 each, and sent real
-- reference photos and new copy for all three.
-- ============================================================================

update products set
  selling_price = 5,
  description = 'Rich Egyptian sugarcane molasses with a deep, bold sweetness.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/black-honey.webp'
where slug = 'black-honey';

update products set
  selling_price = 5,
  description = 'Golden bee honey with a smooth, natural sweetness.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/white-honey.webp'
where slug = 'white-honey';

update products set
  selling_price = 5,
  description = 'Smooth, creamy sesame paste with a rich, nutty flavor.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/tahini.webp'
where slug = 'tahini';

-- ============================================================================
-- 0034_avocado_drink_rename.sql : rename, real photo, rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($8).
-- Renamed from "Avocado Shake with Nuts" — the owner's new photo and
-- description don't have nuts, so the name dropped the nuts reference too.
-- ============================================================================

update products set
  name = 'Avocado Drink',
  name_ar = 'عصير أفوكادو',
  description = 'Creamy avocado blended with milk and white honey for a smooth, naturally sweet drink.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/avocado-drink.webp'
where slug = 'avocado-drink';

-- ============================================================================
-- 0035_protein_shake_rename.sql : rename + protein count + real photo, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($12).
-- Renamed from "House Special Protein Shake" to "Special Chocolate Protein
-- Shake" and the protein amount corrected from 25g to 22g.
-- ============================================================================

update products set
  name = 'Special Chocolate Protein Shake',
  name_ar = 'مشروب البروتين بالشوكولاتة',
  description = 'A rich, creamy chocolate 22g protein shake blended smooth and served chilled.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/protein-shake.webp'
where slug = 'protein-shake';

-- ============================================================================
-- 0036_sides_price_adjustment.sql : rebalance side prices, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. The owner adjusted
-- these after comparing against a nearby Egyptian restaurant's pricing,
-- with white cheese set to $4 rather than the $3 that comparison suggested.
--   Egyptian White Cheese  $2.99 -> $4
--   Black Honey            $5    -> $3.50
--   White Honey            $5    -> $4
--   Tahini                 $5    -> $3
--   Baba Ganoush           $5    -> $4
--   Hummus                 $2    -> $3
-- ============================================================================

update products set selling_price = v.price
from (values
  ('white-cheese', 4.00),
  ('black-honey', 3.50),
  ('white-honey', 4.00),
  ('tahini', 3.00),
  ('baba-ganoush', 4.00),
  ('hummus', 3.00)
) as v(slug, price)
where products.slug = v.slug;

-- ============================================================================
-- 0037_dessert_prices_and_om_ali_feature.sql : dessert/soup price rebalance, 2026-09-27
-- Mirrors assets/js/data.js on the customer website.
--   Lentil Soup            $7    -> $8
--   Small Round Cake       $13   -> $8
--   Chocolate Pudding      $7    -> $5
--   Banana Pudding         $7    -> $5
--   Rice Pudding           $7    -> $5.50
--   Crème Caramel Flan     $8    -> $5
-- Om Ali is now a featured house special, shown first among desserts.
-- ============================================================================

update products set selling_price = v.price
from (values
  ('lentil-soup', 8.00),
  ('round-cake', 8.00),
  ('chocolate-pudding', 5.00),
  ('banana-pudding', 5.00),
  ('rice-pudding', 5.50),
  ('creme-caramel', 5.00)
) as v(slug, price)
where products.slug = v.slug;

-- ===== 0038_diet_coke.sql =====
-- ============================================================================
-- 0038_diet_coke.sql : add Diet Coke 12 oz (menu change, 2026-09-29)
-- Mirrors assets/js/data.js on the customer website. Sells for $2.50; the
-- owner's cost is 63 cents per can, held in ingredient_cost (the "type what
-- it costs you" field) since a can has no recipe. tax_status stays 'review'
-- like the other items until the owner confirms how it is taxed.
-- Photo: "Diet-Coke-Can.jpg" by Evan-Amos, public domain (Wikimedia Commons).
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, other_direct_cost)
select 'diet-coke', 'Diet Coke 12 oz', 'دايت كوكاكولا', c.id,
       'Ice-cold Diet Coke, a classic 12 oz can. The perfect partner for feteer and trays.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/diet-coke.webp',
       2.50, 'review', 0.63, 0
from product_categories c where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, image_url = excluded.image_url,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  other_direct_cost = excluded.other_direct_cost, is_active = true, deleted_at = null;

-- ===== 0039_goulash_beef_photo.sql =====
-- ============================================================================
-- 0039_goulash_beef_photo.sql : correct photo for the Goulash Tray with Plant-Based Beef, 2026-09-29
-- The owner supplied the right photo (tray with beef, olive and green pepper
-- filling). The image file was replaced on the customer website; the version
-- tag makes browsers fetch the new picture instead of the cached old one.
-- ============================================================================

update products set
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/goulash-beef.webp?v=2'
where slug = 'goulash-beef';
-- Online card payments (Stripe Checkout). One payment row per Stripe payment,
-- so webhook retries can never record the same money twice.
alter table orders add column if not exists stripe_session_id text;
create unique index if not exists payments_stripe_ref_uniq on payments(reference) where reference like 'stripe:%';
-- Pay-online orders wait for payment before the owner alert + customer receipt.
-- create-order parks the notification details here; stripe-webhook sends them
-- (once) when Stripe confirms the payment, then clears the column.
alter table orders add column if not exists notify_payload jsonb;
-- ============================================================================
-- 0041_test_item.sql : TEMPORARY 1-cent test drink for checking live payments.
-- Remove it afterwards with 0042 (sets is_active = false, deleted_at = now()).
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status, ingredient_cost, other_direct_cost)
select 'test-item', 'TEST ITEM (1 cent)', 'تجربة', c.id,
       'Temporary test item for checking payments. Not a real dish.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/diet-coke.webp',
       0.01, 'review', 0, 0
from product_categories c where c.name = 'Drinks'
on conflict (slug) do update set name = excluded.name, selling_price = excluded.selling_price,
  is_active = true, deleted_at = null;
-- 0043_remove_test_item.sql : removes the temporary 1-cent test item (0041), 2026-09-30.
update products set is_active = false, deleted_at = now() where slug = 'test-item';

-- 0044_order_customer_email.sql
alter table orders add column if not exists customer_email text not null default '';
-- Orders are now paid online before they reach the kitchen, so the default WhatsApp message
-- to a customer no longer asks them to "confirm". Owner can still edit it in Settings.
update business_settings set default_whatsapp_message =
  'Hi {name}, this is Pharaoh''s Bites about your order {order_number}. Your total is {total} (delivery {delivery_fee}). Thank you for ordering!';
alter table business_settings alter column default_whatsapp_message set default
  'Hi {name}, this is Pharaoh''s Bites about your order {order_number}. Your total is {total} (delivery {delivery_fee}). Thank you for ordering!';


-- ============================================================================
-- 0046_expense_pipeline.sql : Expenses rebuild, phase 1.
--
--  * expenses  = one row per real money event (the only thing totals count)
--  * expense_sources = evidence (bank, receipt, email, stripe, manual,
--    subscription, mileage). (source_type, source_ref) is UNIQUE so the same
--    evidence can never be imported twice.
--  * one SQL matching function (find_expense_match) decides whether new
--    evidence belongs to an existing expense. Used by the bank sync now and by
--    receipts / emails later, so the rule lives in exactly one place.
--  * bank rules get actions (expense / transfer / owner_contribution /
--    personal / payout) and a direction; money that is not a business cost is
--    classified, never turned into an expense.
--  * merge / unmerge tools, an integrity report, a nightly integrity log.
--  * Stripe processing fees become expenses (unique per payment).
--  * bank_items status becomes readable (the token column stays hidden).
-- ============================================================================

-- ------------------------------------------------------------------ 1. bank_items status visible
-- The access_token column is NOT granted, so it can never be selected from the browser.
revoke all on bank_items from anon, authenticated;
grant select (id, institution_id, institution_name, status, last_error, last_synced_at, created_at) on bank_items to authenticated;
drop policy if exists bank_items_select_status on bank_items;
create policy bank_items_select_status on bank_items for select to authenticated using (is_admin());

-- ------------------------------------------------------------------ 2. settings
create table if not exists expense_settings (
  id                 boolean primary key default true check (id),
  match_window_days  int not null default 5 check (match_window_days between 0 and 30),
  amount_tolerance   numeric(8,2) not null default 0 check (amount_tolerance >= 0),
  updated_at         timestamptz not null default now()
);
insert into expense_settings (id) values (true) on conflict do nothing;
alter table expense_settings enable row level security;
drop policy if exists expense_settings_select on expense_settings;
drop policy if exists expense_settings_update on expense_settings;
create policy expense_settings_select on expense_settings for select to authenticated using (is_admin());
create policy expense_settings_update on expense_settings for update to authenticated using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------------ 3. vendor aliases
create table if not exists vendor_aliases (
  id         uuid primary key default gen_random_uuid(),
  pattern    text not null,                 -- case-insensitive substring of a vendor / bank description
  canonical  text not null,                 -- the one name we use everywhere
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);
create unique index if not exists vendor_aliases_pattern_uniq on vendor_aliases (lower(pattern));
alter table vendor_aliases enable row level security;
drop policy if exists vendor_aliases_all on vendor_aliases;
create policy vendor_aliases_all on vendor_aliases for all to authenticated using (is_admin()) with check (is_admin());

insert into vendor_aliases (pattern, canonical, sort_order) values
  ('WAL-MART', 'Walmart', 10), ('WAL MART', 'Walmart', 10), ('WM SUPERCENTER', 'Walmart', 10),
  ('WALMART', 'Walmart', 10),
  ('COSTCO', 'Costco', 10),
  ('WEBSTAURANT', 'WebstaurantStore', 10),
  ('AMZN', 'Amazon', 10), ('AMAZON', 'Amazon', 10),
  ('SAM''S CLUB', 'Sam''s Club', 10), ('SAMS CLUB', 'Sam''s Club', 10), ('SAMSCLUB', 'Sam''s Club', 10),
  ('RESTAURANT DEPOT', 'Restaurant Depot', 10),
  ('H-E-B', 'H-E-B', 10),
  ('KROGER', 'Kroger', 10),
  ('ALDI', 'Aldi', 10),
  ('ULINE', 'Uline', 10),
  ('ANTHROPIC', 'Anthropic', 10), ('CLAUDE.AI', 'Anthropic', 10),
  ('STRIPE', 'Stripe', 10),
  ('GITHUB', 'GitHub', 10),
  ('GOOGLE', 'Google', 20)
on conflict do nothing;

-- Lower-case canonical vendor used ONLY for comparing two names.
create or replace function normalize_vendor(p_text text)
returns text language plpgsql stable set search_path = public as $$
declare v_canon text; v_clean text;
begin
  if coalesce(trim(p_text), '') = '' then return ''; end if;
  select canonical into v_canon from vendor_aliases
   where position(upper(pattern) in upper(p_text)) > 0
   order by sort_order, length(pattern) desc limit 1;
  if v_canon is not null then return lower(v_canon); end if;
  -- no alias: strip store numbers, punctuation and noise words
  v_clean := lower(p_text);
  v_clean := regexp_replace(v_clean, '[#*]\s*\d+', ' ', 'g');
  v_clean := regexp_replace(v_clean, '[^a-z ]', ' ', 'g');
  v_clean := regexp_replace(v_clean, '\m(llc|inc|co|corp|ltd|the|tx|dtx|pos|purchase|debit|card)\M', ' ', 'g');
  return trim(regexp_replace(v_clean, '\s+', ' ', 'g'));
end $$;

-- ------------------------------------------------------------------ 4. expenses columns
alter table expenses add column if not exists review_status text not null default 'ok'
  check (review_status in ('ok', 'needs_review', 'possible_duplicate'));
alter table expenses add column if not exists duplicate_of uuid references expenses(id) on delete set null;
alter table expenses add column if not exists merged_into  uuid references expenses(id) on delete set null;
create index if not exists expenses_review_idx on expenses(review_status) where review_status <> 'ok' and deleted_at is null;

-- ------------------------------------------------------------------ 5. evidence tables
create table if not exists expense_sources (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid references expenses(id) on delete set null,   -- null until matched
  source_type  text not null check (source_type in ('bank', 'receipt', 'email', 'stripe', 'manual', 'subscription', 'mileage')),
  source_ref   text not null,                                      -- external unique id
  amount       numeric(12,2),                                      -- signed: refunds are negative
  occurred_on  date,
  raw          jsonb not null default '{}'::jsonb,
  parsed       jsonb not null default '{}'::jsonb,
  confidence   numeric(5,2),
  merged_from  uuid,                                               -- expense this evidence belonged to before a merge
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists expense_sources_ref_uniq on expense_sources (source_type, source_ref);
create index if not exists expense_sources_expense_idx on expense_sources (expense_id);
create trigger expense_sources_updated before update on expense_sources for each row execute function set_updated_at();

create table if not exists expense_items (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid not null references expenses(id) on delete cascade,
  source_id    uuid references expense_sources(id) on delete set null,
  description  text not null default '',
  quantity     numeric(12,3) not null default 1,
  unit_price   numeric(12,4) not null default 0,
  line_total   numeric(12,2) not null default 0,
  tax_amount   numeric(12,2) not null default 0,
  category_id  uuid references expense_categories(id),
  is_business  boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists expense_items_expense_idx on expense_items (expense_id);

alter table expense_sources enable row level security;
alter table expense_items   enable row level security;
drop policy if exists expense_sources_select on expense_sources;
drop policy if exists expense_sources_update on expense_sources;
drop policy if exists expense_items_all on expense_items;
create policy expense_sources_select on expense_sources for select to authenticated using (is_admin());
create policy expense_sources_update on expense_sources for update to authenticated using (is_admin()) with check (is_admin());
create policy expense_items_all on expense_items for all to authenticated using (is_admin()) with check (is_admin());
create trigger expense_sources_audit after insert or update or delete on expense_sources for each row execute function audit_row();
create trigger expense_items_audit after insert or update or delete on expense_items for each row execute function audit_row();

-- ------------------------------------------------------------------ 6. bank rules: actions + direction
alter table bank_rules add column if not exists action text not null default 'expense'
  check (action in ('expense', 'transfer', 'owner_contribution', 'personal', 'payout'));
alter table bank_rules add column if not exists direction text not null default 'any'
  check (direction in ('any', 'out', 'in'));
-- previous "skip" rules were transfers
update bank_rules set action = 'transfer' where skip and action = 'expense';

create or replace function bank_rules_sync_skip() returns trigger language plpgsql as $$
begin new.skip := (new.action <> 'expense'); return new; end $$;
drop trigger if exists bank_rules_skip_sync on bank_rules;
create trigger bank_rules_skip_sync before insert or update on bank_rules for each row execute function bank_rules_sync_skip();
update bank_rules set skip = (action <> 'expense');

alter table bank_transactions add column if not exists kind text not null default 'unclassified'
  check (kind in ('unclassified', 'expense', 'transfer', 'owner_contribution', 'personal', 'payout', 'money_in', 'pending', 'ignored'));
alter table bank_transactions add column if not exists pending_transaction_id text;
alter table bank_transactions add column if not exists rule_id uuid references bank_rules(id) on delete set null;

-- Zelle is no longer skipped wholesale: money from the owner is an owner contribution,
-- money to someone else is an expense that needs a category.
delete from bank_rules where match_text = 'ZELLE';
insert into bank_rules (match_text, vendor, action, direction, sort_order) values
  ('ZELLE PAYMENT FROM FADY', '', 'owner_contribution', 'in', 12),
  ('STRIPE', 'Stripe', 'payout', 'in', 12)
on conflict do nothing;
insert into bank_rules (match_text, vendor, category_id, cost_type, sort_order)
select 'STRIPE', 'Stripe', c.id, 'operating', 41 from expense_categories c where c.name = 'Bank / payment fees'
on conflict do nothing;

-- ------------------------------------------------------------------ 7. matching engine
-- Candidates for "this new evidence is probably an expense we already have".
-- p_source_type: the kind of evidence arriving. A candidate that already has
-- evidence of the same kind is NOT a candidate (two bank charges are never merged).
create or replace function find_expense_match(
  p_vendor text, p_amount numeric, p_date date, p_source_type text, p_exclude uuid default null
) returns table (expense_id uuid, score int, vendor_match boolean)
language plpgsql stable security definer set search_path = public as $$
declare s expense_settings%rowtype; v_norm text := normalize_vendor(p_vendor);
begin
  select * into s from expense_settings limit 1;
  return query
  select e.id,
         (40
          + case when v_norm <> '' and normalize_vendor(e.vendor) = v_norm then 40 else 0 end
          + (20 * (1 - abs(e.expense_date - p_date)::numeric / greatest(s.match_window_days, 1)))::int
         ) as sc,
         (v_norm <> '' and normalize_vendor(e.vendor) = v_norm)
    from expenses e
   where e.deleted_at is null
     and e.auto_source is distinct from 'order_cost'
     and e.id is distinct from p_exclude
     and abs(e.total_amount - abs(p_amount)) <= s.amount_tolerance
     and abs(e.expense_date - p_date) <= s.match_window_days
     and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = p_source_type)
   order by sc desc, abs(e.expense_date - p_date), e.created_at
   limit 5;
end $$;
revoke all on function find_expense_match(text, numeric, date, text, uuid) from public, anon;
grant execute on function find_expense_match(text, numeric, date, text, uuid) to authenticated;

-- attach / detach evidence ---------------------------------------------------
create or replace function link_source(p_type text, p_ref text, p_expense uuid, p_amount numeric, p_date date, p_parsed jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on, parsed)
  values (p_type, p_ref, p_expense, p_amount, p_date, coalesce(p_parsed, '{}'::jsonb))
  on conflict (source_type, source_ref)
  do update set expense_id = excluded.expense_id, amount = excluded.amount, occurred_on = excluded.occurred_on
  returning id into v_id;
  return v_id;
end $$;
revoke all on function link_source(text, text, uuid, numeric, date, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ 8. bank transaction -> expense
create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype;
  r bank_rules%rowtype;
  e expenses%rowtype;
  v_vendor text; v_cat uuid; v_cost_type cost_type;
  v_expense_id uuid; v_kind text; v_match record; v_review text := 'ok'; v_dup uuid;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;

  -- first matching rule wins (direction aware)
  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
     and (direction = 'any' or (direction = 'out' and t.amount > 0) or (direction = 'in' and t.amount < 0))
   order by sort_order, created_at limit 1;

  -- 1. decide what this transaction is
  if t.ignored or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then
    v_kind := 'ignored';
  elsif t.pending then
    v_kind := 'pending';
  elsif r.id is not null and r.action <> 'expense' then
    v_kind := r.action;
  elsif t.amount <= 0 then
    v_kind := 'money_in';          -- deposits / refunds: never an expense, owner classifies
  else
    v_kind := 'expense';
  end if;

  update bank_transactions set kind = v_kind, rule_id = r.id where id = t.id and (kind is distinct from v_kind or rule_id is distinct from r.id);

  -- 2. not a business cost: make sure no expense is counted for it
  if v_kind <> 'expense' then
    if t.expense_id is not null then
      select * into e from expenses where id = t.expense_id;
      if e.auto_source = 'bank' then
        update expenses set deleted_at = now() where id = e.id and deleted_at is null;
      else
        update expenses set bank_transaction_id = null where id = e.id;   -- adopted manual expense stays
      end if;
      delete from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');

  -- 3a. already linked: refresh amount/date for rows the bank sync owns
  if t.expense_id is not null then
    select * into e from expenses where id = t.expense_id;
    if e.auto_source = 'bank' then
      update expenses
         set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
             amount_before_tax = t.amount, category_id = coalesce(v_cat, category_id),
             cost_type = case when v_cat is not null then v_cost_type else cost_type end, deleted_at = null
       where id = e.id;
    end if;
    perform link_source('bank', t.plaid_transaction_id, t.expense_id, t.amount, t.posted_on);
    return t.expense_id;
  end if;

  -- 3b. try to attach to an expense we already have (manual entry, subscription, receipt)
  select * into v_match from find_expense_match(v_vendor || ' ' || t.name, t.amount, t.posted_on, 'bank') limit 1;
  if v_match.expense_id is not null and v_match.vendor_match then
    update expenses set bank_transaction_id = t.id where id = v_match.expense_id;
    update bank_transactions set expense_id = v_match.expense_id where id = t.id;
    perform link_source('bank', t.plaid_transaction_id, v_match.expense_id, t.amount, t.posted_on);
    return v_match.expense_id;
  elsif v_match.expense_id is not null then
    v_review := 'possible_duplicate'; v_dup := v_match.expense_id;
  end if;

  -- 3c. a genuinely new expense
  if v_review = 'ok' and v_cat is null then v_review := 'needs_review'; end if;
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, notes, auto_source, bank_transaction_id, review_status, duplicate_of)
  values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
          'Imported from the bank feed.', 'bank', t.id, v_review, v_dup)
  returning id into v_expense_id;
  update bank_transactions set expense_id = v_expense_id where id = t.id;
  perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
  return v_expense_id;
end $$;

-- a transaction Plaid says no longer exists
create or replace function remove_bank_transactions(p_plaid_ids text[])
returns int language plpgsql security definer set search_path = public as $$
declare rec record; n int := 0;
begin
  for rec in select bt.id, bt.expense_id, bt.plaid_transaction_id, e.auto_source
               from bank_transactions bt left join expenses e on e.id = bt.expense_id
              where bt.plaid_transaction_id = any(p_plaid_ids)
  loop
    if rec.expense_id is not null then
      if rec.auto_source = 'bank' then
        update expenses set deleted_at = now() where id = rec.expense_id and deleted_at is null;
      else
        update expenses set bank_transaction_id = null where id = rec.expense_id;
      end if;
    end if;
    delete from expense_sources where source_type = 'bank' and source_ref = rec.plaid_transaction_id;
    delete from bank_transactions where id = rec.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function remove_bank_transactions(text[]) from public, anon, authenticated;

-- ------------------------------------------------------------------ 9. every expense has evidence
-- Manual entries and generated subscription charges record themselves as evidence.
create or replace function expense_default_source() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.auto_source is null then
    if new.recurring_parent_id is not null then
      insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
      values ('subscription', new.recurring_parent_id::text || ':' || to_char(new.expense_date, 'YYYY-MM-DD'), new.id, new.total_amount, new.expense_date)
      on conflict (source_type, source_ref) do nothing;
    elsif new.recurrence <> 'none' then
      insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
      values ('subscription', new.id::text || ':' || to_char(new.expense_date, 'YYYY-MM-DD'), new.id, new.total_amount, new.expense_date)
      on conflict (source_type, source_ref) do nothing;
    else
      insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
      values ('manual', new.id::text, new.id, new.total_amount, new.expense_date)
      on conflict (source_type, source_ref) do nothing;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists expenses_default_source on expenses;
create trigger expenses_default_source after insert on expenses for each row execute function expense_default_source();

-- ------------------------------------------------------------------ 10. merge / unmerge (reversible, audited)
create or replace function merge_expenses(p_keep uuid, p_drop uuid)
returns void language plpgsql security definer set search_path = public as $$
declare k expenses%rowtype; d expenses%rowtype;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  if p_keep = p_drop then raise exception 'cannot merge an expense into itself'; end if;
  select * into k from expenses where id = p_keep and deleted_at is null;
  select * into d from expenses where id = p_drop and deleted_at is null;
  if k.id is null or d.id is null then raise exception 'expense not found'; end if;

  -- the bank transaction wins if only the dropped row had one
  if d.bank_transaction_id is not null and k.bank_transaction_id is null then
    update expenses set bank_transaction_id = d.bank_transaction_id where id = k.id;
  end if;
  update bank_transactions set expense_id = k.id where expense_id = d.id;
  update expense_sources set merged_from = d.id, expense_id = k.id where expense_id = d.id;
  update expense_items set expense_id = k.id where expense_id = d.id;
  if k.receipt_path = '' and d.receipt_path <> '' then update expenses set receipt_path = d.receipt_path where id = k.id; end if;
  update expenses set deleted_at = now(), merged_into = k.id, bank_transaction_id = null, review_status = 'ok' where id = d.id;
  update expenses set review_status = 'ok', duplicate_of = null where id = k.id;
end $$;
grant execute on function merge_expenses(uuid, uuid) to authenticated;

create or replace function unmerge_expense(p_drop uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d expenses%rowtype; v_bank uuid;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  select * into d from expenses where id = p_drop and merged_into is not null;
  if d.id is null then raise exception 'this expense was not merged'; end if;
  -- give the evidence back
  update expense_sources set expense_id = d.id, merged_from = null where merged_from = d.id;
  select bt.id into v_bank from expense_sources s join bank_transactions bt on bt.plaid_transaction_id = s.source_ref
   where s.source_type = 'bank' and s.expense_id = d.id limit 1;
  if v_bank is not null then
    update bank_transactions set expense_id = d.id where id = v_bank;
    update expenses set bank_transaction_id = v_bank where id = d.id;
    update expenses set bank_transaction_id = null where id = d.merged_into and bank_transaction_id = v_bank;
  end if;
  update expenses set deleted_at = null, merged_into = null where id = d.id;
end $$;
grant execute on function unmerge_expense(uuid) to authenticated;

-- "Keep both": the owner says these are two real purchases
create or replace function keep_both_expenses(p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  update expenses set review_status = case when category_id is null then 'needs_review' else 'ok' end, duplicate_of = null where id = p_expense;
end $$;
grant execute on function keep_both_expenses(uuid) to authenticated;

-- ------------------------------------------------------------------ 11. integrity report
create or replace function expense_integrity()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'possible_duplicates', (select count(*) from expenses where deleted_at is null and review_status = 'possible_duplicate'),
    'needs_review',        (select count(*) from expenses where deleted_at is null and review_status = 'needs_review'),
    'expenses_without_source', (select count(*) from expenses e where e.deleted_at is null and e.auto_source is distinct from 'order_cost'
                                  and not exists (select 1 from expense_sources s where s.expense_id = e.id)),
    'bank_amount_mismatch', (select count(*) from expenses e join bank_transactions b on b.id = e.bank_transaction_id
                              where e.deleted_at is null and abs(e.total_amount - b.amount) > (select amount_tolerance from expense_settings limit 1)),
    'money_in_unclassified', (select count(*) from bank_transactions where kind = 'money_in'),
    'duplicate_bank_links', (select count(*) from (select bank_transaction_id from expenses where deleted_at is null and bank_transaction_id is not null
                              group by 1 having count(*) > 1) x)
  )
$$;
grant execute on function expense_integrity() to authenticated;

create table if not exists expense_integrity_log (
  id        uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default now(),
  result    jsonb not null
);
alter table expense_integrity_log enable row level security;
drop policy if exists expense_integrity_log_select on expense_integrity_log;
create policy expense_integrity_log_select on expense_integrity_log for select to authenticated using (is_admin());

select cron.schedule('expense-integrity-nightly', '30 7 * * *',
  $$insert into expense_integrity_log (result) select expense_integrity()$$)
 where not exists (select 1 from cron.job where jobname = 'expense-integrity-nightly');

-- ------------------------------------------------------------------ 12. Stripe processing fees
insert into expense_categories (name, cost_type, sort_order) values ('Payment processing fees', 'operating', 15)
on conflict (name) do nothing;

-- One fee expense per Stripe payment. Idempotent: calling it again for the same
-- payment never adds a row; an exact fee replaces an earlier estimate.
create or replace function record_stripe_fee(p_ref text, p_fee numeric, p_date date, p_order_id uuid, p_estimated boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_src expense_sources%rowtype; v_cat uuid; v_name text;
begin
  if p_fee is null or p_fee <= 0 then return null; end if;
  select customer_name into v_name from orders where id = p_order_id;
  if v_name is not null and is_test_order_name(v_name) then return null; end if;

  select * into v_src from expense_sources where source_type = 'stripe' and source_ref = p_ref;
  if found then
    if not p_estimated and v_src.expense_id is not null then
      update expenses set amount_before_tax = p_fee, notes = 'Stripe processing fee (exact).' where id = v_src.expense_id;
      update expense_sources set amount = p_fee, parsed = jsonb_build_object('estimated', false) where id = v_src.id;
    end if;
    return v_src.expense_id;
  end if;

  select id into v_cat from expense_categories where name = 'Payment processing fees';
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, order_id, notes, auto_source)
  values (p_date, 'Stripe', v_cat, 'Card processing fee', p_fee, 0, 'operating', p_order_id,
          case when p_estimated then 'Stripe processing fee (estimated 2.9% + 30 cents; replaced by the exact fee when available).' else 'Stripe processing fee (exact).' end,
          'stripe')
  returning id into v_id;
  insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on, parsed)
  values ('stripe', p_ref, v_id, p_fee, p_date, jsonb_build_object('estimated', p_estimated));
  return v_id;
end $$;
revoke all on function record_stripe_fee(text, numeric, date, uuid, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------------ 13. map the rows that already exist
-- bank imports
insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
select 'bank', bt.plaid_transaction_id, e.id, bt.amount, bt.posted_on
  from expenses e join bank_transactions bt on bt.id = e.bank_transaction_id
 where e.deleted_at is null
on conflict (source_type, source_ref) do nothing;
-- manual + subscription rows (the insert trigger only covers new rows)
insert into expense_sources (source_type, source_ref, expense_id, amount, occurred_on)
select case when e.recurrence <> 'none' or e.recurring_parent_id is not null then 'subscription' else 'manual' end,
       case when e.recurring_parent_id is not null then e.recurring_parent_id::text || ':' || to_char(e.expense_date, 'YYYY-MM-DD')
            when e.recurrence <> 'none' then e.id::text || ':' || to_char(e.expense_date, 'YYYY-MM-DD')
            else e.id::text end,
       e.id, e.total_amount, e.expense_date
  from expenses e
 where e.deleted_at is null and e.auto_source is null
on conflict (source_type, source_ref) do nothing;

-- classify the bank transactions that were already imported
update bank_transactions set kind = 'expense' where expense_id is not null;
do $$ declare rec record; begin
  for rec in select id from bank_transactions where expense_id is null loop
    perform apply_bank_transaction(rec.id);
  end loop;
end $$;

-- ------------------------------------------------------------------ 14. daily bank sync (Chicago morning)
create extension if not exists pg_net with schema extensions;
-- The cron job itself is created by hand after deploy because it embeds the shared
-- secret (see docs/HANDOFF-3-expenses.md). Nothing secret is stored in this file.


-- 0047: an expense that was waiting for a category leaves the Review inbox the moment it has one,
-- whether the category came from a bank rule, the inbox, or the edit form.
create or replace function expense_review_autoclear() returns trigger language plpgsql as $$
begin
  if new.review_status = 'needs_review' and new.category_id is not null then
    new.review_status := 'ok';
  end if;
  return new;
end $$;
drop trigger if exists expenses_review_autoclear on expenses;
create trigger expenses_review_autoclear before update on expenses for each row execute function expense_review_autoclear();


-- 0048: bank imports made before the review flag existed that still have no category go to the Review inbox.
update expenses set review_status = 'needs_review'
 where deleted_at is null and auto_source = 'bank' and category_id is null and review_status = 'ok';


-- ============================================================================
-- 0049_mileage.sql : Expenses rebuild, phase 3 (mileage).
--
--  * orders.delivery_miles : miles of the delivery quote, saved at order time
--  * mileage_logs          : one row per trip. Delivery trips are created
--                            automatically when an order is completed
--                            (unique per order, so never twice).
--  * irs_mileage_rates     : official rate by DATE RANGE (the 2026 rate changed
--                            on July 1). Rows start unconfirmed; the owner confirms.
--  * mileage_places        : saved supply-run destinations (one-tap trips)
--  * mileage_settings      : standard vs actual method, round trip, vehicle
--  * mileage_log_view      : each trip priced with the rate in force on its date
--
-- Mileage is a tax DEDUCTION, not money spent, so it never enters `expenses`
-- totals. It is reported next to them (Overview, Tax Pack).
-- ============================================================================

alter table orders add column if not exists delivery_miles numeric(8,1);

create table if not exists mileage_settings (
  id                   boolean primary key default true check (id),
  method               text not null default 'standard' check (method in ('standard', 'actual')),
  method_confirmed     boolean not null default false,       -- owner/accountant confirmed the choice
  delivery_round_trip  boolean not null default true,        -- a delivery counts there AND back
  vehicle              text not null default 'Personal vehicle',
  updated_at           timestamptz not null default now()
);
insert into mileage_settings (id) values (true) on conflict do nothing;

create table if not exists irs_mileage_rates (
  id              uuid primary key default gen_random_uuid(),
  effective_from  date not null unique,
  effective_to    date not null,
  cents_per_mile  numeric(5,1) not null check (cents_per_mile > 0),
  confirmed       boolean not null default false,
  source          text not null default 'IRS Notice 2026-10 and its July 2026 update (irs.gov/tax-professionals/standard-mileage-rates)',
  check (effective_to >= effective_from)
);
-- 2026: 72.5 cents Jan 1 - Jun 30, raised to 76 cents Jul 1 - Dec 31 (checked on irs.gov 2026-10-01).
insert into irs_mileage_rates (effective_from, effective_to, cents_per_mile) values
  ('2026-01-01', '2026-06-30', 72.5),
  ('2026-07-01', '2026-12-31', 76.0)
on conflict do nothing;

create table if not exists mileage_places (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  address         text not null default '',
  one_way_miles   numeric(8,1) not null check (one_way_miles > 0),
  created_at      timestamptz not null default now()
);

create table if not exists mileage_logs (
  id                 uuid primary key default gen_random_uuid(),
  trip_date          date not null default current_date,
  kind               text not null default 'other' check (kind in ('delivery', 'supply', 'other')),
  purpose            text not null default '',
  from_label         text not null default '',
  to_label           text not null default '',
  miles              numeric(8,1) not null check (miles > 0),
  order_id           uuid references orders(id),
  vehicle            text not null default '',
  notes              text not null default '',
  estimated          boolean not null default false,   -- miles come from the fee formula, not an odometer
  auto               boolean not null default false,   -- created by the system
  route_id           uuid references mileage_logs(id), -- set on trips folded into a combined route
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by_system  boolean not null default false
);
-- one trip per order, EVEN IF it was deleted: a deleted delivery trip never comes back by itself
create unique index if not exists mileage_logs_order_uniq on mileage_logs (order_id) where order_id is not null;
create index if not exists mileage_logs_date_idx on mileage_logs (trip_date desc);
create trigger mileage_logs_updated before update on mileage_logs for each row execute function set_updated_at();
create trigger mileage_logs_audit after insert or update or delete on mileage_logs for each row execute function audit_row();

alter table mileage_settings  enable row level security;
alter table irs_mileage_rates enable row level security;
alter table mileage_places    enable row level security;
alter table mileage_logs      enable row level security;
drop policy if exists mileage_settings_rw on mileage_settings;
drop policy if exists irs_mileage_rates_rw on irs_mileage_rates;
drop policy if exists mileage_places_rw on mileage_places;
drop policy if exists mileage_logs_select on mileage_logs;
drop policy if exists mileage_logs_insert on mileage_logs;
drop policy if exists mileage_logs_update on mileage_logs;
create policy mileage_settings_rw  on mileage_settings  for all to authenticated using (is_admin()) with check (is_admin());
create policy irs_mileage_rates_rw on irs_mileage_rates for all to authenticated using (is_admin()) with check (is_admin());
create policy mileage_places_rw    on mileage_places    for all to authenticated using (is_admin()) with check (is_admin());
create policy mileage_logs_select  on mileage_logs for select to authenticated using (is_admin());
create policy mileage_logs_insert  on mileage_logs for insert to authenticated with check (is_admin());
create policy mileage_logs_update  on mileage_logs for update to authenticated using (is_admin()) with check (is_admin());
-- no delete policy: trips are soft-deleted (deleted_at)

-- ------------------------------------------------------------------ priced view
-- counted = a real, live trip that is not folded into a combined route.
create or replace view mileage_log_view with (security_invoker = true) as
select l.*,
       r.cents_per_mile,
       r.confirmed as rate_confirmed,
       case when r.cents_per_mile is null then null else round(l.miles * r.cents_per_mile) / 100 end as deduction,
       (l.deleted_at is null and l.route_id is null) as counted
  from mileage_logs l
  left join irs_mileage_rates r on l.trip_date between r.effective_from and r.effective_to;

-- ------------------------------------------------------------------ automatic delivery trips
create or replace function sync_delivery_mileage(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; s mileage_settings%rowtype; v_miles numeric; v_day date;
begin
  select * into o from orders where id = p_order_id;
  if not found then return; end if;
  select * into s from mileage_settings limit 1;

  -- a cancelled / refunded / deleted order has no trip; the system retires its own entry
  if o.status in ('cancelled', 'refunded') or o.deleted_at is not null or is_test_order_name(o.customer_name) then
    update mileage_logs set deleted_at = now(), deleted_by_system = true
     where order_id = p_order_id and auto and deleted_at is null;
    return;
  end if;

  if o.status <> 'completed' or o.delivery_method <> 'delivery' or coalesce(o.delivery_miles, 0) <= 0 then return; end if;

  v_miles := round(o.delivery_miles * case when s.delivery_round_trip then 2 else 1 end, 1);
  v_day := (coalesce(o.completed_at, now()) at time zone 'America/Chicago')::date;

  insert into mileage_logs (trip_date, kind, purpose, from_label, to_label, miles, order_id, vehicle, notes, estimated, auto)
  values (v_day, 'delivery', 'Delivery ' || o.order_number, 'Kitchen',
          coalesce(nullif(o.address_city, ''), 'Customer') || ' (order ' || o.order_number || ')',
          v_miles, p_order_id, s.vehicle,
          case when s.delivery_round_trip then 'Round trip. ' else '' end ||
          'Miles come from the delivery quote (straight line x 1.3), not an odometer. Ask accountant if an estimate is acceptable.',
          true, true)
  on conflict (order_id) where order_id is not null do nothing;

  -- the order was cancelled earlier, then restored: bring back the entry the SYSTEM retired
  update mileage_logs set deleted_at = null, deleted_by_system = false
   where order_id = p_order_id and auto and deleted_by_system;
end $$;
revoke all on function sync_delivery_mileage(uuid) from public, anon, authenticated;

create or replace function orders_mileage_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin perform sync_delivery_mileage(new.id); return new; end $$;
drop trigger if exists orders_mileage on orders;
create trigger orders_mileage after insert or update of status, delivery_miles, delivery_method, deleted_at on orders
  for each row execute function orders_mileage_trigger();

-- ------------------------------------------------------------------ combine several drops into one route
-- Several deliveries driven in one outing are not additive: the owner enters the
-- real total for the route; the individual trips stay (history) but stop counting.
create or replace function combine_mileage_route(p_trip_ids uuid[], p_total_miles numeric, p_purpose text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_day date; v_n int; v_veh text;
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  if p_total_miles is null or p_total_miles <= 0 then raise exception 'route miles must be above zero'; end if;
  select count(*), min(trip_date), min(vehicle) into v_n, v_day, v_veh from mileage_logs
   where id = any(p_trip_ids) and deleted_at is null and route_id is null and kind = 'delivery';
  if v_n < 2 then raise exception 'pick at least two delivery trips that are not already in a route'; end if;
  if (select count(distinct trip_date) from mileage_logs where id = any(p_trip_ids)) > 1 then raise exception 'a route is one day: pick trips from the same day'; end if;
  insert into mileage_logs (trip_date, kind, purpose, from_label, to_label, miles, vehicle, notes)
  values (v_day, 'delivery', coalesce(nullif(p_purpose, ''), 'Delivery route (' || v_n || ' orders)'), 'Kitchen', 'Several customers', round(p_total_miles, 1), v_veh,
          'Combined route. Miles entered by the owner.')
  returning id into v_id;
  update mileage_logs set route_id = v_id where id = any(p_trip_ids) and deleted_at is null and route_id is null and kind = 'delivery';
  return v_id;
end $$;
grant execute on function combine_mileage_route(uuid[], numeric, text) to authenticated;

create or replace function split_mileage_route(p_route_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  update mileage_logs set route_id = null where route_id = p_route_id;
  update mileage_logs set deleted_at = now() where id = p_route_id and deleted_at is null;
end $$;
grant execute on function split_mileage_route(uuid) to authenticated;


-- 0050: IRS rates were checked against irs.gov on 2026-10-01, so they are confirmed. No manual step.
update irs_mileage_rates set confirmed = true where not confirmed;
alter table irs_mileage_rates alter column confirmed set default true;


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


-- 0052: the owner does not want to review anything. The system decides, and anything it is unsure
-- about is flagged for the ACCOUNTANT on the Tax tab instead of waiting in the Review inbox.
--
--  * known vendors get rules (Cloudflare = website, Court Solutions = licenses and permits)
--  * a bank charge with no rule gets category "Other" (the tax view already flags "Other" as Ask accountant)
--  * a deposit with no rule is treated as the owner putting money in (Stripe payouts have their own rule),
--    never as income and never as an expense
--  * possible duplicates still need a human decision, because merging wrongly would lose a real purchase

insert into bank_rules (match_text, vendor, category_id, cost_type, action, direction, sort_order)
select v.m, v.vend, c.id, 'operating', 'expense', 'out', 40
  from (values ('CLOUDFLARE', 'Cloudflare', 'Website / technology'),
               ('COURT SOLUTIONS', 'Court Solutions', 'Licenses and permits')) as v(m, vend, cat)
  join expense_categories c on c.name = v.cat
 where not exists (select 1 from bank_rules r where lower(r.match_text) = lower(v.m));

-- catch-all for unknown deposits: lowest priority, so every specific rule wins first
insert into bank_rules (match_text, vendor, action, direction, sort_order)
select '', '', 'owner_contribution', 'in', 900
 where not exists (select 1 from bank_rules where match_text = '' and direction = 'in');

-- a new bank import without a category becomes "Other" and leaves the inbox at once
create or replace function expense_default_category() returns trigger language plpgsql as $$
begin
  if new.auto_source = 'bank' and new.category_id is null then
    new.category_id := (select id from expense_categories where name = 'Other');
    new.review_status := case when new.review_status = 'possible_duplicate' then 'possible_duplicate' else 'ok' end;
  end if;
  return new;
end $$;
drop trigger if exists expenses_default_category on expenses;
create trigger expenses_default_category before insert on expenses for each row execute function expense_default_category();

-- apply the new rules to everything already imported
do $$ declare rec record; begin
  for rec in select id from bank_transactions loop perform apply_bank_transaction(rec.id); end loop;
end $$;
-- anything still waiting only for a category gets "Other"
update expenses set category_id = (select id from expense_categories where name = 'Other'), review_status = 'ok'
 where deleted_at is null and review_status = 'needs_review' and category_id is null;


-- ============================================================================
-- 0053_receipts.sql : Expenses rebuild, phase 2 (receipts, order emails, splits).
--
-- Evidence in, ONE expense out:
--  * receipt_files      : every uploaded photo/PDF or forwarded order email. The SHA-256 of the
--                         content is UNIQUE, so the same photo twice is refused by the database.
--  * apply_parsed_receipt() : takes what the AI read and (a) attaches it to an expense we already
--                         have, (b) creates one, (c) attaches a PARTIAL amount (split shipments,
--                         many-to-one), or (d) records a REFUND against the original purchase.
--  * expense_items      : line items, each with a category and a business/personal flag. A mixed
--                         cart is split across categories in the TAX view (expense_tax_view is
--                         now one row per category line), the Expenses list still shows one row.
--  * item_category_memory : an owner correction ("this item is Packaging") is remembered.
--  * bank sync learns the same tricks: split charges and refunds (apply_bank_transaction).
--  * needs_receipt_view : store charges (Walmart, Costco...) still without a receipt after N days.
-- Totals always come from `expenses`; evidence never adds money by itself.
-- ============================================================================

-- ------------------------------------------------------------------ 1. settings, categories, aliases
alter table expense_settings add column if not exists receipt_wait_days int not null default 3 check (receipt_wait_days between 0 and 60);

insert into expense_categories (name, cost_type, sort_order, schedule_c_line, treatment, always_ask, ask_note)
values ('Personal (not business)', 'operating', 99, 'personal', 'excluded', false, '')
on conflict (name) do update set schedule_c_line = 'personal', treatment = 'excluded';

alter table vendor_aliases add column if not exists needs_receipt boolean not null default false;
update vendor_aliases set needs_receipt = true
 where canonical in ('Walmart', 'Costco', 'WebstaurantStore', 'Amazon', 'Sam''s Club', 'Restaurant Depot', 'H-E-B', 'Kroger', 'Aldi', 'Uline');

alter table bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table bank_transactions add constraint bank_transactions_kind_check
  check (kind in ('unclassified', 'expense', 'transfer', 'owner_contribution', 'personal', 'payout', 'money_in', 'pending', 'ignored', 'refund'));

-- vendor names compare equal when they differ only by store numbers, punctuation or words like CREDIT / REFUND
create or replace function normalize_vendor(p_text text)
returns text language plpgsql stable set search_path = public as $$
declare v_canon text; v_clean text;
begin
  if coalesce(trim(p_text), '') = '' then return ''; end if;
  select canonical into v_canon from vendor_aliases
   where position(upper(pattern) in upper(p_text)) > 0
   order by sort_order, length(pattern) desc limit 1;
  if v_canon is not null then return lower(v_canon); end if;
  v_clean := lower(p_text);
  v_clean := regexp_replace(v_clean, '[#*]\s*\d+', ' ', 'g');
  v_clean := regexp_replace(v_clean, '[^a-z ]', ' ', 'g');
  v_clean := regexp_replace(v_clean, '\m(llc|inc|co|corp|ltd|the|tx|dtx|pos|purchase|debit|card|credit|refund|return|returns|reversal|payment)\M', ' ', 'g');
  return trim(regexp_replace(v_clean, '\s+', ' ', 'g'));
end $$;

-- ------------------------------------------------------------------ 2. receipt files
create table if not exists receipt_files (
  id                uuid primary key default gen_random_uuid(),
  sha256            text not null,                       -- of the file (or of the email text): the duplicate key
  storage_path      text not null default '',            -- object in bucket "receipts"; empty for body-only emails
  original_name     text not null default '',
  mime              text not null default '',
  size_bytes        int not null default 0,
  source            text not null default 'upload' check (source in ('upload', 'email')),
  email_message_id  text,                                -- Gmail Message-ID: the email duplicate key
  email_subject     text not null default '',
  body_text         text not null default '',            -- body-only emails are read from here
  status            text not null default 'uploaded' check (status in ('uploaded', 'parsing', 'parsed', 'failed', 'waiting_key')),
  outcome           text not null default '',            -- linked | created | possible_duplicate | partial | refund
  expense_id        uuid references expenses(id) on delete set null,
  parsed            jsonb not null default '{}'::jsonb,
  totals_ok         boolean,
  error             text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists receipt_files_sha_uniq on receipt_files (sha256);
create unique index if not exists receipt_files_msg_uniq on receipt_files (email_message_id) where email_message_id is not null;
create index if not exists receipt_files_expense_idx on receipt_files (expense_id);
drop trigger if exists receipt_files_updated on receipt_files;
create trigger receipt_files_updated before update on receipt_files for each row execute function set_updated_at();
drop trigger if exists receipt_files_audit on receipt_files;
create trigger receipt_files_audit after insert or update or delete on receipt_files for each row execute function audit_row();
alter table receipt_files enable row level security;
drop policy if exists receipt_files_select on receipt_files;
drop policy if exists receipt_files_insert on receipt_files;
drop policy if exists receipt_files_update on receipt_files;
create policy receipt_files_select on receipt_files for select to authenticated using (is_admin());
create policy receipt_files_insert on receipt_files for insert to authenticated with check (is_admin());
create policy receipt_files_update on receipt_files for update to authenticated using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------------ 3. item category memory
create table if not exists item_category_memory (
  item_key     text primary key,
  category_id  uuid not null references expense_categories(id) on delete cascade,
  is_business  boolean not null default true,
  hits         int not null default 1,
  updated_at   timestamptz not null default now()
);
alter table item_category_memory enable row level security;
drop policy if exists item_category_memory_all on item_category_memory;
create policy item_category_memory_all on item_category_memory for all to authenticated using (is_admin()) with check (is_admin());

-- "KING ARTHUR FLOUR 5LB" and "king arthur flour 10 lb" share a key: the first three letter-words
create or replace function item_key(p_name text) returns text language sql immutable as $$
  select coalesce(nullif(array_to_string((regexp_split_to_array(trim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z ]', ' ', 'g')), '\s+'))[1:3], ' '), ''), '')
$$;

create or replace function remember_item_category(p_name text, p_category uuid, p_business boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  if item_key(p_name) = '' then return; end if;
  insert into item_category_memory (item_key, category_id, is_business) values (item_key(p_name), p_category, p_business)
  on conflict (item_key) do update set category_id = excluded.category_id, is_business = excluded.is_business, hits = item_category_memory.hits + 1, updated_at = now();
end $$;
grant execute on function remember_item_category(text, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ 4. items on an expense
-- (re)writes the line items that came from ONE piece of evidence, so re-reading a receipt never doubles them
create or replace function write_receipt_items(p_expense uuid, p_source uuid, p_items jsonb, p_sign int default 1)
returns numeric language plpgsql security definer set search_path = public as $$
declare it jsonb; v_cat uuid; v_biz boolean; v_name text; v_total numeric; v_sum numeric := 0; v_mem item_category_memory%rowtype; v_personal uuid;
begin
  select id into v_personal from expense_categories where name = 'Personal (not business)';
  delete from expense_items where source_id = p_source;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_name := left(coalesce(it->>'name', ''), 200);
    v_total := p_sign * abs(coalesce(nullif(it->>'total', '')::numeric, coalesce(nullif(it->>'qty', '')::numeric, 1) * coalesce(nullif(it->>'unit_price', '')::numeric, 0)));
    continue when v_total = 0;
    v_cat := null; v_biz := true;
    select * into v_mem from item_category_memory where item_key = item_key(v_name);
    if found then v_cat := v_mem.category_id; v_biz := v_mem.is_business;
    else
      select id into v_cat from expense_categories where lower(name) = lower(coalesce(it->>'category', ''));
      if coalesce((it->>'personal')::boolean, false) then v_cat := v_personal; v_biz := false; end if;
    end if;
    if v_cat = v_personal then v_biz := false; end if;
    insert into expense_items (expense_id, source_id, description, quantity, unit_price, line_total, tax_amount, category_id, is_business)
    values (p_expense, p_source, v_name, coalesce(nullif(it->>'qty', '')::numeric, 1), coalesce(nullif(it->>'unit_price', '')::numeric, 0),
            v_total, 0, v_cat, v_biz);
    v_sum := v_sum + v_total;
  end loop;
  return v_sum;
end $$;
revoke all on function write_receipt_items(uuid, uuid, jsonb, int) from public, anon, authenticated;

-- A refund can be reported twice: an email/receipt says "refund 20" AND the bank deposits 20 later.
-- This finds the expense whose refund is already recorded by one side and not yet by the other,
-- so the second report attaches as evidence instead of reducing the purchase again.
create or replace function find_refund_counterpart(p_norm text, p_amount numeric, p_have text[])
returns uuid language sql stable security definer set search_path = public as $$
  select e.id from expenses e
   where e.deleted_at is null and p_norm <> '' and normalize_vendor(e.vendor) = p_norm
     and exists (select 1 from expense_sources h where h.expense_id = e.id and h.source_type = any(p_have) and h.amount < 0
                   and abs(abs(h.amount) - p_amount) <= (select amount_tolerance from expense_settings limit 1))
     and not exists (select 1 from expense_sources o where o.expense_id = e.id and o.source_type in ('bank', 'email', 'receipt')
                       and not (o.source_type = any(p_have)) and o.amount < 0
                       and abs(abs(o.amount) - p_amount) <= (select amount_tolerance from expense_settings limit 1))
   order by e.expense_date desc, e.created_at desc limit 1
$$;
revoke all on function find_refund_counterpart(text, numeric, text[]) from public, anon, authenticated;

-- ------------------------------------------------------------------ 5. what the AI read -> expense
create or replace function apply_parsed_receipt(p_file_id uuid, p_parsed jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f receipt_files%rowtype; s expense_settings%rowtype;
  v_type text; v_ref text;
  v_vendor text := trim(coalesce(p_parsed->>'vendor', ''));
  v_norm text; v_date date; v_total numeric; v_tax numeric; v_pm text;
  v_refund boolean := coalesce((p_parsed->>'is_refund')::boolean, false) or coalesce((p_parsed->>'total')::numeric, 0) < 0;
  v_items jsonb := coalesce(p_parsed->'items', '[]'::jsonb);
  v_isum numeric := 0; v_ok boolean := true; v_exp uuid; v_outcome text; v_match record; v_src uuid;
  v_cat uuid; v_ctype cost_type; v_review text := 'ok'; v_dup uuid; v_before numeric; v_tx numeric; v_rem numeric; v_main uuid; v_existing uuid;
begin
  select * into f from receipt_files where id = p_file_id;
  if not found then return jsonb_build_object('outcome', 'failed', 'error', 'unknown receipt file'); end if;
  select * into s from expense_settings limit 1;

  v_type := case when f.source = 'email' then 'email' else 'receipt' end;
  v_ref  := case when f.source = 'email' then coalesce(f.email_message_id, f.sha256) else f.sha256 end;
  v_norm := normalize_vendor(v_vendor);
  begin v_date := nullif(p_parsed->>'date', '')::date; exception when others then v_date := null; end;
  v_date := coalesce(v_date, (f.created_at at time zone 'America/Chicago')::date);
  v_total := abs(coalesce(nullif(p_parsed->>'total', '')::numeric, 0));
  v_tax := greatest(coalesce(nullif(p_parsed->>'tax', '')::numeric, 0), 0);
  v_pm := lower(coalesce(p_parsed->>'payment_method', ''));

  if v_total <= 0 then
    update receipt_files set status = 'failed', error = 'Could not read a total from this receipt. Open it and enter the expense by hand.', parsed = p_parsed where id = f.id;
    return jsonb_build_object('outcome', 'failed');
  end if;

  select coalesce(sum(abs(coalesce(nullif(x->>'total', '')::numeric, coalesce(nullif(x->>'qty', '')::numeric, 1) * coalesce(nullif(x->>'unit_price', '')::numeric, 0)))), 0)
    into v_isum from jsonb_array_elements(v_items) x;
  v_ok := jsonb_array_length(v_items) = 0 or abs(v_isum + v_tax - v_total) <= 0.05 or abs(v_isum - v_total) <= 0.05;

  -- ---- evidence we already processed (re-read, retry): reuse its expense, never match again ----
  select expense_id into v_existing from expense_sources where source_type = v_type and source_ref = v_ref and expense_id is not null;

  -- ---- a refund: reduce the ORIGINAL purchase, never income ----
  if v_refund and v_existing is not null then
    update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_existing, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
    return jsonb_build_object('outcome', 'refund', 'expense_id', v_existing);
  end if;
  if v_refund then
    v_exp := find_refund_counterpart(v_norm, v_total, array['bank']);
    if v_exp is not null then
      -- the bank already took this refund off the purchase: just record the receipt as evidence
      v_src := link_source(v_type, v_ref, v_exp, -v_total, v_date, p_parsed);
      update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
      return jsonb_build_object('outcome', 'refund', 'expense_id', v_exp);
    end if;
    select e.id into v_exp from expenses e
     where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and v_norm <> '' and normalize_vendor(e.vendor) = v_norm
       and e.total_amount >= v_total - s.amount_tolerance and e.expense_date <= v_date and v_date - e.expense_date <= 180
     order by e.expense_date desc, e.created_at desc limit 1;
    if v_exp is null then
      update receipt_files set status = 'failed', error = 'This is a refund but the original purchase was not found. Add the purchase first, then upload the refund again.', parsed = p_parsed where id = f.id;
      return jsonb_build_object('outcome', 'failed');
    end if;
    v_src := link_source(v_type, v_ref, v_exp, -v_total, v_date, p_parsed);
    select amount_before_tax, sales_tax_paid into v_before, v_tx from expenses where id = v_exp;
    v_rem := v_total - least(v_before, v_total);
    update expenses set amount_before_tax = greatest(v_before - v_total, 0), sales_tax_paid = greatest(v_tx - v_rem, 0) where id = v_exp;
    if exists (select 1 from expense_items where expense_id = v_exp) then
      select category_id into v_main from expense_items where expense_id = v_exp and is_business order by line_total desc limit 1;
      delete from expense_items where source_id = v_src;
      insert into expense_items (expense_id, source_id, description, line_total, category_id) values (v_exp, v_src, 'Refund', -v_total, v_main);
    end if;
    update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
    return jsonb_build_object('outcome', 'refund', 'expense_id', v_exp);
  end if;

  -- ---- attach to an expense we already have (bank charge first, subscription, earlier receipt...) ----
  if v_existing is not null then
    v_exp := v_existing; v_outcome := coalesce(nullif(f.outcome, ''), 'linked');
  else
    select * into v_match from find_expense_match(v_vendor, v_total, v_date, v_type) limit 1;
  end if;
  if v_exp is not null then null;
  elsif v_match.expense_id is not null and v_match.vendor_match then
    v_exp := v_match.expense_id; v_outcome := 'linked';
  elsif v_norm <> '' then
    -- one bank charge, several receipts / emails (many-to-one)
    select e.id into v_exp from expenses e
     where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and normalize_vendor(e.vendor) = v_norm
       and e.total_amount > v_total + s.amount_tolerance
       and abs(e.expense_date - v_date) <= s.match_window_days * 3
       and exists (select 1 from expense_sources b where b.expense_id = e.id and b.source_type = 'bank')
       and (select coalesce(sum(x.amount), 0) from expense_sources x where x.expense_id = e.id and x.source_type in ('receipt', 'email')) + v_total <= e.total_amount + s.amount_tolerance
       and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = v_type and x.source_ref = v_ref)
     order by abs(e.expense_date - v_date), e.created_at limit 1;
    if v_exp is not null then v_outcome := 'partial'; end if;
  end if;

  if v_exp is null then
    if v_match.expense_id is not null then v_review := 'possible_duplicate'; v_dup := v_match.expense_id; end if;
    -- category of the new expense = the business category with the most money in it
    select i.cat into v_cat from (
      select coalesce(c.id, (select id from expense_categories where name = 'Other')) as cat, sum(abs(coalesce(nullif(x->>'total', '')::numeric, 0))) as amt
        from jsonb_array_elements(v_items) x
        left join expense_categories c on lower(c.name) = lower(coalesce(x->>'category', ''))
       where not coalesce((x->>'personal')::boolean, false) group by 1 order by 2 desc limit 1) i;
    v_cat := coalesce(v_cat, (select id from expense_categories where name = 'Other'));
    select cost_type into v_ctype from expense_categories where id = v_cat;
    insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid, payment_method, cost_type, notes, auto_source, review_status, duplicate_of)
    values (v_date, coalesce(nullif(v_vendor, ''), 'Unknown store'), v_cat, left('Receipt: ' || coalesce(nullif(f.original_name, ''), nullif(f.email_subject, ''), v_vendor), 200),
            greatest(v_total - v_tax, 0), v_tax,
            case when v_pm in ('cash', 'card', 'zelle', 'venmo') then v_pm::payment_method else null end,
            coalesce(v_ctype, 'operating'),
            case when v_pm = 'cash' then 'Paid cash (receipt only).' else 'From a receipt. The bank charge will attach to this when it arrives.' end,
            v_type, v_review, v_dup)
    returning id into v_exp;
    v_outcome := case when v_review = 'possible_duplicate' then 'possible_duplicate' else 'created' end;
  end if;

  v_src := link_source(v_type, v_ref, v_exp, v_total, v_date, p_parsed);
  perform write_receipt_items(v_exp, v_src, v_items, 1);
  update expenses set receipt_path = f.storage_path where id = v_exp and receipt_path = '' and f.storage_path <> '';
  update receipt_files set status = 'parsed', outcome = v_outcome, expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok,
         error = case when v_ok then '' else 'The items do not add up to the total. Check the items.' end where id = f.id;
  return jsonb_build_object('outcome', v_outcome, 'expense_id', v_exp, 'totals_ok', v_ok);
end $$;
revoke all on function apply_parsed_receipt(uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ 6. bank sync: split charges + refunds
create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype; r bank_rules%rowtype; e expenses%rowtype; s expense_settings%rowtype;
  v_vendor text; v_cat uuid; v_cost_type cost_type; v_expense_id uuid; v_kind text; v_match record;
  v_review text := 'ok'; v_dup uuid; v_norm text; v_refund uuid; v_before numeric; v_tx numeric; v_rem numeric; v_amt numeric; v_main uuid; v_src uuid; v_skip_reduce boolean := false; v_search text;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;
  select * into s from expense_settings limit 1;

  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
     and (direction = 'any' or (direction = 'out' and t.amount > 0) or (direction = 'in' and t.amount < 0))
   order by sort_order, created_at limit 1;

  -- a refund already applied: nothing more to do (re-syncs must not reduce the purchase twice)
  if t.amount < 0 then
    select expense_id into v_refund from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id and amount < 0 and expense_id is not null;
    if v_refund is not null then
      update bank_transactions set kind = 'refund', expense_id = v_refund where id = t.id and (kind <> 'refund' or expense_id is distinct from v_refund);
      return v_refund;
    end if;
  end if;

  -- 1. what is this transaction?
  if t.ignored or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then v_kind := 'ignored';
  elsif t.pending then v_kind := 'pending';
  elsif r.id is not null and r.action <> 'expense' and (t.amount > 0 or r.sort_order < 900) then v_kind := r.action;
  elsif t.amount <= 0 then v_kind := 'money_in';
  else v_kind := 'expense'; end if;

  -- money in from a store we bought from = a REFUND of that purchase (unless a specific rule says otherwise)
  if t.amount < 0 and v_kind in ('money_in', 'owner_contribution') and (r.id is null or r.sort_order >= 900 or r.action = 'expense') then
    v_norm := normalize_vendor(coalesce(nullif(t.merchant_name, ''), t.name));
    if v_norm <> '' then
      v_refund := find_refund_counterpart(v_norm, abs(t.amount), array['email', 'receipt']);
      if v_refund is not null then v_skip_reduce := true;   -- a refund email already took it off
      else
        select e2.id into v_refund from expenses e2
         where e2.deleted_at is null and e2.auto_source is distinct from 'order_cost' and normalize_vendor(e2.vendor) = v_norm
           and e2.total_amount >= abs(t.amount) - s.amount_tolerance and e2.expense_date <= t.posted_on and t.posted_on - e2.expense_date <= 180
         order by e2.expense_date desc, e2.created_at desc limit 1;
      end if;
      if v_refund is not null then v_kind := 'refund'; end if;
    end if;
  end if;

  -- no purchase to refund: the catch-all deposit rule (owner money) applies
  if v_kind = 'money_in' and v_refund is null and r.id is not null and r.action <> 'expense' then v_kind := r.action; end if;

  update bank_transactions set kind = v_kind, rule_id = r.id where id = t.id and (kind is distinct from v_kind or rule_id is distinct from r.id);

  if v_kind = 'refund' then
    v_amt := abs(t.amount);
    v_src := link_source('bank', t.plaid_transaction_id, v_refund, t.amount, t.posted_on);
    if not v_skip_reduce then
    select amount_before_tax, sales_tax_paid into v_before, v_tx from expenses where id = v_refund;
    v_rem := v_amt - least(v_before, v_amt);
    update expenses set amount_before_tax = greatest(v_before - v_amt, 0), sales_tax_paid = greatest(v_tx - v_rem, 0) where id = v_refund;
    end if;
    if not v_skip_reduce and exists (select 1 from expense_items where expense_id = v_refund) then
      select category_id into v_main from expense_items where expense_id = v_refund and is_business order by line_total desc limit 1;
      delete from expense_items where source_id = v_src;
      insert into expense_items (expense_id, source_id, description, line_total, category_id) values (v_refund, v_src, 'Refund', -v_amt, v_main);
    end if;
    update bank_transactions set expense_id = v_refund where id = t.id;
    return v_refund;
  end if;

  -- 2. not a business cost
  if v_kind <> 'expense' then
    if t.expense_id is not null then
      select * into e from expenses where id = t.expense_id;
      if e.auto_source = 'bank' then update expenses set deleted_at = now() where id = e.id and deleted_at is null;
      else update expenses set bank_transaction_id = null where id = e.id; end if;
      delete from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');
  v_search := case when position(lower(v_vendor) in lower(t.name)) > 0 then t.name else v_vendor || ' ' || t.name end;

  -- 3a. already linked: refresh amount/date for rows the bank sync owns (refunds already taken off stay off)
  if t.expense_id is not null then
    select * into e from expenses where id = t.expense_id;
    if e.auto_source = 'bank' then
      update expenses
         set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
             amount_before_tax = greatest(t.amount + coalesce((select sum(x.amount) from expense_sources x where x.expense_id = e.id and x.source_type = 'bank' and x.amount < 0), 0), 0),
             category_id = coalesce(v_cat, category_id),
             cost_type = case when v_cat is not null then v_cost_type else cost_type end, deleted_at = null
       where id = e.id;
    end if;
    perform link_source('bank', t.plaid_transaction_id, t.expense_id, t.amount, t.posted_on);
    return t.expense_id;
  end if;

  -- 3b. attach to an expense we already have
  select * into v_match from find_expense_match(v_search, t.amount, t.posted_on, 'bank') limit 1;
  if v_match.expense_id is not null and v_match.vendor_match then
    update expenses set bank_transaction_id = coalesce(bank_transaction_id, t.id) where id = v_match.expense_id;
    update bank_transactions set expense_id = v_match.expense_id where id = t.id;
    perform link_source('bank', t.plaid_transaction_id, v_match.expense_id, t.amount, t.posted_on);
    return v_match.expense_id;
  end if;

  -- 3b'. one order email / receipt, several smaller card charges (split shipments)
  v_norm := normalize_vendor(v_search);
  if v_norm <> '' then
    select e2.id into v_expense_id from expenses e2
     where e2.deleted_at is null and e2.auto_source is distinct from 'order_cost' and normalize_vendor(e2.vendor) = v_norm
       and e2.total_amount > t.amount + s.amount_tolerance
       and abs(e2.expense_date - t.posted_on) <= s.match_window_days * 3
       and exists (select 1 from expense_sources d where d.expense_id = e2.id and d.source_type in ('email', 'receipt'))
       and (select coalesce(sum(b.amount), 0) from expense_sources b where b.expense_id = e2.id and b.source_type = 'bank') + t.amount <= e2.total_amount + s.amount_tolerance
     order by abs(e2.expense_date - t.posted_on), e2.created_at limit 1;
    if v_expense_id is not null then
      update expenses set bank_transaction_id = coalesce(bank_transaction_id, t.id) where id = v_expense_id;
      update bank_transactions set expense_id = v_expense_id where id = t.id;
      perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
      return v_expense_id;
    end if;
  end if;

  if v_match.expense_id is not null then v_review := 'possible_duplicate'; v_dup := v_match.expense_id; end if;

  -- 3c. a genuinely new expense
  if v_review = 'ok' and v_cat is null then v_review := 'needs_review'; end if;
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, notes, auto_source, bank_transaction_id, review_status, duplicate_of)
  values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
          'Imported from the bank feed.', 'bank', t.id, v_review, v_dup)
  returning id into v_expense_id;
  update bank_transactions set expense_id = v_expense_id where id = t.id;
  perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
  return v_expense_id;
end $$;

-- ------------------------------------------------------------------ 7. integrity (one-to-many aware)
create or replace function expense_integrity()
returns jsonb language sql stable security definer set search_path = public as $$
  with bank as (
    select e.id, e.total_amount, coalesce(sum(s.amount), 0) as bank_sum, count(s.id) as n
      from expenses e join expense_sources s on s.expense_id = e.id and s.source_type = 'bank'
     where e.deleted_at is null group by e.id, e.total_amount)
  select jsonb_build_object(
    'possible_duplicates', (select count(*) from expenses where deleted_at is null and review_status = 'possible_duplicate'),
    'needs_review',        (select count(*) from expenses where deleted_at is null and review_status = 'needs_review'),
    'expenses_without_source', (select count(*) from expenses e where e.deleted_at is null and e.auto_source is distinct from 'order_cost'
                                  and not exists (select 1 from expense_sources s where s.expense_id = e.id)),
    -- more money charged than the expense says = a mismatch; less = a split order still waiting for its other charges
    'bank_amount_mismatch', (select count(*) from bank where bank_sum > total_amount + (select amount_tolerance from expense_settings limit 1)
                               + coalesce((select abs(sum(x.amount)) from expense_sources x where x.expense_id = bank.id and x.source_type in ('email', 'receipt') and x.amount < 0), 0)),
    'partial_bank_coverage',(select count(*) from bank where n > 0 and bank_sum < total_amount - (select amount_tolerance from expense_settings limit 1)
                               and exists (select 1 from expense_sources d where d.expense_id = bank.id and d.source_type in ('email', 'receipt'))),
    'money_in_unclassified', (select count(*) from bank_transactions where kind = 'money_in'),
    'duplicate_bank_links', (select count(*) from (select bank_transaction_id from expenses where deleted_at is null and bank_transaction_id is not null
                              group by 1 having count(*) > 1) x),
    'receipts_unmatched_7d', (select count(*) from expenses e where e.deleted_at is null and e.created_at < now() - interval '7 days'
                                and e.auto_source in ('receipt', 'email') and e.payment_method is distinct from 'cash'
                                and not exists (select 1 from expense_sources s where s.expense_id = e.id and s.source_type = 'bank')),
    'receipts_failed', (select count(*) from receipt_files where status = 'failed'),
    'items_not_adding_up', (select count(*) from receipt_files where status = 'parsed' and totals_ok is false)
  )
$$;

-- ------------------------------------------------------------------ 8. needs a receipt
create or replace view needs_receipt_view with (security_invoker = true) as
select e.id as expense_id, e.expense_date, e.vendor, e.total_amount, e.description,
       (current_date - e.expense_date) as days_waiting
  from expenses e
 where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and e.total_amount > 0
   and e.expense_date <= current_date - (select receipt_wait_days from expense_settings limit 1)
   and exists (select 1 from expense_sources b where b.expense_id = e.id and b.source_type = 'bank')
   and not exists (select 1 from expense_sources r where r.expense_id = e.id and r.source_type in ('receipt', 'email'))
   and exists (select 1 from vendor_aliases a where a.needs_receipt and lower(a.canonical) = normalize_vendor(e.vendor));

-- ------------------------------------------------------------------ 9. tax view: one row per category line
-- An expense with items is split by the category of its items; money the items do not explain
-- (shipping, rounding, a tip) stays on the expense's own category so the lines still add up to the total.
create or replace view expense_tax_view with (security_invoker = true) as
with s as (select * from expense_settings limit 1),
     m as (select * from mileage_settings limit 1),
     item_lines as (
       select i.expense_id,
              case when i.is_business then coalesce(i.category_id, e.category_id)
                   else (select id from expense_categories where name = 'Personal (not business)') end as category_id,
              sum(i.line_total + i.tax_amount) as amount
         from expense_items i join expenses e on e.id = i.expense_id
        where e.deleted_at is null
        group by 1, 2),
     lines as (
       select e.id as expense_id, e.category_id, e.total_amount as amount
         from expenses e where e.deleted_at is null and not exists (select 1 from expense_items i where i.expense_id = e.id)
       union all
       select expense_id, category_id, amount from item_lines
       union all
       select e.id, e.category_id, e.total_amount - il.tot
         from expenses e
         join (select expense_id, sum(amount) as tot from item_lines group by 1) il on il.expense_id = e.id
        where e.deleted_at is null and abs(e.total_amount - il.tot) > 0.01),
     numbered as (
       select l.*, row_number() over (partition by l.expense_id order by l.amount desc, l.category_id nulls last) as line_no from lines l)
select
  e.id as expense_id, e.expense_date, e.vendor, e.description, n.category_id,
  coalesce(c.name, 'Uncategorized') as category_name,
  n.amount::numeric(12,2) as total_amount, e.business_pct, e.receipt_path, e.review_status, e.auto_source,
  (e.expense_date < s.business_start_date) as is_startup,
  case
    when e.expense_date < s.business_start_date then 'startup'
    when c.id is null then 'uncategorized'
    else coalesce(c.schedule_c_line, 'l27a_other')
  end as line_key,
  coalesce(c.treatment, 'deductible') as treatment,
  (c.name = 'Gas / mileage' and m.method = 'standard') as gas_excluded,
  (n.amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date) as asset_candidate,
  case
    when coalesce(c.treatment, 'deductible') = 'excluded' then 0
    when c.name = 'Gas / mileage' and m.method = 'standard' then 0
    else round(n.amount * e.business_pct / 100, 2)
  end as deductible_amount,
  nullif(concat_ws(' ',
    case when e.ask_accountant then coalesce(nullif(e.ask_note, ''), 'Owner flagged this.') end,
    case when c.always_ask then c.ask_note end,
    case when c.id is null then 'No category yet.' end,
    case when c.name = 'Gas / mileage' and m.method = 'standard' then 'Gas excluded because standard mileage is selected.' end,
    case when n.amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date
         then 'Possible asset over ' || s.asset_threshold::text || ': depreciate or expense?' end,
    case when e.expense_date < s.business_start_date then 'Before the business start date: startup cost (election and limit to confirm).' end,
    case when e.business_pct < 100 then 'Business use ' || e.business_pct::text || '%.' end
  ), '') as ask_reason,
  n.line_no
from numbered n
join expenses e on e.id = n.expense_id
cross join s cross join m
left join expense_categories c on c.id = n.category_id
where e.deleted_at is null and e.auto_source is distinct from 'order_cost';

-- ============================================================================
-- 0054_orzo_soup.sql : add Egyptian Orzo Soup (menu change, 2026-09-30)
-- Mirrors assets/js/data.js on the customer website. Owner-supplied figures:
-- sells for $6, costs $2 to make.
-- ============================================================================

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'orzo-soup', 'Egyptian Orzo Soup', 'لسان العصفور', c.id,
       'Tender toasted orzo pasta simmered in a warm, savory broth, Egyptian comfort in every spoonful.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/orzo-soup.webp',
       6, 2, 'review'
from product_categories c where c.name = 'Soups'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;


-- ============================================================================
-- 0054_forgotten_costs.sql : costs that are easy to forget, handled automatically.
--
--  * Stripe fee: the rate is now a SETTING (2.9% + 30 cents), and a daily job backfills a fee
--    for any paid Stripe order that has none, so a missed webhook never loses a fee.
--  * New categories: Insurance, Parking & tolls, Postage & shipping, Rent / commissary.
--  * Bank rules for the usual suspects (software, bank fees, insurance, tolls, shipping, phone,
--    delivery apps, accounting). Income-tax payments are personal, not a business cost.
-- Anything a rule does not know falls to "Other" and is flagged Ask accountant (migration 0052).
-- ============================================================================

-- ------------------------------------------------------------------ Stripe fee as a setting
alter table expense_settings add column if not exists stripe_fee_pct   numeric(5,3) not null default 2.9  check (stripe_fee_pct between 0 and 10);
alter table expense_settings add column if not exists stripe_fee_fixed numeric(6,2) not null default 0.30 check (stripe_fee_fixed between 0 and 5);

-- Every paid Stripe order gets exactly one fee expense (unique per payment). Safe to run any time.
create or replace function backfill_stripe_fees()
returns int language plpgsql security definer set search_path = public as $$
declare s expense_settings%rowtype; rec record; n int := 0; v_fee numeric; v_before int;
begin
  select * into s from expense_settings limit 1;
  for rec in
    select p.id, p.amount, p.reference, p.paid_at, p.order_id
      from payments p join orders o on o.id = p.order_id
     where p.reference like 'stripe:%' and p.voided_at is null and o.deleted_at is null
       and not exists (select 1 from expense_sources x where x.source_type = 'stripe' and x.source_ref = substr(p.reference, 8))
  loop
    v_fee := round(rec.amount * s.stripe_fee_pct / 100 + s.stripe_fee_fixed, 2);
    select count(*) into v_before from expense_sources where source_type = 'stripe';
    perform record_stripe_fee(substr(rec.reference, 8), v_fee, (rec.paid_at at time zone 'America/Chicago')::date, rec.order_id, true);
    if (select count(*) from expense_sources where source_type = 'stripe') > v_before then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function backfill_stripe_fees() from public, anon, authenticated;

select cron.schedule('stripe-fee-backfill', '45 7 * * *', $$select backfill_stripe_fees()$$)
 where not exists (select 1 from cron.job where jobname = 'stripe-fee-backfill');

-- ------------------------------------------------------------------ new categories
insert into expense_categories (name, cost_type, sort_order, schedule_c_line, treatment, always_ask, ask_note) values
  ('Insurance',          'operating', 23, 'l15_insurance', 'deductible', false, 'Business insurance (not health insurance).'),
  ('Parking & tolls',    'operating', 24, 'l9_car',        'deductible', false, 'Tolls and parking are deductible even with the standard mileage rate.'),
  ('Postage & shipping', 'operating', 25, 'l27a_other',    'deductible', false, ''),
  ('Rent / commissary',  'operating', 26, 'l20b_rent',     'deductible', true,  'Kitchen or commissary rent: confirm the line and any lease.')
on conflict (name) do update set schedule_c_line = excluded.schedule_c_line, treatment = excluded.treatment;

-- ------------------------------------------------------------------ rules (skipped when the text already has a rule)
insert into bank_rules (match_text, vendor, category_id, cost_type, action, direction, sort_order)
select v.m, v.vend, c.id, 'operating', 'expense', 'out', 45
  from (values
    -- software, hosting, domains
    ('SUPABASE', 'Supabase', 'Website / technology'), ('NAMECHEAP', 'Namecheap', 'Website / technology'),
    ('GODADDY', 'GoDaddy', 'Website / technology'), ('SQUARESPACE', 'Squarespace', 'Website / technology'),
    ('GOOGLE WORKSPACE', 'Google Workspace', 'Website / technology'), ('CANVA', 'Canva', 'Website / technology'),
    ('ZOOM.US', 'Zoom', 'Website / technology'), ('NOTION', 'Notion', 'Website / technology'),
    ('ADOBE', 'Adobe', 'Website / technology'), ('OPENAI', 'OpenAI', 'Website / technology'),
    ('PLAID', 'Plaid', 'Website / technology'), ('TWILIO', 'Twilio', 'Website / technology'),
    ('TELEGRAM', 'Telegram', 'Website / technology'),
    -- bank and payment fees
    ('MONTHLY SERVICE FEE', 'Chase', 'Bank / payment fees'), ('SERVICE FEE', 'Bank fee', 'Bank / payment fees'),
    ('OVERDRAFT', 'Bank fee', 'Bank / payment fees'), ('WIRE FEE', 'Bank fee', 'Bank / payment fees'),
    ('PAYPAL', 'PayPal', 'Bank / payment fees'), ('SQUARE INC', 'Square', 'Bank / payment fees'),
    -- insurance
    ('NEXT INSURANCE', 'Next Insurance', 'Insurance'), ('THIMBLE', 'Thimble', 'Insurance'), ('INSURANCE', 'Insurance', 'Insurance'),
    -- tolls and parking (NOT gas: still deductible with the standard mileage rate)
    ('NTTA', 'NTTA', 'Parking & tolls'), ('TOLL', 'Toll', 'Parking & tolls'), ('PARKING', 'Parking', 'Parking & tolls'),
    -- shipping
    ('USPS', 'USPS', 'Postage & shipping'), ('UPS STORE', 'UPS Store', 'Postage & shipping'), ('FEDEX', 'FedEx', 'Postage & shipping'),
    ('PIRATE SHIP', 'Pirate Ship', 'Postage & shipping'),
    -- delivery apps / couriers
    ('UBER', 'Uber', 'Delivery'), ('DOORDASH', 'DoorDash', 'Delivery'), ('LALAMOVE', 'Lalamove', 'Delivery'),
    -- phone and internet
    ('VERIZON', 'Verizon', 'Phone & internet'), ('AT&T', 'AT&T', 'Phone & internet'), ('T-MOBILE', 'T-Mobile', 'Phone & internet'),
    ('SPECTRUM', 'Spectrum', 'Phone & internet'), ('XFINITY', 'Xfinity', 'Phone & internet'), ('MINT MOBILE', 'Mint Mobile', 'Phone & internet'),
    -- accountant and bookkeeping
    ('QUICKBOOKS', 'QuickBooks', 'Professional services'), ('INTUIT', 'Intuit', 'Professional services'),
    ('TURBOTAX', 'TurboTax', 'Professional services'), ('H&R BLOCK', 'H&R Block', 'Professional services'),
    -- training and food safety
    ('SERVSAFE', 'ServSafe', 'Training'), ('FOOD HANDLER', 'Food handler course', 'Training'), ('DSHS', 'Texas DSHS', 'Licenses and permits'),
    -- marketing
    ('GOOGLE ADS', 'Google Ads', 'Marketing'), ('VISTAPRINT', 'Vistaprint', 'Marketing'), ('YELP', 'Yelp', 'Marketing'),
    -- kitchen rent
    ('COMMISSARY', 'Commissary kitchen', 'Rent / commissary'),
    -- supplies and equipment
    ('HOME DEPOT', 'Home Depot', 'Kitchen supplies'), ('LOWES', 'Lowes', 'Kitchen supplies'), ('DOLLAR TREE', 'Dollar Tree', 'Kitchen supplies')
  ) as v(m, vend, cat)
  join expense_categories c on c.name = v.cat
 where not exists (select 1 from bank_rules r where lower(r.match_text) = lower(v.m));

-- the owner's own income tax is not a business cost
insert into bank_rules (match_text, vendor, action, direction, sort_order)
select v.m, '', 'personal', 'out', 44
  from (values ('USATAXPYMT'), ('IRS TREAS'), ('IRS PAYMENT')) as v(m)
 where not exists (select 1 from bank_rules r where lower(r.match_text) = lower(v.m));

-- a specific rule must come before the generic GOOGLE rule (lowest sort_order wins)
update bank_rules set sort_order = 38 where lower(match_text) in ('google ads', 'google workspace');

-- apply to everything already imported, and create any missing Stripe fee
do $$ declare rec record; begin
  for rec in select id from bank_transactions loop perform apply_bank_transaction(rec.id); end loop;
end $$;
select backfill_stripe_fees();


-- ============================================================================
-- 0055_marketing.sql : Expenses -> Marketing tab.
--
-- A marketing expense (category "Marketing") belongs to a CHANNEL: social media, flyers and print,
-- online ads, email and website, events and samples, influencers, other. The channel is guessed from the
-- vendor/description by keyword (Meta -> social media, Vistaprint -> flyers and print...) and can be
-- changed by the owner at any time; an owner choice is never overwritten.
-- ============================================================================

alter table expenses add column if not exists marketing_channel text
  check (marketing_channel is null or marketing_channel in ('social', 'flyers_print', 'online_ads', 'email_web', 'events', 'influencers', 'other'));

create table if not exists marketing_keywords (
  id         uuid primary key default gen_random_uuid(),
  keyword    text not null,                       -- case-insensitive substring of vendor + description
  channel    text not null check (channel in ('social', 'flyers_print', 'online_ads', 'email_web', 'events', 'influencers', 'other')),
  sort_order int not null default 100              -- lowest wins
);
create unique index if not exists marketing_keywords_uniq on marketing_keywords (lower(keyword));
alter table marketing_keywords enable row level security;
drop policy if exists marketing_keywords_all on marketing_keywords;
create policy marketing_keywords_all on marketing_keywords for all to authenticated using (is_admin()) with check (is_admin());

insert into marketing_keywords (keyword, channel, sort_order) values
  -- social media
  ('facebk', 'social', 10), ('facebook', 'social', 10), ('meta platforms', 'social', 10), ('meta', 'social', 12), ('instagram', 'social', 10),
  ('tiktok', 'social', 10), ('snapchat', 'social', 10), ('pinterest', 'social', 10), ('linkedin', 'social', 10),
  ('twitter', 'social', 10), ('x corp', 'social', 10), ('youtube', 'social', 10), ('social', 'social', 20),
  -- flyers, print and signage
  ('vistaprint', 'flyers_print', 10), ('fedex office', 'flyers_print', 10), ('gogoprint', 'flyers_print', 10), ('uprinting', 'flyers_print', 10),
  ('moo.com', 'flyers_print', 10), ('sticker mule', 'flyers_print', 10), ('zazzle', 'flyers_print', 10), ('flyer', 'flyers_print', 15),
  ('business card', 'flyers_print', 15), ('banner', 'flyers_print', 15), ('brochure', 'flyers_print', 15), ('poster', 'flyers_print', 15),
  ('menu print', 'flyers_print', 15), ('print', 'flyers_print', 30),
  -- online ads
  ('google ads', 'online_ads', 10), ('google*ads', 'online_ads', 10), ('yelp', 'online_ads', 10), ('nextdoor', 'online_ads', 10),
  ('bing ads', 'online_ads', 10), ('ads', 'online_ads', 40),
  -- email and website marketing
  ('mailchimp', 'email_web', 10), ('klaviyo', 'email_web', 10), ('constant contact', 'email_web', 10), ('wix', 'email_web', 10),
  ('seo', 'email_web', 20), ('newsletter', 'email_web', 20),
  -- events and samples
  ('eventbrite', 'events', 10), ('farmers market', 'events', 10), ('popup', 'events', 10), ('pop-up', 'events', 10),
  ('booth', 'events', 15), ('tasting', 'events', 15), ('sample', 'events', 15), ('giveaway', 'events', 15), ('vendor fee', 'events', 15),
  -- influencers
  ('influencer', 'influencers', 10), ('collab', 'influencers', 10), ('sponsor', 'influencers', 15)
on conflict do nothing;

create or replace function infer_marketing_channel(p_text text)
returns text language sql stable set search_path = public as $$
  select coalesce((select channel from marketing_keywords where position(lower(keyword) in lower(coalesce(p_text, ''))) > 0
                    order by sort_order, length(keyword) desc limit 1), 'other')
$$;

-- keep the channel in step with the category: guessed when empty, cleared when it is no longer marketing
create or replace function expenses_marketing_channel() returns trigger language plpgsql set search_path = public as $$
declare v_cat text;
begin
  select name into v_cat from expense_categories where id = new.category_id;
  if v_cat = 'Marketing' then
    if new.marketing_channel is null then new.marketing_channel := infer_marketing_channel(coalesce(new.vendor, '') || ' ' || coalesce(new.description, '')); end if;
  else
    new.marketing_channel := null;
  end if;
  return new;
end $$;
drop trigger if exists expenses_marketing_channel on expenses;
create trigger expenses_marketing_channel before insert or update on expenses for each row execute function expenses_marketing_channel();

-- channels for the marketing expenses that already exist
update expenses set vendor = vendor where deleted_at is null and category_id = (select id from expense_categories where name = 'Marketing');

-- ------------------------------------------------------------------ more bank rules for marketing spend
insert into bank_rules (match_text, vendor, category_id, cost_type, action, direction, sort_order)
select v.m, v.vend, c.id, 'operating', 'expense', 'out', v.so
  from (values
    ('FEDEX OFFICE', 'FedEx Office', 38), ('GOGOPRINT', 'GoGoPrint', 45), ('UPRINTING', 'UPrinting', 45), ('MOO.COM', 'Moo', 45),
    ('STICKER MULE', 'Sticker Mule', 45), ('ZAZZLE', 'Zazzle', 45),
    ('SNAPCHAT', 'Snapchat', 45), ('PINTEREST', 'Pinterest', 45), ('LINKEDIN', 'LinkedIn', 45), ('NEXTDOOR', 'Nextdoor', 45),
    ('MAILCHIMP', 'Mailchimp', 45), ('KLAVIYO', 'Klaviyo', 45), ('CONSTANT CONTACT', 'Constant Contact', 45), ('EVENTBRITE', 'Eventbrite', 45)
  ) as v(m, vend, so)
  join expense_categories c on c.name = 'Marketing'
 where not exists (select 1 from bank_rules r where lower(r.match_text) = lower(v.m));

do $$ declare rec record; begin
  for rec in select id from bank_transactions loop perform apply_bank_transaction(rec.id); end loop;
end $$;


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

-- ============================================================================
-- 0058_price_cost_update_and_combos.sql : menu price/cost rebalance, 2026-10-01
-- Mirrors assets/js/data.js on the customer website.
--
-- Price changes:
--   Macarona Béchamel Tray  $30   -> $35
--   Small Round Cake        $8    -> $10
--   Rice Pudding            $5.50 -> $6
--   Hummus                  $3    -> $4
-- (Special Chocolate Protein Shake, Egyptian Orzo Soup, Lentil Soup were
--  already correct — verified, not touched.)
--
-- Cost changes (ingredient_cost):
--   Om Ali                  none  -> $5.00
--   Rice Pudding            none  -> $2.50
--   Egyptian White Cheese   $3.00 -> $1.00
--   Baba Ganoush            none  -> $1.00 (est.)
--   Hummus                  none  -> $0.90 (est.)
--   Tahini                  none  -> $0.70 (est.)
--   Black Honey             none  -> $0.60 (est.)
--   White Honey             none  -> $1.20 (est.)
--
-- The five sides marked (est.) above are estimated ingredient costs, not
-- measured. The products table has no is-estimate flag to set, so this
-- comment is the record of which ones are estimates until a real column
-- exists for it.
--
-- New "Combos" category and products, with the same owner-estimated cost
-- caveat noted per item below.
-- ============================================================================

-- Price changes
update products set selling_price = v.price
from (values
  ('macarona-bechamel', 35.00),
  ('round-cake', 10.00),
  ('rice-pudding', 6.00),
  ('hummus', 4.00)
) as v(slug, price)
where products.slug = v.slug;

-- Cost changes
update products set ingredient_cost = v.cost
from (values
  ('om-ali', 5.00),
  ('rice-pudding', 2.50),
  ('white-cheese', 1.00),
  ('baba-ganoush', 1.00),   -- est.
  ('hummus', 0.90),         -- est.
  ('tahini', 0.70),         -- est.
  ('black-honey', 0.60),    -- est.
  ('white-honey', 1.20)     -- est.
) as v(slug, cost)
where products.slug = v.slug;

-- New category
insert into product_categories (name, sort_order) values ('Combos', 11)
on conflict (name) do nothing;

-- New combo products. Costs are the owner's estimates (sum of component
-- costs), not yet measured.
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'feteer-dip-trio', 'Feteer Dip Trio', 'ثلاثية الإضافات', c.id,
       'Black Honey, Egyptian White Cheese and Tahini together, at a bundled price.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/white-cheese.webp',
       10, 2.30, 'review'
from product_categories c where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'feteer-and-dip-trio', 'Feteer + Dip Trio', 'فطير مع ثلاثية الإضافات', c.id,
       'A whole Feteer Meshaltet with the Feteer Dip Trio — Black Honey, Egyptian White Cheese and Tahini — bundled together.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg',
       32, 6.69, 'review'
from product_categories c where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;

insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, tax_status)
select 'pick-3-puddings', 'Pick Any 3 Puddings', 'اختر ٣ بودينج', c.id,
       'Any three: Banana Pudding, Chocolate Pudding, Crème Caramel Flan or Rice Pudding. Tell us which three when you order.',
       'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/chocolate-pudding.webp',
       14, 8.37, 'review'
from product_categories c where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost,
  image_url = excluded.image_url, is_active = true, deleted_at = null;


-- 0058: links a receipt item (its item_key, the first three letter-words of the name) to an ingredient in the
-- price book (the existing `ingredients` table that feeds recipes and dish costs). A link only tells the
-- dashboard which receipt prices to compare with that ingredient; it never changes a price by itself. The
-- owner approves each price change, and the existing triggers then recalculate the dishes that use it
-- and keep the price history.

create table if not exists ingredient_receipt_links (
  item_key       text primary key,
  ingredient_id  uuid not null references ingredients(id) on delete cascade,
  created_at     timestamptz not null default now()
);
create index if not exists ingredient_receipt_links_ing_idx on ingredient_receipt_links (ingredient_id);
alter table ingredient_receipt_links enable row level security;
drop policy if exists ingredient_receipt_links_all on ingredient_receipt_links;
create policy ingredient_receipt_links_all on ingredient_receipt_links for all to authenticated using (is_admin()) with check (is_admin());


-- ============================================================================
-- 0059_personal_part.sql : a purchase can carry a PERSONAL part.
--
-- A grocery run with the owner's own ice cream in the basket: the bank charge is $99.48, but only $94.69 is the
-- business's. The expense now shows ONLY the business money (total_amount), and `personal_amount` remembers
-- the rest, so:
--   * every total (Expenses, profit box, budgets, Telegram, tax pack) excludes it automatically
--   * the bank charge still matches (matching compares business + personal with the charge)
--   * flipping an item between business and personal later (receipt detail) updates the expense by itself
-- The receipt's sales tax is spread over its items, so a personal item takes its own share of the tax.
-- ============================================================================

alter table expenses add column if not exists personal_amount numeric(12,2) not null default 0 check (personal_amount >= 0);

drop function if exists write_receipt_items(uuid, uuid, jsonb, int);

create or replace function write_receipt_items(p_expense uuid, p_source uuid, p_items jsonb, p_sign int default 1, p_tax numeric default 0)
returns numeric language plpgsql security definer set search_path = public as $$
declare it jsonb; v_cat uuid; v_biz boolean; v_name text; v_total numeric; v_sum numeric := 0; v_mem item_category_memory%rowtype; v_personal uuid; v_isum numeric := 0; v_tax_i numeric := 0;
begin
  select id into v_personal from expense_categories where name = 'Personal (not business)';
  select coalesce(sum(abs(coalesce(nullif(x->>'total', '')::numeric, coalesce(nullif(x->>'qty', '')::numeric, 1) * coalesce(nullif(x->>'unit_price', '')::numeric, 0)))), 0)
    into v_isum from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;
  delete from expense_items where source_id = p_source;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_name := left(coalesce(it->>'name', ''), 200);
    v_total := p_sign * abs(coalesce(nullif(it->>'total', '')::numeric, coalesce(nullif(it->>'qty', '')::numeric, 1) * coalesce(nullif(it->>'unit_price', '')::numeric, 0)));
    continue when v_total = 0;
    v_cat := null; v_biz := true;
    select * into v_mem from item_category_memory where item_key = item_key(v_name);
    if found then v_cat := v_mem.category_id; v_biz := v_mem.is_business;
    else
      select id into v_cat from expense_categories where lower(name) = lower(coalesce(it->>'category', ''));
      if coalesce((it->>'personal')::boolean, false) then v_cat := v_personal; v_biz := false; end if;
    end if;
    if v_cat = v_personal then v_biz := false; end if;
    -- the receipt's sales tax is spread over its items in proportion to their price
    v_tax_i := case when p_sign = 1 and v_isum > 0 and coalesce(p_tax, 0) > 0 then round(p_tax * abs(v_total) / v_isum, 2) else 0 end;
    insert into expense_items (expense_id, source_id, description, quantity, unit_price, line_total, tax_amount, category_id, is_business)
    values (p_expense, p_source, v_name, coalesce(nullif(it->>'qty', '')::numeric, 1), coalesce(nullif(it->>'unit_price', '')::numeric, 0),
            v_total, v_tax_i, v_cat, v_biz);
    v_sum := v_sum + v_total;
  end loop;
  return v_sum;
end $$;

create or replace function find_expense_match(
  p_vendor text, p_amount numeric, p_date date, p_source_type text, p_exclude uuid default null
) returns table (expense_id uuid, score int, vendor_match boolean)
language plpgsql stable security definer set search_path = public as $$
declare s expense_settings%rowtype; v_norm text := normalize_vendor(p_vendor);
begin
  select * into s from expense_settings limit 1;
  return query
  select e.id,
         (40
          + case when v_norm <> '' and normalize_vendor(e.vendor) = v_norm then 40 else 0 end
          + (20 * (1 - abs(e.expense_date - p_date)::numeric / greatest(s.match_window_days, 1)))::int
         ) as sc,
         (v_norm <> '' and normalize_vendor(e.vendor) = v_norm)
    from expenses e
   where e.deleted_at is null
     and e.auto_source is distinct from 'order_cost'
     and e.id is distinct from p_exclude
     and abs(e.total_amount + e.personal_amount - abs(p_amount)) <= s.amount_tolerance
     and abs(e.expense_date - p_date) <= s.match_window_days
     and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = p_source_type)
   order by sc desc, abs(e.expense_date - p_date), e.created_at
   limit 5;
end $$;

create or replace function apply_parsed_receipt(p_file_id uuid, p_parsed jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f receipt_files%rowtype; s expense_settings%rowtype;
  v_type text; v_ref text;
  v_vendor text := trim(coalesce(p_parsed->>'vendor', ''));
  v_norm text; v_date date; v_total numeric; v_tax numeric; v_pm text;
  v_refund boolean := coalesce((p_parsed->>'is_refund')::boolean, false) or coalesce((p_parsed->>'total')::numeric, 0) < 0;
  v_items jsonb := coalesce(p_parsed->'items', '[]'::jsonb);
  v_isum numeric := 0; v_ok boolean := true; v_exp uuid; v_outcome text; v_match record; v_src uuid;
  v_cat uuid; v_ctype cost_type; v_review text := 'ok'; v_dup uuid; v_before numeric; v_tx numeric; v_rem numeric; v_main uuid; v_existing uuid;
begin
  select * into f from receipt_files where id = p_file_id;
  if not found then return jsonb_build_object('outcome', 'failed', 'error', 'unknown receipt file'); end if;
  select * into s from expense_settings limit 1;

  v_type := case when f.source = 'email' then 'email' else 'receipt' end;
  v_ref  := case when f.source = 'email' then coalesce(f.email_message_id, f.sha256) else f.sha256 end;
  v_norm := normalize_vendor(v_vendor);
  begin v_date := nullif(p_parsed->>'date', '')::date; exception when others then v_date := null; end;
  v_date := coalesce(v_date, (f.created_at at time zone 'America/Chicago')::date);
  v_total := abs(coalesce(nullif(p_parsed->>'total', '')::numeric, 0));
  v_tax := greatest(coalesce(nullif(p_parsed->>'tax', '')::numeric, 0), 0);
  v_pm := lower(coalesce(p_parsed->>'payment_method', ''));

  if v_total <= 0 then
    update receipt_files set status = 'failed', error = 'Could not read a total from this receipt. Open it and enter the expense by hand.', parsed = p_parsed where id = f.id;
    return jsonb_build_object('outcome', 'failed');
  end if;

  select coalesce(sum(abs(coalesce(nullif(x->>'total', '')::numeric, coalesce(nullif(x->>'qty', '')::numeric, 1) * coalesce(nullif(x->>'unit_price', '')::numeric, 0)))), 0)
    into v_isum from jsonb_array_elements(v_items) x;
  v_ok := jsonb_array_length(v_items) = 0 or abs(v_isum + v_tax - v_total) <= 0.05 or abs(v_isum - v_total) <= 0.05;

  -- ---- evidence we already processed (re-read, retry): reuse its expense, never match again ----
  select expense_id into v_existing from expense_sources where source_type = v_type and source_ref = v_ref and expense_id is not null;

  -- ---- a refund: reduce the ORIGINAL purchase, never income ----
  if v_refund and v_existing is not null then
    update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_existing, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
    return jsonb_build_object('outcome', 'refund', 'expense_id', v_existing);
  end if;
  if v_refund then
    v_exp := find_refund_counterpart(v_norm, v_total, array['bank']);
    if v_exp is not null then
      -- the bank already took this refund off the purchase: just record the receipt as evidence
      v_src := link_source(v_type, v_ref, v_exp, -v_total, v_date, p_parsed);
      update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
      return jsonb_build_object('outcome', 'refund', 'expense_id', v_exp);
    end if;
    select e.id into v_exp from expenses e
     where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and v_norm <> '' and normalize_vendor(e.vendor) = v_norm
       and e.total_amount >= v_total - s.amount_tolerance and e.expense_date <= v_date and v_date - e.expense_date <= 180
     order by e.expense_date desc, e.created_at desc limit 1;
    if v_exp is null then
      update receipt_files set status = 'failed', error = 'This is a refund but the original purchase was not found. Add the purchase first, then upload the refund again.', parsed = p_parsed where id = f.id;
      return jsonb_build_object('outcome', 'failed');
    end if;
    v_src := link_source(v_type, v_ref, v_exp, -v_total, v_date, p_parsed);
    select amount_before_tax, sales_tax_paid into v_before, v_tx from expenses where id = v_exp;
    v_rem := v_total - least(v_before, v_total);
    update expenses set amount_before_tax = greatest(v_before - v_total, 0), sales_tax_paid = greatest(v_tx - v_rem, 0) where id = v_exp;
    if exists (select 1 from expense_items where expense_id = v_exp) then
      select category_id into v_main from expense_items where expense_id = v_exp and is_business order by line_total desc limit 1;
      delete from expense_items where source_id = v_src;
      insert into expense_items (expense_id, source_id, description, line_total, category_id) values (v_exp, v_src, 'Refund', -v_total, v_main);
    end if;
    update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
    return jsonb_build_object('outcome', 'refund', 'expense_id', v_exp);
  end if;

  -- ---- attach to an expense we already have (bank charge first, subscription, earlier receipt...) ----
  if v_existing is not null then
    v_exp := v_existing; v_outcome := coalesce(nullif(f.outcome, ''), 'linked');
  else
    select * into v_match from find_expense_match(v_vendor, v_total, v_date, v_type) limit 1;
  end if;
  if v_exp is not null then null;
  elsif v_match.expense_id is not null and v_match.vendor_match then
    v_exp := v_match.expense_id; v_outcome := 'linked';
  elsif v_norm <> '' then
    -- one bank charge, several receipts / emails (many-to-one)
    select e.id into v_exp from expenses e
     where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and normalize_vendor(e.vendor) = v_norm
       and e.total_amount > v_total + s.amount_tolerance
       and abs(e.expense_date - v_date) <= s.match_window_days * 3
       and exists (select 1 from expense_sources b where b.expense_id = e.id and b.source_type = 'bank')
       and (select coalesce(sum(x.amount), 0) from expense_sources x where x.expense_id = e.id and x.source_type in ('receipt', 'email')) + v_total <= e.total_amount + s.amount_tolerance
       and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = v_type and x.source_ref = v_ref)
     order by abs(e.expense_date - v_date), e.created_at limit 1;
    if v_exp is not null then v_outcome := 'partial'; end if;
  end if;

  if v_exp is null then
    if v_match.expense_id is not null then v_review := 'possible_duplicate'; v_dup := v_match.expense_id; end if;
    -- category of the new expense = the business category with the most money in it
    select i.cat into v_cat from (
      select coalesce(c.id, (select id from expense_categories where name = 'Other')) as cat, sum(abs(coalesce(nullif(x->>'total', '')::numeric, 0))) as amt
        from jsonb_array_elements(v_items) x
        left join expense_categories c on lower(c.name) = lower(coalesce(x->>'category', ''))
       where not coalesce((x->>'personal')::boolean, false) group by 1 order by 2 desc limit 1) i;
    v_cat := coalesce(v_cat, (select id from expense_categories where name = 'Other'));
    select cost_type into v_ctype from expense_categories where id = v_cat;
    insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid, payment_method, cost_type, notes, auto_source, review_status, duplicate_of)
    values (v_date, coalesce(nullif(v_vendor, ''), 'Unknown store'), v_cat, left('Receipt: ' || coalesce(nullif(f.original_name, ''), nullif(f.email_subject, ''), v_vendor), 200),
            greatest(v_total - v_tax, 0), v_tax,
            case when v_pm in ('cash', 'card', 'zelle', 'venmo') then v_pm::payment_method else null end,
            coalesce(v_ctype, 'operating'),
            case when v_pm = 'cash' then 'Paid cash (receipt only).' else 'From a receipt. The bank charge will attach to this when it arrives.' end,
            v_type, v_review, v_dup)
    returning id into v_exp;
    v_outcome := case when v_review = 'possible_duplicate' then 'possible_duplicate' else 'created' end;
  end if;

  v_src := link_source(v_type, v_ref, v_exp, v_total, v_date, p_parsed);
  perform write_receipt_items(v_exp, v_src, v_items, 1, v_tax);
  update expenses set receipt_path = f.storage_path where id = v_exp and receipt_path = '' and f.storage_path <> '';
  update receipt_files set status = 'parsed', outcome = v_outcome, expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok,
         error = case when v_ok then '' else 'The items do not add up to the total. Check the items.' end where id = f.id;
  return jsonb_build_object('outcome', v_outcome, 'expense_id', v_exp, 'totals_ok', v_ok);
end $$;

create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype; r bank_rules%rowtype; e expenses%rowtype; s expense_settings%rowtype;
  v_vendor text; v_cat uuid; v_cost_type cost_type; v_expense_id uuid; v_kind text; v_match record;
  v_review text := 'ok'; v_dup uuid; v_norm text; v_refund uuid; v_before numeric; v_tx numeric; v_rem numeric; v_amt numeric; v_main uuid; v_src uuid; v_skip_reduce boolean := false; v_search text;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;
  select * into s from expense_settings limit 1;

  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
     and (direction = 'any' or (direction = 'out' and t.amount > 0) or (direction = 'in' and t.amount < 0))
   order by sort_order, created_at limit 1;

  -- a refund already applied: nothing more to do (re-syncs must not reduce the purchase twice)
  if t.amount < 0 then
    select expense_id into v_refund from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id and amount < 0 and expense_id is not null;
    if v_refund is not null then
      update bank_transactions set kind = 'refund', expense_id = v_refund where id = t.id and (kind <> 'refund' or expense_id is distinct from v_refund);
      return v_refund;
    end if;
  end if;

  -- 1. what is this transaction?
  if t.ignored or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then v_kind := 'ignored';
  elsif t.pending then v_kind := 'pending';
  elsif r.id is not null and r.action <> 'expense' and (t.amount > 0 or r.sort_order < 900) then v_kind := r.action;
  elsif t.amount <= 0 then v_kind := 'money_in';
  else v_kind := 'expense'; end if;

  -- money in from a store we bought from = a REFUND of that purchase (unless a specific rule says otherwise)
  if t.amount < 0 and v_kind in ('money_in', 'owner_contribution') and (r.id is null or r.sort_order >= 900 or r.action = 'expense') then
    v_norm := normalize_vendor(coalesce(nullif(t.merchant_name, ''), t.name));
    if v_norm <> '' then
      v_refund := find_refund_counterpart(v_norm, abs(t.amount), array['email', 'receipt']);
      if v_refund is not null then v_skip_reduce := true;   -- a refund email already took it off
      else
        select e2.id into v_refund from expenses e2
         where e2.deleted_at is null and e2.auto_source is distinct from 'order_cost' and normalize_vendor(e2.vendor) = v_norm
           and e2.total_amount >= abs(t.amount) - s.amount_tolerance and e2.expense_date <= t.posted_on and t.posted_on - e2.expense_date <= 180
         order by e2.expense_date desc, e2.created_at desc limit 1;
      end if;
      if v_refund is not null then v_kind := 'refund'; end if;
    end if;
  end if;

  -- no purchase to refund: the catch-all deposit rule (owner money) applies
  if v_kind = 'money_in' and v_refund is null and r.id is not null and r.action <> 'expense' then v_kind := r.action; end if;

  update bank_transactions set kind = v_kind, rule_id = r.id where id = t.id and (kind is distinct from v_kind or rule_id is distinct from r.id);

  if v_kind = 'refund' then
    v_amt := abs(t.amount);
    v_src := link_source('bank', t.plaid_transaction_id, v_refund, t.amount, t.posted_on);
    if not v_skip_reduce then
    select amount_before_tax, sales_tax_paid into v_before, v_tx from expenses where id = v_refund;
    v_rem := v_amt - least(v_before, v_amt);
    update expenses set amount_before_tax = greatest(v_before - v_amt, 0), sales_tax_paid = greatest(v_tx - v_rem, 0) where id = v_refund;
    end if;
    if not v_skip_reduce and exists (select 1 from expense_items where expense_id = v_refund) then
      select category_id into v_main from expense_items where expense_id = v_refund and is_business order by line_total desc limit 1;
      delete from expense_items where source_id = v_src;
      insert into expense_items (expense_id, source_id, description, line_total, category_id) values (v_refund, v_src, 'Refund', -v_amt, v_main);
    end if;
    update bank_transactions set expense_id = v_refund where id = t.id;
    return v_refund;
  end if;

  -- 2. not a business cost
  if v_kind <> 'expense' then
    if t.expense_id is not null then
      select * into e from expenses where id = t.expense_id;
      if e.auto_source = 'bank' then update expenses set deleted_at = now() where id = e.id and deleted_at is null;
      else update expenses set bank_transaction_id = null where id = e.id; end if;
      delete from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');
  v_search := case when position(lower(v_vendor) in lower(t.name)) > 0 then t.name else v_vendor || ' ' || t.name end;

  -- 3a. already linked: refresh amount/date for rows the bank sync owns (refunds already taken off stay off)
  if t.expense_id is not null then
    select * into e from expenses where id = t.expense_id;
    if e.auto_source = 'bank' then
      update expenses
         set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
             amount_before_tax = greatest(t.amount + coalesce((select sum(x.amount) from expense_sources x where x.expense_id = e.id and x.source_type = 'bank' and x.amount < 0), 0) - e.personal_amount - e.sales_tax_paid, 0),
             category_id = coalesce(v_cat, category_id),
             cost_type = case when v_cat is not null then v_cost_type else cost_type end, deleted_at = null
       where id = e.id;
    end if;
    perform link_source('bank', t.plaid_transaction_id, t.expense_id, t.amount, t.posted_on);
    return t.expense_id;
  end if;

  -- 3b. attach to an expense we already have
  select * into v_match from find_expense_match(v_search, t.amount, t.posted_on, 'bank') limit 1;
  if v_match.expense_id is not null and v_match.vendor_match then
    update expenses set bank_transaction_id = coalesce(bank_transaction_id, t.id) where id = v_match.expense_id;
    update bank_transactions set expense_id = v_match.expense_id where id = t.id;
    perform link_source('bank', t.plaid_transaction_id, v_match.expense_id, t.amount, t.posted_on);
    return v_match.expense_id;
  end if;

  -- 3b'. one order email / receipt, several smaller card charges (split shipments)
  v_norm := normalize_vendor(v_search);
  if v_norm <> '' then
    select e2.id into v_expense_id from expenses e2
     where e2.deleted_at is null and e2.auto_source is distinct from 'order_cost' and normalize_vendor(e2.vendor) = v_norm
       and e2.total_amount > t.amount + s.amount_tolerance
       and abs(e2.expense_date - t.posted_on) <= s.match_window_days * 3
       and exists (select 1 from expense_sources d where d.expense_id = e2.id and d.source_type in ('email', 'receipt'))
       and (select coalesce(sum(b.amount), 0) from expense_sources b where b.expense_id = e2.id and b.source_type = 'bank') + t.amount <= e2.total_amount + s.amount_tolerance
     order by abs(e2.expense_date - t.posted_on), e2.created_at limit 1;
    if v_expense_id is not null then
      update expenses set bank_transaction_id = coalesce(bank_transaction_id, t.id) where id = v_expense_id;
      update bank_transactions set expense_id = v_expense_id where id = t.id;
      perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
      return v_expense_id;
    end if;
  end if;

  if v_match.expense_id is not null then v_review := 'possible_duplicate'; v_dup := v_match.expense_id; end if;

  -- 3c. a genuinely new expense
  if v_review = 'ok' and v_cat is null then v_review := 'needs_review'; end if;
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, notes, auto_source, bank_transaction_id, review_status, duplicate_of)
  values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
          'Imported from the bank feed.', 'bank', t.id, v_review, v_dup)
  returning id into v_expense_id;
  update bank_transactions set expense_id = v_expense_id where id = t.id;
  perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
  return v_expense_id;
end $$;

create or replace function expense_integrity()
returns jsonb language sql stable security definer set search_path = public as $$
  with bank as (
    select e.id, e.total_amount + e.personal_amount as total_amount, coalesce(sum(s.amount), 0) as bank_sum, count(s.id) as n
      from expenses e join expense_sources s on s.expense_id = e.id and s.source_type = 'bank'
     where e.deleted_at is null group by e.id, e.total_amount, e.personal_amount)
  select jsonb_build_object(
    'possible_duplicates', (select count(*) from expenses where deleted_at is null and review_status = 'possible_duplicate'),
    'needs_review',        (select count(*) from expenses where deleted_at is null and review_status = 'needs_review'),
    'expenses_without_source', (select count(*) from expenses e where e.deleted_at is null and e.auto_source is distinct from 'order_cost'
                                  and not exists (select 1 from expense_sources s where s.expense_id = e.id)),
    -- more money charged than the expense says = a mismatch; less = a split order still waiting for its other charges
    'bank_amount_mismatch', (select count(*) from bank where bank_sum > total_amount + (select amount_tolerance from expense_settings limit 1)
                               + coalesce((select abs(sum(x.amount)) from expense_sources x where x.expense_id = bank.id and x.source_type in ('email', 'receipt') and x.amount < 0), 0)),
    'partial_bank_coverage',(select count(*) from bank where n > 0 and bank_sum < total_amount - (select amount_tolerance from expense_settings limit 1)
                               and exists (select 1 from expense_sources d where d.expense_id = bank.id and d.source_type in ('email', 'receipt'))),
    'money_in_unclassified', (select count(*) from bank_transactions where kind = 'money_in'),
    'duplicate_bank_links', (select count(*) from (select bank_transaction_id from expenses where deleted_at is null and bank_transaction_id is not null
                              group by 1 having count(*) > 1) x),
    'receipts_unmatched_7d', (select count(*) from expenses e where e.deleted_at is null and e.created_at < now() - interval '7 days'
                                and e.auto_source in ('receipt', 'email') and e.payment_method is distinct from 'cash'
                                and not exists (select 1 from expense_sources s where s.expense_id = e.id and s.source_type = 'bank')),
    'receipts_failed', (select count(*) from receipt_files where status = 'failed'),
    'items_not_adding_up', (select count(*) from receipt_files where status = 'parsed' and totals_ok is false)
  )
$$;

create or replace view expense_tax_view with (security_invoker = true) as
with s as (select * from expense_settings limit 1),
     m as (select * from mileage_settings limit 1),
     item_lines as (
       select i.expense_id,
              case when i.is_business then coalesce(i.category_id, e.category_id)
                   else (select id from expense_categories where name = 'Personal (not business)') end as category_id,
              sum(i.line_total + i.tax_amount) as amount
         from expense_items i join expenses e on e.id = i.expense_id
        where e.deleted_at is null and i.is_business
        group by 1, 2),
     lines as (
       select e.id as expense_id, e.category_id, e.total_amount as amount
         from expenses e where e.deleted_at is null and not exists (select 1 from expense_items i where i.expense_id = e.id)
       union all
       select expense_id, category_id, amount from item_lines
       union all
       select e.id, e.category_id, e.total_amount - il.tot
         from expenses e
         join (select expense_id, sum(amount) as tot from item_lines group by 1) il on il.expense_id = e.id
        where e.deleted_at is null and abs(e.total_amount - il.tot) > 0.01),
     numbered as (
       select l.*, row_number() over (partition by l.expense_id order by l.amount desc, l.category_id nulls last) as line_no from lines l)
select
  e.id as expense_id, e.expense_date, e.vendor, e.description, n.category_id,
  coalesce(c.name, 'Uncategorized') as category_name,
  n.amount::numeric(12,2) as total_amount, e.business_pct, e.receipt_path, e.review_status, e.auto_source,
  (e.expense_date < s.business_start_date) as is_startup,
  case
    when e.expense_date < s.business_start_date then 'startup'
    when c.id is null then 'uncategorized'
    else coalesce(c.schedule_c_line, 'l27a_other')
  end as line_key,
  coalesce(c.treatment, 'deductible') as treatment,
  (c.name = 'Gas / mileage' and m.method = 'standard') as gas_excluded,
  (n.amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date) as asset_candidate,
  case
    when coalesce(c.treatment, 'deductible') = 'excluded' then 0
    when c.name = 'Gas / mileage' and m.method = 'standard' then 0
    else round(n.amount * e.business_pct / 100, 2)
  end as deductible_amount,
  nullif(concat_ws(' ',
    case when e.ask_accountant then coalesce(nullif(e.ask_note, ''), 'Owner flagged this.') end,
    case when c.always_ask then c.ask_note end,
    case when c.id is null then 'No category yet.' end,
    case when c.name = 'Gas / mileage' and m.method = 'standard' then 'Gas excluded because standard mileage is selected.' end,
    case when n.amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date
         then 'Possible asset over ' || s.asset_threshold::text || ': depreciate or expense?' end,
    case when e.expense_date < s.business_start_date then 'Before the business start date: startup cost (election and limit to confirm).' end,
    case when e.business_pct < 100 then 'Business use ' || e.business_pct::text || '%.' end
  ), '') as ask_reason,
  n.line_no
from numbered n
join expenses e on e.id = n.expense_id
cross join s cross join m
left join expense_categories c on c.id = n.category_id
where e.deleted_at is null and e.auto_source is distinct from 'order_cost';


-- keeps expenses.personal_amount and the business total in step with the items
create or replace function refresh_personal_amount(p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_pers numeric; v_full numeric;
begin
  select coalesce(sum(line_total + tax_amount), 0) into v_pers from expense_items where expense_id = p_expense and not is_business;
  select total_amount + personal_amount into v_full from expenses where id = p_expense and deleted_at is null;
  if v_full is null then return; end if;
  update expenses
     set personal_amount = least(v_pers, v_full),
         amount_before_tax = greatest(v_full - least(v_pers, v_full) - sales_tax_paid, 0)
   where id = p_expense and (personal_amount is distinct from least(v_pers, v_full));
end $$;
revoke all on function refresh_personal_amount(uuid) from public, anon, authenticated;

create or replace function expense_items_personal_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then perform refresh_personal_amount(new.expense_id); end if;
  if tg_op = 'DELETE' then perform refresh_personal_amount(old.expense_id); end if;
  if tg_op = 'UPDATE' and old.expense_id is distinct from new.expense_id then perform refresh_personal_amount(old.expense_id); end if;
  return coalesce(new, old);
end $$;
drop trigger if exists expense_items_personal on expense_items;
create trigger expense_items_personal after insert or update of is_business, line_total, tax_amount, expense_id or delete on expense_items
  for each row execute function expense_items_personal_trigger();

-- expenses already on the books: apply the rule once
do $$ declare r record; begin
  for r in select distinct expense_id from expense_items where not is_business loop perform refresh_personal_amount(r.expense_id); end loop;
end $$;


-- 0060: a receipt can have more than one picture (a long receipt photographed in two parts, an order page plus the
-- confirmation). storage_path stays the main picture; extra_paths holds the others, all in the private "receipts" bucket.
alter table receipt_files add column if not exists extra_paths text[] not null default '{}';
-- 0062: the Feteer Dip Trio combo becomes a six-side platter (slug unchanged so history and the other combo still match).
-- Separate prices: White Cheese 4 + Black Honey 3.50 + White Honey 4 + Tahini 3 + Baba Ganoush 4 + Hummus 4 = 22.50.
-- Priced at 19 (saves 3.50, about 16%). Cost = sum of the six side costs (1.00+0.60+1.20+0.70+1.00+0.90 = 5.40),
-- several of which are owner estimates.
update products set
  name = 'Sides Platter',
  name_ar = 'طبق الإضافات',
  description = 'All six sides together: Egyptian White Cheese, Black Honey, White Honey, Tahini, Baba Ganoush and Hummus, at a bundled price.',
  selling_price = 19,
  ingredient_cost = 5.40
where slug = 'feteer-dip-trio';

update products set description = 'A whole Feteer Meshaltet with a trio of sides — Black Honey, Egyptian White Cheese and Tahini — bundled together.'
where slug = 'feteer-and-dip-trio';
-- 0063: four new combos, a choices system for every "pick your own" combo, combo packaging.
-- Approved by the owner 2026-10-01. Pricing worked out in docs/COMBO-PRICING.md.
-- Packaging is a PLACEHOLDER of $0.50 per item in the combo (owner will replace it from receipts;
-- it is editable per product in the dashboard). ingredient_cost is the WORST CASE across the choices.
--
-- Pick Any 3 Puddings goes to full price ($15, no discount) because puddings alone cannot reach a 50% margin.

-- Which options a customer may choose for each choice slot of a combo. The create-order function checks the
-- customer's picks against this table, so a tampered browser cannot invent a choice.
create table if not exists combo_slots (
  combo_slug     text not null,
  slot_key       text not null,
  label          text not null,
  pick_count     int  not null check (pick_count between 1 and 12),
  distinct_items boolean not null default false,
  allowed        text[] not null,
  sort_order     int  not null default 0,
  primary key (combo_slug, slot_key)
);
alter table combo_slots enable row level security;

insert into combo_slots (combo_slug, slot_key, label, pick_count, distinct_items, allowed, sort_order) values
  ('pick-3-puddings',    'puddings', 'Puddings', 3, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 1),
  ('family-feast',       'main',     'Main',     1, false, array['macarona-bechamel','kofta-tray'], 1),
  ('family-feast',       'sides',    'Sides',    2, true,  array['white-cheese','black-honey','white-honey','tahini','baba-ganoush','hummus'], 2),
  ('family-feast',       'puddings', 'Puddings', 2, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 3),
  ('egyptian-breakfast', 'shake',    'Shake',    1, false, array['protein-shake','avocado-drink'], 1),
  ('meal-for-one',       'side',     'Side',     1, false, array['white-cheese','black-honey','white-honey','tahini','baba-ganoush','hummus'], 1),
  ('meal-for-one',       'pudding',  'Pudding',  1, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 2),
  ('party-tray',         'main',     'Main',     1, false, array['macarona-bechamel','kofta-tray'], 1),
  ('party-tray',         'puddings', 'Puddings', 4, false, array['banana-pudding','chocolate-pudding','creme-caramel','rice-pudding'], 2)
on conflict (combo_slug, slot_key) do update set label = excluded.label, pick_count = excluded.pick_count,
  distinct_items = excluded.distinct_items, allowed = excluded.allowed, sort_order = excluded.sort_order;

-- New combos
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, ingredient_cost, packaging_cost, tax_status)
select v.slug, v.name, v.name_ar, c.id, v.descr, v.img, v.price, v.cost, v.pkg, 'review'
from product_categories c,
(values
  ('egyptian-breakfast', 'Egyptian Breakfast', 'فطار مصري',
   'Feteer Meshaltet with Egyptian White Cheese, Black Honey and Tahini, plus a shake of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 39.50, 9.69, 2.50),
  ('family-feast', 'Family Feast', 'عزومة العيلة',
   'Feteer Meshaltet, plus one main (Macarona Béchamel or Kofta Tray), two sides and two puddings of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 69.00, 26.70, 3.00),
  ('meal-for-one', 'Meal for One', 'وجبة لفرد',
   'Feteer Meshaltet with one side and one pudding of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 30.50, 8.38, 1.50),
  ('party-tray', 'Party Tray', 'صينية الحفلة',
   'Feteer Meshaltet, one main (Macarona Béchamel or Kofta Tray), the full Sides Platter and four puddings of your choice.',
   'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/feteer-meshaltet-wide.jpg', 89.50, 35.48, 3.50)
) as v(slug, name, name_ar, descr, img, price, cost, pkg)
where c.name = 'Combos'
on conflict (slug) do update set name = excluded.name, name_ar = excluded.name_ar, description = excluded.description,
  selling_price = excluded.selling_price, ingredient_cost = excluded.ingredient_cost, packaging_cost = excluded.packaging_cost,
  is_active = true, deleted_at = null;

-- Existing combos: placeholder packaging, and Pick Any 3 Puddings at full price
update products set packaging_cost = 2.00 where slug = 'feteer-and-dip-trio';
update products set packaging_cost = 3.00 where slug = 'feteer-dip-trio';
update products set packaging_cost = 1.50, selling_price = 15 where slug = 'pick-3-puddings';
-- 0064: Feteer + Dip Trio is retired (too close to Egyptian Breakfast). Made inactive, not deleted, so old orders keep their history.
update products set is_active = false where slug = 'feteer-and-dip-trio';
-- 0065: Meal for One now has TWO sides (all different) plus one pudding, so the price goes up.
-- Full price 25 + 3 + 3.50 + 5 = 36.50 (cheapest picks). Worst-case cost 4.39 + 1.20 + 1.00 + 2.79 = 9.38.
-- Packaging placeholder 4 items x 0.50 = 2.00. Price 33 (saves 3.50): profit 20.36 after packaging and card fee, margin 62%.
delete from combo_slots where combo_slug = 'meal-for-one' and slot_key = 'side';
insert into combo_slots (combo_slug, slot_key, label, pick_count, distinct_items, allowed, sort_order) values
  ('meal-for-one', 'sides', 'Sides', 2, true, array['white-cheese','black-honey','white-honey','tahini','baba-ganoush','hummus'], 1)
on conflict (combo_slug, slot_key) do update set label = excluded.label, pick_count = excluded.pick_count,
  distinct_items = excluded.distinct_items, allowed = excluded.allowed, sort_order = excluded.sort_order;
update products set selling_price = 33, ingredient_cost = 9.38, packaging_cost = 2.00,
  description = 'Feteer Meshaltet with two sides and one pudding of your choice.'
where slug = 'meal-for-one';
-- 0066: owner rule (2026-10-01): paid promotion (boosted posts, promoted stories, Nextdoor and Facebook ads, paid
-- page shout-outs) is filed under "Social media". Future charges are guessed that way, and the existing ones move.
insert into marketing_keywords (keyword, channel, sort_order) values
  ('bk promos', 'social', 5), ('promot', 'social', 8), ('boost', 'social', 8)
on conflict do nothing;
update marketing_keywords set channel = 'social', sort_order = 10 where keyword = 'nextdoor';

update expenses set marketing_channel = 'social'
 where deleted_at is null and vendor in ('Meta (Instagram Ads)', 'BK Promos, LLC', 'Meta (Facebook Ads)', 'Nextdoor Ads');

-- 0067_closed_days.sql
-- Kitchen calendar: days the owner has switched off. The website greys them out in red
-- ("Fully booked") and create-order refuses orders for them.
-- The website reads only the day column (anon); the private reason stays admin-only.
create table if not exists closed_days (
  day        date primary key,
  reason     text not null default '',
  created_at timestamptz not null default now()
);
alter table closed_days enable row level security;
revoke all on closed_days from anon, authenticated;
grant select (day) on closed_days to anon;
grant select, insert, update, delete on closed_days to authenticated;
drop policy if exists closed_days_public_read on closed_days;
create policy closed_days_public_read on closed_days for select to anon using (true);
drop policy if exists closed_days_admin on closed_days;
create policy closed_days_admin on closed_days for all to authenticated using (is_admin()) with check (is_admin());
