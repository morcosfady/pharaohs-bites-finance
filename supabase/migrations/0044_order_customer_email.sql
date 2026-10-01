-- The checkout now requires an email. Keep it on the order (and on the customer when empty)
-- so the owner can see it in the dashboard, not only in the Telegram alert.
alter table orders add column if not exists customer_email text not null default '';
