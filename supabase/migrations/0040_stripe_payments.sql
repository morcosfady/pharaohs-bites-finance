-- Online card payments (Stripe Checkout). One payment row per Stripe payment,
-- so webhook retries can never record the same money twice.
alter table orders add column if not exists stripe_session_id text;
create unique index if not exists payments_stripe_ref_uniq on payments(reference) where reference like 'stripe:%';
