-- 0066: owner rule (2026-10-01): paid promotion (boosted posts, promoted stories, Nextdoor and Facebook ads, paid
-- page shout-outs) is filed under "Social media". Future charges are guessed that way, and the existing ones move.
insert into marketing_keywords (keyword, channel, sort_order) values
  ('bk promos', 'social', 5), ('promot', 'social', 8), ('boost', 'social', 8)
on conflict do nothing;
update marketing_keywords set channel = 'social', sort_order = 10 where keyword = 'nextdoor';

update expenses set marketing_channel = 'social'
 where deleted_at is null and vendor in ('Meta (Instagram Ads)', 'BK Promos, LLC', 'Meta (Facebook Ads)', 'Nextdoor Ads');
