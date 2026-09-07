-- 019_extraction_provenance.sql
-- Wire up the provenance tables that were built and never written to.
-- Spec: provenance.md PR-3, PR-4, PR-5, PR-6 · bills-and-expenses.md §4.8
--
-- `source_documents` and `extracted_fields` have existed since 009. Nothing in
-- the TypeScript has ever touched either of them — a seventh dead control, and
-- the one that matters most for review, because `extracted_fields` is exactly
-- the highlight-on-the-bill mechanism a CA needs in order to trust a figure
-- they did not type.
--
-- I made this worse by asserting the capability existed. Two commit messages
-- and a design note claimed the coordinate reader could "name the exact region
-- a figure came from (PR-7)" — while `wordColumns` computed the column bands
-- and threw them away. That claim is what this migration makes true.
--
-- Three changes are needed before it can be written to.
--
-- 1. NEITHER READER HAS A METHOD NAME.
--
--    `extraction_method` offers llamaparse, ocr_vlm, irp_fetch, manual and
--    derived. Our figures come from a PDF's own text-layer coordinates, or
--    from a language model reading extracted TEXT — which is not `ocr_vlm`,
--    because nothing looked at an image. Recording either as something it is
--    not would defeat PR-5, whose whole point is that a value fetched from the
--    IRP and a value read off a photo deserve different trust.
--
-- 2. A FIELD CANNOT NAME THE VOUCHER IT LANDED ON.
--
--    `source_documents.linked_voucher_id` assumes one file becomes one
--    voucher. `splitDocuments` disproved that: a Flipkart file holds three
--    documents from three suppliers, and an Amazon file two. So a single link
--    on the file cannot say which voucher a given figure supports.
--
--    `extracted_fields.voucher_id` says it per field instead.
--
-- 3. NOR WHICH DOCUMENT WITHIN THE FILE.
--
--    Page numbers are not enough — an Amazon file has one document per page,
--    but a Flipkart bill of supply spans two, and a reviewer looking at
--    "page 2" needs to know which of the file's documents that page belongs to.

ALTER TYPE extraction_method ADD VALUE IF NOT EXISTS 'pdf_coordinates';
ALTER TYPE extraction_method ADD VALUE IF NOT EXISTS 'llm_text';

ALTER TABLE extracted_fields
  ADD COLUMN voucher_id      uuid REFERENCES vouchers(id),
  ADD COLUMN document_index  integer;

-- The lookup that matters: given a posted bill, show me where every figure on
-- it came from.
CREATE INDEX extracted_fields_voucher ON extracted_fields (voucher_id);

COMMENT ON COLUMN extracted_fields.voucher_id IS
  'The voucher this field ended up supporting. Nullable: a field may be '
  'extracted from a document that was never posted, which is itself worth '
  'keeping — it is the record of what we read and refused.';
