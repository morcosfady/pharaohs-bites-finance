-- ============================================================================
-- 0059_personal_part.sql : a purchase can carry a PERSONAL part.
--
-- A grocery run with the owner's own ice cream in the basket: the bank charge is $99.48, but only $94.69 is the
-- business's. The expense now shows ONLY the business money (total_amount), and `personal_amount` remembers
-- the rest, so:
--   * every total (Expenses, profit box, budgets, Telegram, tax pack) excludes it automatically
--   * the bank charge still matches (matching compares business + personal with the charge)
--   * flipping an item between business and personal later (receipt detail) updates the expense by itself
-- The receipt's sales tax is spread over its items, so a personal item takes its own share of the tax.
-- ============================================================================

alter table expenses add column if not exists personal_amount numeric(12,2) not null default 0 check (personal_amount >= 0);

drop function if exists write_receipt_items(uuid, uuid, jsonb, int);

create or replace function write_receipt_items(p_expense uuid, p_source uuid, p_items jsonb, p_sign int default 1, p_tax numeric default 0)
returns numeric language plpgsql security definer set search_path = public as $$
declare it jsonb; v_cat uuid; v_biz boolean; v_name text; v_total numeric; v_sum numeric := 0; v_mem item_category_memory%rowtype; v_personal uuid; v_isum numeric := 0; v_tax_i numeric := 0;
begin
  select id into v_personal from expense_categories where name = 'Personal (not business)';
  select coalesce(sum(abs(coalesce(nullif(x->>'total', '')::numeric, coalesce(nullif(x->>'qty', '')::numeric, 1) * coalesce(nullif(x->>'unit_price', '')::numeric, 0)))), 0)
    into v_isum from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;
  delete from expense_items where source_id = p_source;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_name := left(coalesce(it->>'name', ''), 200);
    v_total := p_sign * abs(coalesce(nullif(it->>'total', '')::numeric, coalesce(nullif(it->>'qty', '')::numeric, 1) * coalesce(nullif(it->>'unit_price', '')::numeric, 0)));
    continue when v_total = 0;
    v_cat := null; v_biz := true;
    select * into v_mem from item_category_memory where item_key = item_key(v_name);
    if found then v_cat := v_mem.category_id; v_biz := v_mem.is_business;
    else
      select id into v_cat from expense_categories where lower(name) = lower(coalesce(it->>'category', ''));
      if coalesce((it->>'personal')::boolean, false) then v_cat := v_personal; v_biz := false; end if;
    end if;
    if v_cat = v_personal then v_biz := false; end if;
    -- the receipt's sales tax is spread over its items in proportion to their price
    v_tax_i := case when p_sign = 1 and v_isum > 0 and coalesce(p_tax, 0) > 0 then round(p_tax * abs(v_total) / v_isum, 2) else 0 end;
    insert into expense_items (expense_id, source_id, description, quantity, unit_price, line_total, tax_amount, category_id, is_business)
    values (p_expense, p_source, v_name, coalesce(nullif(it->>'qty', '')::numeric, 1), coalesce(nullif(it->>'unit_price', '')::numeric, 0),
            v_total, v_tax_i, v_cat, v_biz);
    v_sum := v_sum + v_total;
  end loop;
  return v_sum;
end $$;

create or replace function find_expense_match(
  p_vendor text, p_amount numeric, p_date date, p_source_type text, p_exclude uuid default null
) returns table (expense_id uuid, score int, vendor_match boolean)
language plpgsql stable security definer set search_path = public as $$
declare s expense_settings%rowtype; v_norm text := normalize_vendor(p_vendor);
begin
  select * into s from expense_settings limit 1;
  return query
  select e.id,
         (40
          + case when v_norm <> '' and normalize_vendor(e.vendor) = v_norm then 40 else 0 end
          + (20 * (1 - abs(e.expense_date - p_date)::numeric / greatest(s.match_window_days, 1)))::int
         ) as sc,
         (v_norm <> '' and normalize_vendor(e.vendor) = v_norm)
    from expenses e
   where e.deleted_at is null
     and e.auto_source is distinct from 'order_cost'
     and e.id is distinct from p_exclude
     and abs(e.total_amount + e.personal_amount - abs(p_amount)) <= s.amount_tolerance
     and abs(e.expense_date - p_date) <= s.match_window_days
     and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = p_source_type)
   order by sc desc, abs(e.expense_date - p_date), e.created_at
   limit 5;
end $$;

create or replace function apply_parsed_receipt(p_file_id uuid, p_parsed jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f receipt_files%rowtype; s expense_settings%rowtype;
  v_type text; v_ref text;
  v_vendor text := trim(coalesce(p_parsed->>'vendor', ''));
  v_norm text; v_date date; v_total numeric; v_tax numeric; v_pm text;
  v_refund boolean := coalesce((p_parsed->>'is_refund')::boolean, false) or coalesce((p_parsed->>'total')::numeric, 0) < 0;
  v_items jsonb := coalesce(p_parsed->'items', '[]'::jsonb);
  v_isum numeric := 0; v_ok boolean := true; v_exp uuid; v_outcome text; v_match record; v_src uuid;
  v_cat uuid; v_ctype cost_type; v_review text := 'ok'; v_dup uuid; v_before numeric; v_tx numeric; v_rem numeric; v_main uuid; v_existing uuid;
begin
  select * into f from receipt_files where id = p_file_id;
  if not found then return jsonb_build_object('outcome', 'failed', 'error', 'unknown receipt file'); end if;
  select * into s from expense_settings limit 1;

  v_type := case when f.source = 'email' then 'email' else 'receipt' end;
  v_ref  := case when f.source = 'email' then coalesce(f.email_message_id, f.sha256) else f.sha256 end;
  v_norm := normalize_vendor(v_vendor);
  begin v_date := nullif(p_parsed->>'date', '')::date; exception when others then v_date := null; end;
  v_date := coalesce(v_date, (f.created_at at time zone 'America/Chicago')::date);
  v_total := abs(coalesce(nullif(p_parsed->>'total', '')::numeric, 0));
  v_tax := greatest(coalesce(nullif(p_parsed->>'tax', '')::numeric, 0), 0);
  v_pm := lower(coalesce(p_parsed->>'payment_method', ''));

  if v_total <= 0 then
    update receipt_files set status = 'failed', error = 'Could not read a total from this receipt. Open it and enter the expense by hand.', parsed = p_parsed where id = f.id;
    return jsonb_build_object('outcome', 'failed');
  end if;

  select coalesce(sum(abs(coalesce(nullif(x->>'total', '')::numeric, coalesce(nullif(x->>'qty', '')::numeric, 1) * coalesce(nullif(x->>'unit_price', '')::numeric, 0)))), 0)
    into v_isum from jsonb_array_elements(v_items) x;
  v_ok := jsonb_array_length(v_items) = 0 or abs(v_isum + v_tax - v_total) <= 0.05 or abs(v_isum - v_total) <= 0.05;

  -- ---- evidence we already processed (re-read, retry): reuse its expense, never match again ----
  select expense_id into v_existing from expense_sources where source_type = v_type and source_ref = v_ref and expense_id is not null;

  -- ---- a refund: reduce the ORIGINAL purchase, never income ----
  if v_refund and v_existing is not null then
    update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_existing, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
    return jsonb_build_object('outcome', 'refund', 'expense_id', v_existing);
  end if;
  if v_refund then
    v_exp := find_refund_counterpart(v_norm, v_total, array['bank']);
    if v_exp is not null then
      -- the bank already took this refund off the purchase: just record the receipt as evidence
      v_src := link_source(v_type, v_ref, v_exp, -v_total, v_date, p_parsed);
      update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
      return jsonb_build_object('outcome', 'refund', 'expense_id', v_exp);
    end if;
    select e.id into v_exp from expenses e
     where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and v_norm <> '' and normalize_vendor(e.vendor) = v_norm
       and e.total_amount >= v_total - s.amount_tolerance and e.expense_date <= v_date and v_date - e.expense_date <= 180
     order by e.expense_date desc, e.created_at desc limit 1;
    if v_exp is null then
      update receipt_files set status = 'failed', error = 'This is a refund but the original purchase was not found. Add the purchase first, then upload the refund again.', parsed = p_parsed where id = f.id;
      return jsonb_build_object('outcome', 'failed');
    end if;
    v_src := link_source(v_type, v_ref, v_exp, -v_total, v_date, p_parsed);
    select amount_before_tax, sales_tax_paid into v_before, v_tx from expenses where id = v_exp;
    v_rem := v_total - least(v_before, v_total);
    update expenses set amount_before_tax = greatest(v_before - v_total, 0), sales_tax_paid = greatest(v_tx - v_rem, 0) where id = v_exp;
    if exists (select 1 from expense_items where expense_id = v_exp) then
      select category_id into v_main from expense_items where expense_id = v_exp and is_business order by line_total desc limit 1;
      delete from expense_items where source_id = v_src;
      insert into expense_items (expense_id, source_id, description, line_total, category_id) values (v_exp, v_src, 'Refund', -v_total, v_main);
    end if;
    update receipt_files set status = 'parsed', outcome = 'refund', expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok, error = '' where id = f.id;
    return jsonb_build_object('outcome', 'refund', 'expense_id', v_exp);
  end if;

  -- ---- attach to an expense we already have (bank charge first, subscription, earlier receipt...) ----
  if v_existing is not null then
    v_exp := v_existing; v_outcome := coalesce(nullif(f.outcome, ''), 'linked');
  else
    select * into v_match from find_expense_match(v_vendor, v_total, v_date, v_type) limit 1;
  end if;
  if v_exp is not null then null;
  elsif v_match.expense_id is not null and v_match.vendor_match then
    v_exp := v_match.expense_id; v_outcome := 'linked';
  elsif v_norm <> '' then
    -- one bank charge, several receipts / emails (many-to-one)
    select e.id into v_exp from expenses e
     where e.deleted_at is null and e.auto_source is distinct from 'order_cost' and normalize_vendor(e.vendor) = v_norm
       and e.total_amount > v_total + s.amount_tolerance
       and abs(e.expense_date - v_date) <= s.match_window_days * 3
       and exists (select 1 from expense_sources b where b.expense_id = e.id and b.source_type = 'bank')
       and (select coalesce(sum(x.amount), 0) from expense_sources x where x.expense_id = e.id and x.source_type in ('receipt', 'email')) + v_total <= e.total_amount + s.amount_tolerance
       and not exists (select 1 from expense_sources x where x.expense_id = e.id and x.source_type = v_type and x.source_ref = v_ref)
     order by abs(e.expense_date - v_date), e.created_at limit 1;
    if v_exp is not null then v_outcome := 'partial'; end if;
  end if;

  if v_exp is null then
    if v_match.expense_id is not null then v_review := 'possible_duplicate'; v_dup := v_match.expense_id; end if;
    -- category of the new expense = the business category with the most money in it
    select i.cat into v_cat from (
      select coalesce(c.id, (select id from expense_categories where name = 'Other')) as cat, sum(abs(coalesce(nullif(x->>'total', '')::numeric, 0))) as amt
        from jsonb_array_elements(v_items) x
        left join expense_categories c on lower(c.name) = lower(coalesce(x->>'category', ''))
       where not coalesce((x->>'personal')::boolean, false) group by 1 order by 2 desc limit 1) i;
    v_cat := coalesce(v_cat, (select id from expense_categories where name = 'Other'));
    select cost_type into v_ctype from expense_categories where id = v_cat;
    insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid, payment_method, cost_type, notes, auto_source, review_status, duplicate_of)
    values (v_date, coalesce(nullif(v_vendor, ''), 'Unknown store'), v_cat, left('Receipt: ' || coalesce(nullif(f.original_name, ''), nullif(f.email_subject, ''), v_vendor), 200),
            greatest(v_total - v_tax, 0), v_tax,
            case when v_pm in ('cash', 'card', 'zelle', 'venmo') then v_pm::payment_method else null end,
            coalesce(v_ctype, 'operating'),
            case when v_pm = 'cash' then 'Paid cash (receipt only).' else 'From a receipt. The bank charge will attach to this when it arrives.' end,
            v_type, v_review, v_dup)
    returning id into v_exp;
    v_outcome := case when v_review = 'possible_duplicate' then 'possible_duplicate' else 'created' end;
  end if;

  v_src := link_source(v_type, v_ref, v_exp, v_total, v_date, p_parsed);
  perform write_receipt_items(v_exp, v_src, v_items, 1, v_tax);
  update expenses set receipt_path = f.storage_path where id = v_exp and receipt_path = '' and f.storage_path <> '';
  update receipt_files set status = 'parsed', outcome = v_outcome, expense_id = v_exp, parsed = p_parsed, totals_ok = v_ok,
         error = case when v_ok then '' else 'The items do not add up to the total. Check the items.' end where id = f.id;
  return jsonb_build_object('outcome', v_outcome, 'expense_id', v_exp, 'totals_ok', v_ok);
end $$;

create or replace function apply_bank_transaction(p_txn_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t bank_transactions%rowtype; r bank_rules%rowtype; e expenses%rowtype; s expense_settings%rowtype;
  v_vendor text; v_cat uuid; v_cost_type cost_type; v_expense_id uuid; v_kind text; v_match record;
  v_review text := 'ok'; v_dup uuid; v_norm text; v_refund uuid; v_before numeric; v_tx numeric; v_rem numeric; v_amt numeric; v_main uuid; v_src uuid; v_skip_reduce boolean := false; v_search text;
begin
  select * into t from bank_transactions where id = p_txn_id;
  if not found then return null; end if;
  select * into s from expense_settings limit 1;

  select * into r from bank_rules
   where position(lower(match_text) in lower(t.name || ' ' || t.merchant_name)) > 0
     and (direction = 'any' or (direction = 'out' and t.amount > 0) or (direction = 'in' and t.amount < 0))
   order by sort_order, created_at limit 1;

  -- a refund already applied: nothing more to do (re-syncs must not reduce the purchase twice)
  if t.amount < 0 then
    select expense_id into v_refund from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id and amount < 0 and expense_id is not null;
    if v_refund is not null then
      update bank_transactions set kind = 'refund', expense_id = v_refund where id = t.id and (kind <> 'refund' or expense_id is distinct from v_refund);
      return v_refund;
    end if;
  end if;

  -- 1. what is this transaction?
  if t.ignored or not exists (select 1 from bank_accounts a where a.id = t.account_id and a.is_tracked) then v_kind := 'ignored';
  elsif t.pending then v_kind := 'pending';
  elsif r.id is not null and r.action <> 'expense' and (t.amount > 0 or r.sort_order < 900) then v_kind := r.action;
  elsif t.amount <= 0 then v_kind := 'money_in';
  else v_kind := 'expense'; end if;

  -- money in from a store we bought from = a REFUND of that purchase (unless a specific rule says otherwise)
  if t.amount < 0 and v_kind in ('money_in', 'owner_contribution') and (r.id is null or r.sort_order >= 900 or r.action = 'expense') then
    v_norm := normalize_vendor(coalesce(nullif(t.merchant_name, ''), t.name));
    if v_norm <> '' then
      v_refund := find_refund_counterpart(v_norm, abs(t.amount), array['email', 'receipt']);
      if v_refund is not null then v_skip_reduce := true;   -- a refund email already took it off
      else
        select e2.id into v_refund from expenses e2
         where e2.deleted_at is null and e2.auto_source is distinct from 'order_cost' and normalize_vendor(e2.vendor) = v_norm
           and e2.total_amount >= abs(t.amount) - s.amount_tolerance and e2.expense_date <= t.posted_on and t.posted_on - e2.expense_date <= 180
         order by e2.expense_date desc, e2.created_at desc limit 1;
      end if;
      if v_refund is not null then v_kind := 'refund'; end if;
    end if;
  end if;

  -- no purchase to refund: the catch-all deposit rule (owner money) applies
  if v_kind = 'money_in' and v_refund is null and r.id is not null and r.action <> 'expense' then v_kind := r.action; end if;

  update bank_transactions set kind = v_kind, rule_id = r.id where id = t.id and (kind is distinct from v_kind or rule_id is distinct from r.id);

  if v_kind = 'refund' then
    v_amt := abs(t.amount);
    v_src := link_source('bank', t.plaid_transaction_id, v_refund, t.amount, t.posted_on);
    if not v_skip_reduce then
    select amount_before_tax, sales_tax_paid into v_before, v_tx from expenses where id = v_refund;
    v_rem := v_amt - least(v_before, v_amt);
    update expenses set amount_before_tax = greatest(v_before - v_amt, 0), sales_tax_paid = greatest(v_tx - v_rem, 0) where id = v_refund;
    end if;
    if not v_skip_reduce and exists (select 1 from expense_items where expense_id = v_refund) then
      select category_id into v_main from expense_items where expense_id = v_refund and is_business order by line_total desc limit 1;
      delete from expense_items where source_id = v_src;
      insert into expense_items (expense_id, source_id, description, line_total, category_id) values (v_refund, v_src, 'Refund', -v_amt, v_main);
    end if;
    update bank_transactions set expense_id = v_refund where id = t.id;
    return v_refund;
  end if;

  -- 2. not a business cost
  if v_kind <> 'expense' then
    if t.expense_id is not null then
      select * into e from expenses where id = t.expense_id;
      if e.auto_source = 'bank' then update expenses set deleted_at = now() where id = e.id and deleted_at is null;
      else update expenses set bank_transaction_id = null where id = e.id; end if;
      delete from expense_sources where source_type = 'bank' and source_ref = t.plaid_transaction_id;
      update bank_transactions set expense_id = null where id = t.id;
    end if;
    return null;
  end if;

  v_vendor := coalesce(nullif(r.vendor, ''), nullif(t.merchant_name, ''), t.name);
  v_cat := r.category_id;
  v_cost_type := coalesce(r.cost_type, 'operating');
  v_search := case when position(lower(v_vendor) in lower(t.name)) > 0 then t.name else v_vendor || ' ' || t.name end;

  -- 3a. already linked: refresh amount/date for rows the bank sync owns (refunds already taken off stay off)
  if t.expense_id is not null then
    select * into e from expenses where id = t.expense_id;
    if e.auto_source = 'bank' then
      update expenses
         set expense_date = t.posted_on, vendor = v_vendor, description = t.name,
             amount_before_tax = greatest(t.amount + coalesce((select sum(x.amount) from expense_sources x where x.expense_id = e.id and x.source_type = 'bank' and x.amount < 0), 0) - e.personal_amount - e.sales_tax_paid, 0),
             category_id = coalesce(v_cat, category_id),
             cost_type = case when v_cat is not null then v_cost_type else cost_type end, deleted_at = null
       where id = e.id;
    end if;
    perform link_source('bank', t.plaid_transaction_id, t.expense_id, t.amount, t.posted_on);
    return t.expense_id;
  end if;

  -- 3b. attach to an expense we already have
  select * into v_match from find_expense_match(v_search, t.amount, t.posted_on, 'bank') limit 1;
  if v_match.expense_id is not null and v_match.vendor_match then
    update expenses set bank_transaction_id = coalesce(bank_transaction_id, t.id) where id = v_match.expense_id;
    update bank_transactions set expense_id = v_match.expense_id where id = t.id;
    perform link_source('bank', t.plaid_transaction_id, v_match.expense_id, t.amount, t.posted_on);
    return v_match.expense_id;
  end if;

  -- 3b'. one order email / receipt, several smaller card charges (split shipments)
  v_norm := normalize_vendor(v_search);
  if v_norm <> '' then
    select e2.id into v_expense_id from expenses e2
     where e2.deleted_at is null and e2.auto_source is distinct from 'order_cost' and normalize_vendor(e2.vendor) = v_norm
       and e2.total_amount > t.amount + s.amount_tolerance
       and abs(e2.expense_date - t.posted_on) <= s.match_window_days * 3
       and exists (select 1 from expense_sources d where d.expense_id = e2.id and d.source_type in ('email', 'receipt'))
       and (select coalesce(sum(b.amount), 0) from expense_sources b where b.expense_id = e2.id and b.source_type = 'bank') + t.amount <= e2.total_amount + s.amount_tolerance
     order by abs(e2.expense_date - t.posted_on), e2.created_at limit 1;
    if v_expense_id is not null then
      update expenses set bank_transaction_id = coalesce(bank_transaction_id, t.id) where id = v_expense_id;
      update bank_transactions set expense_id = v_expense_id where id = t.id;
      perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
      return v_expense_id;
    end if;
  end if;

  if v_match.expense_id is not null then v_review := 'possible_duplicate'; v_dup := v_match.expense_id; end if;

  -- 3c. a genuinely new expense
  if v_review = 'ok' and v_cat is null then v_review := 'needs_review'; end if;
  insert into expenses (expense_date, vendor, category_id, description, amount_before_tax, sales_tax_paid,
                        cost_type, notes, auto_source, bank_transaction_id, review_status, duplicate_of)
  values (t.posted_on, v_vendor, v_cat, t.name, t.amount, 0, v_cost_type,
          'Imported from the bank feed.', 'bank', t.id, v_review, v_dup)
  returning id into v_expense_id;
  update bank_transactions set expense_id = v_expense_id where id = t.id;
  perform link_source('bank', t.plaid_transaction_id, v_expense_id, t.amount, t.posted_on);
  return v_expense_id;
end $$;

create or replace function expense_integrity()
returns jsonb language sql stable security definer set search_path = public as $$
  with bank as (
    select e.id, e.total_amount + e.personal_amount as total_amount, coalesce(sum(s.amount), 0) as bank_sum, count(s.id) as n
      from expenses e join expense_sources s on s.expense_id = e.id and s.source_type = 'bank'
     where e.deleted_at is null group by e.id, e.total_amount, e.personal_amount)
  select jsonb_build_object(
    'possible_duplicates', (select count(*) from expenses where deleted_at is null and review_status = 'possible_duplicate'),
    'needs_review',        (select count(*) from expenses where deleted_at is null and review_status = 'needs_review'),
    'expenses_without_source', (select count(*) from expenses e where e.deleted_at is null and e.auto_source is distinct from 'order_cost'
                                  and not exists (select 1 from expense_sources s where s.expense_id = e.id)),
    -- more money charged than the expense says = a mismatch; less = a split order still waiting for its other charges
    'bank_amount_mismatch', (select count(*) from bank where bank_sum > total_amount + (select amount_tolerance from expense_settings limit 1)
                               + coalesce((select abs(sum(x.amount)) from expense_sources x where x.expense_id = bank.id and x.source_type in ('email', 'receipt') and x.amount < 0), 0)),
    'partial_bank_coverage',(select count(*) from bank where n > 0 and bank_sum < total_amount - (select amount_tolerance from expense_settings limit 1)
                               and exists (select 1 from expense_sources d where d.expense_id = bank.id and d.source_type in ('email', 'receipt'))),
    'money_in_unclassified', (select count(*) from bank_transactions where kind = 'money_in'),
    'duplicate_bank_links', (select count(*) from (select bank_transaction_id from expenses where deleted_at is null and bank_transaction_id is not null
                              group by 1 having count(*) > 1) x),
    'receipts_unmatched_7d', (select count(*) from expenses e where e.deleted_at is null and e.created_at < now() - interval '7 days'
                                and e.auto_source in ('receipt', 'email') and e.payment_method is distinct from 'cash'
                                and not exists (select 1 from expense_sources s where s.expense_id = e.id and s.source_type = 'bank')),
    'receipts_failed', (select count(*) from receipt_files where status = 'failed'),
    'items_not_adding_up', (select count(*) from receipt_files where status = 'parsed' and totals_ok is false)
  )
$$;

create or replace view expense_tax_view with (security_invoker = true) as
with s as (select * from expense_settings limit 1),
     m as (select * from mileage_settings limit 1),
     item_lines as (
       select i.expense_id,
              case when i.is_business then coalesce(i.category_id, e.category_id)
                   else (select id from expense_categories where name = 'Personal (not business)') end as category_id,
              sum(i.line_total + i.tax_amount) as amount
         from expense_items i join expenses e on e.id = i.expense_id
        where e.deleted_at is null and i.is_business
        group by 1, 2),
     lines as (
       select e.id as expense_id, e.category_id, e.total_amount as amount
         from expenses e where e.deleted_at is null and not exists (select 1 from expense_items i where i.expense_id = e.id)
       union all
       select expense_id, category_id, amount from item_lines
       union all
       select e.id, e.category_id, e.total_amount - il.tot
         from expenses e
         join (select expense_id, sum(amount) as tot from item_lines group by 1) il on il.expense_id = e.id
        where e.deleted_at is null and abs(e.total_amount - il.tot) > 0.01),
     numbered as (
       select l.*, row_number() over (partition by l.expense_id order by l.amount desc, l.category_id nulls last) as line_no from lines l)
select
  e.id as expense_id, e.expense_date, e.vendor, e.description, n.category_id,
  coalesce(c.name, 'Uncategorized') as category_name,
  n.amount::numeric(12,2) as total_amount, e.business_pct, e.receipt_path, e.review_status, e.auto_source,
  (e.expense_date < s.business_start_date) as is_startup,
  case
    when e.expense_date < s.business_start_date then 'startup'
    when c.id is null then 'uncategorized'
    else coalesce(c.schedule_c_line, 'l27a_other')
  end as line_key,
  coalesce(c.treatment, 'deductible') as treatment,
  (c.name = 'Gas / mileage' and m.method = 'standard') as gas_excluded,
  (n.amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date) as asset_candidate,
  case
    when coalesce(c.treatment, 'deductible') = 'excluded' then 0
    when c.name = 'Gas / mileage' and m.method = 'standard' then 0
    else round(n.amount * e.business_pct / 100, 2)
  end as deductible_amount,
  nullif(concat_ws(' ',
    case when e.ask_accountant then coalesce(nullif(e.ask_note, ''), 'Owner flagged this.') end,
    case when c.always_ask then c.ask_note end,
    case when c.id is null then 'No category yet.' end,
    case when c.name = 'Gas / mileage' and m.method = 'standard' then 'Gas excluded because standard mileage is selected.' end,
    case when n.amount >= s.asset_threshold and coalesce(c.treatment, 'deductible') = 'deductible' and e.expense_date >= s.business_start_date
         then 'Possible asset over ' || s.asset_threshold::text || ': depreciate or expense?' end,
    case when e.expense_date < s.business_start_date then 'Before the business start date: startup cost (election and limit to confirm).' end,
    case when e.business_pct < 100 then 'Business use ' || e.business_pct::text || '%.' end
  ), '') as ask_reason,
  n.line_no
from numbered n
join expenses e on e.id = n.expense_id
cross join s cross join m
left join expense_categories c on c.id = n.category_id
where e.deleted_at is null and e.auto_source is distinct from 'order_cost';


-- keeps expenses.personal_amount and the business total in step with the items
create or replace function refresh_personal_amount(p_expense uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_pers numeric; v_full numeric;
begin
  select coalesce(sum(line_total + tax_amount), 0) into v_pers from expense_items where expense_id = p_expense and not is_business;
  select total_amount + personal_amount into v_full from expenses where id = p_expense and deleted_at is null;
  if v_full is null then return; end if;
  update expenses
     set personal_amount = least(v_pers, v_full),
         amount_before_tax = greatest(v_full - least(v_pers, v_full) - sales_tax_paid, 0)
   where id = p_expense and (personal_amount is distinct from least(v_pers, v_full));
end $$;
revoke all on function refresh_personal_amount(uuid) from public, anon, authenticated;

create or replace function expense_items_personal_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then perform refresh_personal_amount(new.expense_id); end if;
  if tg_op = 'DELETE' then perform refresh_personal_amount(old.expense_id); end if;
  if tg_op = 'UPDATE' and old.expense_id is distinct from new.expense_id then perform refresh_personal_amount(old.expense_id); end if;
  return coalesce(new, old);
end $$;
drop trigger if exists expense_items_personal on expense_items;
create trigger expense_items_personal after insert or update of is_business, line_total, tax_amount, expense_id or delete on expense_items
  for each row execute function expense_items_personal_trigger();

-- expenses already on the books: apply the rule once
do $$ declare r record; begin
  for r in select distinct expense_id from expense_items where not is_business loop perform refresh_personal_amount(r.expense_id); end loop;
end $$;
