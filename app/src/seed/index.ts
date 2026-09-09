/**
 * Seeding helpers: create a firm, a client, its fiscal years, and its chart of
 * accounts from the India template.
 */

import type { PoolClient } from 'pg';
import { withFirm, ownerPool } from '../db/pool.ts';
import { INDIA_COA, defaultNormalBalance, type CoaNode, type CoaRoot } from './indiaChartOfAccounts.ts';
import type { RootType } from '../domain/types.ts';
import { seedTdsHeads } from './tdsSections.ts';

export interface SeededTenant {
  firmId: string;
  clientId: string;
  userId: string;
  fiscalYearId: string;
  /** Account id by name, for convenience in tests and scripts. */
  accounts: Record<string, string>;
}

/**
 * Creates the firm/client/user rows. Runs as the schema owner because
 * row-level security needs a firm to exist before it can be selected into.
 */
export async function createTenant(opts: {
  firmName: string; clientName: string; userEmail: string;
  gstin?: string; pan?: string;
  /** Section 17(5) exceptions depend on this (G-3). */
  businessType?: string;
}): Promise<{ firmId: string; clientId: string; userId: string }> {
  const c = await ownerPool.connect();
  try {
    await c.query('BEGIN');
    const firm = await c.query<{ id: string }>(
      'INSERT INTO firms (name) VALUES ($1) RETURNING id', [opts.firmName]);
    const firmId = firm.rows[0]!.id;

    const client = await c.query<{ id: string }>(
      `INSERT INTO clients (firm_id, name, pan, business_type)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [firmId, opts.clientName, opts.pan ?? null, opts.businessType ?? null]);
    const clientId = client.rows[0]!.id;

    // A GSTIN is now a registration under the client, not a field on it (G-22).
    // The state code is derived from the GSTIN rather than accepted separately:
    // the first two characters of a GSTIN ARE the state code, and the database
    // enforces that they agree, so taking a caller's word for it would only
    // create a way for the two to disagree.
    if (opts.gstin) {
      await c.query(
        `INSERT INTO client_registrations
           (firm_id, client_id, gstin, state_code, is_primary)
         VALUES ($1,$2,$3,$4,true)`,
        [firmId, clientId, opts.gstin, opts.gstin.slice(0, 2)]);
    }

    const user = await c.query<{ id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1,$2,$3,'ca_partner') RETURNING id`,
      [firmId, opts.userEmail, opts.userEmail.split('@')[0]!]);

    await c.query('COMMIT');
    return { firmId, clientId, userId: user.rows[0]!.id };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Indian fiscal year: 1 April – 31 March.
 * `startYear` 2026 produces FY 2026-27 (1 Apr 2026 – 31 Mar 2027).
 */
export async function createFiscalYear(
  firmId: string, clientId: string, startYear: number,
): Promise<string> {
  return withFirm(firmId, async (c) => {
    const label = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
    const fy = await c.query<{ id: string }>(
      `INSERT INTO fiscal_years (client_id, label, start_date, end_date)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [clientId, label, `${startYear}-04-01`, `${startYear + 1}-03-31`]);
    const fyId = fy.rows[0]!.id;

    // One accounting period per month, all open.
    for (let i = 0; i < 12; i++) {
      const m = ((3 + i) % 12) + 1;                    // Apr = 4 … Mar = 3
      const y = m >= 4 ? startYear : startYear + 1;
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0))
        .toISOString().slice(0, 10);
      await c.query(
        `INSERT INTO accounting_periods (client_id, fiscal_year_id, label, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5)`,
        [clientId, fyId, `${y}-${String(m).padStart(2, '0')}`, start, end]);
    }
    return fyId;
  });
}

/** Walks the India template and inserts the tree depth-first. */
export async function seedChartOfAccounts(
  firmId: string, clientId: string, createdBy: string,
): Promise<Record<string, string>> {
  return withFirm(firmId, async (c) => {
    const byName: Record<string, string> = {};

    const insert = async (
      node: CoaNode, rootType: RootType, parentId: string | null, isGroup: boolean,
    ): Promise<string> => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO accounts
           (firm_id, client_id, code, name, parent_id, is_group, root_type,
            account_type, normal_balance, expense_class, liquidity_class,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING id`,
        [
          firmId, clientId, node.code ?? null, node.name, parentId, isGroup, rootType,
          node.accountType ?? 'general',
          node.normalBalance ?? defaultNormalBalance(rootType),
          rootType === 'expense' ? (node.expenseClass ?? null) : null,
          ['asset', 'liability'].includes(rootType) ? (node.liquidityClass ?? null) : null,
          createdBy,
        ],
      );
      byName[node.name] = r.rows[0]!.id;
      return r.rows[0]!.id;
    };

    const walk = async (node: CoaNode, rootType: RootType, parentId: string | null) => {
      const hasChildren = !!node.children?.length;
      const id = await insert(node, rootType, parentId, hasChildren);
      for (const child of node.children ?? []) await walk(child, rootType, id);
    };

    for (const root of INDIA_COA as CoaRoot[]) await walk(root, root.rootType, null);
    return byName;
  });
}

/** Full tenant setup, used by tests and by `npm run seed`. */
export async function seedTenant(opts: {
  firmName: string; clientName: string; userEmail: string; startYear: number;
  /** The client's identity (G-22). GSTINs attach via `registerGstin`. */
  pan?: string;
  /** What the client does — unblocks conditional ITC categories (G-3). */
  businessType?: string;
}): Promise<SeededTenant> {
  const { firmId, clientId, userId } = await createTenant(opts);
  const fiscalYearId = await createFiscalYear(firmId, clientId, opts.startYear);
  const accounts = await seedChartOfAccounts(firmId, clientId, userId);
  /*
   * Tagging the chart is part of creating it, not an optional extra.
   *
   * `seedItcEligibility` is still called separately by callers that want it,
   * but the TDS heads are folded in here on purpose: a chart whose
   * "Professional Fees" account does not know it is s.194J work will post a
   * ₹2,00,000 bill with no mention of the ₹20,000 the client had to deduct,
   * and nothing in the tests or the UI would look wrong.
   */
  await seedTdsHeads(clientId);
  return { firmId, clientId, userId, fiscalYearId, accounts };
}

/**
 * Give a client a GST registration (G-22).
 *
 * A client is a PAN and may hold a GSTIN in several states, so this is the only
 * way to attach one. The state code is derived from the GSTIN rather than
 * passed in: its first two characters ARE the state code, and the database
 * enforces the two agree, so accepting it separately would only create a way
 * for them to disagree.
 *
 * The first registration added becomes the primary unless told otherwise —
 * `one_primary_per_client` makes a second primary a database error rather than
 * a silently ambiguous default.
 */
export async function registerGstin(
  firmId: string, clientId: string, gstin: string,
  opts: { primary?: boolean } = {},
): Promise<string> {
  const existing = await ownerPool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM client_registrations WHERE client_id = $1',
    [clientId]);
  const primary = opts.primary ?? existing.rows[0]!.n === '0';

  const r = await ownerPool.query<{ id: string }>(
    `INSERT INTO client_registrations
       (firm_id, client_id, gstin, state_code, is_primary)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    // The state code is derived here rather than in SQL, and the
    // `state_code_matches_gstin` CHECK is what actually guarantees the two
    // agree — the derivation is a convenience, the constraint is the promise.
    [firmId, clientId, gstin, gstin.slice(0, 2), primary]);
  return r.rows[0]!.id;
}
