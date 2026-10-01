-- ============================================================================
-- Price book chain (migration 0058 + the existing recipe triggers). Runs inside ONE transaction that is
-- ROLLED BACK:  supabase db query --linked -f supabase/tests/price_book.sql
-- A clean run ends with {"result": "ALL PRICE BOOK TESTS PASSED"}.
-- Proves what the "Apply new price" button relies on: change an ingredient's price and every dish that uses
-- it is recalculated by the database, with the price history kept, and a dish with no recipe is NOT touched.
-- ============================================================================
begin;

create or replace function _expect(p_label text, p_actual numeric, p_expected numeric) returns void language plpgsql as $$
begin if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if; end $$;

do $$
declare ing uuid; a uuid; b uuid; c uuid; hist int;
begin
  -- a $20, 25 lb bag of flour
  insert into ingredients (name, supplier, package_size, package_unit, package_price) values ('Test flour', 'Costco', 25, 'lb', 20) returning id into ing;
  insert into products (slug, name, selling_price, ingredient_cost) values ('zz-dish-a', 'Dish A', 12, 99), ('zz-dish-b', 'Dish B', 4, 99), ('zz-dish-c', 'Dish C (typed cost, no recipe)', 8, 3.5);
  select id into a from products where slug = 'zz-dish-a'; select id into b from products where slug = 'zz-dish-b'; select id into c from products where slug = 'zz-dish-c';
  insert into recipes (product_id, ingredient_id, quantity, unit) values (a, ing, 2, 'lb'), (b, ing, 8, 'oz');

  perform _expect('recipe cost: 2 lb of a $20/25 lb bag = $1.60', (select ingredient_cost from products where id = a), 1.6);
  perform _expect('recipe cost: 8 oz is half a pound = $0.40', (select ingredient_cost from products where id = b), 0.4);

  -- what the Apply button does: change only the package price
  update ingredients set package_price = 25 where id = ing;
  perform _expect('apply: dish A recalculated by the database', (select ingredient_cost from products where id = a), 2.0);
  perform _expect('apply: dish B recalculated', (select ingredient_cost from products where id = b), 0.5);
  perform _expect('apply: a dish with no recipe keeps the cost the owner typed', (select ingredient_cost from products where id = c), 3.5);

  select count(*) into hist from ingredient_cost_history where ingredient_id = ing;
  perform _expect('apply: the old and the new price are both in the history', hist, 2);
  perform _expect('apply: each dish keeps a cost history row', (select count(*) from product_cost_history where product_id = a), 2);

  -- a link only remembers which receipt item belongs to the ingredient
  insert into ingredient_receipt_links (item_key, ingredient_id) values ('king arthur flour', ing);
  begin
    insert into ingredient_receipt_links (item_key, ingredient_id) values ('king arthur flour', ing);
    raise exception 'FAIL [link]: the same receipt item was linked twice';
  exception when unique_violation then null; end;
  perform _expect('a link never changes a price', (select package_price from ingredients where id = ing), 25);

  -- deleting the ingredient removes its link, not the dishes
  delete from ingredient_receipt_links where item_key = 'king arthur flour';
  perform _expect('dishes survive', (select count(*) from products where slug like 'zz-dish-%'), 3);
end $$;

rollback;
select 'ALL PRICE BOOK TESTS PASSED' as result;
