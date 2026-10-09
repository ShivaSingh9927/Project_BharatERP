import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';

export type ObligationWorkflowState =
  | 'observed' | 'open' | 'blocked' | 'needs_human_review' | 'prepared'
  | 'submitted_unverified' | 'paid_unverified' | 'closed' | 'superseded';

export interface ObligationHistoryEvent {
  id: string;
  eventType: string;
  workflowState: ObligationWorkflowState;
  occurredAt: string;
  recordedAt: string;
  actorType: string;
  actorId: string | null;
  reason: string;
  evidenceRefs: unknown[];
  idempotencyKey: string;
}

export interface ObligationTimelineItem {
  id: string;
  clientId: string;
  registrationId: string | null;
  kind: string;
  periodKey: string;
  identityKey: string;
  ownerUserId: string | null;
  createdAt: string;
  workflowState: ObligationWorkflowState;
  history: ObligationHistoryEvent[];
}

const text = (v: unknown, max: number, label: string): string => {
  if (typeof v !== 'string') throw new ValidationError(`enter a valid ${label}`, 'OBL-1');
  const s = v.trim();
  if (!s || s.length > max) throw new ValidationError(`enter a valid ${label}`, 'OBL-1');
  return s;
};

// Until a verified profile and rule-version path exists, phase 1a can only
// record observations, blockers, review needs, and notes.
const safeEvents = new Set(['blocked', 'needs_human_review', 'note']);
const allowedTransitions: Record<string, string[]> = {
  observed: ['blocked', 'needs_human_review'],
  blocked: ['needs_human_review'],
  needs_human_review: ['blocked'],
};

async function assertClient(c: import('pg').PoolClient, clientId: string): Promise<void> {
  const r = await c.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
  if (!r.rowCount) throw new ValidationError('client is unavailable', 'OBL-2');
}

export async function recordObservedObligation(args: {
  firmId: string;
  clientId: string;
  registrationId?: string | null;
  kind: unknown;
  periodKey: unknown;
  actorId?: string | null;
  ownerUserId?: string | null;
  occurredAt?: Date;
  reason?: unknown;
  evidenceRefs?: unknown[];
  idempotencyKey: unknown;
}): Promise<string> {
  const kind = text(args.kind, 80, 'obligation kind');
  const periodKey = text(args.periodKey, 40, 'period key');
  const identityKey = JSON.stringify([args.registrationId ?? null, kind, periodKey]);
  const idempotencyKey = text(args.idempotencyKey, 200, 'idempotency key');
  const reason = args.reason == null ? '' : text(args.reason, 2000, 'reason');
  const refs = args.evidenceRefs ?? [];
  if (!Array.isArray(refs)) throw new ValidationError('enter valid evidence references', 'OBL-1');
  const occurredAt = args.occurredAt ?? new Date();
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError('enter a valid event time', 'OBL-1');
  }

  return withFirm(args.firmId, async (c) => {
    await assertClient(c, args.clientId);
    // Serialize reuse of an idempotency key across identity values.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`obligation-identity:${args.clientId}:${idempotencyKey}`]);
    const priorRequest = await c.query<{ identity_key: string; obligation_id: string }>(
      `SELECT identity_key, obligation_id FROM obligation_identity_requests
        WHERE client_id = $1 AND idempotency_key = $2`,
      [args.clientId, idempotencyKey]);
    if (priorRequest.rowCount) {
      if (priorRequest.rows[0]!.identity_key !== identityKey) {
        throw new ValidationError('idempotency key was already used for another obligation', 'OBL-4');
      }
      return priorRequest.rows[0]!.obligation_id;
    }
    if (args.registrationId) {
      const r = await c.query('SELECT 1 FROM client_registrations WHERE id = $1 AND client_id = $2',
        [args.registrationId, args.clientId]);
      if (!r.rowCount) throw new ValidationError('registration is unavailable', 'OBL-2');
    }
    if (args.actorId) {
      const r = await c.query('SELECT 1 FROM users WHERE id = $1 AND (client_id IS NULL OR client_id = $2)',
        [args.actorId, args.clientId]);
      if (!r.rowCount) throw new ValidationError('user is unavailable', 'OBL-2');
    }
    if (args.ownerUserId) {
      const r = await c.query('SELECT 1 FROM users WHERE id = $1 AND (client_id IS NULL OR client_id = $2)',
        [args.ownerUserId, args.clientId]);
      if (!r.rowCount) throw new ValidationError('owner is unavailable', 'OBL-2');
    }
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO obligation_timeline_items
         (firm_id, client_id, registration_id, obligation_kind, period_key,
          identity_key, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (firm_id, client_id, identity_key) DO NOTHING RETURNING id`,
      [args.firmId, args.clientId, args.registrationId ?? null, kind, periodKey,
        identityKey, args.ownerUserId ?? null]);
    const existing = inserted.rows[0]?.id ?? (await c.query<{ id: string }>(
      `SELECT id FROM obligation_timeline_items
        WHERE firm_id = $1 AND client_id = $2 AND identity_key = $3`,
      [args.firmId, args.clientId, identityKey])).rows[0]?.id;
    if (!existing) throw new Error('obligation insert did not resolve');
    if (inserted.rowCount) {
      await c.query(
        `INSERT INTO obligation_workflow_events
         (firm_id, client_id, obligation_id, event_type, workflow_state,
          actor_type, actor_id, occurred_at, reason, evidence_refs, idempotency_key, event_ordinal)
         VALUES ($1,$2,$3,'observed','observed',$4,$5,$6,$7,$8,$9,1)`,
        [args.firmId, args.clientId, existing, args.actorId ? 'user' : 'system',
          args.actorId ?? null, occurredAt, reason, JSON.stringify(refs), `initial:${existing}`]);
    }
    await c.query(
      `INSERT INTO obligation_identity_requests
         (firm_id, client_id, obligation_id, identity_key, idempotency_key)
       VALUES ($1,$2,$3,$4,$5)`,
      [args.firmId, args.clientId, existing, identityKey, idempotencyKey]);
    return existing;
  });
}

export async function recordObligationWorkflowEvent(args: {
  firmId: string;
  clientId: string;
  obligationId: string;
  eventType: unknown;
  actorId?: string | null;
  occurredAt?: Date;
  reason?: unknown;
  evidenceRefs?: unknown[];
  idempotencyKey: unknown;
}): Promise<boolean> {
  const eventType = text(args.eventType, 40, 'event type');
  if (!safeEvents.has(eventType)) throw new ValidationError('workflow event is not allowed here', 'OBL-3');
  const idempotencyKey = text(args.idempotencyKey, 200, 'idempotency key');
  const reason = args.reason == null ? '' : text(args.reason, 2000, 'reason');
  const refs = args.evidenceRefs ?? [];
  if (!Array.isArray(refs)) throw new ValidationError('enter valid evidence references', 'OBL-1');
  const occurredAt = args.occurredAt ?? new Date();
  return withFirm(args.firmId, async (c) => {
    await assertClient(c, args.clientId);
    // Transaction-level advisory lock serializes projection reads and appends
    // for this obligation without granting UPDATE on immutable identity rows.
    const obligation = await c.query<{ id: string }>(
      `SELECT id FROM obligation_timeline_items WHERE id=$1 AND client_id=$2`,
      [args.obligationId, args.clientId]);
    if (!obligation.rowCount) throw new ValidationError('obligation is unavailable', 'OBL-2');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`obligation-events:${args.obligationId}`]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`obligation-event-key:${args.clientId}:${idempotencyKey}`]);
    const duplicate = await c.query(
      `SELECT obligation_id, event_type FROM obligation_workflow_events
        WHERE client_id=$1 AND idempotency_key=$2`,
      [args.clientId, idempotencyKey]);
    if (duplicate.rowCount) {
      if (duplicate.rows[0]!.obligation_id !== args.obligationId
          || duplicate.rows[0]!.event_type !== eventType) {
        throw new ValidationError('idempotency key was already used for another event', 'OBL-4');
      }
      return false;
    }
    const actor = args.actorId ? 'user' : 'system';
    if (args.actorId) {
      const r = await c.query('SELECT 1 FROM users WHERE id = $1 AND (client_id IS NULL OR client_id = $2)',
        [args.actorId, args.clientId]);
      if (!r.rowCount) throw new ValidationError('user is unavailable', 'OBL-2');
    }
    const current = await c.query<{ workflow_state: string; event_ordinal: string }>(
      `SELECT workflow_state, event_ordinal FROM obligation_workflow_events
        WHERE obligation_id = $1 AND client_id = $2
        ORDER BY event_ordinal DESC LIMIT 1`, [args.obligationId, args.clientId]);
    if (!current.rowCount) throw new ValidationError('obligation is unavailable', 'OBL-2');
    const previousState = current.rows[0]!.workflow_state;
    const state = eventType === 'note' ? previousState : eventType;
    if (eventType !== 'note' && !allowedTransitions[previousState]?.includes(eventType)) {
      throw new ValidationError(`workflow transition ${previousState} to ${eventType} is not allowed`, 'OBL-3');
    }
    const result = await c.query(
      `INSERT INTO obligation_workflow_events
         (firm_id, client_id, obligation_id, event_type, workflow_state,
          actor_type, actor_id, occurred_at, reason, evidence_refs, idempotency_key, event_ordinal)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        WHERE EXISTS (SELECT 1 FROM obligation_timeline_items
                       WHERE id = $3 AND client_id = $2)
       ON CONFLICT (firm_id, client_id, idempotency_key) DO NOTHING`,
      [args.firmId, args.clientId, args.obligationId, eventType, state, actor,
        args.actorId ?? null, occurredAt, reason, JSON.stringify(refs), idempotencyKey,
        Number(current.rows[0]!.event_ordinal) + 1]);
    if (result.rowCount === 0) {
      const exists = await c.query('SELECT 1 FROM obligation_timeline_items WHERE id=$1 AND client_id=$2',
        [args.obligationId, args.clientId]);
      if (!exists.rowCount) throw new ValidationError('obligation is unavailable', 'OBL-2');
      return false;
    }
    return true;
  });
}

export async function listObligationTimeline(
  firmId: string, clientId: string,
): Promise<ObligationTimelineItem[]> {
  return withFirm(firmId, async (c) => {
    await assertClient(c, clientId);
    const r = await c.query<{
      id: string; client_id: string; registration_id: string | null; obligation_kind: string;
      period_key: string; identity_key: string; owner_user_id: string | null; created_at: Date;
      event_id: string | null; event_type: string | null; workflow_state: ObligationWorkflowState | null;
      occurred_at: Date | null; recorded_at: Date | null; actor_type: string | null; actor_id: string | null;
      reason: string | null; evidence_refs: unknown[] | null; idempotency_key: string | null;
    }>(`SELECT o.id, o.client_id, o.registration_id, o.obligation_kind, o.period_key,
              o.identity_key, o.owner_user_id, o.created_at,
              e.id AS event_id, e.event_type, e.workflow_state, e.occurred_at,
              e.recorded_at, e.actor_type, e.actor_id, e.reason, e.evidence_refs,
              e.idempotency_key
         FROM obligation_timeline_items o
         LEFT JOIN obligation_workflow_events e ON e.obligation_id = o.id
        WHERE o.client_id = $1
        ORDER BY o.created_at DESC, e.event_ordinal`, [clientId]);
    const items = new Map<string, ObligationTimelineItem>();
    for (const row of r.rows) {
      let item = items.get(row.id);
      if (!item) {
        item = { id: row.id, clientId: row.client_id, registrationId: row.registration_id,
          kind: row.obligation_kind, periodKey: row.period_key, identityKey: row.identity_key,
          ownerUserId: row.owner_user_id, createdAt: row.created_at.toISOString(),
          workflowState: 'observed', history: [] };
        items.set(row.id, item);
      }
      if (row.event_id && row.event_type && row.workflow_state && row.occurred_at && row.recorded_at) {
        item.history.push({ id: row.event_id, eventType: row.event_type,
          workflowState: row.workflow_state, occurredAt: row.occurred_at.toISOString(),
          recordedAt: row.recorded_at.toISOString(), actorType: row.actor_type!, actorId: row.actor_id,
          reason: row.reason ?? '', evidenceRefs: row.evidence_refs ?? [],
          idempotencyKey: row.idempotency_key! });
        item.workflowState = row.workflow_state;
      }
    }
    return [...items.values()];
  });
}
