import { describe, expect, it } from 'vitest';
import { answerAssistantWithAi, namedInvoiceMatches, profitPeriod,
         requestedCustomerName } from '../src/domain/assistant.ts';

describe('Bharat Nexus routing details', () => {
  it('names an explicit P&L range for profit questions', () => {
    expect(profitPeriod('what is the total profit', '2026-10-01')).toEqual({
      from: '2026-04-01', to: '2026-10-01', label: 'for FY 2026-27 to date',
    });
    expect(profitPeriod('profit last month', '2026-10-01')).toEqual({
      from: '2026-09-01', to: '2026-09-30', label: 'for 2026-09',
    });
    expect(profitPeriod('profit this month', '2026-10-01')).toEqual({
      from: '2026-10-01', to: '2026-10-01', label: 'for 2026-10 to date',
    });
  });

  it('finds a spoken customer name without the legal suffix', () => {
    const invoices = [
      { customerName: 'ABC Traders Pvt Ltd', invoiceNumber: 'INV-1' },
      { customerName: 'Nova Consulting LLP', invoiceNumber: 'INV-2' },
    ];
    expect(namedInvoiceMatches(invoices, 'What does ABC Traders still owe?'))
      .toEqual([invoices[0]]);
    expect(namedInvoiceMatches(invoices, 'What does INV-2 still owe?'))
      .toEqual([invoices[1]]);
    expect(namedInvoiceMatches(invoices, 'What do customers owe?')).toEqual([]);
    expect(requestedCustomerName('What does ABC Traders still owe?')).toBe('ABC Traders');
    expect(requestedCustomerName('How much do customers owe?')).toBeNull();
  });

  it('does not route an ITR deadline question to generic status', async () => {
    const reply = await answerAssistantWithAi('firm', 'client',
      'When do we have to file next ITR?', 'nexus', {
        provider: 'deepseek', model: 'test',
        complete: async () => '{"intent":"attention"}',
      });
    expect(reply.supported).toBe(false);
    expect(reply.answer).toMatch(/cannot determine your next income-tax return deadline/);
  });
});
