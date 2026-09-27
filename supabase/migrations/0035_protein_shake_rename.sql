-- ============================================================================
-- 0035_protein_shake_rename.sql : rename + protein count + real photo, 2026-09-27
-- Mirrors assets/js/data.js on the customer website. Price unchanged ($12).
-- Renamed from "House Special Protein Shake" to "Special Chocolate Protein
-- Shake" and the protein amount corrected from 25g to 22g.
-- ============================================================================

update products set
  name = 'Special Chocolate Protein Shake',
  name_ar = 'مشروب البروتين بالشوكولاتة',
  description = 'A rich, creamy chocolate 22g protein shake blended smooth and served chilled.',
  image_url = 'https://morcosfady.github.io/pharaohs-bites/assets/img/menu-real/protein-shake.webp'
where slug = 'protein-shake';
