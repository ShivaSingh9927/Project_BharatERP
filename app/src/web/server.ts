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
import { readFile } from 'node:fs/promises';
import { ownerPool, withFirm } from '../db/pool.ts';
import { reconciliationQueue } from '../domain/matching.ts';
import { addDeepSeekFundingSuggestions, setBankClassifierEnabled }
  from '../domain/bankFundingClassifier.ts';
import { billClassifierEnabled, setBillClassifierEnabled,
         suggestBillLineAccounts } from '../domain/billExpenseClassifier.ts';
import { bankSyncCoverage, importStatementBytes, importStatementFile,
         confirmStatementBankAccount } from '../domain/statement.ts';
import {
  saveStatementPassword, savedStatementPassword, statementPasswordSettings,
  setStatementAutoOpenConsent, forgetStatementPassword,
} from '../domain/bankStatementPassword.ts';
import { parseStatementBytes, parseStatementFile } from '../parse/statementFile.ts';
import { createBankAccount, settleInvoiceFromBankLine, postBankCharge,
         postInterestCredit, bankReviewOptions, reviewBankTransaction,
         ignoreBankTransaction,
         postOpeningFromFirstStatement }
  from '../domain/banking.ts';
import { bankReconciliationStatement } from '../domain/brs.ts';
import { bankClassificationCapability, hasBankCapability } from '../domain/bankPermissions.ts';
import { TEMPLATES } from '../parse/bankTemplates.ts';
import { renderShell, renderQueue, renderImport, renderBrs, renderAccounts,
         renderBankAccountSetup,
         renderCashRegister, renderGstr2b, renderClientSetup } from './views.ts';
import { parseGstr2b } from '../parse/../integrations/gstr2bJson.ts';
import { runReconciliation, latestReconForPeriod, periodsWithRecon,
         resolveReconLine } from '../domain/gstr2bStore.ts';
import { paise, money } from '../domain/tax.ts';
import { loadDashboard } from '../domain/dashboard.ts';
import { answerAssistantWithAi, assistantRuns, recordAssistantRun } from '../domain/assistant.ts';
import { llmClientFromEnv } from '../parse/llmTable.ts';
import { outstandingBills, paymentAccounts, recordPayment } from '../domain/payables.ts';
import { renderBillReview, renderDashboard, renderPayables, renderSupplierList, renderSupplier } from './views.ts';
import { createSupplier, supplierList, supplierDetail } from '../domain/suppliers.ts';
import { renderGstr1 } from './views.ts';
import { generateGstr1, salesPeriods } from '../domain/gstr1.ts';
import { renderGstr3b, renderTds, renderReturns, renderReceivables,
         renderStatement, renderAssets } from './views.ts';
import { generateGstr3b, taxPeriods } from '../domain/gstr3b.ts';
import { renderCockpit } from './views.ts';
import { loadCockpit } from '../domain/firmCockpit.ts';
import { setPartyRcmRate } from '../domain/partyRcm.ts';
import { tdsPosition, recordTdsDeposit } from '../domain/tdsCompliance.ts';
import { createPurchaseReturn, recordSupplierCreditNote, purchaseReturns,
         billForReturn } from '../domain/purchaseReturns.ts';
import { outstandingInvoices, recordReceipt, writeOffReceivable,
         customerStatement, receiptAccounts } from '../domain/receivables.ts';
import { assetRegister, computeDepreciation, postDepreciation,
         taxDepreciationSchedule, fiscalYearOf } from '../domain/fixedAssets.ts';
import { formFor } from '../domain/billForm.ts';
import { resolveReaders, purchasesAccount, expenseAccounts, previewBills, postReviewedBill,
         learnedDefaultsFor, lineKey,
         proposalView, type ReviewReaders } from '../domain/billReview.ts';
import { cashRegisterCheck } from '../reports/cashRegister.ts';
import { balanceSheet, profitAndLoss, trialBalance } from '../reports/index.ts';
import { closePeriod, periodCloseCheck } from '../domain/periodClose.ts';
import { login, logout, sessionFromToken, changePassword,
         lockoutRemaining, type Session as AuthSession } from '../domain/auth.ts';
import { renderLogin } from './views.ts';
import { renderAssistantRuns, renderCustomers, renderSales, renderSalesInvoice, renderTallyImport } from './views.ts';
import { renderBalanceSheet, renderPeriodClose, renderProfitAndLoss } from './views.ts';
import { createInvoice } from '../domain/invoicing.ts';
import { createCustomer, salesDesk, salesInvoiceDetail } from '../domain/sales.ts';
import { parseTallyXml } from '../parse/tallyXml.ts';
import type { TallyPreview } from '../parse/tallyXml.ts';
import { importTallyPreview, tallyMappingDesk } from '../domain/tallyImport.ts';
import { clientSetupProgress, saveClientSetup } from '../domain/clientSetup.ts';
import { createHash, randomUUID } from 'node:crypto';
import { receiveDocument, listDocuments, getDocumentBytes,
         markDocumentInReview, requestDocumentInformation, dismissDocument,
         listOpenDocumentRequests, listDocumentRequestHistory,
         answerDocumentRequest, confirmDocumentClass } from '../domain/documentInbox.ts';
import { renderDocumentInbox, renderNexus, renderFollowUps, renderActivity,
         renderEmailInbox, renderAttention, renderNexusBankTransactionSource } from './views.ts';
import { createFollowUp, completeFollowUp, listFollowUps, listFollowUpAssignees,
  recordFollowUpBlocker, snoozeFollowUp } from '../domain/followUps.ts';
import { listObligationTimeline } from '../domain/obligationTimeline.ts';
import { listNexusAlerts } from '../domain/alerts.ts';
import { recentActivity } from '../domain/activity.ts';
import { emailInbox, receiveSampleEmail, assignEmail } from '../domain/emailIntake.ts';
import { markReviewedEmailStatement } from '../domain/emailStatementReview.ts';
import { importArchivedEmails, r2EmailConfig } from '../integrations/cloudflareR2Email.ts';
import { documentClassifierEnabled, setDocumentClassifierEnabled,
         suggestDocumentClass } from '../domain/documentTypeClassifier.ts';
import { createNexusTask, getNexusTask, listNexusTasks, nexusTaskAiEnabled,
         setNexusTaskAiEnabled, type NexusRecordRef } from '../domain/nexusTasks.ts';
import { runNexusTask } from '../domain/nexusTaskRunner.ts';
import { createNexusCase, getNexusCase, listNexusCases, listNexusCaseMessages,
         appendNexusCaseMessage, appendNexusCaseState, getNexusCaseMessageByKey } from '../domain/nexusCases.ts';
import { buildBankActivityResult, getNexusBankTransactionSource, listNexusBankActivityAccounts,
         validateBankActivityRange } from '../domain/nexusBankActivity.ts';

const PORT = Number(process.env.PORT ?? 4321);
const assistantLlm = llmClientFromEnv();
const UI_FONT_ASSETS = new Set([
  'IBMPlexSans-400.woff2', 'IBMPlexSans-500.woff2', 'IBMPlexSans-600.woff2',
  'IBMPlexSans-700.woff2', 'IBMPlexMono-400.woff2', 'IBMPlexMono-500.woff2',
  'IBMPlexMono-600.woff2',
]);

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
      "default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; " +
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

let readers: ReviewReaders = {
  llm: undefined, docling: undefined, parser: undefined, glmOcr: undefined,
  paddle: undefined,
  gstinLookup: undefined };

/** The last preview rendered for a client, so a reload can show it again. */
type PreviewCard = ReturnType<typeof proposalView> & { token: string };
const lastPreview = new Map<string, PreviewCard[]>();

/** Parsed Tally exports awaiting explicit ledger mapping and confirmation. */
const tallyPreviews = new Map<string, { preview: TallyPreview; at: number }>();
function stashTally(preview: TallyPreview, xml: string): string {
  const token = createHash('sha256').update(xml).digest('hex').slice(0, 20);
  tallyPreviews.set(token, { preview, at: Date.now() });
  while (tallyPreviews.size > 12) {
    const oldest = [...tallyPreviews.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) tallyPreviews.delete(oldest[0]); else break;
  }
  return token;
}

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

  // The bundled, open-license UI fonts are public static assets. Keep the
  // allowlist explicit so this handler cannot read arbitrary server paths.
  const fontName = path.startsWith('/assets/fonts/') ? path.slice('/assets/fonts/'.length) : '';
  if ((req.method === 'GET' || req.method === 'HEAD') && UI_FONT_ASSETS.has(fontName)) {
    const bytes = await readFile(new URL(`./fonts/${fontName}`, import.meta.url));
    res.writeHead(200, { 'content-type': 'font/woff2', 'content-length': bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; font-src 'self'",
      'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return;
  }

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
  const canManageEmail = session.boundClientId === null &&
    (session.role === 'ca_partner' || session.role === 'ca_staff');

  // ---- pages --------------------------------------------------------------

  if (req.method === 'GET' && path === '/firm') {
    const canSeeFirm = session.boundClientId === null &&
      ['ca_partner', 'ca_staff', 'auditor'].includes(session.role);
    if (!canSeeFirm) {
      return html(res, 403, renderShell({
        session, accounts, active: 'firm',
        body: '<h1>Firm cockpit unavailable</h1><p>This page is for firm-level CA and audit roles. Use your client workspace to view its books and documents.</p>',
      }));
    }
    const cockpit = await loadCockpit(session.firmId,
      url.searchParams.get('period') ?? undefined);
    return html(res, 200, renderShell({
      session, accounts, active: 'firm', body: renderCockpit(cockpit),
    }));
  }

  if (req.method === 'GET' && path === '/setup') {
    return html(res, 200, renderShell({
      session, accounts, active: 'setup',
      body: renderClientSetup(await clientSetupProgress(session.firmId, session.clientId)),
    }));
  }

  if (req.method === 'GET' && path === '/documents') {
    const [documents, requestHistory, classifierEnabled] = await Promise.all([
      listDocuments(session.firmId, session.clientId),
      listDocumentRequestHistory(session.firmId, session.clientId),
      documentClassifierEnabled(session.firmId),
    ]);
    return html(res, 200, renderShell({
      session, accounts, active: 'documents',
      body: renderDocumentInbox(documents,
        session.role === 'ca_partner' || session.role === 'ca_staff',
        requestHistory, { enabled: classifierEnabled, available: assistantLlm !== null },
        ['owner','ca_partner','ca_staff'].includes(session.role)),
    }));
  }

  if (req.method === 'GET' && path === '/email-inbox') {
    if (!canManageEmail) return html(res, 403, renderShell({
      session, accounts, active: 'email-inbox', body: '<h1>Email inbox unavailable</h1>',
    }));
    return html(res, 200, renderShell({
      session, accounts, active: 'email-inbox',
      body: renderEmailInbox(await emailInbox(session.firmId)),
    }));
  }

  if (req.method === 'POST' && path === '/api/email-inbox/sample') {
    if (!canManageEmail) return json(res, 403, { ok: false, error: 'CA access required' });
    try {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.attachments) || body.attachments.length > 5) {
        throw new Error('provide up to five attachments');
      }
      const attachments = body.attachments.map((attachment: {
        name?: unknown; mimeType?: unknown; data?: unknown;
      }) => {
        if (typeof attachment.name !== 'string' || typeof attachment.data !== 'string'
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) {
          throw new Error('choose a valid attachment');
        }
        return { name: attachment.name,
          mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
          bytes: Buffer.from(attachment.data, 'base64') };
      });
      const saved = await receiveSampleEmail(session.firmId, session.userId, {
        externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
        sender: body.sender, recipients: body.recipients,
        subject: body.subject, bodyText: body.bodyText, attachments,
      });
      return json(res, 201, { ok: true, ...saved });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  const emailAssignMatch = /^\/api\/email-inbox\/([0-9a-f-]{36})\/assign$/i.exec(path);
  if (req.method === 'POST' && emailAssignMatch) {
    if (!canManageEmail) return json(res, 403, { ok: false, error: 'CA access required' });
    try {
      const body = JSON.parse(await readBody(req));
      if (typeof body.clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.clientId)) {
        throw new Error('choose a client');
      }
      const assigned = await assignEmail(session.firmId, session.userId,
        emailAssignMatch[1]!, body.clientId, body.rememberSender === true);
      return json(res, assigned ? 200 : 404,
        { ok: assigned, ...(assigned ? {} : { error: 'email is unavailable for assignment' }) });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/nexus/source/bank-transaction') {
    if (!hasBankCapability(session.role, 'read')) return html(res, 403, renderShell({
      session, accounts, active: 'nexus', body: '<h1>Bank evidence unavailable</h1>',
    }));
    const id = url.searchParams.get('id') ?? '';
    const source = await getNexusBankTransactionSource(session.firmId, session.clientId, id);
    if (!source) {
      return html(res, 404, renderShell({ session, accounts, active: 'nexus',
        body: '<h1>Source not found</h1><p class="empty">That bank line is not available for this client. <a href="/nexus">Return to Nexus</a>.</p>',
      }));
    }
    return html(res, 200, renderShell({ session, accounts, active: 'nexus',
      body: renderNexusBankTransactionSource(source),
    }));
  }

  if (req.method === 'GET' && path === '/nexus') {
    const runs = await assistantRuns(session.firmId, session.clientId, 40);
    const followUps = await listFollowUps(session.firmId, session.clientId, true);
    const activity = await recentActivity(session.firmId, session.clientId, 8);
    const documents = await listDocuments(session.firmId, session.clientId);
    const documentRequests = await listOpenDocumentRequests(session.firmId, session.clientId);
    const [taskConsent, obligations, taskRows] = await Promise.all([
      nexusTaskAiEnabled(session.firmId), listObligationTimeline(session.firmId, session.clientId),
      listNexusTasks(session.firmId, session.clientId, 10),
    ]);
    const nexusTasks = await Promise.all(taskRows.map((task) =>
      getNexusTask(session.firmId, session.clientId, task.id)));
    const nexusCases = await listNexusCases(session.firmId, session.clientId, 20);
    const nexusBankAccounts = await listNexusBankActivityAccounts(session.firmId, session.clientId);
    const rawCaseId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('case');
    const requestedCaseId = rawCaseId && /^[0-9a-f-]{36}$/i.test(rawCaseId) ? rawCaseId : null;
    const selectedCase = requestedCaseId
      ? await getNexusCase(session.firmId, session.clientId, requestedCaseId)
      : nexusCases[0] ? await getNexusCase(session.firmId, session.clientId, String(nexusCases[0].id)) : null;
    const caseMessages = selectedCase
      ? await listNexusCaseMessages(session.firmId, session.clientId, String(selectedCase.id)) : [];
    return html(res, 200, renderShell({
      session, accounts, active: 'nexus',
      body: renderNexus(session.clientName, runs, followUps, activity, documents,
        documentRequests, session.role === 'owner', {
          enabled: taskConsent, available: assistantLlm !== null,
          canManage: ['owner','ca_partner','ca_staff'].includes(session.role),
          obligations, tasks: nexusTasks.filter((task): task is NonNullable<typeof task> => task !== null),
        }, { cases: nexusCases, selectedCase, messages: caseMessages, bankAccounts: nexusBankAccounts }),
    }));
  }

  if (req.method === 'GET' && path === '/activity') {
    return html(res, 200, renderShell({
      session, accounts, active: 'activity',
      body: renderActivity(await recentActivity(session.firmId, session.clientId)),
    }));
  }

  if (req.method === 'GET' && path === '/api/activity') {
    return json(res, 200, { ok: true,
      items: await recentActivity(session.firmId, session.clientId) });
  }

  if (req.method === 'GET' && path === '/follow-ups') {
    const [items, assignees] = await Promise.all([
      listFollowUps(session.firmId, session.clientId, true),
      listFollowUpAssignees(session.firmId, session.clientId),
    ]);
    return html(res, 200, renderShell({
      session, accounts, active: 'follow-ups',
      body: renderFollowUps(items, assignees),
    }));
  }

  if (req.method === 'GET' && path === '/attention') {
    const [followUps, obligations, alertList] = await Promise.all([
      listFollowUps(session.firmId, session.clientId, true),
      listObligationTimeline(session.firmId, session.clientId),
      listNexusAlerts(session.firmId, session.clientId),
    ]);
    return html(res, 200, renderShell({
      session, accounts, active: 'attention',
      body: renderAttention(followUps, obligations, alertList.items, alertList.total),
    }));
  }

  if (req.method === 'GET' && path === '/api/follow-ups') {
    return json(res, 200, { ok: true,
      items: await listFollowUps(session.firmId, session.clientId, true) });
  }

  if (req.method === 'POST' && path === '/api/follow-ups') {
    try {
      const body = JSON.parse(await readBody(req));
      const id = await createFollowUp(session.firmId, session.clientId, session.userId, body);
      return json(res, 201, { ok: true, id });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  const completeFollowUpMatch = /^\/api\/follow-ups\/([0-9a-f-]+)\/complete$/i.exec(path);
  if (req.method === 'POST' && completeFollowUpMatch) {
    const completed = await completeFollowUp(
      session.firmId, session.clientId, session.userId, completeFollowUpMatch[1]!);
    return json(res, completed ? 200 : 404,
      { ok: completed, ...(completed ? {} : { error: 'open follow-up not found' }) });
  }

  const blockerFollowUpMatch = /^\/api\/follow-ups\/([0-9a-f-]+)\/blocker$/i.exec(path);
  if (req.method === 'POST' && blockerFollowUpMatch) {
    try {
      const body = JSON.parse(await readBody(req));
      const saved = await recordFollowUpBlocker(session.firmId, session.clientId, session.userId,
        blockerFollowUpMatch[1]!, body.reason);
      return json(res, saved ? 200 : 404, { ok: saved, ...(saved ? {} : { error: 'open follow-up not found' }) });
    } catch (error) { return json(res, 400, { ok: false, error: (error as Error).message }); }
  }

  const snoozeFollowUpMatch = /^\/api\/follow-ups\/([0-9a-f-]+)\/snooze$/i.exec(path);
  if (req.method === 'POST' && snoozeFollowUpMatch) {
    try {
      const body = JSON.parse(await readBody(req));
      const saved = await snoozeFollowUp(session.firmId, session.clientId, session.userId,
        snoozeFollowUpMatch[1]!, body.until);
      return json(res, saved ? 200 : 404, { ok: saved, ...(saved ? {} : { error: 'open follow-up not found' }) });
    } catch (error) { return json(res, 400, { ok: false, error: (error as Error).message }); }
  }

  if (req.method === 'GET' && path === '/api/documents') {
    return json(res, 200, { ok: true,
      documents: await listDocuments(session.firmId, session.clientId) });
  }

  if (req.method === 'POST' && path === '/api/document-classifier-consent') {
    try {
      const body = JSON.parse(await readBody(req));
      if (typeof body.enabled !== 'boolean') throw new Error('choose whether to enable document suggestions');
      if (body.enabled && !assistantLlm) throw new Error('Nexus AI is not configured on this server');
      await setDocumentClassifierEnabled(session.firmId, body.enabled, session.userId,
        assistantLlm?.provider ?? 'deepseek', assistantLlm?.model ?? 'deepseek-chat');
      return json(res, 200, { ok: true, enabled: body.enabled });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  const classifyDocumentMatch = /^\/api\/documents\/([0-9a-f-]{36})\/classify$/i.exec(path);
  if (req.method === 'POST' && classifyDocumentMatch) {
    try {
      const suggestion = await suggestDocumentClass({ firmId: session.firmId,
        clientId: session.clientId, documentId: classifyDocumentMatch[1]!, llm: assistantLlm });
      if (!suggestion) return json(res, 400, { ok: false,
        error: 'Enable Nexus document-class suggestions first.' });
      return json(res, 200, { ok: true, suggestion });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  const confirmDocumentClassMatch = /^\/api\/documents\/([0-9a-f-]{36})\/classification-review$/i.exec(path);
  if (req.method === 'POST' && confirmDocumentClassMatch) {
    if (!['owner','ca_partner','ca_staff'].includes(session.role)) {
      return json(res, 403, { ok: false, error: 'authorized reviewer access required' });
    }
    try {
      const body = JSON.parse(await readBody(req));
      const saved = await confirmDocumentClass(session.firmId, session.clientId,
        confirmDocumentClassMatch[1]!, session.userId, body.documentClass);
      return json(res, saved ? 200 : 404,
        { ok: saved, ...(saved ? {} : { error: 'document is unavailable for review' }) });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  const answerRequestMatch = /^\/api\/document-requests\/([0-9a-f-]{36})\/answer$/i.exec(path);
  if (req.method === 'POST' && answerRequestMatch) {
    if (session.role !== 'owner') {
      return json(res, 403, { ok: false, error: 'only the founder can answer this request' });
    }
    try {
      const body = JSON.parse(await readBody(req));
      const answered = await answerDocumentRequest(session.firmId, session.clientId,
        answerRequestMatch[1]!, session.userId, body.answer, body.attachmentIds);
      return json(res, answered ? 200 : 404,
        { ok: answered, ...(answered ? {} : { error: 'open request not found' }) });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  const documentReviewAction = /^\/api\/documents\/([0-9a-f-]{36})\/(review|request-info|dismiss)$/i.exec(path);
  if (req.method === 'POST' && documentReviewAction) {
    if (session.role !== 'ca_partner' && session.role !== 'ca_staff') {
      return json(res, 403, { ok: false, error: 'a CA team member must update document review status' });
    }
    try {
      const id = documentReviewAction[1]!;
      const updated = documentReviewAction[2] === 'review'
        ? await markDocumentInReview(session.firmId, session.clientId, id, session.userId)
        : documentReviewAction[2] === 'dismiss'
        ? await dismissDocument(session.firmId, session.clientId, id,
          session.userId, JSON.parse(await readBody(req)).reason)
        : await requestDocumentInformation(session.firmId, session.clientId, id,
          session.userId, JSON.parse(await readBody(req)).note);
      return json(res, updated ? 200 : 404,
        { ok: updated, ...(updated ? {} : { error: 'document not found or already completed' }) });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/documents') {
    const body = JSON.parse(await readBody(req));
    try {
      if (typeof body.name !== 'string' || typeof body.data !== 'string' ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) {
        return json(res, 400, { ok: false, error: 'choose a valid file' });
      }
      const result = await receiveDocument(session.firmId, {
        clientId: session.clientId, uploadedBy: session.userId,
        name: body.name, bytes: Buffer.from(body.data, 'base64'),
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
      });
      let suggestion = null;
      if (!result.duplicate && await documentClassifierEnabled(session.firmId)) {
        try { suggestion = await suggestDocumentClass({ firmId: session.firmId,
          clientId: session.clientId, documentId: result.document.id, llm: assistantLlm }); }
        catch { /* Stored original remains available even if the suggestion service is down. */ }
      }
      return json(res, 200, { ok: true, ...result, suggestion });
    } catch (e) {
      return json(res, 400, { ok: false, error: (e as Error).message });
    }
  }

  const documentDownload = /^\/api\/documents\/([0-9a-f-]{36})\/download$/i.exec(path);
  if (req.method === 'GET' && documentDownload) {
    try {
      const { document, bytes } = await getDocumentBytes(
        session.firmId, session.clientId, documentDownload[1]!);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="document-${document.id}"`,
        'content-length': bytes.length,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(bytes);
      return;
    } catch (e) {
      return json(res, 404, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/') {
    const dash = await loadDashboard(session.firmId, session.clientId,
      url.searchParams.get('period') ?? undefined);
    return html(res, 200, renderShell({
      session, accounts, active: 'home', body: renderDashboard(dash),
    }));
  }

  if (req.method === 'GET' && (path === '/reports' || path === '/reports/profit-loss')) {
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from') ?? `${today.slice(0, 7)}-01`;
    const to = url.searchParams.get('to') ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
      || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`)) || from > to) {
      return html(res, 400, renderShell({ session, accounts, active: 'profit-loss',
        body: '<h1>Profit &amp; loss</h1><div class="msg bad" role="alert">Choose a valid date range.</div><a href="/reports/profit-loss">Return to this report</a>' }));
    }
    return html(res, 200, renderShell({ session, accounts, active: 'profit-loss',
      body: renderProfitAndLoss({ from, to,
        report: await profitAndLoss(session.firmId, session.clientId, from, to) }) }));
  }

  if (req.method === 'GET' && path === '/reports/balance-sheet') {
    const today = new Date().toISOString().slice(0, 10);
    const asOf = url.searchParams.get('asOf') ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
      return html(res, 400, renderShell({ session, accounts, active: 'balance-sheet',
        body: '<h1>Balance sheet</h1><div class="msg bad" role="alert">Choose a valid date.</div><a href="/reports/balance-sheet">Return to this report</a>' }));
    }
    const [report, tb] = await Promise.all([
      balanceSheet(session.firmId, session.clientId, asOf),
      trialBalance(session.firmId, session.clientId, asOf),
    ]);
    return html(res, 200, renderShell({ session, accounts, active: 'balance-sheet',
      body: renderBalanceSheet({ asOf, report, trialBalance: tb }) }));
  }

  if (req.method === 'GET' && path === '/reports/close-month') {
    const periods = await withFirm(session.firmId, async (c) => {
      const result = await c.query<{ label: string; startDate: string; endDate: string;
        isClosed: boolean; closedAt: string | null }>(
        `SELECT label, start_date::text AS "startDate", end_date::text AS "endDate",
                is_closed AS "isClosed", closed_at::text AS "closedAt"
           FROM accounting_periods WHERE client_id = $1
          ORDER BY start_date DESC LIMIT 36`, [session.clientId]);
      return result.rows;
    });
    const selected = periods.find((period) => period.label === url.searchParams.get('period'))
      ?? periods[0] ?? null;
    let check = null;
    if (selected && !selected.isClosed) {
      try { check = await periodCloseCheck(session.firmId, session.clientId, selected.label); }
      catch (error) { check = { ok: false, blockers: [(error as Error).message] }; }
    }
    return html(res, 200, renderShell({ session, accounts, active: 'close-month',
      body: renderPeriodClose({ periods, selected: selected?.label ?? null, check,
        canClose: session.role === 'ca_partner' }) }));
  }

  if (req.method === 'POST' && path === '/reports/close-month') {
    if (session.role !== 'ca_partner') {
      return html(res, 403, renderShell({ session, accounts, active: 'close-month',
        body: '<h1>Close month</h1><div class="msg bad" role="alert">A CA partner must approve period close.</div><a href="/reports/close-month">Return to period review</a>' }));
    }
    try {
      const body = new URLSearchParams(await readBody(req));
      const label = body.get('label');
      if (label === null || !/^\d{4}-\d{2}$/.test(label)) {
        throw new Error('choose a valid accounting period');
      }
      const overrideReason = body.get('reason')?.trim() ?? '';
      await closePeriod(session.firmId, { clientId: session.clientId,
        label, closedBy: session.userId,
        ...(overrideReason ? { overrideReason } : {}) });
      res.writeHead(303, { location: `/reports/close-month?period=${encodeURIComponent(label)}`,
        'cache-control': 'no-store' });
      res.end();
      return;
    } catch (error) {
      return html(res, 400, renderShell({ session, accounts, active: 'close-month',
        body: '<h1>Close month</h1><div class="msg bad" role="alert">The period was not closed. Review the current blockers and reason, then try again.</div><a href="/reports/close-month">Return to period review</a>' }));
    }
  }

  if (req.method === 'GET' && path === '/accounts') {
    if (!hasBankCapability(session.role, 'read')) return html(res, 403, renderShell({
      session, accounts, active: 'accounts', body: '<h1>Bank accounts unavailable</h1>',
    }));
    return html(res, 200, renderShell({
      session, accounts, active: 'accounts',
      body: renderAccounts(accounts, new Date().toISOString().slice(0, 10),
        hasBankCapability(session.role, 'manage_settings')),
    }));
  }

  if (req.method === 'POST' && path === '/api/bank-accounts') {
    if (!hasBankCapability(session.role, 'manage_settings')) {
      return json(res, 403, { ok: false, error: 'owner or CA partner access required to set up a bank account' });
    }
    const body = JSON.parse(await readBody(req));
    try {
      const account = await createBankAccount(session.firmId, {
        clientId: session.clientId,
        bankName: String(body.bankName ?? ''),
        accountNumber: String(body.accountNumber ?? ''),
        ifsc: String(body.ifsc ?? ''),
        kind: String(body.kind ?? ''),
        openingBalance: typeof body.openingBalance === 'string' && body.openingBalance.trim()
          ? body.openingBalance : undefined,
        openingDate: typeof body.openingDate === 'string' && body.openingDate.trim()
          ? body.openingDate : undefined,
        createdBy: session.userId,
      });
      return json(res, 200, { ok: true, ...account });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/client-setup') {
    const body = JSON.parse(await readBody(req));
    try {
      await saveClientSetup(session.firmId, session.clientId, {
        name: String(body.name ?? ''), pan: String(body.pan ?? ''),
        gstin: body.gstin === undefined ? undefined : String(body.gstin),
      });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/nexus/bank-activity') {
    if (!hasBankCapability(session.role, 'read')) {
      return json(res, 403, { ok: false, error: 'bank read access is unavailable for this role' });
    }
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const requestId = String(body.requestId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json(res, 400, { ok: false, error: 'request id is not valid' });
      if (typeof body.accountId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.accountId)) return json(res, 400, { ok: false, error: 'choose a valid bank account' });
      if (typeof body.fromDate !== 'string' || typeof body.toDate !== 'string') return json(res, 400, { ok: false, error: 'choose a date range' });
      validateBankActivityRange(body.fromDate, body.toDate);
      // Validate ownership on every request, including exact retries that can
      // be answered from the durable saved result without rebuilding it.
      const ownedAccounts = await listNexusBankActivityAccounts(session.firmId, session.clientId);
      const account = ownedAccounts.find((row) => row.id === body.accountId);
      if (!account) return json(res, 404, { ok: false, error: 'bank account is unavailable for this client' });
      let caseId: string | undefined;
      if (typeof body.caseId === 'string' && body.caseId) {
        if (!/^[0-9a-f-]{36}$/i.test(body.caseId)) return json(res, 400, { ok: false, error: 'case id is not valid' });
        const existing = await getNexusCase(session.firmId, session.clientId, body.caseId);
        if (!existing) return json(res, 404, { ok: false, error: 'conversation is unavailable for this client' });
        if (!['completed', 'cancelled'].includes(String(existing.state))) caseId = body.caseId;
      }
      if (!caseId) caseId = await createNexusCase({ firmId: session.firmId, clientId: session.clientId,
        title: `Bank activity · ${body.fromDate} to ${body.toDate}`, requestedByUserId: session.userId,
        idempotencyKey: `bank-activity:${requestId}` });
      const fingerprint = createHash('sha256').update(JSON.stringify([
        body.accountId, body.fromDate, body.toDate,
      ])).digest('hex');
      const responseKey = `${requestId}:nexus`;
      const savedResponse = await getNexusCaseMessageByKey(session.firmId, session.clientId, responseKey);
      if (savedResponse) {
        if (savedResponse.case_id !== caseId || savedResponse.actor_type !== 'nexus'
          || savedResponse.request_fingerprint !== fingerprint || !savedResponse.response_blocks) {
          return json(res, 409, { ok: false, error: 'request id was already used for a different bank activity request' });
        }
        return json(res, 200, { ok: true, caseId });
      }
      // Ownership and dates are checked again by this builder before querying.
      const blocks = await buildBankActivityResult({ firmId: session.firmId, clientId: session.clientId,
        bankAccountId: body.accountId, fromDate: body.fromDate, toDate: body.toDate });
      const question = `Show ${account.bank_name} account ending ${account.account_number_last4} activity from ${body.fromDate} to ${body.toDate}.`;
      await appendNexusCaseMessage({ firmId: session.firmId, clientId: session.clientId, caseId,
        actorType: 'user', actorUserId: session.userId, body: question, idempotencyKey: `${requestId}:user` });
      const summaryBlock = blocks.blocks.find((block) => block.id === 'bank-activity-summary');
      await appendNexusCaseMessage({ firmId: session.firmId, clientId: session.clientId, caseId,
        actorType: 'nexus', body: summaryBlock?.type === 'paragraph' ? summaryBlock.text : 'Bank activity loaded.',
        responseBlocks: blocks, requestFingerprint: fingerprint, idempotencyKey: responseKey });
      return json(res, 200, { ok: true, caseId });
    } catch (error) {
      return json(res, 400, { ok: false, error: (error as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/assistant') {
    const body = JSON.parse(await readBody(req));
    const question = String(body.question ?? '').slice(0, 500);
    const page = String(body.page ?? '').slice(0, 40);
    if (page === 'nexus') {
      let caseId: string | undefined;
      if (typeof body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)) {
        return json(res, 400, { ok: false, error: 'request id is not valid' });
      }
      const requestKey = body.requestId;
      try {
        if (typeof body.caseId === 'string' && body.caseId) {
          if (!/^[0-9a-f-]{36}$/i.test(body.caseId)) {
            return json(res, 400, { ok: false, error: 'case id is not valid' });
          }
          const existing = await getNexusCase(session.firmId, session.clientId, body.caseId);
          if (!existing) return json(res, 404, { ok: false, error: 'case is unavailable for this client' });
          // Completed cases are terminal workflow records; a follow-up starts a new case.
          if (existing.state !== 'completed' && existing.state !== 'cancelled') caseId = body.caseId;
        }
        if (!caseId) caseId = await createNexusCase({ firmId: session.firmId,
          clientId: session.clientId, title: question.slice(0, 240), requestedByUserId: session.userId,
          idempotencyKey: `assistant:${requestKey}` });
        const existing = await getNexusCase(session.firmId, session.clientId, caseId);
        const priorMessages = await listNexusCaseMessages(session.firmId, session.clientId, caseId);
        const previousUserQuestion = priorMessages
          .filter((message) => message.actor_type === 'user')
          .at(-1)?.body.slice(0, 500);
        if (existing?.state === 'open' || existing?.state === 'needs_user'
          || existing?.state === 'blocked' || existing?.state === 'with_ca') {
          await appendNexusCaseState({ firmId: session.firmId, clientId: session.clientId, caseId,
            toState: 'working', actorUserId: session.userId, idempotencyKey: `assistant:${requestKey}:working` });
        }
        await appendNexusCaseMessage({ firmId: session.firmId, clientId: session.clientId, caseId,
          actorType: 'user', actorUserId: session.userId, body: question,
          idempotencyKey: `${requestKey}:user` });
        const startedAt = Date.now();
        const reply = await answerAssistantWithAi(
          session.firmId, session.clientId, question, page, assistantLlm, previousUserQuestion,
        );
        await recordAssistantRun(session.firmId, { clientId: session.clientId, userId: session.userId,
          question, page, reply, durationMs: Date.now() - startedAt });
        await appendNexusCaseMessage({ firmId: session.firmId, clientId: session.clientId, caseId,
          actorType: 'nexus', body: reply.answer, idempotencyKey: `${requestKey}:nexus` });
        const latest = await getNexusCase(session.firmId, session.clientId, caseId);
        if (latest?.state === 'working') await appendNexusCaseState({ firmId: session.firmId,
          clientId: session.clientId, caseId, toState: 'open', actorUserId: session.userId,
          idempotencyKey: `assistant:${requestKey}:open` });
        const { audit: _audit, ...safeReply } = reply;
        return json(res, 200, { ok: true, ...safeReply, caseId });
      } catch (e) {
        if (caseId) {
          try {
            const current = await getNexusCase(session.firmId, session.clientId, caseId);
            if (current && ['working','open'].includes(String(current.state))) {
              await appendNexusCaseState({ firmId: session.firmId, clientId: session.clientId, caseId,
                toState: 'blocked', actorUserId: session.userId, idempotencyKey: `assistant:${requestKey}:blocked` });
            }
          } catch { /* preserve the original assistant error */ }
        }
        return json(res, 200, { ok: false, error: (e as Error).message, ...(caseId ? { caseId } : {}) });
      }
    }
    try {
      const startedAt = Date.now();
      const reply = await answerAssistantWithAi(
        session.firmId, session.clientId, question, page, assistantLlm);
      await recordAssistantRun(session.firmId, {
        clientId: session.clientId, userId: session.userId, question, page,
        reply, durationMs: Date.now() - startedAt,
      });
      const { audit: _audit, ...safeReply } = reply;
      return json(res, 200, { ok: true, ...safeReply });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/nexus/task-consent') {
    if (!['owner','ca_partner','ca_staff'].includes(session.role)) {
      return json(res, 403, { ok: false, error: 'authorized firm reviewer access required' });
    }
    try {
      const body = JSON.parse(await readBody(req));
      if (typeof body.enabled !== 'boolean') throw new Error('choose whether to enable Nexus task runs');
      if (body.enabled && !assistantLlm) throw new Error('Nexus AI is not configured on this server');
      await setNexusTaskAiEnabled(session.firmId, session.userId, body.enabled,
        assistantLlm?.provider ?? 'deepseek', assistantLlm?.model ?? 'deepseek-chat');
      return json(res, 200, { ok: true, enabled: body.enabled });
    } catch (error) { return json(res, 400, { ok: false, error: (error as Error).message }); }
  }

  if (req.method === 'POST' && path === '/api/nexus/tasks') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.recordRefs) || body.recordRefs.length < 1 || body.recordRefs.length > 50) {
        throw new Error('select between 1 and 50 timeline records');
      }
      const specialist = body.specialist;
      if (!['gst','tds','banking'].includes(specialist)) throw new Error('choose a supported Nexus specialist');
      const recordRefs = body.recordRefs as NexusRecordRef[];
      if (recordRefs.some((ref) => !ref || ref.kind !== 'obligation')) {
        throw new Error('this review currently accepts compliance timeline records only');
      }
      const taskId = await createNexusTask({ firmId: session.firmId, clientId: session.clientId,
        requestedByUserId: session.userId, purpose: body.purpose, specialist,
        permittedReads: ['obligation.read'], recordRefs,
        idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : randomUUID(),
      });
      return json(res, 200, { ok: true, taskId });
    } catch (error) { return json(res, 400, { ok: false, error: (error as Error).message }); }
  }

  const runNexusTaskMatch = /^\/api\/nexus\/tasks\/([0-9a-f-]{36})\/run$/i.exec(path);
  if (req.method === 'POST' && runNexusTaskMatch) {
    try {
      if (!(await nexusTaskAiEnabled(session.firmId))) throw new Error('Enable Nexus task runs after reviewing the data-sharing notice.');
      const result = await runNexusTask({ firmId: session.firmId, clientId: session.clientId,
        taskId: runNexusTaskMatch[1]!, llm: assistantLlm });
      return json(res, 200, { ok: true, result });
    } catch (error) { return json(res, 400, { ok: false, error: (error as Error).message }); }
  }

  if (req.method === 'GET' && path === '/assistant-runs') {
    const runs = await assistantRuns(session.firmId, session.clientId);
    return html(res, 200, renderShell({
      session, accounts, active: 'assistant-runs', body: renderAssistantRuns(runs),
    }));
  }

  if (req.method === 'GET' && path === '/sales') {
    const desk = await salesDesk(session.firmId, session.clientId);
    const draftCustomer = url.searchParams.get('customer');
    const rawAmount = url.searchParams.get('amount');
    const rawGst = url.searchParams.get('gst');
    const draft = url.searchParams.get('draft') === 'ai'
      && desk.customers.some((customer) => customer.id === draftCustomer)
      ? {
          customerId: draftCustomer!,
          amount: rawAmount && /^\d+(?:\.\d{1,2})?$/.test(rawAmount) && Number(rawAmount) > 0
            ? rawAmount : undefined,
          gstRate: rawGst && /^\d{1,2}(?:\.\d+)?$/.test(rawGst)
            && Number(rawGst) >= 0 && Number(rawGst) <= 40 ? rawGst : undefined,
        }
      : undefined;
    return html(res, 200, renderShell({
      session, accounts, active: 'sales',
      body: renderSales({
        desk,
        today: new Date().toISOString().slice(0, 10),
        created: url.searchParams.get('created') ?? undefined,
        draft,
      }),
    }));
  }

  if (req.method === 'GET' && path === '/customers') {
    const desk = await salesDesk(session.firmId, session.clientId);
    return html(res, 200, renderShell({ session, accounts, active: 'customers',
      body: renderCustomers(desk.customers) }));
  }

  if (req.method === 'GET' && path.startsWith('/sales/')) {
    const voucherId = path.slice('/sales/'.length);
    const invoice = await salesInvoiceDetail(
      session.firmId, session.clientId, voucherId);
    if (invoice === null) {
      return html(res, 404, renderShell({
        session, accounts, active: 'sales',
        body: '<p class="empty">That invoice was not found.</p>',
      }));
    }
    return html(res, 200, renderShell({
      session, accounts, active: 'sales', body: renderSalesInvoice(invoice),
    }));
  }

  if (req.method === 'POST' && path === '/api/customers') {
    const body = JSON.parse(await readBody(req));
    try {
      const customer = await createCustomer(session.firmId, {
        clientId: session.clientId,
        name: String(body.name ?? ''),
        legalName: body.legalName === undefined ? undefined : String(body.legalName),
        billingAddress: String(body.billingAddress ?? ''),
        gstCategory: body.gstCategory === 'unregistered'
          ? 'unregistered' : 'registered_regular',
        gstin: body.gstin === undefined ? undefined : String(body.gstin),
        stateCode: String(body.stateCode ?? ''),
        phone: body.phone === undefined ? undefined : String(body.phone),
        createdBy: session.userId,
      });
      return json(res, 200, { ok: true, ...customer });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/invoices') {
    const body = JSON.parse(await readBody(req));
    try {
      const invoice = await createInvoice(session.firmId, {
        clientId: session.clientId,
        registrationId: String(body.registrationId ?? ''),
        partyId: String(body.partyId ?? ''),
        postingDate: String(body.postingDate ?? ''),
        dueDate: body.dueDate === undefined ? undefined : String(body.dueDate),
        placeOfSupply: String(body.placeOfSupply ?? ''),
        narration: body.narration === undefined ? undefined : String(body.narration),
        createdBy: session.userId,
        lines: Array.isArray(body.lines) ? body.lines.map((line: Record<string, unknown>) => ({
          description: String(line.description ?? ''),
          hsnSac: String(line.hsnSac ?? ''),
          quantity: String(line.quantity ?? ''),
          unitPrice: String(line.unitPrice ?? ''),
          gstRate: String(line.gstRate ?? ''),
          incomeAccountId: String(line.incomeAccountId ?? ''),
        })) : [],
      });
      return json(res, 200, { ok: true, ...invoice });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/tally') {
    return html(res, 200, renderShell({
      session, accounts, active: 'tally', body: renderTallyImport(),
    }));
  }

  if (req.method === 'POST' && path === '/api/tally/preview') {
    try {
      const body = JSON.parse(await readBody(req));
      const xml = String(body.xml ?? '');
      const preview = parseTallyXml(xml);
      const token = stashTally(preview, xml);
      const desk = await tallyMappingDesk(session.firmId, session.clientId, preview);
      return json(res, 200, {
        ok: true,
        token,
        company: preview.companies.join(', '),
        stats: preview.stats,
        warnings: preview.warnings,
        accounts: desk.accounts,
        mappings: desk.mappings,
        canImport: preview.stats.voucherCount > 0 &&
          preview.stats.unbalancedCount === 0 && preview.stats.unsupportedCount === 0 &&
          !preview.vouchers.some((v) => v.date === null),
        ledgers: preview.ledgers.slice(0, 20),
        vouchers: preview.vouchers.slice(0, 20).map((v) => ({
          date: v.date, number: v.number, sourceType: v.sourceType,
          entries: v.entries.length, difference: v.difference, balanced: v.balanced,
        })),
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/tally/import') {
    try {
      const body = JSON.parse(await readBody(req));
      const stashed = tallyPreviews.get(String(body.token ?? ''));
      if (!stashed || Date.now() - stashed.at > 30 * 60 * 1000) {
        return json(res, 200, { ok: false, error: 'this preview has expired — preview the XML again' });
      }
      const pairs = Array.isArray(body.mappings) ? body.mappings : [];
      const mappings: Record<string, string> = {};
      for (const pair of pairs) {
        if (typeof pair?.sourceName === 'string' && typeof pair?.accountId === 'string') {
          mappings[pair.sourceName] = pair.accountId;
        }
      }
      const result = await importTallyPreview(
        session.firmId, session.clientId, session.userId, stashed.preview, mappings);
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'GET' && path === '/bills') {
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    const expAccounts = await expenseAccounts(session.firmId, session.clientId);
    const posted = await recentBills(session);
    const fresh = url.searchParams.has('new');
    const cards = fresh ? (lastPreview.get(session.clientId) ?? []) : [];
    const billAiEnabled = await billClassifierEnabled(session.firmId);
    return html(res, 200, renderShell({
      session, accounts, active: 'bills',
      body: renderBillReview({
        proposals: cards as never, token: cards[0]?.token ?? null, posted,
        hasExpenseAccount: expenseAccountId !== null,
        accounts: expAccounts, defaultAccountId: expenseAccountId,
        canApprove: session.role === 'ca_partner',
        classifier: { enabled: billAiEnabled, available: assistantLlm !== null },
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/bill-classifier-consent') {
    const body = JSON.parse(await readBody(req));
    if (typeof body.enabled !== 'boolean') {
      return json(res, 400, { ok: false, error: 'choose whether to enable bill suggestions' });
    }
    if (body.enabled && !assistantLlm) {
      return json(res, 400, { ok: false, error: 'Nexus AI is not configured on this server' });
    }
    try {
      await setBillClassifierEnabled(session.firmId, body.enabled, session.userId,
        assistantLlm?.provider ?? 'deepseek', assistantLlm?.model ?? 'deepseek-chat');
      return json(res, 200, { ok: true, enabled: body.enabled });
    } catch (e) {
      return json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/bills/preview') {
    const body = JSON.parse(await readBody(req));
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    if (!expenseAccountId) return json(res, 200, { ok: false, error: 'no Purchases account' });
    try {
      const all: unknown[] = [];
      const expAccounts = await expenseAccounts(session.firmId, session.clientId);
      const incoming = Array.isArray(body.files) ? body.files : [];
      const savedIds = Array.isArray(body.documentIds) ? body.documentIds : [];
      for (const f of incoming as Array<{ name: string; data: string }>) {
        const saved = await receiveDocument(session.firmId, {
          clientId: session.clientId, uploadedBy: session.userId,
          name: f.name, bytes: Buffer.from(f.data, 'base64'),
        });
        savedIds.push(saved.document.id);
      }
      for (const token of savedIds as string[]) {
        const { bytes: file } = await getDocumentBytes(
          session.firmId, session.clientId, token);
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
          const lineSuggestions = await suggestBillLineAccounts({
            firmId: session.firmId, clientId: session.clientId,
            documentId: token,
            lines: view.lines.map((line, lineIndex) => ({
              ref: `B${p.index}L${lineIndex}`, billIndex: p.index, lineIndex,
              description: line.description, hsn: line.hsn, vendor: view.partyName,
              ...(line.suggestedAccountId ? { learnedAccountId: line.suggestedAccountId } : {}),
            })),
            accounts: expAccounts, client: assistantLlm,
          });
          view.lines = view.lines.map((line, lineIndex) => ({
            ...line,
            aiSuggestion: lineSuggestions.suggestions.get(`B${p.index}L${lineIndex}`),
          }));
          all.push({ ...view, token });
        }
        if (session.role === 'ca_partner' || session.role === 'ca_staff') {
          await markDocumentInReview(session.firmId, session.clientId, token, session.userId);
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
    let file: Buffer;
    try {
      file = (await getDocumentBytes(session.firmId, session.clientId, body.token)).bytes;
    } catch { return json(res, 200, { ok: false, error: 'this document is unavailable' }); }
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    if (!expenseAccountId) return json(res, 200, { ok: false, error: 'no Purchases account' });
    try {
      const proposals = await previewBills(
        session.firmId, session.clientId, expenseAccountId, session.userId,
        file, readers, body.manual, body.lineAccounts);
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

  if (req.method === 'POST' && path === '/api/suppliers') {
    const body = JSON.parse(await readBody(req));
    try {
      const supplier = await createSupplier(session.firmId, {
        clientId: session.clientId,
        name: String(body.name ?? ''),
        ...(body.gstin ? { gstin: String(body.gstin) } : {}),
        createdBy: session.userId,
      });
      return json(res, 200, { ok: true, ...supplier });
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
    if (session.role !== 'ca_partner') {
      return json(res, 403, { ok: false, error: 'a CA partner must approve this bill' });
    }
    const body = JSON.parse(await readBody(req));
    let original: Awaited<ReturnType<typeof getDocumentBytes>>;
    try {
      original = await getDocumentBytes(session.firmId, session.clientId, body.token);
    } catch { return json(res, 200, { ok: false, error: 'this document is unavailable' }); }
    const expenseAccountId = await purchasesAccount(session.firmId, session.clientId);
    if (!expenseAccountId) return json(res, 200, { ok: false, error: 'no Purchases account' });
    try {
      const bill = await postReviewedBill(
        session.firmId, session.clientId, expenseAccountId,
        original.bytes, body.index, body.confirm ?? {}, session.userId, readers,
        { lineAccounts: body.lineAccounts, expenseAccountId: body.expenseAccountId,
          blockItc: body.blockItc === true, manual: body.manual,
          tds: body.tds, sourceUri: `workspace://${session.firmId}/${session.clientId}/originals/${original.document.hash}` });
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
      body: renderPayables({ bills, accounts: payAccounts, today,
        draftVoucherId: url.searchParams.get('draft') ?? undefined }),
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

  if (req.method === 'GET' && path === '/assets') {
    /*
     * The fiscal year, not the calendar one: depreciation is annual and
     * reckoned April to March, so the page defaults to the year the current
     * date falls in and can be pointed at an earlier one.
     */
    const asOf = new Date().toISOString().slice(0, 10);
    const fy = Number(url.searchParams.get('fy') ?? fiscalYearOf(asOf));
    const from = `${fy}-04-01`, to = `${fy + 1}-03-31`;

    let book;
    let alreadyRun = false;
    try {
      book = await computeDepreciation(session.firmId, session.clientId, from, to);
    } catch {
      book = { fromDate: from, toDate: to, lines: [], total: '0.00', warnings: [] };
    }
    // Already charged? Then the computed figure is what WOULD be charged
    // again, so the button is closed rather than left to be refused.
    const run = await withFirm(session.firmId, async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM depreciation_runs
          WHERE client_id = $1 AND from_date <= $3::date AND to_date >= $2::date`,
        [session.clientId, from, to]);
      return Number(r.rows[0]!.n) > 0;
    });
    alreadyRun = run;
    if (alreadyRun) book = { ...book, lines: [], total: book.total };

    return html(res, 200, renderShell({
      session, accounts, active: 'assets',
      body: renderAssets({
        asOf, fiscalYear: fy,
        register: await assetRegister(session.firmId, session.clientId, to),
        book, alreadyRun,
        tax: await taxDepreciationSchedule(session.firmId, session.clientId, fy),
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/assets/depreciate') {
    const body = JSON.parse(await readBody(req));
    try {
      const r = await postDepreciation(session.firmId, {
        clientId: session.clientId,
        fromDate: String(body.fromDate), toDate: String(body.toDate),
        createdBy: session.userId,
        // Depreciation is an estimate the client is responsible for, so the
        // person running it is the person approving it.
        approvedBy: session.userId,
      });
      return json(res, 200, {
        ok: true, total: r.total, lines: r.lines, warnings: r.warnings });
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
        reminders: url.searchParams.get('reminders') === '1',
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
    if (!hasBankCapability(session.role, 'read')) return html(res, 403, renderShell({
      session, accounts, active: 'reconcile', body: '<h1>Bank reconciliation unavailable</h1>',
    }));
    const accountId = url.searchParams.get('account') ?? accounts[0]?.id;
    if (!accountId) {
      return html(res, 200, renderShell({
        session, accounts, active: 'reconcile',
        body: renderBankAccountSetup(new Date().toISOString().slice(0, 10)),
      }));
    }
    const [queue, brs, reviewOptions] = await Promise.all([
      reconciliationQueue(session.firmId, accountId, session.clientId),
      bankReconciliationStatement(session.firmId, session.clientId, accountId,
        new Date().toISOString().slice(0, 10)),
      bankReviewOptions(session.firmId, session.clientId, accountId),
    ]);
    const classifier = await addDeepSeekFundingSuggestions(
      session.firmId, queue.items, assistantLlm);
    return html(res, 200, renderShell({
      session, accounts, active: 'reconcile', accountId,
      body: renderQueue(queue, brs, accountId, reviewOptions, {
        ...classifier, available: assistantLlm !== null,
        canReview: hasBankCapability(session.role, 'review'),
        canPost: hasBankCapability(session.role, 'confirm'),
        canManageSettings: hasBankCapability(session.role, 'manage_settings'),
      }),
    }));
  }

  if (req.method === 'POST' && path === '/api/bank-classifier-consent') {
    if (!hasBankCapability(session.role, 'manage_settings')) {
      return json(res, 403, { ok: false, error: 'owner or CA partner access required to change Nexus bank suggestions' });
    }
    const body = JSON.parse(await readBody(req));
    if (typeof body.enabled !== 'boolean') {
      return json(res, 400, { ok: false, error: 'choose whether to enable Nexus suggestions' });
    }
    if (body.enabled && !assistantLlm) {
      return json(res, 400, { ok: false, error: 'Nexus AI is not configured on this server' });
    }
    try {
      await setBankClassifierEnabled(session.firmId, body.enabled, session.userId,
        assistantLlm?.provider ?? 'deepseek', assistantLlm?.model ?? 'deepseek-chat');
      return json(res, 200, { ok: true, enabled: body.enabled });
    } catch (e) {
      return json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'GET' && path === '/import') {
    if (!hasBankCapability(session.role, 'import')) return html(res, 403, renderShell({
      session, accounts, active: 'import', body: '<h1>Statement import unavailable</h1>',
    }));
    const syncAccounts = await Promise.all(accounts.map(async (account) => ({
      ...account,
      coverage: await bankSyncCoverage(session.firmId, session.clientId, account.id),
      ...await statementPasswordSettings(session.firmId, session.clientId, account.id),
    })));
    const requestedDocumentId = url.searchParams.get('document');
    let sourceDocument: { id: string; name: string } | undefined;
    if (requestedDocumentId) {
      try {
        const received = await getDocumentBytes(
          session.firmId, session.clientId, requestedDocumentId);
        sourceDocument = { id: received.document.id, name: received.document.originalName };
      } catch {
        return html(res, 404, renderShell({
          session, accounts, active: 'import',
          body: '<h1>Document not found</h1><p class="empty">That file is not available for this client. <a href="/documents">Return to Documents</a>.</p>',
        }));
      }
    }
    return html(res, 200, renderShell({
      session, accounts, active: 'import',
      body: renderImport({ accounts: syncAccounts, banks: TEMPLATES.map((t) => t.bank),
        sourceDocument }),
    }));
  }

  if (req.method === 'GET' && path === '/brs') {
    if (!hasBankCapability(session.role, 'read')) return html(res, 403, renderShell({
      session, accounts, active: 'brs', body: '<h1>Bank reconciliation unavailable</h1>',
    }));
    const accountId = url.searchParams.get('account') ?? accounts[0]?.id;
    if (!accountId) return html(res, 404, 'no account');
    const asOf = url.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
    const brs = await bankReconciliationStatement(session.firmId, session.clientId, accountId, asOf);
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

  if (req.method === 'POST' && path === '/api/statement-password/forget') {
    if (!hasBankCapability(session.role, 'import')) {
      return json(res, 403, { ok: false, error: 'authorized bank-workflow access required' });
    }
    try {
      const body = JSON.parse(await readBody(req));
      await forgetStatementPassword(session.firmId, session.clientId,
        String(body.bankAccountId ?? ''), session.userId);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/preview') {
    if (!hasBankCapability(session.role, 'import')) {
      return json(res, 403, { ok: false, error: 'authorized bank-workflow access required' });
    }
    const body = JSON.parse(await readBody(req));
    const { fileText, fileBase64, bank, bankAccountId } = body;
    try {
      const storedDocument = typeof body.documentId === 'string'
        ? await getDocumentBytes(session.firmId, session.clientId, body.documentId)
        : null;
      if (storedDocument?.document.status === 'dismissed') {
        throw new Error('restore this dismissed document for review before opening it as a statement');
      }
      const suppliedPassword = typeof body.password === 'string' && body.password.length > 0
        ? body.password : null;
      const password = suppliedPassword ?? (bankAccountId
        ? await savedStatementPassword(session.firmId, session.clientId, bankAccountId)
        : null);
      const parse = storedDocument
        ? await parseStatementBytes(storedDocument.bytes, {
          bank: bank || undefined, password: password ?? undefined,
        })
        : fileBase64
        ? await parseStatementBytes(Buffer.from(fileBase64, 'base64'), {
          bank: bank || undefined, password: password ?? undefined,
        })
        : parseStatementFile(fileText, { bank: bank || undefined });
      const accountCheck = await confirmStatementBankAccount(
        session.firmId, session.clientId, bankAccountId, parse.statementAccountNumber);
      if (storedDocument && (session.role === 'ca_partner' || session.role === 'ca_staff')) {
        await markDocumentInReview(
          session.firmId, session.clientId, storedDocument.document.id, session.userId);
      }
      if (body.rememberPassword === true && suppliedPassword && bankAccountId) {
        await saveStatementPassword(session.firmId, {
          clientId: session.clientId, bankAccountId,
          password: suppliedPassword, updatedBy: session.userId,
          autoOpenEmail: body.autoOpenEmail === true,
        });
      } else if (bankAccountId && typeof body.autoOpenEmail === 'boolean') {
        const settings = await statementPasswordSettings(
          session.firmId, session.clientId, bankAccountId);
        if (settings.saved && settings.autoOpenEmail !== body.autoOpenEmail) {
          await setStatementAutoOpenConsent(session.firmId, session.clientId,
            bankAccountId, session.userId, body.autoOpenEmail);
        }
      }
      if (storedDocument && parse.rows.length > 0) {
        await markReviewedEmailStatement(
          session.firmId, session.clientId, storedDocument.document.id,
          bankAccountId, parse.rows.length, parse.periodFrom, parse.periodTo);
      }
      return json(res, 200, {
        ok: true,
        bank: parse.bank,
        rowCount: parse.rows.length,
        openingBalance: parse.openingBalance,
        closingBalance: parse.closingBalance,
        periodFrom: parse.periodFrom,
        periodTo: parse.periodTo,
        accountCheck,
        warnings: parse.warnings,
        skippedRows: parse.skippedRows,
        // The browser initially collapses this list for readability, but it
        // receives every parsed row so the reviewer can expand and inspect the
        // complete statement before importing it.
        rows: parse.rows,
        passwordRemembered: body.rememberPassword === true && Boolean(suppliedPassword),
        autoOpenEmail: (await statementPasswordSettings(
          session.firmId, session.clientId, bankAccountId)).autoOpenEmail,
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/import') {
    if (!hasBankCapability(session.role, 'import')) {
      return json(res, 403, { ok: false, error: 'authorized bank-workflow access required' });
    }
    const body = JSON.parse(await readBody(req));
    const storedDocument = typeof body.documentId === 'string'
      ? await getDocumentBytes(session.firmId, session.clientId, body.documentId)
      : null;
    if (storedDocument?.document.status === 'dismissed') {
      return json(res, 200, { ok: false,
        error: 'restore this dismissed document for review before importing it as a statement',
        warnings: [] });
    }
    const suppliedPassword = typeof body.password === 'string' && body.password.length > 0
      ? body.password : null;
    const password = suppliedPassword ?? await savedStatementPassword(
      session.firmId, session.clientId, body.bankAccountId);
    const common = {
      clientId: session.clientId,
      bankAccountId: body.bankAccountId,
      bank: body.bank || undefined,
      openingBalance: body.openingBalance || undefined,
      closingBalance: body.closingBalance || undefined,
      uploadedBy: session.userId,
      password: password ?? undefined,
      ...(storedDocument ? { sourceDocumentId: storedDocument.document.id } : {}),
    };
    const outcome = storedDocument
      ? await importStatementBytes(session.firmId, { ...common, fileBytes: storedDocument.bytes })
      : body.fileBase64
      ? await importStatementBytes(session.firmId, {
        ...common, fileBytes: Buffer.from(body.fileBase64, 'base64'),
      })
      : await importStatementFile(session.firmId, { ...common, fileText: body.fileText });
    if (outcome.result && body.rememberPassword === true && suppliedPassword) {
      await saveStatementPassword(session.firmId, {
        clientId: session.clientId, bankAccountId: body.bankAccountId,
        password: suppliedPassword, updatedBy: session.userId,
        autoOpenEmail: body.autoOpenEmail === true,
      });
    }
    return json(res, 200, {
      ok: outcome.result !== null,
      error: outcome.error,
      bank: outcome.parse.bank,
      imported: outcome.result?.imported ?? 0,
      duplicates: outcome.result?.duplicates ?? 0,
      arithmetic: outcome.result?.arithmetic ?? null,
      coverage: outcome.result?.coverage ?? null,
      warnings: [...outcome.parse.warnings, ...(outcome.result?.warnings ?? [])],
    });
  }

  if (req.method === 'POST' && path === '/api/accept') {
    if (!hasBankCapability(session.role, 'confirm')) {
      return json(res, 403, { ok: false, error: 'owner or CA partner confirmation is required to reconcile or post this transaction' });
    }
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

  if (req.method === 'POST' && path === '/api/bank-opening-from-statement') {
    if (!hasBankCapability(session.role, 'confirm')) {
      return json(res, 403, { ok: false, error: 'owner or CA partner confirmation is required to post an opening balance' });
    }
    const body = JSON.parse(await readBody(req));
    try {
      const result = await postOpeningFromFirstStatement(session.firmId, {
        clientId: session.clientId, bankAccountId: String(body.bankAccountId ?? ''),
        createdBy: session.userId,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return json(res, 200, { ok: false, error: (e as Error).message });
    }
  }

  if (req.method === 'POST' && path === '/api/classify') {
    if (!hasBankCapability(session.role, 'confirm')) {
      return json(res, 403, { ok: false, error: 'owner or CA partner confirmation is required to post a bank classification' });
    }
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

  if (req.method === 'POST' && path === '/api/review-bank-transaction') {
    const body = JSON.parse(await readBody(req));
    const capability = bankClassificationCapability(body.classification);
    if (!hasBankCapability(session.role, capability)) {
      return json(res, 403, { ok: false, error: capability === 'confirm'
        ? 'owner or CA partner confirmation is required to post this classification'
        : 'authorized bank-review access required' });
    }
    try {
      const r = await reviewBankTransaction(session.firmId, {
        clientId: session.clientId,
        bankTransactionId: body.bankTransactionId,
        classification: body.classification,
        accountId: body.accountId || undefined,
        sourceName: body.sourceName || undefined,
        note: body.note || undefined,
        reviewedBy: session.userId,
      });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/ignore') {
    if (!hasBankCapability(session.role, 'review')) {
      return json(res, 403, { ok: false, error: 'authorized bank-review access required' });
    }
    const body = JSON.parse(await readBody(req));
    try {
      await ignoreBankTransaction(session.firmId, session.clientId,
        String(body.bankTransactionId ?? ''));
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
  const on = [readers.paddle && 'PaddleOCR', readers.docling && 'Docling', readers.llm && 'model',
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

const emailImportConfig = r2EmailConfig();
if (emailImportConfig) {
  let importing = false;
  const poll = async () => {
    if (importing) return;
    importing = true;
    try {
      const summary = await importArchivedEmails(emailImportConfig);
      if (summary.imported || summary.duplicates || summary.held) {
        console.log('  email intake:', summary);
      }
    } catch (error) {
      console.error('  email intake poll failed:', (error as Error).message);
    } finally {
      importing = false;
    }
  };
  void poll();
  setInterval(() => void poll(), 2 * 60 * 1000).unref();
}
