-- Promo codes are also once per delivery address (street + unit + ZIP, normalised).
alter table promo_redemptions add column if not exists address_norm text not null default '';
create unique index if not exists promo_used_address_uniq on promo_redemptions(code, address_norm) where used_at is not null and address_norm <> '';
