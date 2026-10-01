-- Promo codes. First code: FIRSTBITE = free delivery, once per customer.
-- "Once per customer" is enforced in the database (not the browser): a redemption is
-- reserved when the order is saved and marked used when it is paid (or confirmed, for
-- orders that are not paid online). A used redemption blocks the same phone number OR
-- the same email from using that code again, even from another device.
create table if not exists promo_codes (
  code   text primary key,
  kind   text not null check (kind in ('free_delivery')),
  active boolean not null default true
);
insert into promo_codes (code, kind) values ('FIRSTBITE', 'free_delivery') on conflict (code) do nothing;

create table if not exists promo_redemptions (
  id           uuid primary key default gen_random_uuid(),
  code         text not null references promo_codes(code),
  order_id     uuid not null references orders(id) on delete cascade,
  phone_digits text not null default '',
  email_norm   text not null default '',
  fee_waived   numeric(12,2) not null default 0,
  used_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (order_id, code)
);
create unique index if not exists promo_used_phone_uniq on promo_redemptions(code, phone_digits) where used_at is not null and phone_digits <> '';
create unique index if not exists promo_used_email_uniq on promo_redemptions(code, email_norm) where used_at is not null and email_norm <> '';

alter table promo_codes enable row level security;
alter table promo_redemptions enable row level security;
-- no policies: only the Edge Functions (service role) read or write these tables.

alter table orders add column if not exists promo_code text;
