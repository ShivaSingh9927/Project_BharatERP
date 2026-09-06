/**
 * India Chart of Accounts template.
 * Spec: gl-engine.md §3.6
 *
 * Top-level naming follows Indian/Tally convention ("Application of Funds",
 * "Source of Funds") rather than Western "Assets / Liabilities". This is a
 * deliberate `dont-scare-the-ca` decision — it is what CAs expect to see.
 *
 * Note that "Direct Expenses" vs "Indirect Expenses" IS the Lesson 7 COGS/OpEx
 * split, expressed the way Indian accountants already name it.
 */

import type {
  RootType, AccountType, ExpenseClass, LiquidityClass, NormalBalance,
} from '../domain/types.ts';

export interface CoaNode {
  name: string;
  code?: string;
  accountType?: AccountType;
  expenseClass?: ExpenseClass;
  liquidityClass?: LiquidityClass;
  /** Overrides the default derived from rootType — used for contra accounts. */
  normalBalance?: NormalBalance;
  children?: CoaNode[];
}

export interface CoaRoot extends CoaNode {
  rootType: RootType;
}

export const INDIA_COA: CoaRoot[] = [
  {
    name: 'Application of Funds (Assets)',
    rootType: 'asset',
    code: '1000',
    children: [
      {
        name: 'Current Assets',
        liquidityClass: 'current',
        children: [
          { name: 'Cash', accountType: 'cash', liquidityClass: 'current', code: '1010' },
          { name: 'Bank Accounts', accountType: 'bank', liquidityClass: 'current', code: '1020' },
          { name: 'Debtors', accountType: 'receivable', liquidityClass: 'current', code: '1030' },
          { name: 'Input CGST Credit', accountType: 'tax_input', liquidityClass: 'current', code: '1041' },
          { name: 'Input SGST Credit', accountType: 'tax_input', liquidityClass: 'current', code: '1042' },
          { name: 'Input IGST Credit', accountType: 'tax_input', liquidityClass: 'current', code: '1043' },
          { name: 'TDS Receivable', accountType: 'tds_receivable', liquidityClass: 'current', code: '1050' },
          { name: 'Stock in Hand', accountType: 'stock', liquidityClass: 'current', code: '1060' },
          { name: 'Loans and Advances (Assets)', accountType: 'general', liquidityClass: 'current', code: '1070' },
        ],
      },
      {
        name: 'Fixed Assets',
        liquidityClass: 'non_current',
        children: [
          { name: 'Furniture and Fixtures', accountType: 'fixed_asset', liquidityClass: 'non_current', code: '1110' },
          { name: 'Office Equipment', accountType: 'fixed_asset', liquidityClass: 'non_current', code: '1120' },
          { name: 'Plant and Machinery', accountType: 'fixed_asset', liquidityClass: 'non_current', code: '1130' },
          {
            // Contra-asset (Lesson 8): sits under Assets, but its normal
            // balance is credit. Preserves original cost while showing what
            // has been used up.
            name: 'Accumulated Depreciation',
            accountType: 'accumulated_depreciation',
            liquidityClass: 'non_current',
            normalBalance: 'credit',
            code: '1190',
          },
        ],
      },
      {
        name: 'Temporary Accounts',
        liquidityClass: 'current',
        children: [
          // Migration suspense. Must be zero at period close — never silently
          // absorb an opening-balance difference (gl-engine.md §7.2).
          { name: 'Temporary Opening', accountType: 'temporary', liquidityClass: 'current', code: '1900' },
        ],
      },
    ],
  },

  {
    name: 'Source of Funds (Liabilities)',
    rootType: 'liability',
    code: '2000',
    children: [
      {
        name: 'Current Liabilities',
        liquidityClass: 'current',
        children: [
          { name: 'Creditors', accountType: 'payable', liquidityClass: 'current', code: '2010' },
          { name: 'Output CGST Payable', accountType: 'tax_output', liquidityClass: 'current', code: '2021' },
          { name: 'Output SGST Payable', accountType: 'tax_output', liquidityClass: 'current', code: '2022' },
          { name: 'Output IGST Payable', accountType: 'tax_output', liquidityClass: 'current', code: '2023' },
          { name: 'TDS Payable', accountType: 'tds_payable', liquidityClass: 'current', code: '2030' },
        ],
      },
      {
        name: 'Loans (Liabilities)',
        liquidityClass: 'non_current',
        children: [
          { name: 'Bank Loan', accountType: 'general', liquidityClass: 'non_current', code: '2110' },
        ],
      },
    ],
  },

  {
    name: 'Capital Account',
    rootType: 'equity',
    code: '3000',
    children: [
      { name: "Owner's Capital", accountType: 'capital', code: '3010' },
      {
        // Lesson 3: the owner taking money out is NOT an expense. It reduces
        // equity — the mirror of Capital. Booking it as an expense understates
        // profit and is a tax-compliance risk.
        name: 'Drawings',
        accountType: 'drawings',
        normalBalance: 'debit',
        code: '3020',
      },
      { name: 'Reserves and Surplus', accountType: 'equity', code: '3030' },
    ],
  },

  {
    name: 'Income',
    rootType: 'income',
    code: '4000',
    children: [
      {
        name: 'Direct Income',
        children: [
          { name: 'Sales', accountType: 'general', code: '4010' },
          { name: 'Service Income', accountType: 'general', code: '4020' },
        ],
      },
      {
        name: 'Indirect Income',
        children: [
          { name: 'Interest Income', accountType: 'general', code: '4110' },
          { name: 'Other Income', accountType: 'general', code: '4120' },
        ],
      },
    ],
  },

  {
    name: 'Expenses',
    rootType: 'expense',
    code: '5000',
    children: [
      {
        // "Direct Expenses" is the Indian name for COGS (Lesson 7).
        name: 'Direct Expenses',
        expenseClass: 'cogs',
        children: [
          { name: 'Purchases', accountType: 'cogs', expenseClass: 'cogs', code: '5010' },
          { name: 'Raw Materials', accountType: 'cogs', expenseClass: 'cogs', code: '5020' },
          { name: 'Factory Wages', accountType: 'cogs', expenseClass: 'cogs', code: '5030' },
          { name: 'Freight Inward', accountType: 'cogs', expenseClass: 'cogs', code: '5040' },
        ],
      },
      {
        name: 'Indirect Expenses',
        expenseClass: 'opex',
        children: [
          { name: 'Salary', accountType: 'general', expenseClass: 'opex', code: '5110' },
          { name: 'Office Rent', accountType: 'general', expenseClass: 'opex', code: '5120' },
          { name: 'Marketing', accountType: 'general', expenseClass: 'opex', code: '5130' },
          { name: 'Travel Expenses', accountType: 'general', expenseClass: 'opex', code: '5140' },
          { name: 'Utility Expenses', accountType: 'general', expenseClass: 'opex', code: '5150' },
          { name: 'Professional Fees', accountType: 'general', expenseClass: 'opex', code: '5160' },
          { name: 'Print and Stationery', accountType: 'general', expenseClass: 'opex', code: '5170' },
          { name: 'Bank Charges', accountType: 'general', expenseClass: 'opex', code: '5180' },
          { name: 'Depreciation', accountType: 'general', expenseClass: 'opex', code: '5190' },
          // Lesson 4: a customer who will never pay is a real business loss —
          // an Expense, distinct from Drawings.
          { name: 'Bad Debts', accountType: 'general', expenseClass: 'opex', code: '5195' },
          { name: 'Round Off', accountType: 'round_off', expenseClass: 'opex', code: '5199' },
        ],
      },
      {
        name: 'Non-Operating',
        expenseClass: 'non_operating',
        children: [
          { name: 'Interest on Loan', accountType: 'general', expenseClass: 'non_operating', code: '5210' },
          { name: 'Income Tax', accountType: 'general', expenseClass: 'non_operating', code: '5220' },
        ],
      },
    ],
  },
];

/** Debit-normal roots vs credit-normal roots. Lesson 1 / DEAD CLIC. */
export function defaultNormalBalance(rootType: RootType): NormalBalance {
  return rootType === 'asset' || rootType === 'expense' ? 'debit' : 'credit';
}
