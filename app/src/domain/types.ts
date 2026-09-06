/**
 * Domain types for the GL engine.
 * Spec: gl-engine.md §3, §5
 *
 * Money is `string` throughout, never `number`. IEEE-754 cannot represent
 * 0.01 exactly, and a rounding artefact in a ledger is an unbalanced voucher.
 * Postgres numeric(18,2) is the source of truth; we pass decimal strings.
 */

export type RootType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type ExpenseClass = 'cogs' | 'opex' | 'non_operating';
export type LiquidityClass = 'current' | 'non_current';

export type AccountType =
  | 'bank' | 'cash'
  | 'receivable' | 'payable'
  | 'tax_output' | 'tax_input'
  | 'tds_payable' | 'tds_receivable'
  | 'fixed_asset' | 'accumulated_depreciation'
  | 'stock' | 'cogs'
  | 'equity' | 'capital' | 'drawings'
  | 'round_off' | 'temporary'
  | 'general';

/** Mirrors Tally's voucher taxonomy, including F-key mapping. gl-engine.md §5.4 */
export type VoucherType =
  | 'contra'        // F4
  | 'payment'       // F5
  | 'receipt'       // F6
  | 'journal'       // F7
  | 'sales'         // F8
  | 'purchase'      // F9
  | 'credit_note'   // Ctrl+F8
  | 'debit_note'    // Ctrl+F9
  | 'opening'
  | 'depreciation'
  | 'period_close';

export const TALLY_KEYS: Partial<Record<VoucherType, string>> = {
  contra: 'F4',
  payment: 'F5',
  receipt: 'F6',
  journal: 'F7',
  sales: 'F8',
  purchase: 'F9',
  credit_note: 'Ctrl+F8',
  debit_note: 'Ctrl+F9',
};

export type CreatedVia = 'ui' | 'api' | 'ai_proposal' | 'tally_import' | 'whatsapp';
export type PartyType = 'customer' | 'supplier' | 'employee';
export type ActorType = 'human' | 'ai_agent' | 'system_job' | 'support_engineer';

/** One side of a double entry. Exactly one of debit/credit is non-zero. */
export interface LedgerLineInput {
  accountId: string;
  debit?: string;
  credit?: string;
  partyType?: PartyType;
  partyId?: string;
  costCenterId?: string;
  settlesVoucherId?: string;
  isOpening?: boolean;
  financeBookId?: string;
}

export interface PostVoucherInput {
  clientId: string;
  voucherType: VoucherType;
  postingDate: string;            // 'YYYY-MM-DD' — the accounting date
  narration?: string;
  lines: LedgerLineInput[];
  createdBy: string;
  createdVia?: CreatedVia;
  /** Required when createdVia is 'ai_proposal' — AT-13. */
  approvedBy?: string;
  aiProposalId?: string;
  sourceDocumentId?: string;
  /** Explicit number, e.g. during Tally import. Otherwise allocated atomically. */
  voucherNumber?: string;
  actorType?: ActorType;
  aiModel?: string;
  batchId?: string;
}

export interface PostedVoucher {
  id: string;
  voucherNumber: string;
  fiscalYearId: string;
  lineCount: number;
}

/**
 * Thrown when a spec validation rule rejects a posting.
 *
 * The rule identifier is prefixed onto the message as well as exposed as a
 * property, so a log line or an error surfaced to a CA is traceable straight
 * back to the numbered rule in gl-engine.md §6 that caused it.
 */
export class ValidationError extends Error {
  constructor(
    detail: string,
    /** The spec rule identifier, e.g. 'V-1'. */
    readonly rule: string,
  ) {
    super(`${rule}: ${detail}`);
    this.name = 'ValidationError';
  }
}
