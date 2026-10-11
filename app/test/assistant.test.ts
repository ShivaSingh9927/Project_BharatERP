import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { closePools } from '../src/db/pool.ts';
import { answerAssistant, answerAssistantWithAi, recordAssistantRun } from '../src/domain/assistant.ts';
import { withFirm } from '../src/db/pool.ts';
import { createBankAccount } from '../src/domain/banking.ts';
import type { LlmClient } from '../src/parse/llmTable.ts';

let tenant: SeededTenant;

beforeAll(async () => {
  tenant = await seedTenant({
    firmName: `Assistant ${randomUUID().slice(0, 8)}`,
    clientName: 'Assistant client',
    userEmail: `assistant-${randomUUID()}@test.local`,
    startYear: 2026,
  });
});

afterAll(async () => closePools());

describe('Ask Bharat read-only tools', () => {
  it('answers profit from the posted P&L with an explicit period', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'how much profit am I making?', 'nexus');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toMatch(/net profit of ₹0.00/);
    expect(reply.answer).toMatch(/FY \d{4}-\d{2} to date/);
    expect(reply.evidence).toContain('Profit and loss from posted ledger entries');
  });

  it('routes a profit question through DeepSeek without asking it to calculate', async () => {
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => '{"intent":"profit"}',
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'what is the total profit', 'nexus', router);
    expect(reply.supported).toBe(true);
    expect(reply.answer).toContain('net profit');
    expect(reply.audit?.intent).toBe('profit');
  });
  it('answers payable questions from the ledger', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'How much do we owe suppliers?', 'payables');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toBe('There are no unpaid supplier bills.');
    expect(reply.action?.href).toBe('/payables');
    expect(reply.evidence).toContain('Payable ledger settlements');
  });

  it('explains that reconciliation needs a bank account', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'Can we reconcile the bank?', 'reconcile');
    expect(reply.answer).toMatch(/No bank account/);
    expect(reply.action).toEqual({ href: '/reconcile', label: 'Add bank account' });
  });

  it('refuses unsupported questions instead of inventing an answer', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'Predict annual revenue exactly', 'home');
    expect(reply.supported).toBe(false);
    expect(reply.answer).toMatch(/no supported book query for that subject/i);
  });

  it('explains why a short follow-up cannot be answered without chat context', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'now tell me', 'nexus');
    expect(reply.supported).toBe(false);
    expect(reply.answer).toMatch(/need the earlier topic/i);
    expect(reply.evidence).toContain('No preceding user question was available in this request');
  });

  it('routes “how much do we have” to a clear bank balance answer when no account exists', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'How much do we have?', 'nexus');
    expect(reply.supported).toBe(false);
    expect(reply.answer).toMatch(/no connected bank account/i);
    expect(reply.action?.href).toBe('/accounts');
  });

  it('reports an exact connected bank ledger balance and its scope', async () => {
    const balanceTenant = await seedTenant({
      firmName: `Balance ${randomUUID().slice(0, 8)}`,
      clientName: 'Balance client',
      userEmail: `balance-${randomUUID()}@test.local`,
      startYear: 2026,
    });
    const account = await createBankAccount(balanceTenant.firmId, {
      clientId: balanceTenant.clientId,
      bankName: 'HDFC Bank',
      accountNumber: `5020012543${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      kind: 'current',
      openingBalance: '51000.25',
      openingDate: '2026-04-01',
      createdBy: balanceTenant.userId,
    });
    const reply = await answerAssistant(
      balanceTenant.firmId, balanceTenant.clientId, 'How much do we have?', 'nexus');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toContain('₹51,000.25');
    expect(reply.answer).toContain('HDFC Bank ··');
    expect(reply.answer).toContain('book balance');
    expect(reply.evidence).toContain('Posted ledger entries for connected bank accounts');
    expect(reply.action?.href).toBe('/accounts');
    expect(account.last4).toHaveLength(4);
  });

  it('does not delegate money balance questions to the AI router', async () => {
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => { throw new Error('router should not be called'); },
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'How much do we have?', 'nexus', router);
    expect(reply.audit?.routingMode).toBe('deterministic');
    expect(reply.audit?.intent).toBe('bank_balance');
    expect(reply.answer).toMatch(/no connected bank account/i);
  });

  it('uses the prior user question to resolve a period follow-up before querying books', async () => {
    let routedQuestion = '';
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async (_system, user) => { routedQuestion = user; return '{"intent":"profit"}'; },
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'what about last month?', 'nexus', router,
      'How much profit are we making?',
    );
    expect(routedQuestion).toContain('How much profit are we making? (last month)');
    expect(reply.answer).toMatch(/net profit.*for \d{4}-\d{2}/);
    expect(reply.audit?.intent).toBe('profit');
  });

  it('does not answer a period-sensitive follow-up with a current-only total', async () => {
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => { throw new Error('unsupported period should not be routed'); },
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'what about last month?', 'nexus', router,
      'How much do we owe suppliers?',
    );
    expect(reply.supported).toBe(false);
    expect(reply.answer).toMatch(/historical periods.*profit and connected bank book balances/i);
  });

  it('explains that source-level “show me more” follow-ups are not wired yet', async () => {
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => { throw new Error('detail follow-up should not be routed'); },
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'show me more', 'nexus', router,
      'How much do we have?',
    );
    expect(reply.supported).toBe(false);
    expect(reply.answer).toMatch(/source-level drill-down.*not connected/i);
    expect(reply.answer).toContain('Which bank transactions are still unmatched?');
  });

  it('gives contextual page help', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'How does this page work?', 'bills');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toMatch(/Upload a bill or receipt/);
  });

  it('never invents a payment draft when no payable exists', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'Prepare payment for Campus E-Shop', 'payables');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toMatch(/no unpaid supplier bills/i);
    expect(reply.evidence).toContain('Payable ledger settlements');
  });

  it('does not invent a reconciliation draft without a bank account', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'Prepare bank reconciliation review', 'reconcile');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toMatch(/No bank account is set up/);
    expect(reply.action).toEqual({ href: '/accounts', label: 'Add bank account' });
  });

  it('does not invent an invoice customer master from chat', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'Create invoice for ₹1000 to New Customer at 18% GST', 'sales');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toMatch(/Add a customer/);
    expect(reply.action).toEqual({ href: '/sales', label: 'Add customer' });
  });

  it('does not draft reminders when no customer invoice is overdue', async () => {
    const reply = await answerAssistant(
      tenant.firmId, tenant.clientId, 'Draft payment reminders', 'receivables');
    expect(reply.supported).toBe(true);
    expect(reply.answer).toMatch(/no overdue customer invoices/i);
  });

  it('lets DeepSeek route natural wording but keeps figures in book tools', async () => {
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => '{"intent":"payables"}',
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId,
      'Are there people whose payment is still pending from our side?',
      'accounts', router,
    );
    expect(reply.supported).toBe(true);
    expect(reply.answer).toBe('There are no unpaid supplier bills.');
    expect(reply.evidence).toContain('Payable ledger settlements');
  });

  it('understands a natural-language follow-up question through the read-only receivables tool', async () => {
    const router: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => '{"intent":"receivables"}',
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId,
      'Who should I follow up with for collections this week?', 'home', router,
    );
    expect(reply.supported).toBe(true);
    expect(reply.answer).toBe('No customer invoices are outstanding.');
    expect(reply.action?.href).toBe('/receivables');
  });

  it('falls back safely when DeepSeek is unavailable', async () => {
    const unavailable: LlmClient = {
      provider: 'deepseek', model: 'test',
      complete: async () => { throw new Error('offline'); },
    };
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'How much do we owe suppliers?',
      'payables', unavailable,
    );
    expect(reply.supported).toBe(true);
    expect(reply.answer).toBe('There are no unpaid supplier bills.');
    expect(reply.audit?.routingMode).toBe('deepseek_fallback');
  });

  it('writes an append-only audit record for the answer the CA saw', async () => {
    const reply = await answerAssistantWithAi(
      tenant.firmId, tenant.clientId, 'How much do we owe suppliers?',
      'payables', null,
    );
    await recordAssistantRun(tenant.firmId, {
      clientId: tenant.clientId, userId: tenant.userId,
      question: 'How much do we owe suppliers?', page: 'payables', reply, durationMs: 12,
    });
    const row = await withFirm(tenant.firmId, async (c) => (await c.query<{
      routing_mode: string; answer: string; evidence: string[]; duration_ms: number;
    }>(`SELECT routing_mode, answer, evidence, duration_ms FROM assistant_runs
        WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenant.clientId])).rows[0]);
    expect(row).toMatchObject({
      routing_mode: 'deterministic', answer: 'There are no unpaid supplier bills.', duration_ms: 12,
    });
    expect(row?.evidence).toContain('Payable ledger settlements');
  });
});
