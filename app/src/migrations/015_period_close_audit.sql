-- 015_period_close_audit.sql
-- Closing and reopening a period are their own audit actions.
-- Spec: gl-engine.md §7.4, audit-trail.md
-- Gap: DEFECT-LOG G-4
--
-- Recording a close as 'update' would be technically true and practically
-- useless: an auditor asking "who locked March, and did they override an
-- unreconciled bank account to do it?" would have to distinguish it from every
-- other row change by reading the payload. Under the MCA audit-trail rules the
-- close is one of the events most worth being able to find.
--
-- Adding a value to an enum is allowed inside a transaction on PostgreSQL 12+
-- provided the value is not USED in the same transaction. Nothing here uses
-- them; the first use is at runtime, long after this has committed.
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'close';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'reopen';
