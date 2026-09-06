/**
 * Local review server for the reconciliation screen.
 * Spec: bank-and-reconciliation.md §14.1
 *
 * ⚠️ THIS HAS NO AUTHENTICATION AND IS NOT A PRODUCTION SERVER.
 *
 * It binds to 127.0.0.1 only and exists for one purpose: putting the
 * reconciliation workflow in front of a CA to find out whether it actually
 * saves them time (§16.2, §16.3). Those answers change the product, and no
 * amount of further engine work produces them.
 *
 * Deliberately dependency-free — node:http and server-rendered HTML. A build
 * step and a framework are commitments; this is a question being asked.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ownerPool, withFirm } from '../db/pool.ts';
import { reconciliationQueue } from '../domain/matching.ts';
import { importStatementFile } from '../domain/statement.ts';
import { parseStatementFile } from '../parse/statementFile.ts';
import { settleInvoiceFromBankLine, postBankCharge, postInterestCredit } from '../domain/banking.ts';
import { bankReconciliationStatement } from '../domain/brs.ts';
import { TEMPLATES } from '../parse/bankTemplates.ts';
import { renderShell, renderQueue, renderImport, renderBrs, renderAccounts,
         renderCashRegister } from './views.ts';
import { cashRegisterCheck } from '../reports/cashRegister.ts';

const PORT = Number(process.env.PORT ?? 4321);

/** Resolved once at boot so the screens need no login. */
interface Session {
  firmId: string;
  clientId: string;
  userId: string;
  clientName: string;
}

async function resolveSession(): Promise<Session> {
  const r = await ownerPool.query<Session & { firm_id: string; client_id: string;
                                              user_id: string; client_name: string }>(
    `SELECT c.firm_id, c.id AS client_id, c.name AS client_name,
            (SELECT id FROM users u WHERE u.firm_id = c.firm_id ORDER BY u.created_at LIMIT 1) AS user_id
     FROM clients c ORDER BY c.created_at LIMIT 1`);
  if (r.rowCount === 0) {
    throw new Error('no client found — run `npm run seed` first');
  }
  const row = r.rows[0]!;
  if (!row.user_id) throw new Error('the firm has no users — run `npm run seed` first');
  return {
    firmId: row.firm_id, clientId: row.client_id,
    userId: row.user_id, clientName: row.client_name,
  };
}

// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // A statement file is small. Anything larger is a mistake or an attack.
    if (size > 8 * 1024 * 1024) throw new Error('upload exceeds the 8 MB limit');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // No external requests, no framing, no sniffing. Cheap and worth having
    // even on a local tool.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
};

const html = (res: ServerResponse, code: number, body: string): void => {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
};

// ---------------------------------------------------------------------------

async function bankAccounts(session: Session): Promise<Array<{
  id: string; bank_name: string; last4: string; kind: string;
}>> {
  // withFirm, not a raw connection. Setting app.firm_id with is_local=false on
  // a POOLED connection leaves the tenant context behind for whoever borrows it
  // next — harmless in a single-firm local tool, and exactly the leak the
  // helper exists to prevent. No reason to hand-roll the unsafe version.
  return withFirm(session.firmId, async (c) => {
    const r = await c.query(
      `SELECT id, bank_name, account_number_last4 AS last4, kind::text
       FROM bank_accounts WHERE client_id = $1 ORDER BY bank_name`,
      [session.clientId]);
    return r.rows;
  });
}

async function handle(
  req: IncomingMessage, res: ServerResponse, session: Session,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const accounts = await bankAccounts(session);

  // ---- pages --------------------------------------------------------------

  if (req.method === 'GET' && (path === '/' || path === '/accounts')) {
    return html(res, 200, renderShell({
      session, accounts, active: 'accounts',
      body: renderAccounts(accounts),
    }));
  }

  if (req.method === 'GET' && path === '/reconcile') {
    const accountId = url.searchParams.get('account') ?? accounts[0]?.id;
    if (!accountId) {
      return html(res, 200, renderShell({
        session, accounts, active: 'reconcile',
        body: '<p class="empty">No bank account yet. Add one before reconciling.</p>',
      }));
    }
    const [queue, brs] = await Promise.all([
      reconciliationQueue(session.firmId, accountId),
      bankReconciliationStatement(session.firmId, accountId,
        new Date().toISOString().slice(0, 10)),
    ]);
    return html(res, 200, renderShell({
      session, accounts, active: 'reconcile', accountId,
      body: renderQueue(queue, brs, accountId),
    }));
  }

  if (req.method === 'GET' && path === '/import') {
    return html(res, 200, renderShell({
      session, accounts, active: 'import',
      body: renderImport({ accounts, banks: TEMPLATES.map((t) => t.bank) }),
    }));
  }

  if (req.method === 'GET' && path === '/brs') {
    const accountId = url.searchParams.get('account') ?? accounts[0]?.id;
    if (!accountId) return html(res, 404, 'no account');
    const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
    const brs = await bankReconciliationStatement(session.firmId, accountId, asOf);
    return html(res, 200, renderShell({
      session, accounts, active: 'brs', accountId,
      body: renderBrs(brs, accountId),
    }));
  }

  if (req.method === 'GET' && path === '/cash') {
    // Defaults to the current financial year to date. Review answer B3 says
    // firms work monthly at close, but a cash error found in July was usually
    // made in April, so the wider window is the more useful default.
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from')
      ?? `${Number(today.slice(0, 4)) - (today.slice(5, 7) < '04' ? 1 : 0)}-04-01`;
    const to = url.searchParams.get('to') ?? today;
    const check = await cashRegisterCheck(session.firmId, session.clientId, { from, to });
    return html(res, 200, renderShell({
      session, accounts, active: 'cash',
      body: renderCashRegister(check, from, to),
    }));
  }

  // ---- actions ------------------------------------------------------------

  if (req.method === 'POST' && path === '/api/preview') {
    const { fileText, bank } = JSON.parse(await readBody(req));
    try {
      const parse = parseStatementFile(fileText, { bank: bank || undefined });
      return json(res, 200, {
        ok: true,
        bank: parse.bank,
        rowCount: parse.rows.length,
        openingBalance: parse.openingBalance,
        closingBalance: parse.closingBalance,
        periodFrom: parse.periodFrom,
        periodTo: parse.periodTo,
        warnings: parse.warnings,
        skippedRows: parse.skippedRows,
        rows: parse.rows.slice(0, 12),
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/import') {
    const body = JSON.parse(await readBody(req));
    const outcome = await importStatementFile(session.firmId, {
      clientId: session.clientId,
      bankAccountId: body.bankAccountId,
      fileText: body.fileText,
      bank: body.bank || undefined,
      openingBalance: body.openingBalance || undefined,
      closingBalance: body.closingBalance || undefined,
      uploadedBy: session.userId,
    });
    return json(res, 200, {
      ok: outcome.result !== null,
      error: outcome.error,
      bank: outcome.parse.bank,
      imported: outcome.result?.imported ?? 0,
      duplicates: outcome.result?.duplicates ?? 0,
      arithmetic: outcome.result?.arithmetic ?? null,
      warnings: [...outcome.parse.warnings, ...(outcome.result?.warnings ?? [])],
    });
  }

  if (req.method === 'POST' && path === '/api/accept') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await settleInvoiceFromBankLine(session.firmId, {
        clientId: session.clientId,
        bankTransactionId: body.bankTransactionId,
        invoiceVoucherId: body.voucherId,
        amount: body.amount || undefined,
        treatShortfallAsTds: body.treatShortfallAsTds === true,
        matchType: body.matchType ?? 'manual',
        confidence: body.confidence ?? undefined,
        evidence: body.evidence ?? undefined,
        createdBy: session.userId,
      });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/classify') {
    const body = JSON.parse(await readBody(req));
    try {
      if (body.kind === 'bank_charge') {
        const r = await postBankCharge(session.firmId, {
          clientId: session.clientId,
          bankTransactionId: body.bankTransactionId,
          amount: body.amount,
          gstAmount: body.gstAmount || '0',
          createdBy: session.userId,
        });
        return json(res, 200, { ok: true, ...r });
      }
      if (body.kind === 'interest') {
        const r = await postInterestCredit(session.firmId, {
          clientId: session.clientId,
          bankTransactionId: body.bankTransactionId,
          grossInterest: body.grossInterest,
          createdBy: session.userId,
        });
        return json(res, 200, { ok: true, ...r });
      }
      return json(res, 400, { ok: false, error: `unknown classification "${body.kind}"` });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/ignore') {
    const body = JSON.parse(await readBody(req));
    try {
      await withFirm(session.firmId, (c) => c.query(
        'UPDATE bank_transactions SET is_ignored = true WHERE id = $1',
        [body.bankTransactionId]));
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return html(res, 404, renderShell({
    session, accounts, active: '',
    body: `<p class="empty">No route for <code>${path.replace(/[<>&]/g, '')}</code>.</p>`,
  }));
}

// ---------------------------------------------------------------------------

const session = await resolveSession();

createServer((req, res) => {
  handle(req, res, session).catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`  ${req.method} ${req.url} — ${message}`);
    if (!res.headersSent) json(res, 500, { ok: false, error: message });
    else res.end();
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  BharatERP review server`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  firm ${session.firmId}`);
  console.log(`  client ${session.clientName}`);
  console.log(`\n  No authentication. Localhost only. Not for production.\n`);
});
