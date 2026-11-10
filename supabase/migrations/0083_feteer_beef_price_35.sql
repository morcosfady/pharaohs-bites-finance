-- ============================================================================
-- 0083_feteer_beef_price_35.sql : stuffed feteer price $40 -> $35 (owner request, 2026-11)
-- Mirrors assets/js/data.js on the customer website. Already applied to the live database.
-- ============================================================================

update products set selling_price = 35 where slug = 'feteer-beef';
