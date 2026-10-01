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
