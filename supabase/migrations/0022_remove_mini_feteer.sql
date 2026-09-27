-- ============================================================================
-- 0022_remove_mini_feteer.sql : Mini Feteer removed from the menu, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Deactivated rather than
-- deleted so past orders and reports keep their product reference, same
-- treatment as the crepes removed earlier (migration 0006).
-- ============================================================================

update products set is_active = false
where slug = 'mini-feteer-sweet';
