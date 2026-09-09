-- Who is using this, and proving it.
-- Spec: audit-trail.md §AU-1 · bills-and-expenses.md BE-39
--
-- Until now the review server picked the oldest client and that firm's first
-- user at boot, and every screen trusted it. That was honest for a question
-- being asked of one CA on one laptop, and it is the single thing standing
-- between this and being usable by anyone else — because "who approved this
-- bill" is the load-bearing fact in the whole audit trail (AT-13), and it was
-- being answered by a SELECT ... ORDER BY created_at LIMIT 1.
--
-- ── Authentication sits OUTSIDE the tenant boundary ──────────────────────
--
-- Every other table in this database is isolated by RLS on `app.firm_id`. A
-- session cannot be, because resolving the session is HOW the firm becomes
-- known — the lookup necessarily happens before there is a firm to filter by.
-- So these tables are read with the owner connection, and that is exactly why
-- they hold as little as possible and why the queries against them are narrow
-- and few.

-- ---------------------------------------------------------------------------
-- Signing in and out are auditable events.
--
-- `audit_log` already carries session_id, ip_address and user_agent — the
-- audit-trail spec anticipated this and the enum simply had no value for it.
-- Added rather than worked around: an approval trail that cannot say when its
-- approver arrived is missing the first link.
--
-- Safe inside the migrator's transaction on PostgreSQL 12+, because the new
-- values are not USED until a later statement in another transaction.
-- ---------------------------------------------------------------------------
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'login';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'logout';

-- ---------------------------------------------------------------------------
-- The password verifier. Never the password.
--
-- scrypt, from Node's own crypto — memory-hard, no dependency, and the
-- parameters are stored PER ROW so they can be raised later without
-- invalidating every existing hash. A cost factor hardcoded in application
-- code can never be increased, because the old hashes stop verifying.
-- ---------------------------------------------------------------------------
CREATE TABLE user_credentials (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 'scrypt' today. Named so a future migration to something else can live
  -- alongside it rather than requiring a flag day.
  algorithm     text NOT NULL,
  -- Hex. The salt is per user and random; a shared or absent salt makes one
  -- rainbow table work against every account at once.
  salt          text NOT NULL,
  verifier      text NOT NULL,
  -- scrypt's cost parameters, as they were when this hash was made.
  cost_n        int  NOT NULL,
  block_size_r  int  NOT NULL,
  parallel_p    int  NOT NULL,
  -- True after a password was issued by an administrator rather than chosen.
  -- An issued password is known to somebody other than its owner, so it is
  -- good for exactly one login.
  must_change   boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_credentials_algo_ck CHECK (algorithm IN ('scrypt'))
);

-- ---------------------------------------------------------------------------
-- Sessions.
--
-- The token itself is NEVER stored — only its SHA-256. A leak of this table
-- then yields nothing usable: an attacker holds hashes and the cookie needs
-- the preimage. It is the same reason a password is not stored, applied to the
-- thing that stands in for one.
--
-- Two expiries, because they answer different questions. `expires_at` is
-- absolute and caps how long one login can last however busy the user is.
-- `last_seen_at` drives an idle timeout, so a session left open on a shared
-- machine dies on its own.
-- ---------------------------------------------------------------------------
CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_sha256  char(64) NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  -- Recorded for the audit trail, which wants to know where an approval came
  -- from. Not used for authorisation: an IP is not an identity, and pinning a
  -- session to one breaks every CA on a mobile connection.
  ip_address    inet,
  user_agent    text
);

CREATE INDEX ON user_sessions (user_id);
CREATE INDEX ON user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Failed attempts, so guessing costs something.
--
-- In the database rather than in memory on purpose: an attacker who can
-- restart the process, or who simply waits for a deploy, should not get a
-- fresh allowance. Keyed by the email TRIED — including one that matches no
-- user, because otherwise probing for valid addresses is free.
-- ---------------------------------------------------------------------------
CREATE TABLE login_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  succeeded     boolean NOT NULL,
  ip_address    inet
);

CREATE INDEX ON login_attempts (email, attempted_at DESC);

-- No grants to bharaterp_app. These tables are reached only by the owner
-- connection, from `auth.ts`, and nothing else has any business in them.
