-- ============================================================================
-- 0019_kofta_tray_photo_desc.sql : real photo + rewritten copy, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($40).
-- ============================================================================

update products set
  description = 'Seasoned plant-based kofta baked in a rich Egyptian tomato salsa and served in a half-size foil tray, with a separate tray of Egyptian rice with toasted vermicelli.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/kofta-tray.webp'
where slug = 'kofta-tray';
