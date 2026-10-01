-- 0065: Meal for One now has TWO sides (all different) plus one pudding, so the price goes up.
-- Full price 25 + 3 + 3.50 + 5 = 36.50 (cheapest picks). Worst-case cost 4.39 + 1.20 + 1.00 + 2.79 = 9.38.
-- Packaging placeholder 4 items x 0.50 = 2.00. Price 33 (saves 3.50): profit 20.36 after packaging and card fee, margin 62%.
delete from combo_slots where combo_slug = 'meal-for-one' and slot_key = 'side';
insert into combo_slots (combo_slug, slot_key, label, pick_count, distinct_items, allowed, sort_order) values
  ('meal-for-one', 'sides', 'Sides', 2, true, array['white-cheese','black-honey','white-honey','tahini','baba-ganoush','hummus'], 1)
on conflict (combo_slug, slot_key) do update set label = excluded.label, pick_count = excluded.pick_count,
  distinct_items = excluded.distinct_items, allowed = excluded.allowed, sort_order = excluded.sort_order;
update products set selling_price = 33, ingredient_cost = 9.38, packaging_cost = 2.00,
  description = 'Feteer Meshaltet with two sides and one pudding of your choice.'
where slug = 'meal-for-one';
