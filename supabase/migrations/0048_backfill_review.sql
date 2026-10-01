-- 0048: bank imports made before the review flag existed that still have no category go to the Review inbox.
update expenses set review_status = 'needs_review'
 where deleted_at is null and auto_source = 'bank' and category_id is null and review_status = 'ok';
