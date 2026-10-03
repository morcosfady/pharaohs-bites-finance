-- ============================================================================
-- 0074_site_events.sql : website activity log for the dashboard "Website Pulse" tab (2026-10-03)
-- One row per thing a visitor did on the customer website: opened a page, added a dish to
-- the basket, pressed Place Order, placed an order, or hit a problem. Visitors are
-- ANONYMOUS (a random id kept in their browser). The only personal details ever stored are
-- in "problem" rows for a failed order: first name, last 4 digits of the phone, and ZIP.
-- The website writes through the "track" Edge Function (rate limited); only the
-- signed-in admin can read the table. Rows older than 180 days are deleted by that function.
-- ============================================================================
create table if not exists site_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor_id text not null,
  kind       text not null check (kind in ('visit', 'add_to_basket', 'checkout_started', 'order_placed', 'problem')),
  page       text not null default '',
  detail     text not null default '',
  meta       jsonb not null default '{}'::jsonb,
  ip_hash    text not null default ''
);
create index if not exists site_events_time on site_events (created_at desc);
create index if not exists site_events_visitor on site_events (visitor_id, created_at);
create index if not exists site_events_ip on site_events (ip_hash, created_at);

alter table site_events enable row level security;
revoke all on site_events from anon, authenticated;
grant select on site_events to authenticated;
drop policy if exists site_events_admin_read on site_events;
create policy site_events_admin_read on site_events for select to authenticated using (is_admin());
