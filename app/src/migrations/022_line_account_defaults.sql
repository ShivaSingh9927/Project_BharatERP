-- What a client habitually posts a supplier's line to.
-- Spec: bills-and-expenses.md §4.11
--
-- Classifying the same marketplace fees every month is the busywork a review
-- screen should erase. Once a reviewer files "Protect Promise Fee" from a
-- supplier under Freight Inward, the next one should arrive already pointed
-- there — a default they confirm, never a silent auto-post.
--
-- Keyed by the party rather than the GSTIN so a supplier with several
-- registrations is still one memory, and per client because how a spend is
-- classified is that client's own chart, not a fact about the supplier.
CREATE TABLE line_account_defaults (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  party_id    uuid NOT NULL REFERENCES parties(id),
  -- The line's description, normalised: lower-cased, alphanumerics only. So
  -- "Protect Promise Fee" and "Protect Promise Fee" collapse to one key while
  -- two different products stay apart.
  line_key    text NOT NULL,
  account_id  uuid NOT NULL REFERENCES accounts(id),
  -- How many times this mapping has been chosen — a weak confidence signal and
  -- a way to see which memories are load-bearing.
  times_seen  int  NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- One account per (client, supplier, line). The latest choice wins on
  -- conflict, so a reviewer changing their mind re-teaches it.
  UNIQUE (client_id, party_id, line_key)
);

CREATE INDEX ON line_account_defaults (client_id, party_id);

ALTER TABLE line_account_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_isolation ON line_account_defaults
  USING (firm_id = current_setting('app.firm_id')::uuid);

GRANT SELECT, INSERT, UPDATE ON line_account_defaults TO bharaterp_app;
