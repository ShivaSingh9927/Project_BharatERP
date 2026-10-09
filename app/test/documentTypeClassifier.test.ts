import { describe, expect, it } from 'vitest';
import { buildDocumentClassificationInput, DOCUMENT_CLASSIFIER_SYSTEM_PROMPT,
  parseDocumentClassSuggestion } from '../src/domain/documentTypeClassifier.ts';
import type { LlmClient } from '../src/parse/llmTable.ts';

const llm: LlmClient = { provider: 'deepseek', model: 'test-model',
  complete: async () => '{}' };

describe('DeepSeek document class suggestions', () => {
  it('sends redacted text and labels document content as untrusted', () => {
    const input = buildDocumentClassificationInput('supplier-123456789012.txt', 'text/plain',
      Buffer.from('TAX INVOICE\nPAN: ABCDE1234F\nGSTIN 27ABCDE1234F1Z5\n' +
        'bank A/C 1234567890123456\nRs 12,345.67\nhello@example.com'));
    expect(input).toContain('TAX INVOICE');
    expect(input).toContain('[redacted PAN]');
    expect(input).toContain('[redacted GSTIN]');
    expect(input).toContain('[redacted number]');
    expect(input).toContain('[redacted amount]');
    expect(input).toContain('[redacted email]');
    expect(input).not.toContain('ABCDE1234F');
    expect(input).not.toContain('1234567890123456');
    expect(DOCUMENT_CLASSIFIER_SYSTEM_PROMPT).toContain('untrusted document data');
    expect(DOCUMENT_CLASSIFIER_SYSTEM_PROMPT).toContain('Never recommend posting');
  });

  it('accepts only allowed classes and exact quoted evidence', () => {
    const supplied = '{"filename":"bill.pdf","text":"TAX INVOICE"}';
    const suggestion = parseDocumentClassSuggestion({ document_class: 'purchase_bill',
      subtype: null, confidence: 88, rationale: 'Tax invoice heading found.',
      evidence: ['TAX INVOICE', 'invented phrase'] }, llm, supplied);
    expect(suggestion?.documentClass).toBe('purchase_bill');
    expect(suggestion?.evidence).toEqual(['TAX INVOICE']);
    expect(parseDocumentClassSuggestion({ document_class: 'ledger_entry', confidence: 99 }, llm, supplied))
      .toBeNull();
    expect(parseDocumentClassSuggestion({ document_class: 'bank_statement', confidence: 101 }, llm, supplied))
      .toBeNull();
  });
});
