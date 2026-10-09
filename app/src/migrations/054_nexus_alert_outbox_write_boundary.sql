-- Only the SECURITY DEFINER materialization triggers may write delivery rows.
-- The application role can inspect its firm's queue but cannot fabricate a
-- queued/sent state or alter retry history directly.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON nexus_alert_email_outbox FROM bharaterp_app;
GRANT SELECT ON nexus_alert_email_outbox TO bharaterp_app;
