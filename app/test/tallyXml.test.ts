import { describe, expect, it } from 'vitest';
import { parseTallyXml } from '../src/parse/tallyXml.ts';
import { renderTallyImport } from '../src/web/views.ts';
import { suggestTallyMappings } from '../src/domain/tallyImport.ts';

const exportXml = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC><STATICVARIABLES>
    <SVCURRENTCOMPANY>Shree Ram &amp; Co</SVCURRENTCOMPANY>
  </STATICVARIABLES></REQUESTDESC><REQUESTDATA>
    <TALLYMESSAGE><GROUP NAME="North Zone Debtors"><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
    <TALLYMESSAGE>
      <LEDGER NAME="Acme &amp; Sons"><PARENT>North Zone Debtors</PARENT>
        <MAILINGNAME>Acme Trading Private Limited</MAILINGNAME>
        <ADDRESS.LIST><ADDRESS>Fort</ADDRESS><ADDRESS>Mumbai</ADDRESS></ADDRESS.LIST>
        <PARTYGSTREGISTRATIONTYPE>Regular</PARTYGSTREGISTRATIONTYPE>
        <PARTYGSTIN>27AABCA4444P1ZK</PARTYGSTIN><OPENINGBALANCE>-1,000.00</OPENINGBALANCE>
      </LEDGER>
    </TALLYMESSAGE>
    <TALLYMESSAGE>
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>20260914</DATE><GUID>abc-123</GUID><VOUCHERNUMBER>12</VOUCHERNUMBER>
        <NARRATION>Fasteners &amp; bolts</NARRATION>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme &amp; Sons</LEDGERNAME><AMOUNT>-11800</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>10000</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>900</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>900</AMOUNT></ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </TALLYMESSAGE>
  </REQUESTDATA></EXPORTDATA></BODY>
</ENVELOPE>`;

describe('Tally XML preview', () => {
  it('renders an upload screen with valid client-side code', () => {
    const html = renderTallyImport();
    expect(html).toContain('Choose Tally XML');
    expect(html).toContain('/api/tally/preview');
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('reads masters and converts Tally signs into debit and credit', () => {
    const result = parseTallyXml(exportXml);
    expect(result.companies).toEqual(['Shree Ram & Co']);
    expect(result.ledgers).toEqual([{
      name: 'Acme & Sons', parent: 'North Zone Debtors', gstin: '27AABCA4444P1ZK',
      openingBalance: '-1000.00', partyType: 'customer',
      mailingName: 'Acme Trading Private Limited', address: 'Fort, Mumbai',
      gstRegistrationType: 'Regular',
    }]);
    expect(result.vouchers[0]).toMatchObject({
      type: 'sales', sourceType: 'Sales', number: '12', date: '2026-09-14',
      narration: 'Fasteners & bolts', difference: '0.00', balanced: true,
    });
    expect(result.vouchers[0]!.entries[0]).toEqual({
      ledgerName: 'Acme & Sons', signedAmount: '-11800.00',
      debit: '11800.00', credit: '0.00',
    });
    expect(result.stats).toEqual({
      ledgerCount: 1, voucherCount: 1, balancedCount: 1,
      unbalancedCount: 0, unsupportedCount: 0,
    });
  });

  it('suggests only exact or narrow, known ledger mappings', () => {
    const preview = parseTallyXml(exportXml);
    const mappings = suggestTallyMappings(preview, [
      { id: 'a1', name: 'Debtors', rootType: 'asset', accountType: 'receivable' },
      { id: 'a2', name: 'Sales', rootType: 'income', accountType: 'general' },
      { id: 'a3', name: 'Output CGST Payable', rootType: 'liability', accountType: 'tax_output' },
      { id: 'a4', name: 'Output SGST Payable', rootType: 'liability', accountType: 'tax_output' },
    ]);
    expect(mappings.find((x) => x.sourceName === 'Sales')?.suggestedAccountId).toBe('a2');
    expect(mappings.find((x) => x.sourceName === 'Output CGST')?.suggestedAccountId).toBe('a3');
    expect(mappings.find((x) => x.sourceName === 'Acme & Sons')).toMatchObject({
      suggestedAccountId: 'a1', partyType: 'customer',
    });
  });

  it('surfaces unsupported, invalid and unbalanced vouchers instead of guessing', () => {
    const xml = `<ENVELOPE><VOUCHER VCHTYPE="Memorandum">
      <DATE>14/09/2026</DATE><VOUCHERNUMBER>M-1</VOUCHERNUMBER>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
    const result = parseTallyXml(xml);
    expect(result.vouchers[0]).toMatchObject({ type: null, date: null, balanced: false });
    expect(result.stats.unbalancedCount).toBe(1);
    expect(result.stats.unsupportedCount).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/invalid YYYYMMDD date/);
  });

  it('rejects a raw backup or arbitrary file with export instructions', () => {
    expect(() => parseTallyXml('company.900 binary data'))
      .toThrow(/export Masters and Transactions as XML/);
  });

  it('rejects declarations that could expand external entities', () => {
    expect(() => parseTallyXml('<!DOCTYPE x [<!ENTITY x SYSTEM "file">]><ENVELOPE/>'))
      .toThrow(/DTD and entity declarations/);
  });
});
