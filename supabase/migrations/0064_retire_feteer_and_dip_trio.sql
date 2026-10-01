-- 0064: Feteer + Dip Trio is retired (too close to Egyptian Breakfast). Made inactive, not deleted, so old orders keep their history.
update products set is_active = false where slug = 'feteer-and-dip-trio';
