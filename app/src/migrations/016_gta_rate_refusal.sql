-- 016_gta_rate_refusal.sql
-- Some HSN/SAC codes have no single correct rate. Say so, instead of guessing.
-- Spec: invoicing.md §4.4 — CA review answer A3.1.
-- Gap: DEFECT-LOG G-24
--
-- ── Found by resolving a REAL invoice ──────────────────────────────────────
--
-- Review answer A3.1 told us to delete the empty-prefix 18% fallback, because
-- an unmatched HSN that quietly resolves to 18% produces a wrong liability
-- that nobody is ever shown. We deleted it, and then left a bare `99` row at
-- 18% doing the identical job one level down: `99` is the prefix of EVERY
-- service in the scheme, so no service code could ever fail to match and the
-- refuse-and-ask path was unreachable for the entire services half of the
-- schedule.
--
-- It went unnoticed because 18% is right for most services. A real Flipkart
-- invoice showed where it is not: SAC 996511, goods transport by road, which
-- the rate master answered `18%`.
--
-- ── Why GTA cannot simply be seeded with the right number ──────────────────
--
-- Because there isn't one. Goods transport by a GTA is 5% or 12%, and which
-- applies is not a property of the code: it depends on whether the supplier
-- opted to pay under forward charge, and on whether input credit is being
-- taken. Two invoices bearing SAC 996511 can correctly carry different rates.
-- Seeding either number would be a guess wearing a citation.
--
-- So the row exists — we know the code, we know it is a real service, we know
-- what makes it ambiguous — but it carries no rate. `requires_human_rate`
-- marks it, and `human_rate_reason` says what to ask. That is strictly better
-- than no row at all, which would refuse with a generic "not configured" and
-- leave the user to rediscover why.
--
-- The CHECK is the guarantee: a refusing row CANNOT carry a rate, so there is
-- no number for a caller to read by mistake.

ALTER TABLE gst_rates ALTER COLUMN gst_rate DROP NOT NULL;

ALTER TABLE gst_rates
  ADD COLUMN requires_human_rate boolean NOT NULL DEFAULT false,
  ADD COLUMN human_rate_reason   text;

ALTER TABLE gst_rates ADD CONSTRAINT gst_rates_refusal_ck CHECK (
  (requires_human_rate AND gst_rate IS NULL     AND human_rate_reason IS NOT NULL)
  OR
  (NOT requires_human_rate AND gst_rate IS NOT NULL AND human_rate_reason IS NULL)
);

-- Unchanged in body; widened to carry the refusal. Callers that resolve a rate
-- must now decide what to do when one is withheld.
DROP FUNCTION IF EXISTS resolve_gst_rate(text, date);

CREATE FUNCTION resolve_gst_rate(p_hsn text, p_on date)
RETURNS TABLE (rate_id uuid, gst_rate numeric, cess_rate numeric,
               source_notification text, effective_from date,
               requires_human_rate boolean, human_rate_reason text) AS $$
  SELECT id, gst_rate, cess_rate, source_notification, effective_from,
         requires_human_rate, human_rate_reason
  FROM gst_rates
  WHERE p_hsn LIKE hsn_sac_prefix || '%'
    AND p_on >= effective_from
    AND (effective_to IS NULL OR p_on <= effective_to)
  ORDER BY length(hsn_sac_prefix) DESC, effective_from DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION resolve_gst_rate(text, date) TO bharaterp_app;
