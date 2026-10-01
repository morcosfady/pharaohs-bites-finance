-- ============================================================================
-- 0055_marketing.sql : Expenses -> Marketing tab.
--
-- A marketing expense (category "Marketing") belongs to a CHANNEL: social media, flyers and print,
-- online ads, email and website, events and samples, influencers, other. The channel is guessed from the
-- vendor/description by keyword (Meta -> social media, Vistaprint -> flyers and print...) and can be
-- changed by the owner at any time; an owner choice is never overwritten.
-- ============================================================================

alter table expenses add column if not exists marketing_channel text
  check (marketing_channel is null or marketing_channel in ('social', 'flyers_print', 'online_ads', 'email_web', 'events', 'influencers', 'other'));

create table if not exists marketing_keywords (
  id         uuid primary key default gen_random_uuid(),
  keyword    text not null,                       -- case-insensitive substring of vendor + description
  channel    text not null check (channel in ('social', 'flyers_print', 'online_ads', 'email_web', 'events', 'influencers', 'other')),
  sort_order int not null default 100              -- lowest wins
);
create unique index if not exists marketing_keywords_uniq on marketing_keywords (lower(keyword));
alter table marketing_keywords enable row level security;
drop policy if exists marketing_keywords_all on marketing_keywords;
create policy marketing_keywords_all on marketing_keywords for all to authenticated using (is_admin()) with check (is_admin());

insert into marketing_keywords (keyword, channel, sort_order) values
  -- social media
  ('facebk', 'social', 10), ('facebook', 'social', 10), ('meta platforms', 'social', 10), ('meta', 'social', 12), ('instagram', 'social', 10),
  ('tiktok', 'social', 10), ('snapchat', 'social', 10), ('pinterest', 'social', 10), ('linkedin', 'social', 10),
  ('twitter', 'social', 10), ('x corp', 'social', 10), ('youtube', 'social', 10), ('social', 'social', 20),
  -- flyers, print and signage
  ('vistaprint', 'flyers_print', 10), ('fedex office', 'flyers_print', 10), ('gogoprint', 'flyers_print', 10), ('uprinting', 'flyers_print', 10),
  ('moo.com', 'flyers_print', 10), ('sticker mule', 'flyers_print', 10), ('zazzle', 'flyers_print', 10), ('flyer', 'flyers_print', 15),
  ('business card', 'flyers_print', 15), ('banner', 'flyers_print', 15), ('brochure', 'flyers_print', 15), ('poster', 'flyers_print', 15),
  ('menu print', 'flyers_print', 15), ('print', 'flyers_print', 30),
  -- online ads
  ('google ads', 'online_ads', 10), ('google*ads', 'online_ads', 10), ('yelp', 'online_ads', 10), ('nextdoor', 'online_ads', 10),
  ('bing ads', 'online_ads', 10), ('ads', 'online_ads', 40),
  -- email and website marketing
  ('mailchimp', 'email_web', 10), ('klaviyo', 'email_web', 10), ('constant contact', 'email_web', 10), ('wix', 'email_web', 10),
  ('seo', 'email_web', 20), ('newsletter', 'email_web', 20),
  -- events and samples
  ('eventbrite', 'events', 10), ('farmers market', 'events', 10), ('popup', 'events', 10), ('pop-up', 'events', 10),
  ('booth', 'events', 15), ('tasting', 'events', 15), ('sample', 'events', 15), ('giveaway', 'events', 15), ('vendor fee', 'events', 15),
  -- influencers
  ('influencer', 'influencers', 10), ('collab', 'influencers', 10), ('sponsor', 'influencers', 15)
on conflict do nothing;

create or replace function infer_marketing_channel(p_text text)
returns text language sql stable set search_path = public as $$
  select coalesce((select channel from marketing_keywords where position(lower(keyword) in lower(coalesce(p_text, ''))) > 0
                    order by sort_order, length(keyword) desc limit 1), 'other')
$$;

-- keep the channel in step with the category: guessed when empty, cleared when it is no longer marketing
create or replace function expenses_marketing_channel() returns trigger language plpgsql set search_path = public as $$
declare v_cat text;
begin
  select name into v_cat from expense_categories where id = new.category_id;
  if v_cat = 'Marketing' then
    if new.marketing_channel is null then new.marketing_channel := infer_marketing_channel(coalesce(new.vendor, '') || ' ' || coalesce(new.description, '')); end if;
  else
    new.marketing_channel := null;
  end if;
  return new;
end $$;
drop trigger if exists expenses_marketing_channel on expenses;
create trigger expenses_marketing_channel before insert or update on expenses for each row execute function expenses_marketing_channel();

-- channels for the marketing expenses that already exist
update expenses set vendor = vendor where deleted_at is null and category_id = (select id from expense_categories where name = 'Marketing');

-- ------------------------------------------------------------------ more bank rules for marketing spend
insert into bank_rules (match_text, vendor, category_id, cost_type, action, direction, sort_order)
select v.m, v.vend, c.id, 'operating', 'expense', 'out', v.so
  from (values
    ('FEDEX OFFICE', 'FedEx Office', 38), ('GOGOPRINT', 'GoGoPrint', 45), ('UPRINTING', 'UPrinting', 45), ('MOO.COM', 'Moo', 45),
    ('STICKER MULE', 'Sticker Mule', 45), ('ZAZZLE', 'Zazzle', 45),
    ('SNAPCHAT', 'Snapchat', 45), ('PINTEREST', 'Pinterest', 45), ('LINKEDIN', 'LinkedIn', 45), ('NEXTDOOR', 'Nextdoor', 45),
    ('MAILCHIMP', 'Mailchimp', 45), ('KLAVIYO', 'Klaviyo', 45), ('CONSTANT CONTACT', 'Constant Contact', 45), ('EVENTBRITE', 'Eventbrite', 45)
  ) as v(m, vend, so)
  join expense_categories c on c.name = 'Marketing'
 where not exists (select 1 from bank_rules r where lower(r.match_text) = lower(v.m));

do $$ declare rec record; begin
  for rec in select id from bank_transactions loop perform apply_bank_transaction(rec.id); end loop;
end $$;
