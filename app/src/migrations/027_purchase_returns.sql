-- Returning goods to a supplier — the debit note.
-- Spec: bills-and-expenses.md BE-38
--
-- Short delivery, damaged stock, a rate corrected after the invoice was cut:
-- every real payables ledger needs to reduce a bill that has already been
-- posted, and there was no way to express it. The alternatives people reach
-- for are both wrong — deleting the bill destroys the audit trail and the
-- GSTR-2B match, and a manual journal reverses the money without touching the
-- tax or the ageing.
--
-- ── The GST asymmetry, which is the whole reason this is not simple ───────
--
-- Under s.34 a CREDIT NOTE is the SUPPLIER's instrument. Only they can issue
-- one, and only their credit note reduces their output liability. What the
-- recipient issues is a debit note, and it is a book document: it records that
-- we are paying less, and it does NOT by itself entitle anyone to a tax
-- adjustment.
--
-- What the law requires of the recipient is the mirror duty: reverse the input
-- credit taken on the returned portion. So this table records our debit note
-- and the ITC reversal, and separately records the supplier's credit note WHEN
-- IT ARRIVES — because until it does, and until it shows in GSTR-2B, the tax
-- side of the return has no support in the GST system at all.
CREATE TABLE purchase_returns (
  voucher_id        uuid PRIMARY KEY REFERENCES vouchers(id),
  firm_id           uuid NOT NULL REFERENCES firms(id),
  client_id         uuid NOT NULL REFERENCES clients(id),
  -- The bill being returned against. Not nullable: a return with no bill is a
  -- credit the supplier owes us for reasons nobody recorded.
  bill_voucher_id   uuid NOT NULL REFERENCES vouchers(id),
  party_id          uuid NOT NULL REFERENCES parties(id),

  -- OUR number for the debit note, which is ours to allocate.
  note_number       text NOT NULL,
  note_date         date NOT NULL,
  -- Why, in words. A return with no reason is the one an auditor asks about.
  reason            text NOT NULL,

  taxable_value     numeric(18,2) NOT NULL,
  total_cgst        numeric(18,2) NOT NULL DEFAULT 0,
  total_sgst        numeric(18,2) NOT NULL DEFAULT 0,
  total_igst        numeric(18,2) NOT NULL DEFAULT 0,
  total_cess        numeric(18,2) NOT NULL DEFAULT 0,
  grand_total       numeric(18,2) NOT NULL,

  -- The supplier's own credit note (s.34), once they issue it. Nullable
  -- because the return happens when the goods go back, and their paperwork
  -- follows days or weeks later — that gap is real and has to be visible
  -- rather than assumed away.
  supplier_credit_note      text,
  supplier_credit_note_date date,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),

  CONSTRAINT purchase_return_positive_ck CHECK (taxable_value > 0 AND grand_total > 0),
  -- One number per client. A duplicated debit note number is the thing that
  -- makes two returns look like one at reconciliation.
  UNIQUE (client_id, note_number)
);

CREATE INDEX ON purchase_returns (client_id, bill_voucher_id);
CREATE INDEX ON purchase_returns (client_id, note_date);

-- Line by line, because a return is nearly always PART of a bill and the
-- reversal has to follow the original line's ITC treatment. A line whose
-- credit was blocked had its GST capitalised into the expense, so returning it
-- takes the whole GST back out of the expense — while an eligible line's GST
-- comes off the input credit instead. Reversing the wrong one misstates
-- profit by the tax.
CREATE TABLE purchase_return_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id        uuid NOT NULL REFERENCES purchase_returns(voucher_id) ON DELETE CASCADE,
  -- Which line of the original bill this returns.
  bill_line_no      int NOT NULL,
  description       text NOT NULL,
  hsn_sac           text,
  taxable_value     numeric(18,2) NOT NULL,
  gst_rate          numeric(5,2) NOT NULL,
  cgst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  sgst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  igst_amount       numeric(18,2) NOT NULL DEFAULT 0,
  cess_amount       numeric(18,2) NOT NULL DEFAULT 0,
  expense_account_id uuid NOT NULL REFERENCES accounts(id),
  itc_eligibility   itc_eligibility NOT NULL,

  UNIQUE (voucher_id, bill_line_no)
);

CREATE INDEX ON purchase_return_items (voucher_id);

ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON purchase_returns
  USING (firm_id = current_firm_id())
  WITH CHECK (firm_id = current_firm_id());

-- The items table is isolated THROUGH its parent, the same way
-- `purchase_bill_items` is. It carries no firm_id of its own, so the policy
-- has to reach the header for one — leaving it unprotected would make one
-- firm's return lines readable by another's session.
ALTER TABLE purchase_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_return_items FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON purchase_return_items
  USING (voucher_id IN (SELECT voucher_id FROM purchase_returns WHERE firm_id = current_firm_id()))
  WITH CHECK (voucher_id IN (SELECT voucher_id FROM purchase_returns WHERE firm_id = current_firm_id()));

GRANT SELECT, INSERT ON purchase_returns, purchase_return_items TO bharaterp_app;
-- The supplier's own credit note arrives after the return; nothing else about
-- a posted return may change.
GRANT UPDATE (supplier_credit_note, supplier_credit_note_date)
  ON purchase_returns TO bharaterp_app;
