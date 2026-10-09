-- Document class suggestions run by default; a firm may explicitly opt out.
-- Preserve a previous user-initiated opt-out (the older toggle recorded the
-- actor in llm_document_classification_by even while the feature was false).
ALTER TABLE firm_ai_settings
  ADD COLUMN llm_document_classification_disabled boolean NOT NULL DEFAULT false;

UPDATE firm_ai_settings
   SET llm_document_classification_disabled = true
 WHERE llm_document_classification = false
   AND llm_document_classification_by IS NOT NULL;

COMMENT ON COLUMN firm_ai_settings.llm_document_classification_disabled IS
  'Explicit firm opt-out. No row or false means Nexus document suggestions are enabled by default.';
