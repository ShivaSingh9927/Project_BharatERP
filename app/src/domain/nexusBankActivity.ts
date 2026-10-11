import { withFirm } from '../db/pool.ts';
import { validateNexusBlocks, type NexusBlockEnvelope, type Provenance, type Source } from '../web/nexusBlocks.ts';
import { ValidationError } from './types.ts';

const MAX_ROWS = 25;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type TransactionRow = {
  id: string;
  txn_date: string;
  narration: string;
  debit: string;
  credit: string;
  reference_number: string | null;
  payment_mode: string | null;
};
type LineageRow = { kind: string; id: string; label: string; total: string };
type DailyRow = { txn_date: string; debit: string; credit: string };

export type NexusBankTransactionSource = {
  id: string; txn_date: string; value_date: string | null; narration: string;
  debit: string; credit: string; running_balance: string | null;
  reference_number: string | null; payment_mode: string | null;
  counterparty_name: string | null; bank_name: string; account_number_last4: string;
  statement_from: string | null; statement_to: string | null;
};

/** Resolve one bank line only inside the authenticated firm's active client. */
export async function getNexusBankTransactionSource(
  firmId: string, clientId: string, transactionId: string,
): Promise<NexusBankTransactionSource | null> {
  if (!/^[0-9a-f-]{36}$/i.test(transactionId)) return null;
  return withFirm(firmId, async (c) => {
    const result = await c.query<NexusBankTransactionSource>(
      `SELECT bt.id, bt.txn_date::text, bt.value_date::text, bt.narration,
              bt.debit::text, bt.credit::text, bt.running_balance::text,
              bt.reference_number, bt.payment_mode::text, bt.counterparty_name,
              ba.bank_name, ba.account_number_last4,
              bs.period_from::text AS statement_from, bs.period_to::text AS statement_to
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
                              AND ba.firm_id = bt.firm_id AND ba.client_id = bt.client_id
         LEFT JOIN bank_statements bs ON bs.id = bt.statement_id
                                     AND bs.firm_id = bt.firm_id AND bs.client_id = bt.client_id
        WHERE bt.id = $1 AND bt.firm_id = $2 AND bt.client_id = $3`,
      [transactionId, firmId, clientId]);
    return result.rows[0] ?? null;
  });
}

function validDate(value: string, label: string): void {
  if (!DATE_RE.test(value)) throw new ValidationError(`invalid ${label}`, 'NX-BANK-1');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`invalid ${label}`, 'NX-BANK-1');
  }
}

export function validateBankActivityRange(fromDate: string, toDate: string): void {
  validDate(fromDate, 'start date');
  validDate(toDate, 'end date');
  if (fromDate > toDate) throw new ValidationError('start date must not be after end date', 'NX-BANK-1');
}

/** Normalize a database decimal string with integer paise arithmetic. */
function exactMoney(value: string): string {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Unexpected database money value');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const abs = paise < 0n ? -paise : paise;
  return `${paise < 0n || (negative && abs !== 0n) ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/**
 * Build a trusted, read-only bank activity response for one owned account and
 * inclusive date range. No classifications or accounting actions are made.
 */
export async function buildBankActivityResult(args: {
  firmId: string;
  clientId: string;
  bankAccountId: string;
  fromDate: string;
  toDate: string;
}): Promise<NexusBlockEnvelope> {
  validateBankActivityRange(args.fromDate, args.toDate);

  return withFirm(args.firmId, async (c) => {
    const account = await c.query<{ id: string; bank_name: string; account_number_last4: string }>(
      `SELECT id, bank_name, account_number_last4
         FROM bank_accounts
        WHERE id = $1 AND firm_id = $2 AND client_id = $3`,
      [args.bankAccountId, args.firmId, args.clientId]);
    if (account.rowCount !== 1) throw new ValidationError('bank account not found', 'NX-BANK-2');

    const params = [args.firmId, args.clientId, args.bankAccountId, args.fromDate, args.toDate];
    const [totals, rows, lineage, daily] = await Promise.all([
      c.query<{ count: string; debit: string; credit: string }>(
        `SELECT COUNT(*)::text AS count,
                COALESCE(SUM(debit), 0)::text AS debit,
                COALESCE(SUM(credit), 0)::text AS credit
           FROM bank_transactions
          WHERE firm_id = $1 AND client_id = $2 AND bank_account_id = $3
            AND txn_date >= $4::date AND txn_date <= $5::date`, params),
      c.query<TransactionRow>(
        `SELECT id, txn_date::text, narration, debit::text, credit::text,
                reference_number, payment_mode::text
           FROM bank_transactions
          WHERE firm_id = $1 AND client_id = $2 AND bank_account_id = $3
            AND txn_date >= $4::date AND txn_date <= $5::date
          ORDER BY txn_date, row_no NULLS LAST, id
          LIMIT $6`, [...params, MAX_ROWS + 1]),
      c.query<LineageRow>(
        `SELECT kind, id, label, COUNT(*) OVER ()::text AS total FROM (
           SELECT 'bank_statement'::text AS kind, bs.id::text AS id,
                  'Bank statement · ' || bs.period_from::text || ' to ' || bs.period_to::text AS label
             FROM bank_statements bs
            WHERE bs.firm_id = $1 AND bs.client_id = $2 AND bs.bank_account_id = $3
              AND EXISTS (SELECT 1 FROM bank_transactions bt
                           WHERE bt.statement_id = bs.id AND bt.firm_id = $1
                             AND bt.client_id = $2 AND bt.bank_account_id = $3
                             AND bt.txn_date >= $4::date AND bt.txn_date <= $5::date)
           UNION ALL
           SELECT 'bank_transaction'::text AS kind, bt.id::text AS id,
                  'Unlinked bank line · ' || bt.txn_date::text AS label
             FROM bank_transactions bt
            WHERE bt.firm_id = $1 AND bt.client_id = $2 AND bt.bank_account_id = $3
              AND bt.statement_id IS NULL AND bt.txn_date >= $4::date AND bt.txn_date <= $5::date
         ) sources ORDER BY kind, id LIMIT 31`, params),
      c.query<DailyRow>(
        `SELECT txn_date::text, COALESCE(SUM(debit), 0)::text AS debit,
                COALESCE(SUM(credit), 0)::text AS credit
           FROM bank_transactions
          WHERE firm_id = $1 AND client_id = $2 AND bank_account_id = $3
            AND txn_date >= $4::date AND txn_date <= $5::date
          GROUP BY txn_date ORDER BY txn_date LIMIT 101`, params),
    ]);
    const totalCount = BigInt(totals.rows[0]?.count ?? '0');
    const truncated = totalCount > BigInt(MAX_ROWS);
    const shown = rows.rows.slice(0, MAX_ROWS);
    const asOf = new Date().toISOString();
    const lineageTotal = BigInt(lineage.rows[0]?.total ?? '0');
    // The renderer allows at most 30 provenance sources. Reserve sources for
    // every displayed row, then include as many aggregate source records as fit.
    const lineageIncluded = lineage.rows.slice(0, Math.max(1, 30 - shown.length));
    const lineageTruncated = lineageTotal > BigInt(lineageIncluded.length);
    const sources: Source[] = [...lineageIncluded.map(({ kind, id, label }) => ({ kind, id, label }))];
    for (const row of shown) {
      if (!sources.some((source) => source.id === row.id)) sources.push({
        kind: 'bank_transaction', id: row.id, label: `Bank line · ${row.txn_date}`,
      });
    }
    // With no transaction rows, the owned account record is the auditable
    // source for the empty-period result.
    if (sources.length === 0) sources.push({ kind: 'bank_account', id: account.rows[0]!.id, label: `${account.rows[0]!.bank_name} · account ending ${account.rows[0]!.account_number_last4}` });
    const aggregateRefs = lineageIncluded.length > 0
      ? lineageIncluded.map((source) => source.id)
      : [account.rows[0]!.id];
    const period = `${args.fromDate} to ${args.toDate}`;
    const limitation: string[] = [];
    if (truncated) limitation.push(`Showing ${MAX_ROWS} of ${totalCount.toString()} bank lines; totals cover the full selected period.`);
    if (lineageTruncated) limitation.push(`Aggregate provenance lists ${lineageIncluded.length} of ${lineageTotal.toString()} statement or unlinked-line sources because the response allows at most 30 source references.`);
    const hasChart = daily.rows.length >= 2 && daily.rows.length <= 100;
    if (!hasChart) limitation.push(daily.rows.length < 2
      ? 'Daily chart omitted because the selected period has fewer than two transaction dates.'
      : 'Daily chart omitted because the selected period has more than 100 transaction dates.');
    const provenance: Provenance = {
      as_of: asOf,
      sources,
      coverage: {
        scope: `${account.rows[0]!.bank_name} account ending ${account.rows[0]!.account_number_last4} · ${period}`,
        completeness: truncated || lineageTruncated ? 'partial' : 'complete',
        limitations: limitation,
      },
    };
    const totalDebit = exactMoney(totals.rows[0]?.debit ?? '0');
    const totalCredit = exactMoney(totals.rows[0]?.credit ?? '0');
    const summary = totalCount === 0n
      ? `No bank lines were found for ${period}.`
      : `Checked ${totalCount.toString()} bank lines for ${period}: total debits ${totalDebit} and credits ${totalCredit}.${truncated ? ` The table shows the first ${MAX_ROWS} lines.` : ''}${!hasChart ? ' A daily chart is omitted because the selected period has fewer than two transaction dates or exceeds the 100-date chart limit.' : ''}`;
    const tableRows = shown.slice(0, MAX_ROWS).map((row) => ({
      id: row.id,
      cells: {
        date: row.txn_date,
        description: row.narration,
        reference: row.reference_number ?? '',
        mode: row.payment_mode ?? '',
        debit: exactMoney(row.debit),
        credit: exactMoney(row.credit),
      },
      source_refs: [row.id],
    }));
    const envelope = {
      schema_version: 1 as const,
      generated_at: asOf,
      blocks: [
        { id: 'bank-activity-summary', type: 'paragraph' as const, text: summary, provenance },
        { id: 'bank-activity-totals', type: 'metrics' as const, title: 'Period totals', provenance, items: [
          { label: 'Bank lines', value: totalCount.toString(), unit: 'lines', period, source_refs: aggregateRefs },
          { label: 'Debits', value: totalDebit, unit: 'INR', period, source_refs: aggregateRefs },
          { label: 'Credits', value: totalCredit, unit: 'INR', period, source_refs: aggregateRefs },
        ] },
        { id: 'bank-activity-lines', type: 'table' as const, title: `Bank lines · ${shown.length > MAX_ROWS ? MAX_ROWS : shown.length} shown`, provenance,
          columns: [
            { key: 'date', label: 'Date', kind: 'date' as const },
            { key: 'description', label: 'Description', kind: 'text' as const },
            { key: 'reference', label: 'Reference', kind: 'text' as const },
            { key: 'mode', label: 'Mode', kind: 'text' as const },
            { key: 'debit', label: 'Debit (INR)', kind: 'money' as const },
            { key: 'credit', label: 'Credit (INR)', kind: 'money' as const },
          ], rows: tableRows },
        ...(hasChart ? [{
          id: 'bank-activity-daily-chart', type: 'chart' as const, kind: 'bar' as const,
          title: 'Daily bank activity',
          accessible_summary: `${daily.rows.length} transaction dates shown with separate debit and credit totals in INR.`,
          provenance,
          series: [
            { name: 'Debits', unit: 'INR', points: daily.rows.map((day) => ({ label: day.txn_date, value: exactMoney(day.debit) })) },
            { name: 'Credits', unit: 'INR', points: daily.rows.map((day) => ({ label: day.txn_date, value: exactMoney(day.credit) })) },
          ],
          table_fallback: {
            columns: [
              { key: 'series', label: 'Series', kind: 'text' as const },
              { key: 'label', label: 'Date', kind: 'text' as const },
              { key: 'value', label: 'Value (INR)', kind: 'text' as const },
            ],
            rows: ['Debits', 'Credits'].flatMap((name, seriesIndex) => daily.rows.map((day, index) => ({
              id: `bank-activity-${seriesIndex}-${index}`,
              cells: { series: name, label: day.txn_date, value: exactMoney(seriesIndex === 0 ? day.debit : day.credit) },
            }))),
          },
        }] : []),
      ],
    };
    return validateNexusBlocks(envelope);
  });
}

/** Only expose accounts belonging to the active firm and selected client. */
export async function listNexusBankActivityAccounts(firmId: string, clientId: string) {
  return withFirm(firmId, async (c) => {
    const result = await c.query<{ id: string; bank_name: string; account_number_last4: string }>(
      `SELECT id, bank_name, account_number_last4 FROM bank_accounts
        WHERE firm_id=$1 AND client_id=$2 ORDER BY bank_name, account_number_last4, id`,
      [firmId, clientId]);
    return result.rows;
  });
}
