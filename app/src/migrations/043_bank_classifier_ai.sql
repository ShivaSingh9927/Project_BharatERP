-- DeepSeek may suggest a review category for bank receipts only after the
-- firm explicitly enables this separate data-sharing purpose.
ALTER TABLE firm_ai_settings
  ADD COLUMN llm_bank_classification boolean NOT NULL DEFAULT false,
  ADD COLUMN llm_bank_classification_by uuid REFERENCES users(id),
  ADD COLUMN llm_bank_classification_at timestamptz;

ALTER TABLE firm_ai_settings ADD CONSTRAINT bank_classifier_consent_attributed CHECK (
  NOT llm_bank_classification
  OR (llm_bank_classification_by IS NOT NULL
      AND llm_bank_classification_at IS NOT NULL
      AND llm_provider IS NOT NULL AND llm_model IS NOT NULL)
);

ALTER TABLE bank_transaction_reviews
  DROP CONSTRAINT bank_transaction_reviews_classification_check;
ALTER TABLE bank_transaction_reviews
  ADD CONSTRAINT bank_transaction_reviews_classification_check CHECK (classification IN
    ('business_expense','personal','transfer','unsure',
     'share_application_pending','related_party_loan_pending','customer_advance_pending',
     'intercompany_transfer_pending','refund_or_reversal_pending',
     'bank_interest_pending','customer_receipt_pending'));

ALTER TABLE bank_transaction_reviews
  DROP CONSTRAINT bank_review_pending_source_ck;
ALTER TABLE bank_transaction_reviews
  ADD CONSTRAINT bank_review_pending_source_ck CHECK (
    classification NOT IN ('share_application_pending','related_party_loan_pending',
      'customer_advance_pending','intercompany_transfer_pending',
      'refund_or_reversal_pending','bank_interest_pending','customer_receipt_pending')
    OR source_name IS NOT NULL
  );

ALTER TABLE bank_transaction_reviews DROP CONSTRAINT bank_review_posting_ck;
ALTER TABLE bank_transaction_reviews ADD CONSTRAINT bank_review_posting_ck CHECK (
  (classification IN ('unsure','share_application_pending',
      'related_party_loan_pending','customer_advance_pending',
      'intercompany_transfer_pending','refund_or_reversal_pending',
      'bank_interest_pending','customer_receipt_pending')
   AND posted_voucher_id IS NULL)
  OR classification IN ('business_expense','personal','transfer')
);

CREATE TABLE bank_transaction_ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id),
  firm_id uuid NOT NULL REFERENCES firms(id),
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  category text NOT NULL CHECK (category IN
    ('share_application_pending','related_party_loan_pending','customer_advance_pending',
     'intercompany_transfer_pending','refund_or_reversal_pending',
     'bank_interest_pending','customer_receipt_pending','unsure')),
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL DEFAULT '',
  question text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_transaction_ai_suggestions_lookup
  ON bank_transaction_ai_suggestions (bank_transaction_id, prompt_version, created_at DESC);

ALTER TABLE bank_transaction_ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transaction_ai_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_transaction_ai_suggestions_firm_isolation
  ON bank_transaction_ai_suggestions
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());
GRANT SELECT, INSERT ON bank_transaction_ai_suggestions TO bharaterp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON bank_transaction_ai_suggestions FROM bharaterp_app;
