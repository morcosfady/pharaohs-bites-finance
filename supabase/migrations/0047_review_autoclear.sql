-- 0047: an expense that was waiting for a category leaves the Review inbox the moment it has one,
-- whether the category came from a bank rule, the inbox, or the edit form.
create or replace function expense_review_autoclear() returns trigger language plpgsql as $$
begin
  if new.review_status = 'needs_review' and new.category_id is not null then
    new.review_status := 'ok';
  end if;
  return new;
end $$;
drop trigger if exists expenses_review_autoclear on expenses;
create trigger expenses_review_autoclear before update on expenses for each row execute function expense_review_autoclear();
