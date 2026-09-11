-- ============================================================================
-- 0003_catalog.sql : real product catalogue (mirrors the customer website)
-- This is business reference data, not sample data. Prices match
-- assets/js/data.js on the customer site; the Edge Function validates every
-- website order against this table and never trusts browser prices.
-- ============================================================================

insert into product_categories (name, sort_order) values
  ('Feteer', 1), ('Feteer & Trays', 2), ('Soups', 3), ('Cakes', 4), ('Desserts', 5),
  ('Pudding', 6), ('Sides', 7), ('Drinks', 8), ('Seasonal Products', 9), ('Other', 10)
on conflict (name) do nothing;

with rows(slug, name, name_ar, category, description, image_url, selling_price) as (values
  ('feteer-meshaltet', 'Feteer Meshaltet', 'فطير مشلتت', 'Feteer', 'The original. Paper-thin dough stretched by hand, folded again and again with ghee between every layer, then baked until the top shatters.', 'https://images.unsplash.com/photo-1787690376659-e5e7cd2ae452?auto=format&fit=crop&w=900&q=80', 14),
  ('feteer-beef', 'Feteer with Plant-Based Beef & Mozzarella', 'فطير محشي لحمة', 'Feteer', 'The same hand-stretched layers, stuffed with seasoned plant-based ground beef and melted mozzarella, sealed and returned to the oven.', 'https://images.unsplash.com/photo-1631875962715-e36c2d5189ca?auto=format&fit=crop&w=900&q=80', 18),
  ('macarona-bechamel', 'Macarona Béchamel Tray', 'صينية مكرونة بشاميل', 'Feteer & Trays', 'Penne baked under a thick blanket of béchamel with plant-based ground beef through the middle, browned on top and cut into squares.', 'https://images.unsplash.com/photo-1620041631703-45ddcef3dae0?auto=format&fit=crop&w=900&q=80', 16),
  ('goulash-beef', 'Goulash Tray with Plant-Based Beef', 'صينية جلاش باللحمة', 'Feteer & Trays', 'Sheet after sheet of thin pastry layered with spiced plant-based ground beef and onion, brushed with ghee and baked golden.', 'https://images.unsplash.com/photo-1617806501736-fc7cab7c05bf?auto=format&fit=crop&w=900&q=80', 16),
  ('crepe-beef', 'Crepe with Ground Beef & Mozzarella', 'كريب باللحمة والموتزاريلا', 'Feteer & Trays', 'A soft crepe rolled around seasoned ground beef and mozzarella, griddled until the cheese pulls.', 'https://images.unsplash.com/photo-1776820620219-c5079240a997?auto=format&fit=crop&w=900&q=80', 13),
  ('kofta-tray', 'Plant-Based Kofta Tray with Salsa & Rice', 'صينية كفتة بالصلصة والأرز', 'Feteer & Trays', 'Hand-shaped plant-based kofta baked in a rich tomato salsa with onion and garlic, served over a bed of Egyptian rice. Feeds a table.', 'https://images.unsplash.com/photo-1763647818263-62a9256f097c?auto=format&fit=crop&w=900&q=80', 35),
  ('meatballs-spaghetti', 'Plant-Based Meatballs & Spaghetti', 'كرات لحم نباتية بالمكرونة', 'Feteer & Trays', 'Plant-based meatballs simmered in tomato sauce and tossed through spaghetti, finished with a little parmesan.', 'https://images.unsplash.com/photo-1622973536968-3ead9e780960?auto=format&fit=crop&w=900&q=80', 25),
  ('lentil-soup', 'Lentil Soup', 'شوربة عدس', 'Soups', 'Red lentils cooked down with onion, carrot and cumin until smooth, finished with lemon. Comes with bread on the side.', 'https://images.unsplash.com/photo-1642497394078-4794e837019c?auto=format&fit=crop&w=900&q=80', 7),
  ('goulash-nuts', 'Goulash Tray with Nuts', 'صينية جلاش بالمكسرات', 'Desserts', 'Layered pastry packed with walnut, almond and pistachio, baked crisp and soaked in syrup the moment it leaves the oven.', 'https://images.unsplash.com/photo-1594981449006-3bb015dd305a?auto=format&fit=crop&w=900&q=80', 15),
  ('mini-feteer-sweet', 'Mini Feteer, Nutella or Pistachio', 'فطير صغير حلو', 'Feteer', 'A palm-sized feteer with all its layers intact, finished with Nutella or pistachio sauce. Choose when you order.', 'https://images.unsplash.com/photo-1669630367800-b2c3ae70528e?auto=format&fit=crop&w=900&q=80', 11),
  ('crepe-nutella', 'Crepe with Nutella', 'كريب بالنوتيلا', 'Desserts', 'Warm crepe folded over Nutella until it melts through.', 'https://images.unsplash.com/photo-1723029343498-b061d6594a42?auto=format&fit=crop&w=900&q=80', 9),
  ('crepe-pistachio', 'Crepe with Pistachio Sauce', 'كريب بالفستق', 'Desserts', 'The same warm crepe with a thick pistachio cream, dusted with crushed pistachio.', 'https://images.unsplash.com/photo-1777891258086-52a41e4477f6?auto=format&fit=crop&w=900&q=80', 10),
  ('round-cake', 'Small Round Cake', 'كيكة صغيرة', 'Cakes', 'A small home-style cake, baked fresh and iced simply. Ask what today''s is.', 'https://images.unsplash.com/photo-1602351447937-745cb720612f?auto=format&fit=crop&w=900&q=80', 12),
  ('chocolate-pudding', 'Chocolate Pudding', 'بودينج شوكولاتة', 'Pudding', 'Set dark chocolate pudding, chilled, with cream folded through the top.', 'https://images.unsplash.com/photo-1673551494277-92204546b504?auto=format&fit=crop&w=900&q=80', 7),
  ('banana-pudding', 'Banana Pudding', 'بودينج موز', 'Pudding', 'Layers of vanilla cream, banana and biscuit, left to soften overnight.', 'https://images.unsplash.com/photo-1639330842151-8a92eb332b2d?auto=format&fit=crop&w=900&q=80', 7),
  ('creme-caramel', 'Crème Caramel Flan', 'كريم كراميل', 'Pudding', 'Baked custard turned out under its own caramel. Cold, wobbling, and gone in a minute.', 'https://images.unsplash.com/photo-1653988354010-39637252a2db?auto=format&fit=crop&w=900&q=80', 8),
  ('white-cheese', 'Egyptian White Cheese', 'جبنة بيضاء', 'Sides', 'Salty, crumbling domiati — the thing every Egyptian reaches for the moment the feteer is torn open.', 'https://images.unsplash.com/photo-1559561853-08451507cbe7?auto=format&fit=crop&w=900&q=80', 6),
  ('black-honey', 'Black Honey', 'عسل أسود', 'Sides', 'Sugarcane molasses, dark and mineral. The oldest sweet in the country, and the right partner for plain feteer.', 'https://images.unsplash.com/photo-1779120708355-7a41581b4584?auto=format&fit=crop&w=900&q=80', 5),
  ('white-honey', 'White Honey', 'عسل أبيض', 'Sides', 'Clear wildflower honey, poured cold over hot layers so it runs straight through.', 'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?auto=format&fit=crop&w=900&q=80', 5),
  ('tahini', 'Tahini', 'طحينة', 'Sides', 'Stone-ground sesame, loosened with lemon. Best stirred into the black honey until the two go pale.', 'https://images.unsplash.com/photo-1747932984398-dd52d84886d6?auto=format&fit=crop&w=900&q=80', 5),
  ('protein-shake', 'House Special Protein Shake', 'مشروب البروتين', 'Drinks', 'Twenty-five grams of protein, blended thick and cold. Our own recipe — nothing about it tastes like a supplement.', 'https://images.unsplash.com/photo-1542444592-0d5997f202eb?auto=format&fit=crop&w=900&q=80', 9)
)
insert into products (slug, name, name_ar, category_id, description, image_url, selling_price, tax_status)
select r.slug, r.name, r.name_ar, c.id, r.description, r.image_url, r.selling_price, 'review'
from rows r left join product_categories c on c.name = r.category
on conflict (slug) do update set name = excluded.name, selling_price = excluded.selling_price, image_url = excluded.image_url;

insert into expense_categories (name, cost_type, sort_order) values
  ('Ingredients', 'direct_product', 1),
  ('Packaging', 'direct_product', 2),
  ('Pizza boxes', 'direct_product', 3),
  ('Cake boxes', 'direct_product', 4),
  ('Dessert cups', 'direct_product', 5),
  ('Logo stickers', 'direct_product', 6),
  ('Kitchen supplies', 'operating', 7),
  ('Equipment', 'operating', 8),
  ('Delivery', 'operating', 9),
  ('Gas / mileage', 'operating', 10),
  ('Marketing', 'operating', 11),
  ('Website / technology', 'operating', 12),
  ('Licenses and permits', 'operating', 13),
  ('Training', 'operating', 14),
  ('Bank / payment fees', 'operating', 15),
  ('Refunds', 'operating', 16),
  ('Utilities', 'operating', 17),
  ('Repairs', 'operating', 18),
  ('Other', 'operating', 19)
on conflict (name) do nothing;
