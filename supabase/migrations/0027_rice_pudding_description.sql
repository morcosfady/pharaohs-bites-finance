-- ============================================================================
-- 0027_rice_pudding_description.sql : owner sent a better photo/description, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($7).
-- The image_url is unchanged (same filename, new file); only the wording
-- changed to mention the optional mixed nuts topping shown in the new photo.
-- ============================================================================

update products set
  description = 'Creamy Egyptian rice pudding topped with mixed nuts (optional), served chilled in a small dessert cup.'
where slug = 'rice-pudding';
