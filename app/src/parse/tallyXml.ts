/**
 * Read a native Tally XML export without executing or expanding anything.
 *
 * This is the preview boundary, not the importer. Tally data is first reduced
 * to a small, reviewable model; only a later confirmed step may map ledgers and
 * call the GL posting path. Raw `.tly` company backups are deliberately not
 * accepted — Tally's supported interchange boundary is an XML/JSON export.
 */

import { money, paise } from '../domain/tax.ts';
import type { VoucherType } from '../domain/types.ts';
import { ValidationError } from '../domain/types.ts';

export interface TallyLedger {
  name: string;
  parent: string | null;
  gstin: string | null;
  openingBalance: string | null;
  partyType: 'customer' | 'supplier' | null;
  mailingName: string | null;
  address: string | null;
  gstRegistrationType: string | null;
}

export interface TallyEntry {
  ledgerName: string;
  /** Tally-native sign: negative is debit, positive is credit. */
  signedAmount: string;
  debit: string;
  credit: string;
}

export interface TallyVoucher {
  guid: string | null;
  type: VoucherType | null;
  sourceType: string;
  number: string | null;
  date: string | null;
  narration: string | null;
  entries: TallyEntry[];
  difference: string;
  balanced: boolean;
}

export interface TallyPreview {
  companies: string[];
  ledgers: TallyLedger[];
  vouchers: TallyVoucher[];
  stats: {
    ledgerCount: number;
    voucherCount: number;
    balancedCount: number;
    unbalancedCount: number;
    unsupportedCount: number;
  };
  warnings: string[];
}

const entities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, key: string) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] ?? `&${key};`;
    const hex = key[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : '';
  }).trim();
}

function patternName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tag(block: string, name: string): string | null {
  const n = patternName(name);
  const match = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i'));
  return match ? decodeXml(match[1]!.replace(/<[^>]*>/g, ' ')) : null;
}

function tags(block: string, name: string): string[] {
  const n = patternName(name);
  return [...block.matchAll(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'gi'))]
    .map((match) => decodeXml(match[1]!.replace(/<[^>]*>/g, ' ')))
    .filter(Boolean);
}

function attribute(openingTag: string, name: string): string | null {
  const n = patternName(name);
  const match = openingTag.match(new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match ? decodeXml(match[1] ?? match[2] ?? '') : null;
}

function decimal(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  let value = raw.replace(/[₹,\s]/g, '');
  if (/^\(.*\)$/.test(value)) value = `-${value.slice(1, -1)}`;
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(value)) {
    throw new ValidationError(`Tally amount "${raw}" is not a decimal`, 'TM-1');
  }
  return money(paise(value));
}

function tallyDate(raw: string | null): string | null {
  if (raw === null) return null;
  if (!/^\d{8}$/.test(raw)) return null;
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date
    ? null : date;
}

const VOUCHER_TYPES: Record<string, VoucherType> = {
  contra: 'contra', payment: 'payment', receipt: 'receipt', journal: 'journal',
  sales: 'sales', purchase: 'purchase', 'credit note': 'credit_note',
  'debit note': 'debit_note',
};

function voucherType(value: string): VoucherType | null {
  return VOUCHER_TYPES[value.trim().toLowerCase()] ?? null;
}

export function parseTallyXml(xml: string): TallyPreview {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new ValidationError('DTD and entity declarations are not accepted', 'TM-1');
  }
  if (!/<ENVELOPE\b/i.test(xml)) {
    throw new ValidationError(
      'this is not a Tally XML export — export Masters and Transactions as XML from TallyPrime',
      'TM-1',
    );
  }

  const companies = new Set<string>();
  for (const match of xml.matchAll(/<SVCURRENTCOMPANY(?:\s[^>]*)?>([\s\S]*?)<\/SVCURRENTCOMPANY>/gi)) {
    const name = decodeXml(match[1]!.replace(/<[^>]*>/g, ' '));
    if (name) companies.add(name);
  }

  // Party ledgers may sit below a user-created subgroup, so resolve the group
  // chain instead of recognising only a direct Sundry Debtors/Creditors parent.
  const groupParents = new Map<string, string>();
  for (const match of xml.matchAll(/(<GROUP\b[^>]*>)([\s\S]*?)<\/GROUP>/gi)) {
    const name = attribute(match[1]!, 'NAME') ?? tag(match[2]!, 'NAME');
    const parent = tag(match[2]!, 'PARENT');
    if (name && parent) groupParents.set(name.toLowerCase(), parent);
  }
  const partyType = (parent: string | null): 'customer' | 'supplier' | null => {
    const seen = new Set<string>();
    let name = parent;
    while (name && !seen.has(name.toLowerCase())) {
      const key = name.toLowerCase();
      if (key === 'sundry debtors') return 'customer';
      if (key === 'sundry creditors') return 'supplier';
      seen.add(key);
      name = groupParents.get(key) ?? null;
    }
    return null;
  };

  const ledgers: TallyLedger[] = [];
  for (const match of xml.matchAll(/(<LEDGER\b[^>]*>)([\s\S]*?)<\/LEDGER>/gi)) {
    const name = attribute(match[1]!, 'NAME') ?? tag(match[2]!, 'NAME');
    if (!name) continue;
    const parent = tag(match[2]!, 'PARENT');
    const address = tags(match[2]!, 'ADDRESS');
    ledgers.push({
      name,
      parent,
      gstin: tag(match[2]!, 'PARTYGSTIN') ?? tag(match[2]!, 'GSTIN'),
      openingBalance: decimal(tag(match[2]!, 'OPENINGBALANCE')),
      partyType: partyType(parent),
      mailingName: tag(match[2]!, 'MAILINGNAME'),
      address: address.length ? address.join(', ') : null,
      gstRegistrationType: tag(match[2]!, 'PARTYGSTREGISTRATIONTYPE')
        ?? tag(match[2]!, 'GSTREGISTRATIONTYPE'),
    });
  }

  const vouchers: TallyVoucher[] = [];
  for (const match of xml.matchAll(/(<VOUCHER\b[^>]*>)([\s\S]*?)<\/VOUCHER>/gi)) {
    const opening = match[1]!;
    const body = match[2]!;
    const sourceType = attribute(opening, 'VCHTYPE') ?? tag(body, 'VOUCHERTYPENAME') ?? 'Unknown';
    const entries: TallyEntry[] = [];
    const entryPattern = /<(?:ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST\b[^>]*>([\s\S]*?)<\/(?:ALLLEDGERENTRIES|LEDGERENTRIES)\.LIST>/gi;
    for (const entry of body.matchAll(entryPattern)) {
      const ledgerName = tag(entry[1]!, 'LEDGERNAME');
      const amount = decimal(tag(entry[1]!, 'AMOUNT'));
      if (!ledgerName || amount === null) continue;
      const signed = paise(amount);
      entries.push({
        ledgerName, signedAmount: amount,
        debit: signed < 0n ? money(-signed) : '0.00',
        credit: signed > 0n ? money(signed) : '0.00',
      });
    }

    const difference = entries.reduce((sum, entry) => sum + paise(entry.signedAmount), 0n);
    vouchers.push({
      guid: tag(body, 'GUID'),
      type: voucherType(sourceType),
      sourceType,
      number: tag(body, 'VOUCHERNUMBER'),
      date: tallyDate(tag(body, 'DATE')),
      narration: tag(body, 'NARRATION'),
      entries,
      difference: money(difference),
      balanced: entries.length >= 2 && difference === 0n,
    });
  }

  const unbalanced = vouchers.filter((v) => !v.balanced).length;
  const unsupported = vouchers.filter((v) => v.type === null).length;
  const warnings: string[] = [];
  if (companies.size > 1) warnings.push('This export contains more than one company. Import each company separately.');
  if (unbalanced) warnings.push(`${unbalanced} voucher(s) do not balance or have fewer than two ledger entries.`);
  if (unsupported) warnings.push(`${unsupported} voucher(s) use a type that is not mapped yet.`);
  if (vouchers.some((v) => v.date === null)) warnings.push('At least one voucher has a missing or invalid YYYYMMDD date.');

  return {
    companies: [...companies], ledgers, vouchers,
    stats: {
      ledgerCount: ledgers.length, voucherCount: vouchers.length,
      balancedCount: vouchers.length - unbalanced, unbalancedCount: unbalanced,
      unsupportedCount: unsupported,
    },
    warnings,
  };
}
