-- 0060: a receipt can have more than one picture (a long receipt photographed in two parts, an order page plus the
-- confirmation). storage_path stays the main picture; extra_paths holds the others, all in the private "receipts" bucket.
alter table receipt_files add column if not exists extra_paths text[] not null default '{}';
