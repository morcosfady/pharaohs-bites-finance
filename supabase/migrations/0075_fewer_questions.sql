-- Fewer questions: obvious duplicates merge themselves, and unexplained deposits are not asked about.
-- 1. same amount + same days + names that share a word (Nextdoor / Nextdoor Ads, Zelle payment to Bk Promos / BK Promos) = same purchase.
--    Only a match with NO shared word is still asked.
create or replace function vendors_alike(p_a text, p_b text) returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from unnest(string_to_array(normalize_vendor(p_a), ' ')) x
     where length(x) >= 3 and x not in ('zelle','ach','ppd','transfer','online','payment','from','and','ads')
       and x = any(string_to_array(normalize_vendor(p_b), ' ')))
$$;

-- 2. a deposit with no rule is simply 'deposit': not a sale, not an expense, no question
alter table bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table bank_transactions add constraint bank_transactions_kind_check
  check (kind in ('unclassified','expense','transfer','owner_contribution','personal','payout','money_in','pending','ignored','refund','deposit'));

create or replace function merge_expenses_core(p_keep uuid, p_drop uuid)
returns void language plpgsql security definer set search_path = public as $$
declare k expenses%rowtype; d expenses%rowtype;
begin
  if p_keep = p_drop then raise exception 'cannot merge an expense into itself'; end if;
  select * into k from expenses where id = p_keep and deleted_at is null;
  select * into d from expenses where id = p_drop and deleted_at is null;
  if k.id is null or d.id is null then raise exception 'expense not found'; end if;

  -- the bank transaction wins if only the dropped row had one
  if d.bank_transaction_id is not null and k.bank_transaction_id is null then
    update expenses set bank_transaction_id = d.bank_transaction_id where id = k.id;
  end if;
  update bank_transactions set expense_id = k.id where expense_id = d.id;
  update expense_sources set merged_from = d.id, expense_id = k.id where expense_id = d.id;
  update expense_items set expense_id = k.id where expense_id = d.id;
  if k.receipt_path = '' and d.receipt_path <> '' then update expenses set receipt_path = d.receipt_path where id = k.id; end if;
  update expenses set deleted_at = now(), merged_into = k.id, bank_transaction_id = null, review_status = 'ok' where id = d.id;
  update expenses set review_status = 'ok', duplicate_of = null where id = k.id;
end $$;
revoke all on function merge_expenses_core(uuid, uuid) from public, anon, authenticated;
create or replace function merge_expenses(p_keep uuid, p_drop uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not authorised'; end if;
  perform merge_expenses_core(p_keep, p_drop);
end $$;
grant execute on function merge_expenses(uuid, uuid) to authenticated;

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

  -- a deposit nobody has a rule for is just money in the bank: never a sale, never an expense, nothing to ask
  if v_kind = 'money_in' and v_refund is null then v_kind := 'deposit'; end if;

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
  if v_match.expense_id is not null and (v_match.vendor_match or vendors_alike(v_search, (select e3.vendor from expenses e3 where e3.id = v_match.expense_id))) then
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
  elsif v_match.expense_id is not null and (v_match.vendor_match or vendors_alike(v_vendor, (select e3.vendor from expenses e3 where e3.id = v_match.expense_id))) then
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

-- 3. clean up what is already waiting
update bank_transactions set kind = 'deposit' where kind = 'money_in';
do $$
declare d record;
begin
  for d in select e.id, e.duplicate_of from expenses e join expenses k on k.id = e.duplicate_of
            where e.deleted_at is null and k.deleted_at is null and e.review_status = 'possible_duplicate'
              and vendors_alike(e.vendor || ' ' || e.description, k.vendor) loop
    perform merge_expenses_core(d.duplicate_of, d.id);
  end loop;
end $$;
