-- 0052: the owner does not want to review anything. The system decides, and anything it is unsure
-- about is flagged for the ACCOUNTANT on the Tax tab instead of waiting in the Review inbox.
--
--  * known vendors get rules (Cloudflare = website, Court Solutions = licenses and permits)
--  * a bank charge with no rule gets category "Other" (the tax view already flags "Other" as Ask accountant)
--  * a deposit with no rule is treated as the owner putting money in (Stripe payouts have their own rule),
--    never as income and never as an expense
--  * possible duplicates still need a human decision, because merging wrongly would lose a real purchase

insert into bank_rules (match_text, vendor, category_id, cost_type, action, direction, sort_order)
select v.m, v.vend, c.id, 'operating', 'expense', 'out', 40
  from (values ('CLOUDFLARE', 'Cloudflare', 'Website / technology'),
               ('COURT SOLUTIONS', 'Court Solutions', 'Licenses and permits')) as v(m, vend, cat)
  join expense_categories c on c.name = v.cat
 where not exists (select 1 from bank_rules r where lower(r.match_text) = lower(v.m));

-- catch-all for unknown deposits: lowest priority, so every specific rule wins first
insert into bank_rules (match_text, vendor, action, direction, sort_order)
select '', '', 'owner_contribution', 'in', 900
 where not exists (select 1 from bank_rules where match_text = '' and direction = 'in');

-- a new bank import without a category becomes "Other" and leaves the inbox at once
create or replace function expense_default_category() returns trigger language plpgsql as $$
begin
  if new.auto_source = 'bank' and new.category_id is null then
    new.category_id := (select id from expense_categories where name = 'Other');
    new.review_status := case when new.review_status = 'possible_duplicate' then 'possible_duplicate' else 'ok' end;
  end if;
  return new;
end $$;
drop trigger if exists expenses_default_category on expenses;
create trigger expenses_default_category before insert on expenses for each row execute function expense_default_category();

-- apply the new rules to everything already imported
do $$ declare rec record; begin
  for rec in select id from bank_transactions loop perform apply_bank_transaction(rec.id); end loop;
end $$;
-- anything still waiting only for a category gets "Other"
update expenses set category_id = (select id from expense_categories where name = 'Other'), review_status = 'ok'
 where deleted_at is null and review_status = 'needs_review' and category_id is null;
