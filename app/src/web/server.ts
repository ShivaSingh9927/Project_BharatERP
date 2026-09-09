/**
 * Local review server for the reconciliation screen.
 * Spec: bank-and-reconciliation.md §14.1
 *
 * It binds to 127.0.0.1 only and exists for one purpose: putting the
 * workflow in front of a CA to find out whether it actually saves them time
 * (§16.2, §16.3). Those answers change the product, and no amount of further
 * engine work produces them.
 *
 * ── Authentication (BE-39) ────────────────────────────────────────────────
 *
 * It used to have none: `resolveSession` picked the oldest client and that
 * firm's first user at boot, and every screen trusted it. That made the whole
 * audit trail a fiction — "who approved this bill" is the load-bearing fact
 * (AT-13), and it was being answered by ORDER BY created_at LIMIT 1.
 *
 * Now every route is behind a session cookie, every write is checked for
 * same-origin, and the user on the session is the user recorded as the
 * approver. It still binds to localhost, because a login is not the only thing
 * production needs — TLS, a real secret store, and rate limiting that is not
 * one process's opinion are the rest of it.
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
         renderCashRegister, renderGstr2b } from './views.ts';
import { parseGstr2b } from '../parse/../integrations/gstr2bJson.ts';
import { runReconciliation, latestReconForPeriod, periodsWithRecon,
         resolveReconLine } from '../domain/gstr2bStore.ts';
import { paise, money } from '../domain/tax.ts';
import { loadDashboard } from '../domain/dashboard.ts';
import { outstandingBills, paymentAccounts, recordPayment } from '../domain/payables.ts';
import { renderBillReview, renderDashboard, renderPayables, renderSupplierList, renderSupplier } from './views.ts';
import { supplierList, supplierDetail } from '../domain/suppliers.ts';
import { renderGstr1 } from './views.ts';
import { generateGstr1, salesPeriods } from '../domain/gstr1.ts';
import { renderGstr3b, renderTds, renderReturns, renderReceivables,
         renderStatement } from './views.ts';
import { generateGstr3b, taxPeriods } from '../domain/gstr3b.ts';
import { renderCockpit } from './views.ts';
import { loadCockpit } from '../domain/firmCockpit.ts';
import { setPartyRcmRate } from '../domain/partyRcm.ts';
import { tdsPosition, recordTdsDeposit } from '../domain/tdsCompliance.ts';
import { createPurchaseReturn, recordSupplierCreditNote, purchaseReturns,
         billForReturn } from '../domain/purchaseReturns.ts';
import { outstandingInvoices, recordReceipt, writeOffReceivable,
         customerStatement, receiptAccounts } from '../domain/receivables.ts';
import { formFor } from '../domain/billForm.ts';
import { resolveReaders, purchasesAccount, expenseAccounts, previewBills, postReviewedBill,
         learnedDefaultsFor, lineKey,
         proposalView, type ReviewReaders } from '../domain/billReview.ts';
import { createHash } from 'node:crypto';
import { cashRegisterCheck } from '../reports/cashRegister.ts';
import { login, logout, sessionFromToken, changePassword,
         lockoutRemaining, type Session as AuthSession } from '../domain/auth.ts';
import { renderLogin } from './views.ts';

const PORT = Number(process.env.PORT ?? 4321);

/**
 * Who is signed in. Resolved from the cookie on EVERY request — not once at
 * boot — because that is the difference between an identity and a default.
 */
type Session = AuthSession;

/** Name of the session cookie. */
const COOKIE = 'bharaterp_session';

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * The cookie a browser is asked to keep.
 *
 * HttpOnly so a script on the page cannot read it; SameSite=Strict so it is
 * not sent on any cross-site request at all, which is most of CSRF defence on
 * its own; Path=/ because every route needs it. Not Secure, and that is not an
 * oversight — this serves plain HTTP on localhost, where a Secure cookie would
 * simply never be sent. Behind TLS it must be added, and the note at the
 * bottom of this file says so.
 */
const setCookie = (token: string, expires: Date): string =>
  `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; ` +
  `Expires=${expires.toUTCString()}`;

const clearCookie = (): string =>
  `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/** The caller's address, for the audit trail. */
const callerIp = (req: IncomingMessage): string | undefined =>
  req.socket.remoteAddress ?? undefined;

/**
 * Is this state-changing request coming from our own page?
 *
 * SameSite=Strict already stops a browser sending the cookie cross-site, so
 * this is the second lock rather than the first — it catches the cases where
 * the header is present and wrong, and it costs nothing. A missing Origin on a
 * same-origin form post is normal and allowed; a PRESENT one that disagrees
 * with Host is not.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * The signed-in session for this request, or null.
 *
 * Resolved per request rather than at boot. The client can be switched by
 * query string — the cockpit links into each of the firm's clients — and
 * `sessionFromToken` decides whether this user may look at the one asked for:
 * a client-scoped user never leaves their own, and a firm-scoped one never
 * leaves their firm.
 */
async function currentSession(
  req: IncomingMessage, wantedClientId?: string,
): Promise<Session | null> {
  const token = cookies(req)[COOKIE];
  if (token === undefined) return null;
  return sessionFromToken(token, wantedClientId);
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
    // connect-src 'self' is required, not optional: without it default-src
    // 'none' blocks the same-origin fetch() every interactive screen makes,
    // and the browser reports only "TypeError: Failed to fetch". curl ignores
    // CSP, so this was invisible until the UI was driven from a browser.
    'content-security-policy':
      "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline'; form-action 'self'",
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

/*
 * Uploaded files, held in memory by content hash so a proposal can be re-run
 * at post time without a second upload. A local single-reviewer tool, so a
 * simple bounded map is enough; oldest fall out past the cap.
 */
const fileStash = new Map<string, { file: Buffer; at: number }>();
const STASH_CAP = 20;
function stashFile(file: Buffer): string {
  const token = createHash('sha256').update(file).digest('hex').slice(0, 16);
  fileStash.set(token, { file, at: Date.now() });
  while (fileStash.size > STASH_CAP) {
    const oldest = [...fileStash.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) fileStash.delete(oldest[0]); else break;
  }
  return token;
}

let readers: ReviewReaders = {
  llm: undefined, docling: undefined, parser: undefined, glmOcr: undefined,
  gstinLookup: undefined };

/** The last preview rendered for a client, so a reload can show it again. */
type PreviewCard = ReturnType<typeof proposalView> & { token: string };
const lastPreview = new Map<string, PreviewCard[]>();

/** A handful of the client's most recently posted bills. */
async function recentBills(session: Session): Promise<Array<{
  number: string; party: string; date: string; total: string;
}>> {
  return withFirm(session.firmId, async (c) => {
    const r = await c.query<{ number: string; party: string; date: string; total: string }>(
      `SELECT bill_number AS number, supplier_legal_name AS party,
              to_char(bill_date, 'YYYY-MM-DD') AS date, grand_total::text AS total
         FROM purchase_bills WHERE client_id = $1
        ORDER BY approved_at DESC NULLS LAST LIMIT 10`, [session.clientId]);
    return r.rows;
  });
}

async function handle(
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  /*
   * Everything that CHANGES something must come from our own page.
   *
   * Checked before the session is even resolved, and for every method that is
   * not a read — so a new endpoint added later is covered by default rather
   * than by the author remembering.
   */
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return json(res, 403, {
      ok: false,
      error: 'this request did not come from this page and was refused.',
    });
  }

  // ---- the door ------------------------------------------------------------

  if (path === '/login') {
    if (req.method === 'GET') {
      return html(res, 200, renderLogin({}));
    }
    if (req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      const email = (body.get('email') ?? '').trim();
      const r = await login(email, body.get('password') ?? '', {
        ip: callerIp(req), userAgent: req.headers['user-agent'],
      });
      if (!r.ok) {
        /*
         * One message for every kind of failure.
         *
         * A wrong password, an unknown email and an account with no password
         * all read the same, because a different message for each turns this
         * form into a directory of who banks with which CA. The lockout is the
         * one exception: a user who cannot get in needs to know it is
         * temporary, and by then the address is already known to be real.
         */
        return html(res, r.reason === 'locked' ? 429 : 401, renderLogin({
          email,
          error: r.reason === 'locked'
            ? `Too many attempts. Try again in ` +
              `${Math.ceil((r.retryAfterSeconds ?? 60) / 60)} minute(s).`
            : r.reason === 'no_client'
              ? 'That sign-in is right, but this firm has no client set up yet.'
              : 'Those details do not match an account.',
        }));
      }
      res.setHeader('Set-Cookie', setCookie(r.token, r.expiresAt));
      res.statusCode = 302;
      res.setHeader('Location', r.mustChangePassword ? '/password' : '/');
      res.end();
      return;
    }
  }

  if (req.method === 'POST' && path === '/logout') {
    const token = cookies(req)[COOKIE];
    if (token !== undefined) await logout(token);
    res.setHeader('Set-Cookie', clearCookie());
    res.statusCode = 302;
    res.setHeader('Location', '/login');
    res.end();
    return;
  }

  // ---- the gate ------------------------------------------------------------

  const session = await currentSession(req, url.searchParams.get('client') ?? undefined);
  if (session === null) {
    // An API caller gets an error it can act on; a browser gets the form.
    if (path.startsWith('/api/')) {
      return json(res, 401, { ok: false, error: 'your session has ended — sign in again' });
    }
    res.statusCode = 302;
    res.setHeader('Location', '/login');
    res.end();
    return;
  }

  /*
   * An ISSUED password is good for one login and no further.
   *
   * Somebody other than its owner chose it, so until it is replaced the
   * session can reach exactly one page. Letting it roam would leave a shared
   * password in use indefinitely, which is the state this check exists to end.
   */
  if (session.mustChangePassword && path !== '/password') {
    if (path.startsWith('/api/')) {
      return json(res, 403, {
        ok: false, error: 'set your own password before using this' });
    }
    res.statusCode = 302;
    res.setHeader('Location', '/password');
    res.end();
    return;
  }

  if (path === '/password') {
    if (req.method === 'GET') {
      return html(res, 200, renderLogin({
        changeFor: session.email, issued: session.mustChangePassword }));
    }
    if (req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      try {
        await changePassword(
          session.userId, body.get('current') ?? '', body.get('next') ?? '',
          session.sessionId);
      } catch (e) {
        return html(res, 400, renderLogin({
          changeFor: session.email, issued: session.mustChangePassword,
          error: (e as Error).message,
        }));
      }
      res.statusCode = 302;
      res.setHeader('Location', '/');
      res.end();
      return;
    }
  }

  const accounts = await bankAccounts(session);

  // ---- pages --------------------------------------------------------------

  if (req.method === 'GET' && path === '/firm') {
    const cockpit = await loadCockpit(session.firmId,
      url.searchParams.get('period') ?? undefined);
    return html(res, 200, renderShell({
      session, accounts, active: 'firm', body: renderCockpit(cockpit),
    }));
  }

  if (req.method === 'GET' && path === '/') {
    const dash = await loadDashboard(session.firmId, session.clientId,
      url.searchParams.get('period') ?? undefined);
    return html(res, 200, renderShell({
      session, accounts, active: 'home', body: renderDashboard(dash),
    }));
  }

  if (req.method === 'GET' && path === '/accounts') {
    return html(res, 200, renderShell({
      session, accounts, active: 'accounts',
      body: renderAccounts(accounts),
    }));
  }

  if (req.method === 'GET' && path === '/bills') {
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    const expAccounts = await expenseAccounts(session.firmId, session.clientId);
    const posted = await recentBills(session);
    const fresh = url.searchParams.has('new');
    const cards = fresh ? (lastPreview.get(session.clientId) ?? []) : [];
    return html(res, 200, renderShell({
      session, accounts, active: 'bills',
      body: renderBillReview({
        proposals: cards as never, token: cards[0]?.token ?? null, posted,
        hasExpenseAccount: expenseAccountId !== null,
        accounts: expAccounts, defaultAccountId: expenseAccountId,
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/bills/preview') {
    const body = JSON.parse(await readBody(req));
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    if (!expenseAccountId) return json(res, 200, { ok: false, error: 'no Purchases account' });
    try {
      const all: unknown[] = [];
      for (const f of body.files as Array<{ name: string; data: string }>) {
        const file = Buffer.from(f.data, 'base64');
        const token = stashFile(file);
        const proposals = await previewBills(
          session.firmId, session.clientId, expenseAccountId,
          session.userId, file, readers);
        for (const p of proposals) {
          const view = proposalView(p);
          // Pre-classify each line from what this supplier's lines were posted
          // to before. A suggestion, pre-selected in the picker, never a post.
          if (view.partyId) {
            const learned = await learnedDefaultsFor(
              session.firmId, session.clientId, view.partyId);
            view.lines = view.lines.map((l) => ({
              ...l, suggestedAccountId: learned.get(lineKey(l.description)),
            }));
          }
          all.push({ ...view, token });
        }
      }
      // Cache the last preview so the GET page can render it after reload.
      lastPreview.set(session.clientId, all as PreviewCard[]);
      return json(res, 200, { ok: true, count: all.length });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/bills/fill') {
    /*
     * Re-read the file with the reviewer's answers folded in, and show what
     * they produce. The same gates run, so a mistyped figure is refused here
     * rather than at the moment of posting — the reviewer sees the bill they
     * are about to approve.
     */
    const body = JSON.parse(await readBody(req));
    const stashed = fileStash.get(body.token);
    if (!stashed) return json(res, 200, { ok: false, error: 'this upload has expired — read the file again' });
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    if (!expenseAccountId) return json(res, 200, { ok: false, error: 'no Purchases account' });
    try {
      const proposals = await previewBills(
        session.firmId, session.clientId, expenseAccountId, session.userId,
        stashed.file, readers, body.manual, body.lineAccounts);
      const p = proposals.find((x) => x.index === body.index);
      if (p === undefined) return json(res, 200, { ok: false, error: 'no such document' });
      const view = proposalView(p);
      return json(res, 200, {
        ok: true, ready: p.blockers.length === 0,
        blockers: p.blockers, warnings: p.warnings,
        // The reviewer's line classification came in with this request, so the
        // TDS position reflects it — which is the whole reason to re-read.
        tds: view.tds,
        confirmations: p.confirmations,
        form: formFor(p),
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/parties/rcm-rate') {
    /*
     * Master data, written on a named user's decision.
     *
     * Separate from `/api/bills/fill` on purpose: that endpoint answers
     * questions about one document, this one sets a rate that will price every
     * future bill from this supplier. `setPartyRcmRate` checks the party
     * belongs to this client and that its category can carry a reverse-charge
     * rate at all — a body arriving from a browser is untrusted input, and RLS
     * alone would not stop a firm's own other client's supplier being named.
     */
    const body = JSON.parse(await readBody(req));
    try {
      await setPartyRcmRate(session.firmId, {
        clientId: session.clientId, partyId: body.partyId,
        rate: String(body.rate), provision: body.provision,
        supply: String(body.supply ?? ''),
        effectiveFrom: String(body.effectiveFrom),
        ...(body.notification ? { notification: String(body.notification) } : {}),
        setBy: session.userId,
      });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/bills/post') {
    const body = JSON.parse(await readBody(req));
    const stashed = fileStash.get(body.token);
    if (!stashed) return json(res, 200, { ok: false, error: 'this upload has expired — read the file again' });
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    if (!expenseAccountId) return json(res, 200, { ok: false, error: 'no Purchases account' });
    try {
      const bill = await postReviewedBill(
        session.firmId, session.clientId, expenseAccountId,
        stashed.file, body.index, body.confirm ?? {}, session.userId, readers,
        { lineAccounts: body.lineAccounts, expenseAccountId: body.expenseAccountId,
          blockItc: body.blockItc === true, manual: body.manual,
          tds: body.tds });
      return json(res, 200, { ok: true, voucherId: bill.voucherId });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/suppliers') {
    return html(res, 200, renderShell({
      session, accounts, active: 'suppliers',
      body: renderSupplierList({
        suppliers: await supplierList(session.firmId, session.clientId) }),
    }));
  }

  if (req.method === 'GET' && path.startsWith('/suppliers/')) {
    const id = decodeURIComponent(path.slice('/suppliers/'.length));
    const detail = await supplierDetail(session.firmId, session.clientId, id);
    if (detail === null) {
      return html(res, 404, renderShell({
        session, accounts, active: 'suppliers',
        body: '<h1>Supplier not found</h1><p><a href="/suppliers">← Suppliers</a></p>',
      }));
    }
    return html(res, 200, renderShell({
      session, accounts, active: 'suppliers', body: renderSupplier(detail),
    }));
  }

  if (req.method === 'GET' && path === '/payables') {
    const [bills, payAccounts] = await Promise.all([
      outstandingBills(session.firmId, session.clientId),
      paymentAccounts(session.firmId, session.clientId),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    return html(res, 200, renderShell({
      session, accounts, active: 'payables',
      body: renderPayables({ bills, accounts: payAccounts, today }),
    }));
  }

  if (req.method === 'POST' && path === '/api/payables/pay') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await recordPayment(session.firmId, {
        clientId: session.clientId, billVoucherId: body.billVoucherId,
        amount: body.amount, paidFromAccountId: body.paidFromAccountId,
        paymentDate: body.paymentDate, createdBy: session.userId,
        reference: body.reference,
      });
      return json(res, 200, {
        ok: true, paid: r.paid, outstandingAfter: r.outstandingAfter,
        fullySettled: r.fullySettled,
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/receivables') {
    const party = url.searchParams.get('party');
    if (party !== null) {
      return html(res, 200, renderShell({
        session, accounts, active: 'receivables',
        body: renderStatement(
          await customerStatement(session.firmId, session.clientId, party)),
      }));
    }
    return html(res, 200, renderShell({
      session, accounts, active: 'receivables',
      body: renderReceivables({
        invoices: await outstandingInvoices(session.firmId, session.clientId),
        accounts: await receiptAccounts(session.firmId, session.clientId),
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/receivables/receipt') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await recordReceipt(session.firmId, {
        clientId: session.clientId,
        invoiceVoucherId: String(body.invoiceVoucherId),
        amount: String(body.amount),
        ...(body.tdsWithheld ? { tdsWithheld: String(body.tdsWithheld) } : {}),
        receivedIntoAccountId: String(body.receivedIntoAccountId),
        receiptDate: String(body.receiptDate),
        createdBy: session.userId,
        ...(body.reference ? { reference: String(body.reference) } : {}),
      });
      return json(res, 200, {
        ok: true, received: r.received, tdsWithheld: r.tdsWithheld,
        outstandingAfter: r.outstandingAfter, fullySettled: r.fullySettled,
        warnings: r.warnings,
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/receivables/write-off') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await writeOffReceivable(session.firmId, {
        clientId: session.clientId,
        invoiceVoucherId: String(body.invoiceVoucherId),
        amount: String(body.amount),
        reason: String(body.reason ?? ''),
        writeOffDate: String(body.writeOffDate),
        createdBy: session.userId,
        // Giving up on money owed is a decision, and the person taking it is
        // the one signed in.
        approvedBy: session.userId,
      });
      return json(res, 200, {
        ok: true, writtenOff: r.writtenOff, warnings: r.warnings });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/returns') {
    const billId = url.searchParams.get('bill');
    return html(res, 200, renderShell({
      session, accounts, active: 'returns',
      body: renderReturns({
        returns: await purchaseReturns(session.firmId, session.clientId),
        bill: billId === null ? null
          : await billForReturn(session.firmId, session.clientId, billId),
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/returns/create') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await createPurchaseReturn(session.firmId, {
        clientId: session.clientId,
        billVoucherId: String(body.billVoucherId),
        noteNumber: String(body.noteNumber ?? '').trim(),
        noteDate: String(body.noteDate),
        reason: String(body.reason ?? ''),
        lines: (body.lines as Array<{ billLineNo: number; taxableValue: string }>)
          .map((l) => ({ billLineNo: Number(l.billLineNo),
                         taxableValue: String(l.taxableValue) })),
        createdBy: session.userId,
        // The reviewer posting it IS the approver here: a return is money
        // leaving the expense and coming off a supplier's account.
        approvedBy: session.userId,
        ...(body.supplierCreditNote
          ? { supplierCreditNote: {
                number: String(body.supplierCreditNote.number),
                date: String(body.supplierCreditNote.date) } }
          : {}),
      });
      return json(res, 200, {
        ok: true, grandTotal: r.grandTotal, warnings: r.warnings,
        awaiting: r.awaitingSupplierCreditNote,
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/returns/credit-note') {
    const body = JSON.parse(await readBody(req));
    try {
      await recordSupplierCreditNote(session.firmId, {
        clientId: session.clientId,
        returnVoucherId: String(body.returnVoucherId),
        number: String(body.number), date: String(body.date),
      });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/tds') {
    /*
     * As of TODAY, and that is the whole value of the page: interest under
     * s.201(1A) accrues per month or part of a month, so the same unpaid
     * deduction costs more tomorrow than it does now.
     */
    const asOf = new Date().toISOString().slice(0, 10);
    const pos = await tdsPosition(session.firmId, session.clientId, asOf);
    return html(res, 200, renderShell({
      session, accounts, active: 'tds',
      body: renderTds({
        ...pos,
        paymentAccounts: await paymentAccounts(session.firmId, session.clientId),
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/tds/deposit') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await recordTdsDeposit(session.firmId, {
        clientId: session.clientId, period: String(body.period),
        depositedOn: String(body.depositedOn), tax: String(body.tax),
        interest: body.interest ? String(body.interest) : '0',
        lateFee: body.lateFee ? String(body.lateFee) : '0',
        paidFromAccountId: String(body.paidFromAccountId),
        ...(body.bsrCode ? { bsrCode: String(body.bsrCode) } : {}),
        ...(body.challanSerial ? { challanSerial: String(body.challanSerial) } : {}),
        createdBy: session.userId,
      });
      return json(res, 200, { ok: true, remitted: r.remitted });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/gstr3b') {
    const periods = await taxPeriods(session.firmId, session.clientId);
    const period = url.searchParams.get('period') ?? periods[0]
      ?? new Date().toISOString().slice(0, 7);
    const g = await generateGstr3b(session.firmId, session.clientId, period);
    return html(res, 200, renderShell({
      session, accounts, active: 'gstr3b',
      body: renderGstr3b({ ...g, periods }),
    }));
  }

  if (req.method === 'GET' && path === '/gstr1') {
    const periods = await salesPeriods(session.firmId, session.clientId);
    const period = url.searchParams.get('period') ?? periods[0]
      ?? new Date().toISOString().slice(0, 7);
    const g = await generateGstr1(session.firmId, session.clientId, period);
    return html(res, 200, renderShell({
      session, accounts, active: 'gstr1',
      body: renderGstr1({ ...g, periods }),
    }));
  }

  if (req.method === 'GET' && path === '/gstr2b') {
    const periods = await periodsWithRecon(session.firmId, session.clientId);
    const period = url.searchParams.get('period') ?? periods[0]
      ?? new Date().toISOString().slice(0, 7);
    const lines = periods.length
      ? await latestReconForPeriod(session.firmId, session.clientId, period)
      : [];
    // The two figures the CA came for.
    let supported = 0n, atRisk = 0n;
    for (const l of lines) {
      if (l.status === 'matched' && l.billTax) supported += paise(l.billTax);
      if (l.status === 'in_books_only' && l.supplierGstin && l.billTax)
        atRisk += paise(l.billTax);
    }
    return html(res, 200, renderShell({
      session, accounts, active: 'gstr2b',
      body: renderGstr2b({
        period, periods, lines,
        creditSupported: money(supported), creditAtRisk: money(atRisk),
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/2b/run') {
    const body = JSON.parse(await readBody(req));
    try {
      const filed = parseGstr2b(body.json);
      await runReconciliation(session.firmId, session.clientId, body.period,
        filed, body.json, 'portal-json');
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/2b/resolve') {
    const body = JSON.parse(await readBody(req));
    await resolveReconLine(session.firmId, body.id, session.userId);
    return json(res, 200, { ok: true });
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

readers = await resolveReaders();

createServer((req, res) => {
  handle(req, res).catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`  ${req.method} ${req.url} — ${message}`);
    if (!res.headersSent) json(res, 500, { ok: false, error: message });
    else res.end();
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\n  BharatERP review server`);
  console.log(`  http://127.0.0.1:${PORT}`);
  const on = [readers.docling && 'Docling', readers.llm && 'model',
              readers.gstinLookup && 'GSTIN lookup'].filter(Boolean);
  console.log(`  readers: ${on.length ? on.join(', ') : 'on-page only'}`);
  console.log(`  sign in at /login — set a password with ` +
              `npx tsx scripts/set-password.ts <email>`);
  /*
   * Still not production, and the reason is no longer the login.
   *
   * The cookie cannot be Secure over plain HTTP, so on anything but localhost
   * it would travel in clear. TLS, a cookie marked Secure, and rate limiting
   * that is not one process's opinion are what remains.
   */
  console.log(`\n  Localhost only: no TLS, so the session cookie is not Secure.\n`);
});
