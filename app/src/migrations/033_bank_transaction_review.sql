-- Human classification of statement lines that have no bill or invoice.
-- A bank debit proves money moved; it does not prove business purpose or GST.

CREATE TABLE bank_transaction_reviews (
  bank_transaction_id uuid PRIMARY KEY REFERENCES bank_transactions(id),
  firm_id              uuid NOT NULL REFERENCES firms(id),
  client_id            uuid NOT NULL REFERENCES clients(id),
  classification       text NOT NULL CHECK (classification IN
                         ('business_expense','personal','transfer','unsure')),
  account_id           uuid REFERENCES accounts(id),
  receipt_status       text NOT NULL CHECK (receipt_status IN
                         ('missing','not_required')),
  note                 text,
  posted_voucher_id    uuid REFERENCES vouchers(id),
  reviewed_by          uuid NOT NULL REFERENCES users(id),
  reviewed_at          timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_review_posting_ck CHECK (
    (classification = 'unsure' AND posted_voucher_id IS NULL)
    OR classification <> 'unsure'
  ),
  CONSTRAINT bank_review_receipt_ck CHECK (
    classification <> 'business_expense' OR receipt_status = 'missing'
  )
);

ALTER TABLE bank_transaction_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transaction_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_transaction_reviews_firm_isolation ON bank_transaction_reviews
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());

GRANT SELECT, INSERT, UPDATE ON bank_transaction_reviews TO bharaterp_app;
REVOKE DELETE, TRUNCATE ON bank_transaction_reviews FROM bharaterp_app;

-- Companies and firms must not send a director/partner's personal purchase to
-- the P&L. It remains recoverable until repaid. Proprietors use Drawings.
INSERT INTO accounts
  (firm_id, client_id, code, name, parent_id, is_group, root_type,
   account_type, normal_balance, liquidity_class, created_by)
SELECT p.firm_id, p.client_id, '1075', 'Personal Expenses Recoverable', p.id,
       false, 'asset', 'general', 'debit', 'current', p.created_by
FROM accounts p
WHERE p.name = 'Current Assets' AND p.is_group
  AND NOT EXISTS (
    SELECT 1 FROM accounts a
    WHERE a.client_id = p.client_id AND a.name = 'Personal Expenses Recoverable'
  );
