-- 0061: the receipt's sales tax is spread over its items and each share is rounded to the cent, so many items could
-- leave the shares 1 cent off the receipt's tax (Walmart #2000152: 27 items, 4.12 instead of 4.13), and the
-- category totals then differed from the expense total. Put the rounding difference on the largest item.
create or replace function write_receipt_items_fix_rounding(p_expense uuid, p_source uuid, p_tax numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_diff numeric; v_id uuid;
begin
  if coalesce(p_tax, 0) <= 0 then return; end if;
  select p_tax - coalesce(sum(tax_amount), 0) into v_diff from expense_items where source_id = p_source;
  if v_diff = 0 or abs(v_diff) > 0.5 then return; end if;
  select id into v_id from expense_items where source_id = p_source order by line_total desc, id limit 1;
  if v_id is not null then update expense_items set tax_amount = tax_amount + v_diff where id = v_id; end if;
end $$;

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
    v_tax_i := case when p_sign = 1 and v_isum > 0 and coalesce(p_tax, 0) > 0 then round(p_tax * abs(v_total) / v_isum, 2) else 0 end;
    insert into expense_items (expense_id, source_id, description, quantity, unit_price, line_total, tax_amount, category_id, is_business)
    values (p_expense, p_source, v_name, coalesce(nullif(it->>'qty', '')::numeric, 1), coalesce(nullif(it->>'unit_price', '')::numeric, 0),
            v_total, v_tax_i, v_cat, v_biz);
    v_sum := v_sum + v_total;
  end loop;
  if p_sign = 1 then perform write_receipt_items_fix_rounding(p_expense, p_source, p_tax); end if;
  return v_sum;
end $$;

-- repair the receipts already entered (idempotent): one receipt per expense with items
do $$ declare r record; begin
  for r in select i.expense_id as eid, min(i.source_id::text)::uuid as sid, max((rf.parsed->>'tax')::numeric) as tax
             from expense_items i join receipt_files rf on rf.expense_id = i.expense_id
            where i.source_id is not null group by i.expense_id
           having count(distinct i.source_id) = 1 and count(distinct rf.id) = 1 loop
    perform write_receipt_items_fix_rounding(r.eid, r.sid, r.tax);
  end loop;
end $$;
