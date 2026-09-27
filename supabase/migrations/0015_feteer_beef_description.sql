-- ============================================================================
-- 0015_feteer_beef_description.sql : mention the mixed vegetables, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($40) —
-- the owner clarified the filling also has green pepper, olives and onions.
-- ============================================================================

update products set
  description = 'The same hand-stretched layers, stuffed with seasoned plant-based ground beef, melted mozzarella and a mix of vegetables — green pepper, olives and onions — then sealed and returned to the oven.'
where slug = 'feteer-beef';
