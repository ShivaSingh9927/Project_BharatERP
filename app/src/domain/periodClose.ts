/**
 * Closing an accounting period.
 * Spec: gl-engine.md §7.4, bank-and-reconciliation.md BR-23.
 * Gap: DEFECT-LOG G-4
 *
 * Everything needed for this existed except the act itself. `accounting_periods`
 * carries `is_closed`, `closed_at` and `closed_by`; `resolve_open_fiscal_year`
 * already refuses to post into a closed period, in the database, so it cannot
 * be bypassed; and `assertReconciledForClose` already computes whether every
 * bank account ties. There was simply no function that closed anything, so
 * BR-23 was a control with no moment at which to fire.
 *
 * ── Why closing is gated at all ────────────────────────────────────────────
 *
 * Closing a period with an unreconciled bank account is how an error becomes
 * permanent. Before the close, a misposted entry is edited where it belongs.
 * After it, the only remedy is a later-dated adjustment — which leaves BOTH
 * periods wrong: the month that should have carried the entry still does not,
 * and the month that receives it never did.
 *
 * That is worse than it sounds for a firm working to the GSTR-3B deadline
 * (review answer B3), because the return for the closed month has already been
 * filed against the wrong figures.
 *
 * ── Why it is a refusal and not a warning ──────────────────────────────────
 *
 * A warning at close time is read by someone whose goal, at that moment, is to
 * close. BR-23 exists precisely because that is the one moment the check will
 * be dismissed. So an untied account blocks, and the way past it is to fix the
 * reconciliation or to state a reason that is recorded.
 */

import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { assertReconciledForClose } from './brs.ts';
import { trialBalance } from '../reports/index.ts';

export interface PeriodCloseResult {
  periodId: string;
  label: string;
  closedAt: string;
  /** Blockers that were overridden, empty on a clean close. */
  overridden: string[];
}

export interface PeriodCloseCheck {
  ok: boolean;
  label: string;
  blockers: string[];
}

/**
 * What would stop this period closing? Runs the same checks as `closePeriod`.
 *
 * Separate so a reviewer can see the blockers before attempting a close, rather
 * than discovering them by being refused. The close re-runs them rather than
 * trusting this result: between looking and acting, someone else may have
 * posted.
 */
export async function periodCloseCheck(
  firmId: string, clientId: string, label: string,
): Promise<PeriodCloseCheck> {
  return withFirm(firmId, async (c) => {
    const p = await c.query<{ id: string; end_date: string; is_closed: boolean }>(
      `SELECT id, end_date::text, is_closed FROM accounting_periods
       WHERE client_id = $1 AND label = $2`, [clientId, label]);
    if (p.rowCount === 0) {
      throw new ValidationError(`no accounting period "${label}" for this client`, 'V-6');
    }
    const period = p.rows[0]!;
    const blockers: string[] = [];

    if (period.is_closed) blockers.push(`period ${label} is already closed`);

    // BR-23. The reason this module exists.
    const recon = await assertReconciledForClose(firmId, clientId, period.end_date);
    blockers.push(...recon.blockers);

    /*
     * A trial balance that does not balance means the ledger itself is broken,
     * not merely unreconciled. It should be impossible — the double entry is
     * enforced at posting — so if it ever fires, closing is the last thing that
     * should happen. Cheap to check, and the one failure that would make every
     * report downstream wrong.
     */
    const tb = await trialBalance(firmId, clientId, period.end_date);
    if (!tb.balanced) {
      blockers.push(
        `the trial balance does not balance as of ${period.end_date} — ` +
        'the ledger is inconsistent and must be investigated before any close');
    }

    return { ok: blockers.length === 0, label, blockers };
  });
}

/**
 * Close a period.
 *
 * `overrideReason` is required to close over a blocker, and is recorded. A
 * firm sometimes genuinely must close — the client will not produce the last
 * statement and the return is due tomorrow — and refusing absolutely would
 * mean the close happens by an UPDATE run against the database instead, which
 * is the same act with no record of who decided it or why.
 */
export async function closePeriod(
  firmId: string,
  input: {
    clientId: string; label: string; closedBy: string; overrideReason?: string;
  },
): Promise<PeriodCloseResult> {
  const check = await periodCloseCheck(firmId, input.clientId, input.label);

  if (!check.ok && !input.overrideReason) {
    throw new ValidationError(
      `period ${input.label} cannot be closed:\n  - ${check.blockers.join('\n  - ')}\n` +
      'Fix these, or supply an override reason, which will be recorded against ' +
      'the close.', 'BR-23');
  }

  return withFirm(firmId, async (c) => {
    // Re-read inside the transaction and refuse if it closed meanwhile, so two
    // people closing at once cannot both believe they did it.
    const upd = await c.query<{ id: string; closed_at: string }>(
      `UPDATE accounting_periods
       SET is_closed = true, closed_at = now(), closed_by = $3
       WHERE client_id = $1 AND label = $2 AND NOT is_closed
       RETURNING id, closed_at::text`,
      [input.clientId, input.label, input.closedBy]);

    if (upd.rowCount === 0) {
      throw new ValidationError(`period ${input.label} is already closed`, 'V-6');
    }

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after,
          actor_user_id, actor_type)
       VALUES ($1,$2,'accounting_period',$3,'close',$4,$5,'human')`,
      [
        firmId, input.clientId, upd.rows[0]!.id,
        JSON.stringify({
          label: input.label,
          blockers: check.blockers,
          override_reason: input.overrideReason ?? null,
        }),
        input.closedBy,
      ]);

    return {
      periodId: upd.rows[0]!.id,
      label: input.label,
      closedAt: upd.rows[0]!.closed_at,
      overridden: check.ok ? [] : check.blockers,
    };
  });
}

/**
 * Reopen a closed period.
 *
 * Included deliberately. A close with no way back is a trap: one premature
 * close and the month can only ever be corrected by a later-dated adjustment,
 * which is the exact harm closing was meant to prevent. The reason is
 * mandatory and audited, so reopening is a decision on the record rather than
 * a quiet `UPDATE`.
 */
export async function reopenPeriod(
  firmId: string,
  input: { clientId: string; label: string; reopenedBy: string; reason: string },
): Promise<void> {
  if (!input.reason.trim()) {
    throw new ValidationError('reopening a closed period requires a reason', 'V-6');
  }

  return withFirm(firmId, async (c) => {
    const upd = await c.query<{ id: string }>(
      `UPDATE accounting_periods
       SET is_closed = false, closed_at = NULL, closed_by = NULL
       WHERE client_id = $1 AND label = $2 AND is_closed
       RETURNING id`,
      [input.clientId, input.label]);

    if (upd.rowCount === 0) {
      throw new ValidationError(`period ${input.label} is not closed`, 'V-6');
    }

    await c.query(
      `INSERT INTO audit_log
         (firm_id, client_id, entity_type, entity_id, action, after,
          actor_user_id, actor_type)
       VALUES ($1,$2,'accounting_period',$3,'reopen',$4,$5,'human')`,
      [firmId, input.clientId, upd.rows[0]!.id,
       JSON.stringify({ label: input.label, reason: input.reason }),
       input.reopenedBy]);
  });
}
