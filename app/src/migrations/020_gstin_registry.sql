-- The GST portal's own record of a supplier, cached.
-- Spec: bills-and-expenses.md §4.8 · CGST s.16(2), s.10
--
-- Until now a supplier GSTIN was only checked for a valid CHECK DIGIT, which
-- proves the number was typed correctly and nothing else. A structurally
-- perfect GSTIN can belong to a registration that was cancelled two years ago,
-- or to a composition dealer who may not charge GST at all — and input credit
-- claimed against either is credit that will be reversed with interest.
--
-- Cached because the lookup is a paid call to a third party and the answer
-- changes rarely: a registration status is a fact about a business, not about
-- this bill. `fetched_at` is kept so the caller can decide what counts as
-- stale, and so an audit can say WHEN the portal said this.
--
-- Not per firm. A GSTIN is a public identifier and the portal's answer is the
-- same for everyone who asks, so this is reference data rather than a tenant's
-- records — which is why there is no RLS policy on it.
CREATE TABLE gstin_registry (
  gstin             char(15) PRIMARY KEY,

  -- 'Active', 'Cancelled', 'Suspended', 'Inactive' — the portal's own word.
  status            text NOT NULL,
  -- 'Regular', 'Composition', 'Casual Taxable Person', ... — decides whether
  -- this supplier is even permitted to charge GST.
  taxpayer_type     text,
  legal_name        text,
  trade_name        text,
  state_code        char(2),
  registered_on     date,
  cancelled_on      date,
  -- Whether the portal says this supplier must issue e-invoices. A B2B invoice
  -- from one who must, and does not, can have its credit denied.
  einvoice_required boolean,

  -- The whole response, so a question nobody thought to ask today can still be
  -- answered from what was actually returned (PR-3).
  raw               jsonb NOT NULL,

  source            text NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE gstin_registry IS
  'Cached GST portal registration details, keyed by GSTIN. Reference data '
  'shared across firms: the portal returns the same answer to everyone.';
