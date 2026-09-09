/**
 * Who is using this, and proving it.
 * Spec: bills-and-expenses.md BE-39
 *
 * The review server picked the oldest client and that firm's first user at
 * boot, and every screen trusted it. Honest for a question being asked of one
 * CA on one laptop, and the single thing between this and being usable by
 * anyone else — because "who approved this bill" is the load-bearing fact of
 * the whole audit trail (AT-13), and it was being answered by
 * `ORDER BY created_at LIMIT 1`.
 *
 * ── This module runs outside the tenant boundary ──────────────────────────
 *
 * Every other table is isolated by RLS on `app.firm_id`. A session cannot be,
 * because resolving it is HOW the firm becomes known. So the queries here use
 * the owner connection, and that is precisely why they are few, narrow, and
 * parameterised by nothing but a token hash or an id.
 *
 * ── What is deliberately not here ────────────────────────────────────────
 *
 * No password reset by email, no "remember me", no OAuth. Each is a real
 * feature with its own failure modes, and a half-built one is worse than none:
 * a reset flow with a guessable token is a back door with a friendly name.
 */

import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual }
  from 'node:crypto';
import { ownerPool } from '../db/pool.ts';
import { ValidationError } from './types.ts';

/**
 * scrypt cost. Roughly 100ms and 32MB per hash on the target hardware, which
 * is unnoticeable on a login and expensive across a stolen database.
 *
 * Stored per row, so raising these later re-hashes on next login rather than
 * invalidating every existing password.
 */
interface ScryptParams { N: number; r: number; p: number; keyLength: number }
const SCRYPT: ScryptParams = { N: 32_768, r: 8, p: 1, keyLength: 64 };

/** How long one login can last, and how long it may sit idle. */
const ABSOLUTE_HOURS = 12;
const IDLE_MINUTES = 120;

/** Guessing budget: this many failures in this window locks the account out. */
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

/** The signed-in user, and the client they are looking at. */
export interface Session {
  sessionId: string;
  userId: string;
  firmId: string;
  clientId: string;
  clientName: string;
  email: string;
  displayName: string;
  role: string;
  /** Set when this user is scoped to ONE client and cannot leave it. */
  boundClientId: string | null;
  mustChangePassword: boolean;
}

const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

async function hash(
  password: string, salt: Buffer, params: ScryptParams = SCRYPT,
): Promise<Buffer> {
  // `promisify` cannot see scrypt's optional-options overload, so the call is
  // wrapped by hand rather than cast into shape.
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, params.keyLength, {
      N: params.N, r: params.r, p: params.p,
      // scrypt needs memory proportional to N*r*128, and Node's default cap
      // is below that at these parameters — it throws without this.
      maxmem: 256 * params.N * params.r,
    }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Sets a user's password.
 *
 * `issued` marks a password chosen by somebody other than its owner — an
 * administrator bootstrapping an account. Such a password is known to two
 * people, so it is good for exactly one login and the user is made to replace
 * it. That is the difference between bootstrapping an account and having a
 * shared password nobody ever changes.
 */
export async function setPassword(
  userId: string, password: string, opts: { issued?: boolean } = {},
): Promise<void> {
  /*
   * Length, and nothing else.
   *
   * No character-class rules: they push people towards Passw0rd! and are worse
   * than a length floor on every measure anybody has taken. Long enough that
   * scrypt's cost makes guessing hopeless is the whole requirement.
   */
  if (password.length < 12) {
    throw new ValidationError(
      'a password needs at least 12 characters. Length is what defeats ' +
      'guessing; a short password with a symbol in it does not.', 'AU-1');
  }
  const salt = randomBytes(16);
  const verifier = await hash(password, salt);
  await ownerPool.query(
    `INSERT INTO user_credentials
       (user_id, algorithm, salt, verifier, cost_n, block_size_r, parallel_p,
        must_change, updated_at)
     VALUES ($1,'scrypt',$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (user_id) DO UPDATE
       SET algorithm = 'scrypt', salt = EXCLUDED.salt,
           verifier = EXCLUDED.verifier, cost_n = EXCLUDED.cost_n,
           block_size_r = EXCLUDED.block_size_r,
           parallel_p = EXCLUDED.parallel_p,
           must_change = EXCLUDED.must_change, updated_at = now()`,
    [userId, salt.toString('hex'), verifier.toString('hex'),
     SCRYPT.N, SCRYPT.r, SCRYPT.p, opts.issued === true]);
}

/** Is this account locked out by recent failures? Returns seconds remaining. */
export async function lockoutRemaining(email: string): Promise<number> {
  /*
   * The remaining wait is computed IN SQL, in seconds.
   *
   * Formatting a timestamp and parsing it back in JS was the first attempt and
   * it produced NaN — the offset format varies, and the arithmetic then
   * silently returned "not locked". The database already knows both times, so
   * let it do the subtraction.
   */
  const r = await ownerPool.query<{ n: string; wait: string | null }>(
    `SELECT COUNT(*)::text AS n,
            CEIL(EXTRACT(EPOCH FROM
              (MIN(attempted_at) + ($2 || ' minutes')::interval - now())))::text
              AS wait
       FROM login_attempts
      WHERE lower(email) = lower($1) AND NOT succeeded
        AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [email, WINDOW_MINUTES]);
  if (Number(r.rows[0]!.n) < MAX_FAILURES) return 0;
  return Math.max(0, Number(r.rows[0]!.wait ?? 0));
}

/** What a caller learns from a login attempt. */
export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; mustChangePassword: boolean }
  | { ok: false; reason: 'bad_credentials' | 'locked' | 'no_client';
      retryAfterSeconds?: number };

interface Verified {
  id: string; firm_id: string; client_id: string | null; must_change: boolean;
}

/**
 * Checks an email and password. Issues nothing.
 *
 * Separate from `login` on purpose. Changing a password needs the current one
 * proved, and routing that through `login` gave the user a session they never
 * asked for and wrote a "login" row into the audit trail for an event that was
 * not one. An audit trail that reports the wrong event is worse than one that
 * misses it.
 *
 * The failure is deliberately UNIFORM. A wrong password, an unknown email and
 * an account with no password set are indistinguishable to the caller, because
 * a different answer for each turns a login form into a directory of who banks
 * with which CA.
 */
async function verifyPassword(
  email: string, password: string, ip?: string,
): Promise<{ ok: true; user: Verified }
         | { ok: false; reason: 'bad_credentials' | 'locked'; retryAfterSeconds?: number }> {
  const locked = await lockoutRemaining(email);
  if (locked > 0) return { ok: false, reason: 'locked', retryAfterSeconds: locked };

  const u = await ownerPool.query<{
    id: string; firm_id: string; client_id: string | null;
    algorithm: string; salt: string; verifier: string;
    cost_n: number; block_size_r: number; parallel_p: number;
    must_change: boolean;
  }>(
    `SELECT u.id, u.firm_id, u.client_id, c.algorithm, c.salt, c.verifier,
            c.cost_n, c.block_size_r, c.parallel_p, c.must_change
       FROM users u JOIN user_credentials c ON c.user_id = u.id
      WHERE lower(u.email) = lower($1)`,
    [email]);
  const row = u.rows[0];

  /*
   * The work is done even when the account does not exist.
   *
   * Returning immediately makes an unknown email answer in a millisecond and a
   * known one in a hundred, which is a usable oracle. Hashing against a
   * throwaway salt costs the same as the real thing.
   */
  const salt = Buffer.from(row?.salt ?? randomBytes(16).toString('hex'), 'hex');
  const attempt = await hash(password, salt, {
    N: row?.cost_n ?? SCRYPT.N, r: row?.block_size_r ?? SCRYPT.r,
    p: row?.parallel_p ?? SCRYPT.p, keyLength: SCRYPT.keyLength,
  });

  const stored = row ? Buffer.from(row.verifier, 'hex') : randomBytes(SCRYPT.keyLength);
  const good = row !== undefined
    && attempt.length === stored.length
    && timingSafeEqual(attempt, stored);

  await ownerPool.query(
    `INSERT INTO login_attempts (email, succeeded, ip_address)
     VALUES ($1, $2, $3::inet)`,
    [email, good, ip ?? null]);

  if (!good) return { ok: false, reason: 'bad_credentials' };
  return { ok: true, user: {
    id: row!.id, firm_id: row!.firm_id, client_id: row!.client_id,
    must_change: row!.must_change,
  } };
}

/** Verifies an email and password, and issues a session. */
export async function login(
  email: string, password: string,
  context: { ip?: string; userAgent?: string } = {},
): Promise<LoginResult> {
  const v = await verifyPassword(email, password, context.ip);
  if (!v.ok) {
    return v.reason === 'locked'
      ? { ok: false, reason: 'locked', retryAfterSeconds: v.retryAfterSeconds }
      : { ok: false, reason: 'bad_credentials' };
  }
  const row = v.user;

  /*
   * A user with no client to look at cannot have a session.
   *
   * Every screen is about one client's books. A firm-scoped user with no
   * clients yet would land on a page that cannot render, and inventing a
   * client for them to look at is not this module's decision.
   */
  const client = await firstClientFor(row.firm_id, row.client_id);
  if (client === null) return { ok: false, reason: 'no_client' };

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ABSOLUTE_HOURS * 3_600_000);
  const s = await ownerPool.query<{ id: string }>(
    `INSERT INTO user_sessions
       (user_id, token_sha256, expires_at, ip_address, user_agent)
     VALUES ($1,$2,$3,$4::inet,$5) RETURNING id`,
    [row.id, sha256(token), expiresAt, context.ip ?? null,
     context.userAgent?.slice(0, 500) ?? null]);

  await audit(row.firm_id, client.id, row.id, s.rows[0]!.id, 'login', context);

  return { ok: true, token, expiresAt, mustChangePassword: row.must_change };
}

async function firstClientFor(
  firmId: string, boundClientId: string | null,
): Promise<{ id: string; name: string } | null> {
  const r = await ownerPool.query<{ id: string; name: string }>(
    boundClientId === null
      ? `SELECT id, name FROM clients WHERE firm_id = $1
          ORDER BY created_at LIMIT 1`
      : `SELECT id, name FROM clients WHERE firm_id = $1 AND id = $2`,
    boundClientId === null ? [firmId] : [firmId, boundClientId]);
  return r.rows[0] ?? null;
}

/**
 * Resolves a cookie token to a session, or null.
 *
 * Also the point where idle and absolute expiry bite, and where `last_seen_at`
 * is pushed forward — so a session in use stays alive and one abandoned on a
 * shared machine does not.
 */
export async function sessionFromToken(
  token: string, wantedClientId?: string,
): Promise<Session | null> {
  if (token === '') return null;
  const r = await ownerPool.query<{
    session_id: string; user_id: string; firm_id: string;
    bound_client_id: string | null; email: string; display_name: string;
    role: string; must_change: boolean;
  }>(
    `UPDATE user_sessions s SET last_seen_at = now()
      WHERE s.token_sha256 = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.last_seen_at > now() - ($2 || ' minutes')::interval
      RETURNING s.id AS session_id, s.user_id,
        (SELECT firm_id FROM users WHERE id = s.user_id) AS firm_id,
        (SELECT client_id FROM users WHERE id = s.user_id) AS bound_client_id,
        (SELECT email FROM users WHERE id = s.user_id) AS email,
        (SELECT display_name FROM users WHERE id = s.user_id) AS display_name,
        (SELECT role FROM users WHERE id = s.user_id) AS role,
        COALESCE((SELECT must_change FROM user_credentials WHERE user_id = s.user_id), false)
          AS must_change`,
    [sha256(token), IDLE_MINUTES]);
  const row = r.rows[0];
  if (row === undefined) return null;

  /*
   * Which client, and whether this user may look at it.
   *
   * Two separate checks and both are needed. A CLIENT-SCOPED user may only
   * ever see their own client, whatever the URL says — an SMB owner must not
   * reach another of the firm's clients by editing a query string. A
   * FIRM-scoped user may switch, but only within their own firm, which is the
   * check that stops a URL reaching another firm's books entirely.
   */
  let client: { id: string; name: string } | null;
  if (row.bound_client_id !== null) {
    client = await firstClientFor(row.firm_id, row.bound_client_id);
  } else if (wantedClientId !== undefined) {
    const c = await ownerPool.query<{ id: string; name: string }>(
      'SELECT id, name FROM clients WHERE id = $1 AND firm_id = $2',
      [wantedClientId, row.firm_id]);
    // Not ours: fall back rather than fail, so a stale bookmark lands
    // somewhere legitimate instead of on an error page.
    client = c.rows[0] ?? await firstClientFor(row.firm_id, null);
  } else {
    client = await firstClientFor(row.firm_id, null);
  }
  if (client === null) return null;

  return {
    sessionId: row.session_id, userId: row.user_id, firmId: row.firm_id,
    clientId: client.id, clientName: client.name,
    email: row.email, displayName: row.display_name, role: row.role,
    boundClientId: row.bound_client_id,
    mustChangePassword: row.must_change,
  };
}

/** Ends one session. Idempotent, so a double-click on Sign out is harmless. */
export async function logout(token: string): Promise<void> {
  const r = await ownerPool.query<{ user_id: string; id: string }>(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE token_sha256 = $1 AND revoked_at IS NULL
      RETURNING user_id, id`,
    [sha256(token)]);
  const row = r.rows[0];
  if (row === undefined) return;
  const u = await ownerPool.query<{ firm_id: string; client_id: string | null }>(
    'SELECT firm_id, client_id FROM users WHERE id = $1', [row.user_id]);
  const client = await firstClientFor(u.rows[0]!.firm_id, u.rows[0]!.client_id);
  if (client !== null) {
    await audit(u.rows[0]!.firm_id, client.id, row.user_id, row.id, 'logout', {});
  }
}

/**
 * Changes a password, on proof of the current one.
 *
 * Every other session is revoked, because the usual reason to change a
 * password is that somebody else might know the old one — and leaving their
 * session alive makes the change theatre.
 */
export async function changePassword(
  userId: string, current: string, next: string,
  keepSessionId?: string,
): Promise<void> {
  const u = await ownerPool.query<{ email: string; firm_id: string;
                                    client_id: string | null }>(
    'SELECT email, firm_id, client_id FROM users WHERE id = $1', [userId]);
  if (u.rowCount === 0) throw new ValidationError('no such user', 'AU-1');
  const check = await verifyPassword(u.rows[0]!.email, current);
  if (!check.ok) {
    throw new ValidationError(
      check.reason === 'locked'
        ? 'too many failed attempts on this account — wait, then try again.'
        : 'the current password is not right, so nothing has changed.', 'AU-1');
  }

  await setPassword(userId, next);
  await ownerPool.query(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND id <> COALESCE($2::uuid, id)`,
    [userId, keepSessionId ?? null]);

  // Recorded as what it is — a change to the user — rather than as a login.
  const client = await firstClientFor(u.rows[0]!.firm_id, u.rows[0]!.client_id);
  if (client !== null) {
    await ownerPool.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, actor_user_id,
          actor_type, after)
       VALUES ($1,$2,'user',$3,'update',$3,'human','{"password":"changed"}')`,
      [u.rows[0]!.firm_id, client.id, userId]);
  }
}

/** Drops expired and long-revoked sessions. Run from a schedule. */
export async function purgeSessions(): Promise<number> {
  const r = await ownerPool.query(
    `DELETE FROM user_sessions
      WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`);
  return r.rowCount ?? 0;
}

async function audit(
  firmId: string, clientId: string, userId: string, sessionId: string,
  action: string, ctx: { ip?: string; userAgent?: string },
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO audit_log
       (firm_id, client_id, entity_type, entity_id, action, actor_user_id,
        actor_type, session_id, ip_address, user_agent)
     VALUES ($1,$2,'user',$3,$4,$3,'human',$5,$6::inet,$7)`,
    [firmId, clientId, userId, action, sessionId, ctx.ip ?? null,
     ctx.userAgent?.slice(0, 500) ?? null]);
}
