-- 0081: combos switched off for now (owner, 2026-10-21). The website hides them (data.js COMBOS_ENABLED = false)
-- and the server refuses them (inactive products fail intake with "no longer available"). Individual dishes
-- are untouched. To bring combos back: set these active again and flip COMBOS_ENABLED on the website.
update products set is_active = false
 where slug in ('party-tray', 'family-feast', 'egyptian-breakfast', 'meal-for-one', 'feteer-dip-trio', 'pick-3-puddings')
   and deleted_at is null;
