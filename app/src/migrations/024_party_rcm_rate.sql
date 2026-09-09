-- The reverse-charge rate a supplier's supplies attract, per supplier, by date.
-- Spec: bills-and-expenses.md BE-35
--
-- Under reverse charge the recipient owes the tax and the supplier charges
-- none — so the rate is NOT on the document, and never can be. It arrived
-- until now as a command-line flag applied to a whole folder, which is wrong
-- in two ways: it is a decision with money attached that nobody recorded, and
-- one flag cannot distinguish a German hosting bill from the local carpenter's.
--
-- The rate is really a property of the SUPPLIER. An advocate's every bill is
-- taxed in the client's hands at 18% under s.9(3); a foreign SaaS vendor's
-- every bill is an import of service under s.5(3) of the IGST Act. Set once by
-- a human against the party, it applies to all their bills without being
-- re-decided, and it carries who decided and under which provision.
--
-- Date-ranged rather than a column on `parties`, for the reason migration 008
-- gives: rates move. The 2025-09-22 rationalisation collapsed two slabs, and a
-- bill for an earlier period was charged at the rate in force THEN. A column
-- would silently reprice history the moment somebody edited the master.
CREATE TABLE party_rcm_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES firms(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  party_id        uuid NOT NULL REFERENCES parties(id),

  gst_rate        numeric(5,2) NOT NULL,

  -- WHICH PROVISION puts the tax in the recipient's hands. Not decoration:
  -- s.9(4) — reverse charge merely because the supplier is unregistered — has
  -- been suspended since 13 October 2017, so a row claiming it would be
  -- claiming a liability that does not exist. Only the two live routes are
  -- accepted, and the row has to say which one it is relying on.
  provision       text NOT NULL,
  -- What this supplier actually supplies, in the words of the notification —
  -- 'legal services by an advocate', 'goods transport agency'. This is the
  -- justification for the rate, and PR-7 wants the rule cited, not the number.
  supply          text NOT NULL,
  source_notification text,

  effective_from  date NOT NULL,
  effective_to    date,

  set_by          uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT party_rcm_provision_ck CHECK (provision IN ('igst_5_3', 'cgst_9_3')),
  CONSTRAINT party_rcm_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A rate outside the schedule is not a rate. Kept in the database as well as
  -- in code because this number is read back years later and reprices a
  -- liability the client pays in cash.
  CONSTRAINT party_rcm_rate_ck CHECK (
    gst_rate IN (0, 0.25, 1.5, 3, 5, 12, 18, 28)),
  -- One row per start date. Overlapping ranges would leave the rate for a
  -- given bill genuinely undecided; the resolver refuses rather than picking,
  -- and the setter closes the previous row so it never comes to that.
  UNIQUE (party_id, effective_from)
);

CREATE INDEX ON party_rcm_rates (client_id, party_id, effective_from);

ALTER TABLE party_rcm_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON party_rcm_rates
  USING (firm_id = current_setting('app.firm_id')::uuid);

-- No DELETE: a rate that priced a posted bill is that bill's evidence. A rate
-- that stops applying is closed with `effective_to`, which keeps the history
-- the bill points back at.
GRANT SELECT, INSERT, UPDATE ON party_rcm_rates TO bharaterp_app;
