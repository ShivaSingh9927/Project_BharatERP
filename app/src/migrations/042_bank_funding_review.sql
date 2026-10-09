-- Record a human's answer about an incoming receipt without turning that
-- answer into a journal entry before supporting documents are checked.
ALTER TABLE bank_transaction_reviews
  DROP CONSTRAINT bank_transaction_reviews_classification_check;
ALTER TABLE bank_transaction_reviews
  ADD CONSTRAINT bank_transaction_reviews_classification_check CHECK (classification IN
    ('business_expense','personal','transfer','unsure',
     'share_application_pending','related_party_loan_pending','customer_advance_pending'));

ALTER TABLE bank_transaction_reviews
  ADD COLUMN source_name text CHECK (source_name IS NULL OR length(source_name) BETWEEN 1 AND 160);

ALTER TABLE bank_transaction_reviews ADD CONSTRAINT bank_review_pending_source_ck CHECK (
  classification NOT IN ('share_application_pending','related_party_loan_pending',
                         'customer_advance_pending') OR source_name IS NOT NULL
);

ALTER TABLE bank_transaction_reviews DROP CONSTRAINT bank_review_posting_ck;
ALTER TABLE bank_transaction_reviews ADD CONSTRAINT bank_review_posting_ck CHECK (
  (classification IN ('unsure','share_application_pending',
                      'related_party_loan_pending','customer_advance_pending')
   AND posted_voucher_id IS NULL)
  OR classification IN ('business_expense','personal','transfer')
);
