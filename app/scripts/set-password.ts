/**
 * Issue or reset a user's password.
 *
 *   npx tsx scripts/set-password.ts <email>
 *
 * Generates a strong password, prints it ONCE, and marks it as issued — so it
 * is good for a single login and the user is made to choose their own before
 * they can reach anything (BE-39).
 *
 * ── Why it generates rather than asks ─────────────────────────────────────
 *
 * A password typed on a command line lands in the shell history, in the
 * process list while it runs, and in any terminal recording. Generating it
 * here means the only copy is the one on screen, and it stops working the
 * moment its owner replaces it.
 *
 * Nothing prints an existing password, because none is stored — only a scrypt
 * verifier. A forgotten password is reset by running this again.
 */

import { randomInt } from 'node:crypto';
import { setPassword } from '../src/domain/auth.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';

const email = process.argv[2];
if (!email) {
  console.error('usage: npx tsx scripts/set-password.ts <email>');
  process.exit(1);
}

const u = await ownerPool.query<{ id: string; display_name: string; role: string;
                                  firm: string; client: string | null }>(
  `SELECT u.id, u.display_name, u.role, f.name AS firm,
          (SELECT name FROM clients WHERE id = u.client_id) AS client
     FROM users u JOIN firms f ON f.id = u.firm_id
    WHERE lower(u.email) = lower($1)`, [email]);

if (u.rowCount === 0) {
  console.error(`no user with email ${email}. Users are created with the firm, ` +
                'not here — this only sets a password on one that exists.');
  await closePools();
  process.exit(1);
}
const user = u.rows[0]!;

/*
 * Four words and a number, rather than a line of noise.
 *
 * It has to survive being read off a screen and typed on a phone once. A
 * 24-character random string gets mistyped, retried, and eventually pasted
 * into a chat window; this does not. The entropy is in the word count, and
 * these are drawn from a list long enough that four of them plus a number are
 * far past what scrypt at this cost makes guessable.
 */
const WORDS = [
  'anchor', 'basket', 'candle', 'dossier', 'ember', 'falcon', 'gravel',
  'harbour', 'ivory', 'jasmine', 'kettle', 'lantern', 'marble', 'nutmeg',
  'orchid', 'pewter', 'quarry', 'rafter', 'saffron', 'timber', 'umber',
  'velvet', 'walnut', 'yarrow', 'zephyr', 'bramble', 'cobalt', 'driftwood',
  'eggshell', 'fathom', 'granite', 'hollow', 'indigo', 'juniper', 'kindle',
  'lattice', 'mortar', 'nectar', 'obsidian', 'plinth', 'quiver', 'ripple',
  'sextant', 'thistle', 'upland', 'vellum', 'wicker', 'yonder', 'zenith',
];
const password =
  Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]!).join('-')
  + '-' + String(randomInt(10, 100));

await setPassword(user.id, password, { issued: true });

console.log(`\n  ${user.display_name} — ${user.role}`);
console.log(`  ${user.firm}${user.client ? ` · ${user.client}` : ' · all clients'}`);
console.log(`\n  password:  ${password}`);
console.log(`\n  Printed once and not stored — only a scrypt verifier is kept.`);
console.log(`  It works for ONE sign-in; they will be asked to choose their own.`);
console.log(`  Give it to them by a route you would trust with a bank OTP.\n`);

await closePools();
