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
create type customer_status as enum ('active', 'vip', 'blocked');
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
  select coalesce(sum(recipe_line_cost(r.quantity, r.unit, i.package_size, i.package_unit, i.package_price, greatest(r.waste_pct, i.waste_pct))), 0)
    into v_ing
  from recipes r join ingredients i on i.id = r.ingredient_id
  where r.product_id = p_product_id and i.deleted_at is null;

  update products set ingredient_cost = v_ing where id = p_product_id returning * into v_p;
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
