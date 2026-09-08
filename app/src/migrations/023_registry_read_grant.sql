-- The dashboard joins a client's suppliers to their registration status, which
-- means the app role must be able to READ the registry. It is public reference
-- data — the portal returns the same answer to everyone — so a plain SELECT
-- grant is right; writes still go through the owner path that fetches it.
GRANT SELECT ON gstin_registry TO bharaterp_app;
