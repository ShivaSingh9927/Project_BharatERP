/**
 * Per-bank statement templates.
 * Spec: bank-and-reconciliation.md §5.2
 *
 * ⚠️ COLUMN HEADINGS ARE UNVERIFIED. They are drawn from commonly documented
 * export layouts, not from real files. Question B1 in CA-REVIEW-REQUEST.md asks
 * which banks the pilot clients actually use — validate each template against a
 * genuine export before relying on it. The *shape* is what is being committed
 * here, exactly as with the GST and TDS masters.
 *
 * A wrong template is not dangerous, only annoying: BR-6's arithmetic check
 * rejects a mis-parsed file rather than importing it. That is the whole reason
 * it is safe to ship templates built from documentation.
 *
 * DIVERGENCE FROM SPEC: §5.2 models these as a `bank_statement_templates`
 * table, versioned by effective date. They live in code instead, for now —
 * templates are tested, reviewed and versioned by git, and a database table
 * buys the ability to add a bank without a deploy, which is not worth having
 * before there is anyone to deploy for. Revisit when support engineers exist.
 */

import type { DateFormat } from './values.ts';

export type AmountConvention =
  /** Separate withdrawal and deposit columns — the usual Indian layout. */
  | 'separate_dr_cr'
  /** One signed column, negative meaning money out. */
  | 'single_signed'
  /** One amount column plus a separate Dr/Cr type column. */
  | 'amount_plus_type';

export interface BankTemplate {
  bank: string;
  /** Higher wins when several templates match. */
  priority: number;
  dateFormat: DateFormat;
  amountConvention: AmountConvention;
  /**
   * Header cell text, lower-cased, matched by substring. The first heading
   * that contains any of these aliases claims the column.
   */
  columns: {
    txnDate: string[];
    valueDate?: string[];
    narration: string[];
    reference?: string[];
    debit?: string[];
    credit?: string[];
    amount?: string[];
    drCrFlag?: string[];
    balance?: string[];
  };
  /** Substrings that identify this bank anywhere in the file's first rows. */
  detect: string[];
}

/**
 * Ordered by priority. `generic` exists so an unrecognised bank still imports
 * — BR-5 says auto-detect but always let the user override, and refusing an
 * unknown layout outright would make the feature useless on its first contact
 * with a bank we have not seen.
 */
export const TEMPLATES: BankTemplate[] = [
  {
    bank: 'HDFC Bank',
    priority: 90,
    dateFormat: 'dd/MM/yy',
    amountConvention: 'separate_dr_cr',
    detect: ['hdfc'],
    columns: {
      txnDate: ['date'],
      valueDate: ['value dt', 'value date'],
      narration: ['narration'],
      reference: ['chq./ref.no', 'chq/ref', 'ref.no', 'reference'],
      debit: ['withdrawal amt', 'withdrawal'],
      credit: ['deposit amt', 'deposit'],
      balance: ['closing balance', 'balance'],
    },
  },
  {
    bank: 'ICICI Bank',
    priority: 90,
    dateFormat: 'dd/MM/yyyy',
    amountConvention: 'separate_dr_cr',
    detect: ['icici'],
    columns: {
      txnDate: ['transaction date', 'txn date'],
      valueDate: ['value date'],
      narration: ['transaction remarks', 'remarks', 'description'],
      reference: ['cheque number', 'cheque no'],
      debit: ['withdrawal amount', 'withdrawal'],
      credit: ['deposit amount', 'deposit'],
      balance: ['balance'],
    },
  },
  {
    bank: 'State Bank of India',
    priority: 90,
    // Corrected from 'dd MMM yyyy' against a real net-banking statement, which
    // writes transaction dates as 01/09/2026 — day-first with slashes. Its
    // header and summary lines use dd-MM-yyyy, so one document carries two
    // formats; only the transaction rows matter here.
    dateFormat: 'dd/MM/yyyy',
    amountConvention: 'separate_dr_cr',
    detect: ['state bank of india', 'sbi'],
    columns: {
      txnDate: ['txn date', 'transaction date', 'date'],
      valueDate: ['value date'],
      narration: ['description', 'particulars', 'narration'],
      reference: ['ref no./cheque no', 'ref no', 'cheque no'],
      debit: ['debit'],
      credit: ['credit'],
      balance: ['balance'],
    },
  },
  {
    bank: 'Axis Bank',
    priority: 90,
    dateFormat: 'dd-MM-yyyy',
    amountConvention: 'separate_dr_cr',
    detect: ['axis'],
    columns: {
      txnDate: ['tran date', 'transaction date'],
      valueDate: ['value date'],
      narration: ['particulars'],
      reference: ['chqno', 'chq no', 'cheque'],
      debit: ['dr', 'debit'],
      credit: ['cr', 'credit'],
      balance: ['bal', 'balance'],
    },
  },
  {
    bank: 'Kotak Mahindra Bank',
    priority: 90,
    dateFormat: 'dd-MM-yyyy',
    amountConvention: 'amount_plus_type',
    detect: ['kotak'],
    columns: {
      txnDate: ['transaction date', 'date'],
      valueDate: ['value date'],
      narration: ['description', 'narration'],
      reference: ['chq / ref no', 'ref no', 'cheque'],
      amount: ['amount'],
      drCrFlag: ['dr / cr', 'dr/cr', 'type'],
      balance: ['balance'],
    },
  },
  {
    bank: 'Generic (separate debit/credit columns)',
    priority: 10,
    dateFormat: 'dd/MM/yyyy',
    amountConvention: 'separate_dr_cr',
    detect: [],
    columns: {
      txnDate: ['txn date', 'transaction date', 'tran date', 'date'],
      valueDate: ['value date', 'value dt'],
      narration: ['narration', 'description', 'particulars', 'remarks', 'details'],
      reference: ['ref', 'cheque', 'chq', 'utr'],
      debit: ['withdrawal', 'debit', 'dr amount', 'paid out', 'dr'],
      credit: ['deposit', 'credit', 'cr amount', 'paid in', 'cr'],
      balance: ['closing balance', 'running balance', 'balance', 'bal'],
    },
  },
  {
    bank: 'Generic (single signed amount column)',
    priority: 5,
    dateFormat: 'dd/MM/yyyy',
    amountConvention: 'single_signed',
    detect: [],
    columns: {
      txnDate: ['txn date', 'transaction date', 'date'],
      narration: ['narration', 'description', 'particulars', 'remarks'],
      reference: ['ref', 'cheque', 'utr'],
      amount: ['amount', 'transaction amount'],
      balance: ['balance', 'bal'],
    },
  },
];

/**
 * Which template does this file look like?
 *
 * Bank name first, since it is unambiguous when present. Otherwise fall back to
 * whichever generic template can actually resolve the columns — decided by the
 * caller, which is why this returns candidates in preference order rather than
 * a single answer.
 */
export function candidateTemplates(headerText: string): BankTemplate[] {
  const hay = headerText.toLowerCase();
  const named = TEMPLATES
    .filter((t) => t.detect.some((d) => hay.includes(d)))
    .sort((a, b) => b.priority - a.priority);
  const generic = TEMPLATES
    .filter((t) => t.detect.length === 0)
    .sort((a, b) => b.priority - a.priority);
  return [...named, ...generic];
}

export function templateByName(bank: string): BankTemplate | undefined {
  return TEMPLATES.find((t) => t.bank.toLowerCase() === bank.toLowerCase());
}
