-- ============================================================================
-- 0037_dessert_prices_and_om_ali_feature.sql : dessert/soup price rebalance, 2026-09-27
-- Mirrors assets/js/data.js on the customer website.
--   Lentil Soup            $7    -> $8
--   Small Round Cake       $13   -> $8
--   Chocolate Pudding      $7    -> $5
--   Banana Pudding         $7    -> $5
--   Rice Pudding           $7    -> $5.50
--   Crème Caramel Flan     $8    -> $5
-- Om Ali is now a featured house special, shown first among desserts.
-- ============================================================================

update products set selling_price = v.price
from (values
  ('lentil-soup', 8.00),
  ('round-cake', 8.00),
  ('chocolate-pudding', 5.00),
  ('banana-pudding', 5.00),
  ('rice-pudding', 5.50),
  ('creme-caramel', 5.00)
) as v(slug, price)
where products.slug = v.slug;
