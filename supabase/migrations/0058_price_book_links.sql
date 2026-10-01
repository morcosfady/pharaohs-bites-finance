-- 0058: links a receipt item (its item_key, the first three letter-words of the name) to an ingredient in the
-- price book (the existing `ingredients` table that feeds recipes and dish costs). A link only tells the
-- dashboard which receipt prices to compare with that ingredient; it never changes a price by itself. The
-- owner approves each price change, and the existing triggers then recalculate the dishes that use it
-- and keep the price history.

create table if not exists ingredient_receipt_links (
  item_key       text primary key,
  ingredient_id  uuid not null references ingredients(id) on delete cascade,
  created_at     timestamptz not null default now()
);
create index if not exists ingredient_receipt_links_ing_idx on ingredient_receipt_links (ingredient_id);
alter table ingredient_receipt_links enable row level security;
drop policy if exists ingredient_receipt_links_all on ingredient_receipt_links;
create policy ingredient_receipt_links_all on ingredient_receipt_links for all to authenticated using (is_admin()) with check (is_admin());
