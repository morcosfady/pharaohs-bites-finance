-- ============================================================================
-- 0086_pharaohs_rolls_cost_10.sql : Pharaoh's Rolls real ingredient cost, $10 (owner, 2026-11)
-- Already applied to the live database. Replaces the $14.24 estimate from 0085.
-- ============================================================================

update products set ingredient_cost = 10 where slug = 'pharaohs-rolls';
