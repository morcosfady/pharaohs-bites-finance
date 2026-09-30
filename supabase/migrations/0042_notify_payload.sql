-- Pay-online orders wait for payment before the owner alert + customer receipt.
-- create-order parks the notification details here; stripe-webhook sends them
-- (once) when Stripe confirms the payment, then clears the column.
alter table orders add column if not exists notify_payload jsonb;
