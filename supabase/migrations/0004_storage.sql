-- ============================================================================
-- 0004_storage.sql : private bucket for expense receipts
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy receipts_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and is_admin());
create policy receipts_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and is_admin());
create policy receipts_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'receipts' and is_admin());
create policy receipts_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and is_admin());
