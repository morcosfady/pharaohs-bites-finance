-- 0062: the Feteer Dip Trio combo becomes a six-side platter (slug unchanged so history and the other combo still match).
-- Separate prices: White Cheese 4 + Black Honey 3.50 + White Honey 4 + Tahini 3 + Baba Ganoush 4 + Hummus 4 = 22.50.
-- Priced at 19 (saves 3.50, about 16%). Cost = sum of the six side costs (1.00+0.60+1.20+0.70+1.00+0.90 = 5.40),
-- several of which are owner estimates.
update products set
  name = 'Sides Platter',
  name_ar = 'طبق الإضافات',
  description = 'All six sides together: Egyptian White Cheese, Black Honey, White Honey, Tahini, Baba Ganoush and Hummus, at a bundled price.',
  selling_price = 19,
  ingredient_cost = 5.40
where slug = 'feteer-dip-trio';

update products set description = 'A whole Feteer Meshaltet with a trio of sides — Black Honey, Egyptian White Cheese and Tahini — bundled together.'
where slug = 'feteer-and-dip-trio';
