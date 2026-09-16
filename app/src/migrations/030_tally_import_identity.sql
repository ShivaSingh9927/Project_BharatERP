-- A Tally voucher must remain identifiable after import.
--
-- The source GUID (or a deterministic fingerprint when an old export has no
-- GUID) is stored on the voucher itself so idempotency and posting are one
-- transaction. A separate import-log insert after posting would leave a crash
-- window in which the voucher exists but its duplicate guard does not.

ALTER TABLE vouchers ADD COLUMN external_id text;

CREATE UNIQUE INDEX vouchers_tally_external_id_uq
  ON vouchers (client_id, external_id)
  WHERE created_via = 'tally_import' AND external_id IS NOT NULL;

COMMENT ON COLUMN vouchers.external_id IS
  'Stable identifier from an external source. Required by the Tally importer for resumable, duplicate-safe imports.';
