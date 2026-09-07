-- 017_llm_extraction_consent.sql
-- A firm decides, per firm, whether documents may leave the building.
-- Spec: bills-and-expenses.md §4.5 · BE-3 (documents are data, not instructions)
--
-- Two deterministic extractors read an invoice's table: reconstructed spacing
-- and word coordinates. Between them they read 11 of the 24 documents in the
-- corpus. The rest are refused, and a language model would very likely read
-- several of them, because irregular layout is its strength and a clusterer's
-- weakness.
--
-- Sending them means uploading a client's invoice to a third party. That is a
-- DPDP Act decision belonging to the CA firm, who is the data fiduciary — not
-- to us, and not to a default in a config file.
--
-- A practitioner pasting one PDF into a chat window is one person choosing
-- once. A product doing it automatically for every invoice of every client is a
-- systematic processing activity, and it is the firm that has to answer for it
-- when its own client asks. So it is off unless switched on, the switch names
-- who threw it and when, and the provider is recorded — because "we sent it to
-- an AI" is not an answer to "where did our invoices go".
--
-- Same shape as the LlamaParse decision, and the same reason.

CREATE TABLE firm_ai_settings (
  firm_id             uuid PRIMARY KEY REFERENCES firms(id),

  -- Off is the only safe default. No row means off.
  llm_extraction      boolean NOT NULL DEFAULT false,

  -- Which service, so the firm can say where documents went.
  llm_provider        text,
  llm_model           text,

  -- Who turned it on. Not nullable when it is on: an unattributed decision to
  -- export client documents is the thing this table exists to prevent.
  enabled_by          uuid REFERENCES users(id),
  enabled_at          timestamptz,

  CONSTRAINT llm_extraction_is_attributed CHECK (
    NOT llm_extraction
    OR (llm_provider IS NOT NULL AND llm_model IS NOT NULL
        AND enabled_by IS NOT NULL AND enabled_at IS NOT NULL)
  )
);

ALTER TABLE firm_ai_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY firm_ai_settings_isolation ON firm_ai_settings
  USING (firm_id = current_setting('app.firm_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON firm_ai_settings TO bharaterp_app;
