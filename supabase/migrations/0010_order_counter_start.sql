-- ============================================================================
-- 0010_order_counter_start.sql : start public order numbers at 101.
--
-- The website's first live orders should not read PB-2026-00001; the owner
-- wants the sequence to continue from 100 orders already made. Only moves
-- the counter forward, never back, so re-running is harmless.
-- ============================================================================

insert into order_counters (year, last_seq) values (2026, 100)
on conflict (year) do update set last_seq = greatest(order_counters.last_seq, 100);
