-- 004_fiscal.sql
-- Fiscal years (India: 1 April – 31 March) and period close.
-- Spec: gl-engine.md §7

CREATE TABLE fiscal_years (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id),
  label        text NOT NULL,             -- '2026-27'
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  -- A company incorporated mid-year has a short first FY (e.g. 1 Nov – 31 Mar).
  is_short     boolean NOT NULL DEFAULT false,
  is_closed    boolean NOT NULL DEFAULT false,   -- hard close, §7.4
  UNIQUE (client_id, label),
  CONSTRAINT fiscal_year_range_ck CHECK (end_date > start_date)
);

CREATE INDEX ON fiscal_years (client_id, start_date);

-- Soft close: block new postings into a closed month, overridable by a
-- privileged role. Spec: gl-engine.md §7.4
CREATE TABLE accounting_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id),
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id),
  label          text NOT NULL,           -- '2026-09'
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  is_closed      boolean NOT NULL DEFAULT false,
  closed_at      timestamptz,
  closed_by      uuid REFERENCES users(id),
  UNIQUE (client_id, label),
  CONSTRAINT accounting_period_range_ck CHECK (end_date >= start_date)
);

CREATE INDEX ON accounting_periods (client_id, start_date);

-- ---------------------------------------------------------------------------
-- Resolve a posting date to its fiscal year, and reject if the date falls in a
-- closed year or a closed period. This is validation V-6, enforced in the
-- database so it cannot be bypassed by a caller that forgets to check.
-- ---------------------------------------------------------------------------
CREATE FUNCTION resolve_open_fiscal_year(p_client_id uuid, p_posting_date date)
RETURNS uuid AS $$
DECLARE
  v_fy_id     uuid;
  v_fy_closed boolean;
  v_period_closed boolean;
BEGIN
  SELECT id, is_closed INTO v_fy_id, v_fy_closed
  FROM fiscal_years
  WHERE client_id = p_client_id
    AND p_posting_date BETWEEN start_date AND end_date;

  IF v_fy_id IS NULL THEN
    RAISE EXCEPTION 'V-6: no fiscal year covers posting date %', p_posting_date
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_fy_closed THEN
    RAISE EXCEPTION 'V-6: fiscal year for % is closed', p_posting_date
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT is_closed INTO v_period_closed
  FROM accounting_periods
  WHERE client_id = p_client_id
    AND p_posting_date BETWEEN start_date AND end_date;

  IF COALESCE(v_period_closed, false) THEN
    RAISE EXCEPTION 'V-6: accounting period containing % is closed', p_posting_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_fy_id;
END $$ LANGUAGE plpgsql;

GRANT SELECT, INSERT, UPDATE ON fiscal_years, accounting_periods TO bharaterp_app;
