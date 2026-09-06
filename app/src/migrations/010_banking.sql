-- 010_banking.sql
-- Bank accounts, statement ingestion, reconciliation matching, cheque float.
-- Spec: bank-and-reconciliation.md

CREATE TYPE bank_account_kind AS ENUM ('current', 'savings', 'od', 'cc', 'fd');

-- BR-10: the UTR is the strongest matching signal available, but only if it
-- was captured. When a customer confirms "paid, UTR HDFCR52026090412345", that
-- string turns a probabilistic match into an exact one — so there has to be
-- somewhere to put it before the money arrives.
ALTER TABLE sales_invoices ADD COLUMN expected_reference text;
CREATE INDEX ON sales_invoices (client_id, expected_reference)
  WHERE expected_reference IS NOT NULL;

CREATE TYPE statement_parse_status AS ENUM ('parsed', 'failed', 'partial');

-- How the money moved. Drives which narration rules apply (§6) and how much a
-- reference number is worth to the matcher (§8.2).
CREATE TYPE payment_mode AS ENUM (
  'upi', 'neft', 'rtgs', 'imps', 'cheque', 'cash', 'nach',
  'card', 'atm', 'charge', 'interest', 'transfer'
);

CREATE TYPE bank_txn_source AS ENUM ('statement', 'decentro_webhook', 'manual');

CREATE TYPE match_type AS ENUM ('known_link', 'exact', 'scored', 'rule', 'ai_proposed', 'manual');

CREATE TYPE match_proposer AS ENUM ('system', 'ai', 'user');

CREATE TYPE cheque_direction AS ENUM ('issued', 'received');

CREATE TYPE cheque_status AS ENUM ('pending', 'cleared', 'bounced', 'cancelled', 'stale');

CREATE TYPE bank_rule_action AS ENUM ('classify_as', 'match_party', 'create_voucher');

-- ---------------------------------------------------------------------------
-- Bank accounts.
--
-- BR-2: the full account number is never stored. Last four digits identify the
-- account to a human; the hash matches an uploaded statement to it. Neither
-- can be used to move money, so a breach of this table is not a breach of the
-- client's banking.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id              uuid NOT NULL REFERENCES firms(id),
  client_id            uuid NOT NULL REFERENCES clients(id),
  account_id           uuid NOT NULL REFERENCES accounts(id),   -- the GL account
  bank_name            text NOT NULL,
  account_number_last4 char(4) NOT NULL,
  account_number_hash  text NOT NULL,
  ifsc                 text,
  kind                 bank_account_kind NOT NULL DEFAULT 'current',
  is_virtual_account   boolean NOT NULL DEFAULT false,
  decentro_va_id       text,
  opening_balance      numeric(18,2) NOT NULL DEFAULT 0,
  opening_date         date NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, account_number_hash)
);

CREATE INDEX ON bank_accounts (client_id);

-- ---------------------------------------------------------------------------
-- One uploaded statement file.
--
-- `parser_version` is recorded so a line can still be explained years later,
-- after the parser has been improved (BR-11, provenance PR-4).
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            uuid NOT NULL REFERENCES firms(id),
  client_id          uuid NOT NULL REFERENCES clients(id),
  bank_account_id    uuid NOT NULL REFERENCES bank_accounts(id),
  source_document_id uuid REFERENCES source_documents(id),
  period_from        date NOT NULL,
  period_to          date NOT NULL,
  opening_balance    numeric(18,2) NOT NULL,
  closing_balance    numeric(18,2) NOT NULL,
  row_count          integer NOT NULL,
  parse_status       statement_parse_status NOT NULL,
  parser_version     text NOT NULL,
  uploaded_by        uuid NOT NULL REFERENCES users(id),
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_period_ck CHECK (period_to >= period_from)
);

CREATE INDEX ON bank_statements (bank_account_id, period_from);

-- ---------------------------------------------------------------------------
-- Statement lines. IMMUTABLE (BR-1).
--
-- A line is a fact reported by a third party. It is evidence, not our record —
-- so it is never edited, not even to fix an obvious typo in the narration.
-- Corrections happen through matching decisions.
--
-- Note what is NOT here: `status` and `matched_amount`. Both are derived from
-- reconciliation_matches by the view below, for the same reason the GL stores
-- no balances — a stored total is a second source of truth that can drift.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid NOT NULL REFERENCES firms(id),
  client_id         uuid NOT NULL REFERENCES clients(id),
  bank_account_id   uuid NOT NULL REFERENCES bank_accounts(id),
  statement_id      uuid REFERENCES bank_statements(id),   -- null for webhooks
  txn_date          date NOT NULL,
  value_date        date,
  row_no            integer,                    -- position in the source file
  -- BR-11: verbatim, forever. Parsing improves; the original is the evidence.
  narration         text NOT NULL,
  debit             numeric(18,2) NOT NULL DEFAULT 0,
  credit            numeric(18,2) NOT NULL DEFAULT 0,
  running_balance   numeric(18,2),
  reference_number  text,                       -- UTR / cheque no / UPI ref
  payment_mode      payment_mode,
  counterparty_name text,
  parser_version    text,
  -- BR-7: overlapping uploads are routine. Hash the content of the line, not
  -- the file it arrived in.
  content_hash      text NOT NULL,
  source            bank_txn_source NOT NULL DEFAULT 'statement',
  is_ignored        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (bank_account_id, content_hash),
  CONSTRAINT bank_txn_one_sided_ck CHECK (NOT (debit > 0 AND credit > 0)),
  CONSTRAINT bank_txn_nonzero_ck   CHECK (debit > 0 OR credit > 0),
  CONSTRAINT bank_txn_nonneg_ck    CHECK (debit >= 0 AND credit >= 0)
);

CREATE INDEX ON bank_transactions (bank_account_id, txn_date);
CREATE INDEX ON bank_transactions (client_id, reference_number)
  WHERE reference_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Matches: which voucher a bank line settles.
--
-- Append-only apart from un-matching, which sets unmatched_at rather than
-- deleting the row — a CA reversing a match is itself an auditable decision.
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_matches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES firms(id),
  client_id           uuid NOT NULL REFERENCES clients(id),
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id),
  voucher_id          uuid NOT NULL REFERENCES vouchers(id),
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  match_type          match_type NOT NULL,
  confidence          numeric(4,3),
  -- PR-9: which signals fired, their scores, and the runner-up the CA can
  -- switch to in one click (PR-11).
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_by         match_proposer NOT NULL,
  approved_by         uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  unmatched_at        timestamptz,
  unmatched_by        uuid REFERENCES users(id),
  unmatch_reason      text,

  -- BV-11 / AT-13: an AI-proposed match is a proposal until a human owns it.
  CONSTRAINT match_ai_needs_approver_ck CHECK (
    match_type <> 'ai_proposed' OR approved_by IS NOT NULL
  )
);

CREATE INDEX ON reconciliation_matches (bank_transaction_id) WHERE unmatched_at IS NULL;
CREATE INDEX ON reconciliation_matches (voucher_id) WHERE unmatched_at IS NULL;

-- Derived reconciliation state. One place computes it, so nothing can disagree.
CREATE VIEW bank_transactions_reconciled AS
SELECT bt.*,
       (bt.debit + bt.credit)                                   AS amount,
       COALESCE(m.matched, 0)                                   AS matched_amount,
       (bt.debit + bt.credit) - COALESCE(m.matched, 0)          AS unmatched_amount,
       CASE
         WHEN bt.is_ignored                                     THEN 'ignored'
         WHEN COALESCE(m.matched, 0) = 0                        THEN 'unmatched'
         WHEN COALESCE(m.matched, 0) >= bt.debit + bt.credit    THEN 'matched'
         ELSE 'partially_matched'
       END AS status
FROM bank_transactions bt
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS matched FROM reconciliation_matches rm
  WHERE rm.bank_transaction_id = bt.id AND rm.unmatched_at IS NULL
) m ON true;

-- ---------------------------------------------------------------------------
-- BV-4 / BV-5 / BV-6 / BV-7 as a database constraint.
--
-- Over-allocation is the failure that quietly destroys a receivables ageing:
-- match ₹20,000 against an invoice with ₹15,000 outstanding and the extra
-- ₹5,000 vanishes into a negative balance nobody looks at. Deferred, so a 1:N
-- allocation can be inserted row by row and judged as a whole.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_match_within_bounds() RETURNS trigger AS $$
DECLARE
  v_txn      RECORD;
  v_voucher  RECORD;
  v_allocated numeric(18,2);
BEGIN
  SELECT client_id, debit, credit INTO v_txn
  FROM bank_transactions WHERE id = NEW.bank_transaction_id;

  SELECT client_id, id INTO v_voucher
  FROM vouchers WHERE id = NEW.voucher_id;

  -- BV-6. The trigger runs as the calling role, so row-level security applies
  -- here too: a voucher belonging to another firm is not merely a different
  -- client_id, it is INVISIBLE. Without this branch the comparison below is
  -- NULL <> NULL, which is NULL, and the IF quietly does nothing — the foreign
  -- key still resolves because FK checks bypass RLS, so the row would insert.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BV-6: voucher % is not visible to this firm', NEW.voucher_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_txn.client_id <> v_voucher.client_id THEN
    RAISE EXCEPTION 'BV-6: bank transaction and voucher belong to different clients'
      USING ERRCODE = 'check_violation';
  END IF;

  -- BV-7: a reversed voucher no longer represents an obligation.
  IF EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_id = NEW.voucher_id) THEN
    RAISE EXCEPTION 'BV-7: voucher % has been reversed and cannot be matched', NEW.voucher_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- BV-5
  SELECT COALESCE(SUM(amount), 0) INTO v_allocated
  FROM reconciliation_matches
  WHERE bank_transaction_id = NEW.bank_transaction_id AND unmatched_at IS NULL;

  IF v_allocated > v_txn.debit + v_txn.credit THEN
    RAISE EXCEPTION 'BV-5: matched % exceeds the bank line amount %',
      v_allocated, v_txn.debit + v_txn.credit USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_match_within_bounds
  AFTER INSERT ON reconciliation_matches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_match_within_bounds();

-- ---------------------------------------------------------------------------
-- Learned rules (§8.4). Client-scoped only — one client's vendor patterns must
-- never influence another's books.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_transaction_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id              uuid NOT NULL REFERENCES firms(id),
  client_id            uuid NOT NULL REFERENCES clients(id),
  priority             integer NOT NULL DEFAULT 100,
  -- {contains: [...], starts_with: '...', regex: '...'}
  narration_conditions jsonb NOT NULL,
  payment_mode         payment_mode,
  direction            text CHECK (direction IN ('debit', 'credit')),
  amount_min           numeric(18,2),
  amount_max           numeric(18,2),
  action               bank_rule_action NOT NULL,
  target_account_id    uuid REFERENCES accounts(id),
  party_id             uuid REFERENCES parties(id),
  -- A rule earns auto-apply through repeated CA agreement, not by being
  -- written confidently.
  confirmed_count      integer NOT NULL DEFAULT 0,
  auto_post            boolean NOT NULL DEFAULT false,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON bank_transaction_rules (client_id, priority);

-- ---------------------------------------------------------------------------
-- Cheque register (§10).
--
-- The float is real: a cheque issued on 5 September and presented on the 20th
-- is recorded in the books on the 5th and by the bank on the 20th, and BOTH
-- are correct. That gap is the main reason a BRS exists at all.
-- ---------------------------------------------------------------------------
CREATE TABLE cheque_register (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES firms(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  voucher_id      uuid NOT NULL REFERENCES vouchers(id),
  party_id        uuid REFERENCES parties(id),
  cheque_number   text NOT NULL,
  cheque_date     date NOT NULL,
  direction       cheque_direction NOT NULL,
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),
  status          cheque_status NOT NULL DEFAULT 'pending',
  cleared_date    date,
  bounce_reason   text,
  -- BR-20: a bounced cheque received may attract Section 138 of the Negotiable
  -- Instruments Act. That is a legal event, not a routine reversal, so it is
  -- flagged rather than buried in a status.
  section_138_flag boolean NOT NULL DEFAULT false,
  reversal_voucher_id uuid REFERENCES vouchers(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, cheque_number, direction, cheque_date)
);

CREATE INDEX ON cheque_register (client_id, status, cheque_date);

-- ---------------------------------------------------------------------------
-- Row-level security and grants, matching 007.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts','bank_statements','bank_transactions',
    'reconciliation_matches','bank_transaction_rules','cheque_register'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY firm_isolation ON %I
        USING (firm_id = current_firm_id())
        WITH CHECK (firm_id = current_firm_id())
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON
  bank_accounts, bank_statements, bank_transactions,
  reconciliation_matches, bank_transaction_rules, cheque_register
  TO bharaterp_app;

GRANT SELECT ON bank_transactions_reconciled TO bharaterp_app;

-- BR-1: a statement line is third-party evidence. The only mutable field is
-- the operator's decision to set it aside, which is not a change to the fact.
GRANT UPDATE (is_ignored) ON bank_transactions TO bharaterp_app;
-- Un-matching is a recorded decision, not a deletion.
GRANT UPDATE (unmatched_at, unmatched_by, unmatch_reason, approved_by)
  ON reconciliation_matches TO bharaterp_app;
-- A cheque's lifecycle genuinely progresses after issue.
GRANT UPDATE (status, cleared_date, bounce_reason, section_138_flag, reversal_voucher_id)
  ON cheque_register TO bharaterp_app;
GRANT UPDATE (confirmed_count, auto_post, priority) ON bank_transaction_rules TO bharaterp_app;
-- Recording the UTR a customer quotes is not a change to the invoice's figures.
GRANT UPDATE (expected_reference) ON sales_invoices TO bharaterp_app;

REVOKE DELETE, TRUNCATE ON
  bank_accounts, bank_statements, bank_transactions,
  reconciliation_matches, bank_transaction_rules, cheque_register
  FROM bharaterp_app;
