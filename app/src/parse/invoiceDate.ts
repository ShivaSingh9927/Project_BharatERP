/**
 * The invoice date — read, or refused, but never assumed.
 *
 * Spec: bills-and-expenses.md §4.7
 *
 * Until now every proposed bill carried TODAY as its date, with a comment
 * saying a reviewer must fix it. That is the worst-filled field in the
 * pipeline: a wrong date puts the bill in the wrong GST return period, which
 * is a correction to two filings rather than one edit, and it is wrong
 * silently — nothing downstream can tell that a plausible date is the wrong one.
 *
 * ── Half the vendors write ambiguous dates ────────────────────────────────
 *
 * Measured across the corpus:
 *
 *     Flipkart   27-08-2025     unambiguous — 27 cannot be a month
 *     Kamatera   01-Aug-2026    unambiguous — the month is named
 *     Blinkit    03-Jun-2026    unambiguous — the month is named
 *     Anomaly    July 9, 2026   unambiguous
 *     Amazon     04.09.2026     AMBIGUOUS — 4 Sept, or 9 April?
 *     Zepto      09-08-2026     AMBIGUOUS — 9 Aug, or 8 Sept?
 *     Hetzner    01/09/2026     AMBIGUOUS — 1 Sept, or 9 Jan?
 *
 * "Indian invoices are day-first" is true, and is exactly the kind of
 * assumption that has produced every wrong answer in this codebase so far. So
 * ambiguity is resolved from EVIDENCE ON THE DOCUMENT first, and only then
 * from convention — and never silently.
 *
 * Amazon supplies its own evidence: the digital-signature block prints
 * `2026.09.03`, year first and therefore unambiguous, and its month of 09 sits
 * in the same position as the 09 in `04.09.2026`. The document has said it
 * writes day-first, so 4 September stands without anyone guessing.
 *
 * Zepto and Hetzner carry exactly one date each and nothing to check it
 * against. These were refused outright, and that was too brittle: an invoice
 * plainly reading 01/09/2026 is not unreadable, it is written in a format two
 * countries read differently. So the day-first reading is offered — India
 * writes the day first — together with the other one, and the bill CANNOT POST
 * until a human says which is right. Not a warning: warnings get clicked past,
 * and the two readings fall in different return periods where no arithmetic
 * will ever notice the mistake.
 *
 * The line this holds is between not knowing the CONVENTION and not knowing
 * the VALUE. A date read off the paper whose format is uncertain can be
 * offered for confirmation. A figure that was never read cannot be guessed at,
 * and stays refused.
 *
 * ── When ambiguity does not matter ────────────────────────────────────────
 *
 * The harm being avoided is a wrong return period. So when both readings fall
 * in the same month — 05.05.2026, 07.07.2026 — either is safe for filing and
 * the value is taken. Refusing there would be fastidiousness, not care.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Real calendar check — 31 February is a misread, not a date. */
function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const len = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= len[m - 1]!;
}

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export type DayOrder = 'day_first' | 'month_first' | 'unknown';

export interface DateCandidate {
  raw: string;
  /** Where it appears, so a label can be looked for just before it. */
  at: number;
  /** Resolved value, when the arrangement is not in doubt. */
  certain?: string;
  /** Both readings, when it is. Always two, and different. */
  ambiguous?: [string, string];
}

const NAMED = /\b(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{4})\b/g;
const NAMED_FIRST = /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/g;
const NUMERIC = /\b(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})\b/g;

/**
 * Finds every date on the page, resolved where the arrangement is certain.
 *
 * Certain means: the month is named, or the year comes first, or one of the
 * two leading numbers exceeds 12 and can only be a day.
 */
export function findDates(text: string): DateCandidate[] {
  const out: DateCandidate[] = [];

  for (const m of text.matchAll(NAMED)) {
    const mon = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    const d = Number(m[1]), y = Number(m[3]);
    if (mon && isRealDate(y, mon, d)) {
      out.push({ raw: m[0], at: m.index, certain: iso(y, mon, d) });
    }
  }
  for (const m of text.matchAll(NAMED_FIRST)) {
    const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    const d = Number(m[2]), y = Number(m[3]);
    if (mon && isRealDate(y, mon, d)) {
      out.push({ raw: m[0], at: m.index, certain: iso(y, mon, d) });
    }
  }

  for (const m of text.matchAll(NUMERIC)) {
    const a = Number(m[1]), b = Number(m[2]);
    let y = Number(m[3]);

    if (m[1]!.length === 4) {                    // year first: 2026.09.03
      if (isRealDate(a, b, y)) out.push({ raw: m[0], at: m.index, certain: iso(a, b, y) });
      continue;
    }
    if (y < 100) y += y < 70 ? 2000 : 1900;

    const asDayFirst = isRealDate(y, b, a);
    const asMonthFirst = isRealDate(y, a, b);

    if (asDayFirst && !asMonthFirst) {
      out.push({ raw: m[0], at: m.index, certain: iso(y, b, a) });
    } else if (asMonthFirst && !asDayFirst) {
      out.push({ raw: m[0], at: m.index, certain: iso(y, a, b) });
    } else if (asDayFirst && asMonthFirst) {
      const dayFirst = iso(y, b, a), monthFirst = iso(y, a, b);
      if (dayFirst === monthFirst) {
        out.push({ raw: m[0], at: m.index, certain: dayFirst });
      } else {
        out.push({ raw: m[0], at: m.index, ambiguous: [dayFirst, monthFirst] });
      }
    }
  }

  return out.sort((x, y2) => x.at - y2.at);
}

/**
 * Works out how this document arranges its numeric dates, from the dates it
 * resolved without help.
 *
 * A year-first date settles it too, and that is what rescues Amazon: its
 * signature block prints `2026.09.03`, so the 09 in `04.09.2026` is the month.
 */
export function inferDayOrder(dates: DateCandidate[]): DayOrder {
  for (const d of dates) {
    if (d.certain === undefined) continue;
    const nums = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(d.raw);
    if (!nums) continue;
    const month = Number(d.certain.slice(5, 7));
    if (nums[1]!.length === 4) {
      return Number(nums[2]) === month ? 'day_first' : 'unknown';
    }
    if (Number(nums[1]) > 12) return 'day_first';
    if (Number(nums[2]) > 12) return 'month_first';
  }
  return 'unknown';
}

/** Labels that mark the date a bill is dated BY, in preference order. */
const DATE_LABELS = [
  /\b(?:tax\s+)?invoice\s+date\b/i,
  /\bbill\s+of\s+supply\s+date\b/i,
  /\bdate\s+of\s+issue\b/i,
  /\binvoice\b[^\n]{0,20}\bdate\b/i,
];

/** How close after a label a date must sit to be that label's date. */
const LABEL_REACH = 40;

export interface DateResult {
  date?: string;
  /** Present when no date could be settled: what to tell the user. */
  reason?: string;
  /** How it was decided, for the audit trail (PR-7). */
  basis?: string;
  /**
   * The other reading, when the digits alone do not settle which is meant.
   *
   * Present means `date` is a DEFAULT and not a reading: it was chosen by
   * convention, and a human has to say whether the convention holds for this
   * document. The caller turns this into something that must be answered
   * before the bill can post — not a warning, which nobody reads.
   */
  alternative?: string;
}

/**
 * Reads the date a document is dated by.
 *
 * Prefers a date sitting just after an invoice-date label. Falls back to the
 * document carrying exactly ONE distinct date — which is how Blinkit is read,
 * since it splits its own label over two lines ("Invoice   :   03-Jun-2026"
 * with "Date" below) and no label pattern will catch that.
 *
 * With several unlabelled dates it refuses rather than taking the first. An
 * order date and an invoice date are different dates and can fall in
 * different months.
 */
export function extractInvoiceDate(text: string, fileText?: string): DateResult {
  const dates = findDates(text);
  if (dates.length === 0) return { reason: 'no date appears on this document' };

  /*
   * Day order is inferred from the WHOLE FILE, not just this document.
   *
   * How dates are arranged is a property of whatever generated the PDF, and
   * one PDF has one generator. An Amazon file holds two documents: the
   * seller's invoice and Amazon's own fee invoice, and only the second carries
   * the digital-signature block with its year-first `2026.09.03`. Judged
   * segment by segment, page one refused a date that page two could read —
   * from the same file, produced by the same system, on the same day.
   *
   * The same fixes a Flipkart bill of supply whose own `01-09-2025` is
   * ambiguous while `27-08-2025` sits on an earlier page of the same file.
   */
  const order = inferDayOrder(findDates(fileText ?? text));
  const settle = (c: DateCandidate): DateResult => {
    if (c.certain) return { date: c.certain, basis: `read as "${c.raw}"` };
    const [dayFirst, monthFirst] = c.ambiguous!;
    if (order === 'day_first') {
      return { date: dayFirst,
               basis: `"${c.raw}" read day-first, as another date on the document is` };
    }
    if (order === 'month_first') {
      return { date: monthFirst,
               basis: `"${c.raw}" read month-first, as another date on the document is` };
    }
    /*
     * Nothing on the document settles the order, so convention does — and it
     * is offered as a question, not as an answer.
     *
     * Refusing outright was the old behaviour and it was too brittle: an
     * invoice that plainly reads 01/09/2026 is not unreadable, it is written
     * in a format that two countries interpret differently. India writes the
     * day first, in the Gazette, on every government form and on every other
     * document in this corpus, so day-first is the reading to offer.
     *
     * What keeps it honest is that `alternative` is set. The caller must not
     * post this bill until a human confirms, because the two readings fall in
     * different return periods and no arithmetic anywhere will notice.
     */
    return {
      date: dayFirst,
      alternative: monthFirst,
      basis: `"${c.raw}" read day-first by Indian convention — nothing on the ` +
             'document settles it',
    };
  };

  for (const label of DATE_LABELS) {
    const m = label.exec(text);
    if (!m) continue;
    const from = m.index + m[0].length;
    const hit = dates.find((d) => d.at >= from && d.at <= from + LABEL_REACH);
    if (hit) return settle(hit);
  }

  const distinct = new Set(dates.map((d) => d.certain ?? d.ambiguous!.join('|')));
  if (distinct.size === 1) return settle(dates[0]!);

  /*
   * Several dates, none labelled in a way the patterns above recognise.
   *
   * Blinkit is the case: it prints "Invoice   :   03-Jun-2026" with the word
   * "Date" on the NEXT line, below the value, so no label pattern can reach
   * it — and it carries a second, unrelated date in its terms. Refusing was
   * correct but pessimistic.
   *
   * A date sharing a LINE with the word "invoice" or "bill" is the document's
   * own association, not our guess. Same line rather than a character window:
   * a window is an arbitrary number, and a first attempt at ±60 characters
   * swallowed a terms-and-conditions date that happened to sit nearby.
   *
   * If exactly one date qualifies, that is the one. If several do, we are back
   * to guessing and it refuses.
   */
  const lineAround = (at: number): string => {
    const start = text.lastIndexOf('\n', at) + 1;
    const end = text.indexOf('\n', at);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const near = dates.filter((d) => /invoice|bill/i.test(lineAround(d.at)));
  const nearDistinct = new Set(near.map((d) => d.certain ?? d.ambiguous!.join('|')));
  if (nearDistinct.size === 1) return settle(near[0]!);

  return {
    reason: 'this document carries several dates and none of them is labelled ' +
            'as the invoice date. An order date and an invoice date can fall ' +
            'in different return periods, so it must be entered by hand.',
  };
}
