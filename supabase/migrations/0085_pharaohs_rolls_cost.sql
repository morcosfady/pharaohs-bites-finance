-- ============================================================================
-- 0085_pharaohs_rolls_cost.sql : Pharaoh's Rolls ingredient cost (2026-11)
-- Already applied to the live database. $14.24 is an ESTIMATE: the same typed-in cost as the
-- stuffed feteer (feteer-beef), since the two rolls use the same dough and filling. The owner
-- should replace it with the real cost in the dashboard (Menu & Profit, tap the dish).
-- ============================================================================

update products set ingredient_cost = 14.24 where slug = 'pharaohs-rolls' and ingredient_cost = 0;
