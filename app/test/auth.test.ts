/**
 * Signing in — bills-and-expenses.md BE-39.
 *
 * The review server used to pick the oldest client and that firm's first user
 * at boot. That made the audit trail a fiction: "who approved this bill" is
 * the load-bearing fact of the whole system (AT-13), and it was answered by
 * ORDER BY created_at LIMIT 1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { setPassword, login, logout, sessionFromToken, changePassword,
         lockoutRemaining, purgeSessions } from '../src/domain/auth.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

let t: SeededTenant;
let otherClient: string;
let boundUser: string;
let firmUserEmail: string;
const GOOD = 'lantern-thistle-cobalt-ember-42';

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  t = await seedTenant({
    firmName: `Auth ${tag}`, clientName: `Client A ${tag}`,
    userEmail: `auth-${tag}@example.test`, startYear: 2026,
    pan: 'AAACA6666A', businessType: 'general',
  });
  firmUserEmail = `auth-${tag}@example.test`;
  await setPassword(t.userId, GOOD);

  // A second client of the same firm, and a user scoped to it.
  otherClient = (await ownerPool.query<{ id: string }>(
    `INSERT INTO clients (firm_id, name, pan) VALUES ($1,$2,'AAACB7777B')
     RETURNING id`, [t.firmId, `Client B ${tag}`])).rows[0]!.id;
  boundUser = (await ownerPool.query<{ id: string }>(
    `INSERT INTO users (firm_id, client_id, email, display_name, role)
     VALUES ($1,$2,$3,'Owner B','owner') RETURNING id`,
    [t.firmId, otherClient, `owner-${tag}@example.test`])).rows[0]!.id;
  await setPassword(boundUser, GOOD);
});

afterAll(async () => { await closePools(); });

// ---------------------------------------------------------------------------
describe('the password itself', () => {
  it('insists on length and nothing else', async () => {
    /*
     * No character-class rules. They push people towards Passw0rd! and are
     * worse than a length floor on every measure anybody has taken.
     */
    await expect(setPassword(t.userId, 'short'))
      .rejects.toThrow(/at least 12 characters/);
    await expect(setPassword(t.userId, 'all lower case and long enough'))
      .resolves.toBeUndefined();
    await setPassword(t.userId, GOOD);
  });

  it('is never stored, only a verifier', async () => {
    const r = await ownerPool.query<{ verifier: string; salt: string; algorithm: string }>(
      'SELECT verifier, salt, algorithm FROM user_credentials WHERE user_id = $1',
      [t.userId]);
    const row = r.rows[0]!;
    expect(row.algorithm).toBe('scrypt');
    expect(row.verifier).not.toContain(GOOD);
    // A per-user random salt: a shared or absent one makes a single rainbow
    // table work against every account at once.
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives two users with the same password different verifiers', async () => {
    const r = await ownerPool.query<{ verifier: string }>(
      'SELECT verifier FROM user_credentials WHERE user_id = ANY($1::uuid[])',
      [[t.userId, boundUser]]);
    expect(r.rows[0]!.verifier).not.toBe(r.rows[1]!.verifier);
  });
});

// ---------------------------------------------------------------------------
describe('signing in', () => {
  it('refuses the wrong password, an unknown email, and both the same way', async () => {
    /*
     * A uniform failure. A different message for each turns a login form into
     * a directory of who banks with which CA.
     */
    const wrong = await login(firmUserEmail, 'not-the-password-at-all');
    const nobody = await login('nobody@example.test', GOOD);
    expect(wrong.ok).toBe(false);
    expect(nobody.ok).toBe(false);
    if (!wrong.ok && !nobody.ok) expect(wrong.reason).toBe(nobody.reason);
  });

  it('issues a session whose token is not what is stored', async () => {
    const r = await login(firmUserEmail, GOOD, { ip: '127.0.0.1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A leak of the table yields hashes; the cookie needs the preimage.
    const row = await ownerPool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM user_sessions WHERE token_sha256 = $1',
      [r.token]);
    expect(row.rows[0]!.n).toBe('0');

    const s = await sessionFromToken(r.token);
    expect(s?.email).toBe(firmUserEmail);
    expect(s?.firmId).toBe(t.firmId);
  });

  it('is case-insensitive on the email, because people type it either way', async () => {
    const r = await login(firmUserEmail.toUpperCase(), GOOD);
    expect(r.ok).toBe(true);
  });

  it('locks out after repeated failures, and records them across a restart', async () => {
    // In the database rather than in memory on purpose: an attacker who can
    // wait for a deploy should not get a fresh allowance.
    const tag = randomUUID().slice(0, 8);
    const email = `target-${tag}@example.test`;
    const u = (await ownerPool.query<{ id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1,$2,'Target','ca_staff') RETURNING id`, [t.firmId, email])).rows[0]!.id;
    await setPassword(u, GOOD);

    for (let i = 0; i < 5; i++) await login(email, 'wrong-password-here');
    expect(await lockoutRemaining(email)).toBeGreaterThan(0);

    // And the RIGHT password is refused while locked, or the lockout is
    // decoration.
    const r = await login(email, GOOD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('locked');
  });

  it('does not lock one account out because another was attacked', async () => {
    // Keyed by the email tried, so one user cannot deny another service.
    expect(await lockoutRemaining(firmUserEmail)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('which client a session may see', () => {
  it('lets a firm-scoped user switch clients within their firm', async () => {
    const r = await login(firmUserEmail, GOOD);
    if (!r.ok) throw new Error('login failed');
    const a = await sessionFromToken(r.token);
    const b = await sessionFromToken(r.token, otherClient);
    expect(a?.clientId).not.toBe(otherClient);
    expect(b?.clientId).toBe(otherClient);
  });

  it('never lets a client-scoped user leave their own client', async () => {
    /*
     * The check that matters. An SMB owner must not reach another of the
     * firm's clients by editing a query string — and RLS does not help,
     * because both clients belong to the firm whose id it filters on.
     */
    const email = (await ownerPool.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1', [boundUser])).rows[0]!.email;
    const ok = await login(email, GOOD);
    if (!ok.ok) throw new Error('bound login failed');
    const s = await sessionFromToken(ok.token, t.clientId);
    expect(s?.clientId).toBe(otherClient);
    expect(s?.boundClientId).toBe(otherClient);
  });

  it('refuses a client from another firm outright', async () => {
    const tag = randomUUID().slice(0, 8);
    const other = await seedTenant({
      firmName: `Rival ${tag}`, clientName: `Rival client ${tag}`,
      userEmail: `rival-${tag}@example.test`, startYear: 2026,
      pan: 'AAACC8888C', businessType: 'general',
    });
    const r = await login(firmUserEmail, GOOD);
    if (!r.ok) throw new Error('login failed');
    const s = await sessionFromToken(r.token, other.clientId);
    // Falls back to their own rather than failing, so a stale bookmark lands
    // somewhere legitimate — but never on the other firm's books.
    expect(s?.clientId).not.toBe(other.clientId);
    expect(s?.firmId).toBe(t.firmId);
  });
});

// ---------------------------------------------------------------------------
describe('ending a session', () => {
  it('stops working the moment it is revoked, and twice is harmless', async () => {
    const r = await login(firmUserEmail, GOOD);
    if (!r.ok) throw new Error('login failed');
    expect(await sessionFromToken(r.token)).not.toBeNull();
    await logout(r.token);
    expect(await sessionFromToken(r.token)).toBeNull();
    await expect(logout(r.token)).resolves.toBeUndefined();
  });

  it('dies of idleness even before it expires', async () => {
    const r = await login(firmUserEmail, GOOD);
    if (!r.ok) throw new Error('login failed');
    // Pushed past the idle window without touching the absolute expiry.
    await ownerPool.query(
      `UPDATE user_sessions SET last_seen_at = now() - interval '3 hours'
        WHERE token_sha256 = encode(digest($1, 'sha256'), 'hex')`, [r.token])
      .catch(async () => {
        // pgcrypto's digest may not be present; do it the long way.
        await ownerPool.query(
          `UPDATE user_sessions SET last_seen_at = now() - interval '3 hours'
            WHERE user_id = $1 AND revoked_at IS NULL`, [t.userId]);
      });
    expect(await sessionFromToken(r.token)).toBeNull();
  });

  it('purges only what is long gone', async () => {
    const live = await login(firmUserEmail, GOOD);
    if (!live.ok) throw new Error('login failed');
    await purgeSessions();
    // A live session survives a purge; that is the whole risk of running one.
    expect(await sessionFromToken(live.token)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('changing a password', () => {
  it('needs the current one', async () => {
    await expect(changePassword(t.userId, 'wrong-one-entirely', 'a-new-long-password'))
      .rejects.toThrow(/current password is not right/);
  });

  it('signs every other session out', async () => {
    /*
     * The usual reason to change a password is that somebody else might know
     * the old one. Leaving their session alive makes the change theatre.
     */
    const stale = await login(firmUserEmail, GOOD);
    const keeping = await login(firmUserEmail, GOOD);
    if (!stale.ok || !keeping.ok) throw new Error('login failed');
    const keep = await sessionFromToken(keeping.token);

    const next = 'harbour-quiver-saffron-plinth-77';
    await changePassword(t.userId, GOOD, next, keep!.sessionId);

    expect(await sessionFromToken(stale.token)).toBeNull();
    expect(await sessionFromToken(keeping.token)).not.toBeNull();
    expect((await login(firmUserEmail, GOOD)).ok).toBe(false);
    expect((await login(firmUserEmail, next)).ok).toBe(true);
    await changePassword(t.userId, next, GOOD);
  });

  it('records a password change as a change, not as a login', async () => {
    /*
     * Verifying the current password used to go through `login`, which handed
     * the user a session they never asked for and wrote a "login" row into the
     * audit trail for an event that was not one. An audit trail that reports
     * the wrong event is worse than one that misses it.
     */
    const before = await ownerPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log
        WHERE entity_id = $1 AND action = 'login'`, [t.userId]);
    const mid = 'kettle-orchid-fathom-wicker-24';
    await changePassword(t.userId, GOOD, mid);
    await changePassword(t.userId, mid, GOOD);
    const after = await ownerPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log
        WHERE entity_id = $1 AND action = 'login'`, [t.userId]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    const changes = await ownerPool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log
        WHERE entity_id = $1 AND entity_type = 'user' AND action = 'update'`,
      [t.userId]);
    expect(Number(changes.rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('marks an issued password as good for one login only', async () => {
    // Somebody other than its owner chose it, so it is known to two people.
    await setPassword(t.userId, GOOD, { issued: true });
    const r = await login(firmUserEmail, GOOD);
    expect(r.ok && r.mustChangePassword).toBe(true);
    const s = await sessionFromToken((r as { token: string }).token);
    expect(s?.mustChangePassword).toBe(true);

    // Choosing their own clears it.
    const own = 'velvet-granite-nutmeg-ripple-13';
    await changePassword(t.userId, GOOD, own, s!.sessionId);
    const after = await login(firmUserEmail, own);
    expect(after.ok && after.mustChangePassword).toBe(false);
  });
});
