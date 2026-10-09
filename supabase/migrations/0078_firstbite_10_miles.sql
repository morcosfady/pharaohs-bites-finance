-- FIRSTBITE free delivery now reaches 10 miles (was 5). The distance limit lives in promo_codes.max_miles,
-- so the website, the order check and the dashboard Promos tab all follow this one number.
update promo_codes set max_miles = 10 where code = 'FIRSTBITE';
