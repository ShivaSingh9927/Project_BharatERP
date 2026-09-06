-- 014_gst_rate_resolution.sql
-- Resolve a GST rate deterministically, and say where the number came from.
-- Spec: invoicing.md §4.4, provenance.md PR-7 — CA review answer A3.1/A3.3.
-- Gap: DEFECT-LOG G-23
--
-- Two defects in the original function, and the first defeats the entire
-- date-ranging design the review endorsed.
--
-- 1. NON-DETERMINISTIC WHEN A RATE CHANGES.
--
--    The whole point of date-ranged rates is that a change arrives as a NEW ROW
--    with a later `effective_from`, leaving the old row intact so last year's
--    voucher still computes with last year's law. That is exactly the pattern
--    used for the B2C-Large threshold two commits ago.
--
--    But the ordering was
--        ORDER BY length(hsn_sac_prefix) DESC LIMIT 1
--    and two rows sharing a prefix have the SAME length. With `effective_to`
--    NULL on both — which is normal, since nobody closes off the old row — both
--    match, the sort is a tie, and PostgreSQL returns whichever it likes.
--
--    So the first time anyone recorded a rate change, invoices would silently
--    start picking between the old and new rate at random. Nothing would fail;
--    the numbers would just sometimes be last year's. This has not bitten yet
--    only because no second row has been seeded for any HSN.
--
-- 2. NO PROVENANCE.
--
--    The function returned a number and dropped `source_notification` on the
--    floor, so a caller could not say WHICH notification produced the rate it
--    just posted. That matters more than usual right now: every seeded HSN rate
--    is marked UNVERIFIED because it predates the 2025-09-22 rationalisation
--    (G-19b), and the caller needs to be able to say so on the invoice.

DROP FUNCTION IF EXISTS resolve_gst_rate(text, date);

CREATE FUNCTION resolve_gst_rate(p_hsn text, p_on date)
RETURNS TABLE (rate_id uuid, gst_rate numeric, cess_rate numeric,
               source_notification text, effective_from date) AS $$
  SELECT id, gst_rate, cess_rate, source_notification, effective_from
  FROM gst_rates
  WHERE p_hsn LIKE hsn_sac_prefix || '%'
    AND p_on >= effective_from
    AND (effective_to IS NULL OR p_on <= effective_to)
  -- Most specific HSN first, then the most recent rate that had taken effect by
  -- the posting date. The second key is what makes a rate change resolve to the
  -- rate in force, rather than to whichever row the planner reached first.
  ORDER BY length(hsn_sac_prefix) DESC, effective_from DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON FUNCTION resolve_gst_rate(text, date) TO bharaterp_app;

-- Supports the ordering above; the old index was on (prefix, effective_from)
-- ascending, which is the wrong direction for the tie-break.
CREATE INDEX IF NOT EXISTS gst_rates_prefix_from_desc
  ON gst_rates (hsn_sac_prefix, effective_from DESC);
