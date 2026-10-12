import { describe, expect, it } from 'vitest';
import { renderSales, renderSalesInvoice } from '../src/web/views.ts';
import { createCustomer } from '../src/domain/sales.ts';
import { createInvoice } from '../src/domain/invoicing.ts';

const emptyDesk = {
  customers: [], registrations: [], incomeAccounts: [], invoices: [],
};

describe('sales desk', () => {
  it('directs a new client through the required setup', () => {
    const html = renderSales({ desk: emptyDesk, today: '2026-09-14' });
    expect(html).toContain('Add the first customer');
    expect(html).toContain('Add an active GST registration');
    expect(html).toContain('Add a sales or income ledger');
    expect(html).toMatch(/id="post-invoice" disabled/);
  });

  it('renders the invoice entry and recent invoices without trusting names', () => {
    const html = renderSales({
      today: '2026-09-14',
      desk: {
        customers: [{
          id: 'customer-1', name: '<Acme & Sons>', legalName: null,
          gstin: null, gstCategory: 'unregistered', stateCode: '27', phone: '9876543210',
        }],
        registrations: [{ id: 'reg-1', gstin: '27AAPFS4321L1ZA', stateCode: '27', primary: true }],
        incomeAccounts: [{ id: 'income-1', name: 'Sales' }],
        invoices: [{
          voucherId: 'invoice-1', invoiceNumber: 'INV/26-27/0001',
          postingDate: '2026-09-14', customerName: '<Acme & Sons>',
          grandTotal: '11800.00', outstanding: '11800.00',
        }],
      },
    });
    expect(html).toContain('id="invoice-lines"');
    expect(html).toContain('class="page-intro"');
    expect(html).toContain('invoices in this view');
    expect(html).toContain('Next: enter customer and invoice lines');
    expect(html).toContain('Posting preview');
    expect(html).toContain("$('post-invoice').disabled = !$('invoice-registration').value");
    expect(html).toContain('&lt;Acme &amp; Sons&gt;');
    expect(html).not.toContain('<Acme & Sons>');
    expect(html).toContain('/sales/invoice-1');

    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('rejects invalid customer details before touching the database', async () => {
    await expect(createCustomer('firm', {
      clientId: 'client', name: '', gstCategory: 'unregistered',
      stateCode: '27', billingAddress: 'Mumbai', createdBy: 'user',
    })).rejects.toThrow(/customer name is required/);

    await expect(createCustomer('firm', {
      clientId: 'client', name: 'Acme', gstCategory: 'registered_regular',
      gstin: 'not-a-gstin', stateCode: '27', billingAddress: 'Mumbai', createdBy: 'user',
    })).rejects.toThrow(/GSTIN invalid/);
  });

  it('rejects an incomplete invoice line before touching the database', async () => {
    await expect(createInvoice('firm', {
      clientId: 'client', partyId: 'customer', postingDate: '2026-09-14',
      createdBy: 'user',
      lines: [{ description: '', hsnSac: '7318', quantity: '1',
        unitPrice: '100', gstRate: '18', incomeAccountId: 'not-an-account' }],
    })).rejects.toThrow(/line 1 has no description/);
  });
});

describe('printable invoice', () => {
  it('shows the statutory identities, lines and total', () => {
    const html = renderSalesInvoice({
      voucherId: 'v1', invoiceNumber: 'INV/26-27/0001',
      supplierName: 'Shree Ram Trading',
      postingDate: '2026-09-14', dueDate: '2026-10-14',
      customerName: 'Acme Trading', customerGstin: '27AABCA4444P1ZK',
      customerPhone: '98765 43210',
      billingAddress: 'Fort, Mumbai',
      supplierGstin: '27AAPFS4321L1ZA', placeOfSupply: '27',
      taxableValue: '10000.00', totalCgst: '900.00', totalSgst: '900.00',
      totalIgst: '0.00', totalCess: '0.00', roundOff: '0.00', grandTotal: '11800.00',
      lines: [{
        description: 'Fasteners', hsnSac: '7318', quantity: '1.000', uom: 'NOS',
        unitPrice: '10000.0000', taxableValue: '10000.00', gstRate: '18.00',
        cgst: '900.00', sgst: '900.00', igst: '0.00', cess: '0.00',
      }],
    });
    expect(html).toContain('Tax invoice');
    expect(html).toContain('27AABCA4444P1ZK');
    expect(html).toContain('Fasteners');
    expect(html).toContain('₹11,800.00');
    expect(html).not.toContain('>IGST<');
    expect(html).toContain('Share on WhatsApp');
    expect(html).toContain('Send payment reminder');
    expect(html).toContain('wa.me/9876543210');
  });
});
