-- Removes the temporary 1-cent test item (0041) and the test data (2026-09-30).
update products set is_active = false, deleted_at = now() where slug = 'test-item';
