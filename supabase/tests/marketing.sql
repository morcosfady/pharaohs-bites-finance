-- ============================================================================
-- Marketing channel tests (migration 0055). Runs inside ONE transaction that is ROLLED BACK:
--   supabase db query --linked -f supabase/tests/marketing.sql
-- A clean run ends with {"result": "ALL MARKETING TESTS PASSED"}.
-- ============================================================================
begin;

create or replace function _expect(p_label text, p_actual text, p_expected text) returns void language plpgsql as $$
begin if p_actual is distinct from p_expected then raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual; end if; end $$;

create or replace function _mk(p_vendor text, p_desc text default '', p_cat text default 'Marketing') returns text language plpgsql as $$
declare v uuid;
begin
  insert into expenses (expense_date, vendor, description, category_id, amount_before_tax)
  values ('2026-11-01', p_vendor, p_desc, (select id from expense_categories where name = p_cat), 10) returning id into v;
  return (select marketing_channel from expenses where id = v);
end $$;

-- ---- the channel is guessed from the vendor ----
do $$ begin
  perform _expect('Meta is social media', _mk('Meta Platforms'), 'social');
  perform _expect('TikTok is social media', _mk('TikTok Ads'), 'social');
  perform _expect('Vistaprint is flyers and print', _mk('Vistaprint'), 'flyers_print');
  perform _expect('flyers in the description', _mk('Staples', 'Flyers for the farmers weekend'), 'flyers_print');
  perform _expect('Google Ads is online ads', _mk('Google Ads'), 'online_ads');
  perform _expect('Yelp is online ads', _mk('Yelp'), 'online_ads');
  perform _expect('Mailchimp is email and website', _mk('Mailchimp'), 'email_web');
  perform _expect('Eventbrite is events', _mk('Eventbrite'), 'events');
  perform _expect('free samples are events', _mk('Costco', 'tasting samples'), 'events');
  perform _expect('an influencer collab', _mk('Instagram creator', 'influencer collab'), 'influencers');
  perform _expect('an unknown marketing vendor is other', _mk('Totally New Thing'), 'other');
end $$;

-- ---- specific beats generic: "Facebook Ads" is social media, not online ads ----
do $$ begin
  perform _expect('Facebook ads stay social', _mk('Facebook Ads'), 'social');
  perform _expect('FedEx Office is print, not shipping', _mk('FEDEX OFFICE PRINT'), 'flyers_print');
end $$;

-- ---- not marketing = no channel; moving out of marketing clears it ----
do $$
declare v uuid;
begin
  perform _expect('an ingredient has no channel', coalesce(_mk('Costco', '', 'Ingredients'), 'none'), 'none');
  insert into expenses (expense_date, vendor, category_id, amount_before_tax) values ('2026-11-02', 'Meta', (select id from expense_categories where name = 'Marketing'), 5) returning id into v;
  update expenses set category_id = (select id from expense_categories where name = 'Other') where id = v;
  perform _expect('leaving marketing clears the channel', coalesce((select marketing_channel from expenses where id = v), 'none'), 'none');
  update expenses set category_id = (select id from expense_categories where name = 'Marketing') where id = v;
  perform _expect('coming back guesses again', (select marketing_channel from expenses where id = v), 'social');
end $$;

-- ---- an owner choice is never overwritten ----
do $$
declare v uuid;
begin
  insert into expenses (expense_date, vendor, category_id, amount_before_tax, marketing_channel) values ('2026-11-03', 'Meta', (select id from expense_categories where name = 'Marketing'), 5, 'influencers') returning id into v;
  perform _expect('explicit channel kept on insert', (select marketing_channel from expenses where id = v), 'influencers');
  update expenses set description = 'changed text with flyer in it' where id = v;
  perform _expect('explicit channel kept on edit', (select marketing_channel from expenses where id = v), 'influencers');
end $$;

-- ---- bank rules land marketing charges in the right channel ----
do $$
declare t uuid; e uuid;
begin
  insert into bank_items (id, plaid_item_id, access_token) values ('00000000-0000-0000-0000-0000000000a8', 'mk-item', 'x');
  insert into bank_accounts (id, item_id, plaid_account_id, name, mask) values ('00000000-0000-0000-0000-0000000000b8', '00000000-0000-0000-0000-0000000000a8', 'mk-acct', 't', '0');
  insert into bank_transactions (account_id, plaid_transaction_id, posted_on, name, amount) values
    ('00000000-0000-0000-0000-0000000000b8', 'mk-print', '2026-11-04', 'FEDEX OFFICE 1234 DALLAS TX', 48.5),
    ('00000000-0000-0000-0000-0000000000b8', 'mk-ship',  '2026-11-04', 'FEDEX 7741 SHIPPING', 22),
    ('00000000-0000-0000-0000-0000000000b8', 'mk-meta',  '2026-11-04', 'FACEBK *ADS 123', 15);
  perform apply_bank_transaction(id) from bank_transactions where plaid_transaction_id like 'mk-%';
  perform _expect('FedEx Office charge is print marketing', (select e.marketing_channel from bank_transactions b join expenses e on e.id = b.expense_id where b.plaid_transaction_id = 'mk-print'), 'flyers_print');
  perform _expect('FedEx shipping is NOT marketing', coalesce((select e.marketing_channel from bank_transactions b join expenses e on e.id = b.expense_id where b.plaid_transaction_id = 'mk-ship'), 'none'), 'none');
  perform _expect('Facebook charge is social media', (select e.marketing_channel from bank_transactions b join expenses e on e.id = b.expense_id where b.plaid_transaction_id = 'mk-meta'), 'social');
end $$;

rollback;
select 'ALL MARKETING TESTS PASSED' as result;
