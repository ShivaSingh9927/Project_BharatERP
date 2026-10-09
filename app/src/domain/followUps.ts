import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';

export interface FollowUpItem {
  id: string; title: string; details: string; sourceQuestion: string | null; sourceAnswer: string | null;
  assigneeUserId: string | null; assigneeName: string | null; dueDate: string | null;
  priority: 'low' | 'normal' | 'high'; status: 'open' | 'completed'; createdBy: string;
  completedBy: string | null; createdAt: string; completedAt: string | null;
  blockerReason: string | null; snoozedUntil: string | null; history: FollowUpEvent[];
}
export interface FollowUpEvent { id: string; eventType: 'created' | 'blocker_recorded' | 'snoozed' | 'completed';
  reason: string | null; snoozedUntil: string | null; actorName: string; recordedAt: string }
export interface FollowUpAssignee { id: string; displayName: string; role: string }

const clean = (value: unknown, max: number): string => {
  if (typeof value !== 'string') throw new ValidationError('enter valid text', 'FU-1');
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`text must be ${max} characters or fewer`, 'FU-1');
  return text;
};

function validDueDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError('enter a valid due date', 'FU-2');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new ValidationError('enter a valid due date', 'FU-2');
  return value;
}

export async function listFollowUps(firmId: string, clientId: string, includeCompleted = false): Promise<FollowUpItem[]> {
  return withFirm(firmId, async (c) => {
    const result = await c.query<{
      id: string; title: string; details: string; source_question: string | null; source_answer: string | null;
      assignee_user_id: string | null; assignee_name: string | null; due_date: string | null;
      priority: 'low' | 'normal' | 'high'; status: 'open' | 'completed'; created_by: string;
      completed_by: string | null; created_at: Date; completed_at: Date | null;
      blocker_reason: string | null; snoozed_until: string | null;
    }>(`SELECT f.id, f.title, f.details, f.source_question, f.source_answer, f.assignee_user_id,
              u.display_name AS assignee_name, f.due_date::text AS due_date, f.priority, f.status,
              f.created_by, f.completed_by, f.created_at, f.completed_at,
              f.blocker_reason, f.snoozed_until::text AS snoozed_until
         FROM follow_up_items f LEFT JOIN users u ON u.id = f.assignee_user_id
        WHERE f.client_id = $1 AND ($2::boolean OR f.status = 'open')
        ORDER BY (f.status = 'open') DESC, f.due_date NULLS LAST, f.created_at DESC LIMIT 200`, [clientId, includeCompleted]);
    const histories = await c.query<{ id: string; follow_up_id: string; event_type: FollowUpEvent['eventType'];
      reason: string | null; snoozed_until: string | null; actor_name: string; recorded_at: Date }>(
      `SELECT e.id, e.follow_up_id, e.event_type, e.reason, e.snoozed_until::text AS snoozed_until,
              u.display_name AS actor_name, e.recorded_at
         FROM follow_up_events e JOIN users u ON u.id=e.actor_user_id
        WHERE e.client_id=$1 AND e.follow_up_id = ANY($2::uuid[])
        ORDER BY e.recorded_at, e.id`, [clientId, result.rows.map((row) => row.id)]);
    return result.rows.map((row) => ({
      id: row.id, title: row.title, details: row.details, sourceQuestion: row.source_question,
      sourceAnswer: row.source_answer, assigneeUserId: row.assignee_user_id, assigneeName: row.assignee_name,
      dueDate: row.due_date, priority: row.priority, status: row.status, createdBy: row.created_by,
      completedBy: row.completed_by, createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
      blockerReason: row.blocker_reason, snoozedUntil: row.snoozed_until,
      history: histories.rows.filter((event) => event.follow_up_id === row.id).map((event) => ({
        id: event.id, eventType: event.event_type, reason: event.reason, snoozedUntil: event.snoozed_until,
        actorName: event.actor_name, recordedAt: event.recorded_at.toISOString(),
      })),
    }));
  });
}

export async function listFollowUpAssignees(firmId: string, clientId: string): Promise<FollowUpAssignee[]> {
  return withFirm(firmId, async (c) => (await c.query<FollowUpAssignee>(
    `SELECT id, display_name AS "displayName", role FROM users
      WHERE firm_id = $1 AND (client_id IS NULL OR client_id = $2) ORDER BY display_name, id`,
    [firmId, clientId])).rows);
}

export async function createFollowUp(
  firmId: string, clientId: string, userId: string,
  input: { title: unknown; details?: unknown; sourceQuestion?: unknown; sourceAnswer?: unknown;
    assigneeUserId?: unknown; dueDate?: unknown; priority?: unknown },
): Promise<string> {
  const title = clean(input.title, 160);
  if (!title) throw new ValidationError('add a short title', 'FU-1');
  const details = input.details === undefined ? '' : clean(input.details, 2000);
  const sourceQuestion = input.sourceQuestion == null ? null : clean(input.sourceQuestion, 500);
  const sourceAnswer = input.sourceAnswer == null ? null : clean(input.sourceAnswer, 2000);
  const due = validDueDate(input.dueDate);
  const priority = input.priority ?? 'normal';
  if (priority !== 'low' && priority !== 'normal' && priority !== 'high') throw new ValidationError('choose low, normal, or high priority', 'FU-3');
  const assignee = input.assigneeUserId == null || input.assigneeUserId === '' ? null : input.assigneeUserId;
  if (assignee !== null && (typeof assignee !== 'string' || !/^[0-9a-f-]{36}$/i.test(assignee))) throw new ValidationError('choose a valid assignee', 'FU-4');
  return withFirm(firmId, async (c) => {
    if (assignee) {
      const eligible = await c.query(`SELECT 1 FROM users WHERE id=$1 AND firm_id=$2 AND (client_id IS NULL OR client_id=$3)`, [assignee, firmId, clientId]);
      if (!eligible.rowCount) throw new ValidationError('assignee is not available for this client', 'FU-4');
    }
    const result = await c.query<{ id: string }>(
      `INSERT INTO follow_up_items (firm_id, client_id, created_by, title, details, source_question, source_answer,
                                    assignee_user_id, due_date, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [firmId, clientId, userId, title, details, sourceQuestion, sourceAnswer, assignee, due, priority]);
    const id = result.rows[0]!.id;
    await c.query(`INSERT INTO follow_up_events (firm_id, client_id, follow_up_id, actor_user_id, event_type)
      VALUES ($1,$2,$3,$4,'created')`, [firmId, clientId, id, userId]);
    await c.query(`INSERT INTO nexus_alert_events
      (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
      VALUES ($1,$2,'follow_up',$3,'follow_up_created','routine','Follow-up added',$4,$5)
      ON CONFLICT (firm_id, client_id, dedupe_key) DO NOTHING`, [firmId, clientId, id, title, `follow_up:${id}:created`]);
    return id;
  });
}

export async function completeFollowUp(firmId: string, clientId: string, userId: string, id: string): Promise<boolean> {
  return withFirm(firmId, async (c) => {
    const result = await c.query(`UPDATE follow_up_items SET status='completed', completed_by=$3, completed_at=now()
      WHERE id=$1 AND client_id=$2 AND status='open'`, [id, clientId, userId]);
    if (result.rowCount !== 1) return false;
    await c.query(`INSERT INTO follow_up_events (firm_id, client_id, follow_up_id, actor_user_id, event_type)
      VALUES ($1,$2,$3,$4,'completed')`, [firmId, clientId, id, userId]);
    const followUp = await c.query<{ title: string }>('SELECT title FROM follow_up_items WHERE id=$1 AND client_id=$2', [id, clientId]);
    if (followUp.rowCount) await c.query(`INSERT INTO nexus_alert_events
      (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
      VALUES ($1,$2,'follow_up',$3,'follow_up_completed','routine','Follow-up marked complete',$4,$5)
      ON CONFLICT (firm_id, client_id, dedupe_key) DO NOTHING`, [firmId, clientId, id, followUp.rows[0]!.title, `follow_up:${id}:completed`]);
    return true;
  });
}

export async function recordFollowUpBlocker(firmId: string, clientId: string, userId: string,
  id: string, value: unknown): Promise<boolean> {
  const reason = clean(value, 2000);
  if (!reason) throw new ValidationError('enter the blocker or reason', 'FU-5');
  return withFirm(firmId, async (c) => {
    const changed = await c.query(`UPDATE follow_up_items SET blocker_reason=$4
      WHERE id=$1 AND client_id=$2 AND firm_id=$3 AND status='open'`, [id, clientId, firmId, reason]);
    if (changed.rowCount !== 1) return false;
    await c.query(`INSERT INTO follow_up_events (firm_id, client_id, follow_up_id, actor_user_id, event_type, reason)
      VALUES ($1,$2,$3,$4,'blocker_recorded',$5)`, [firmId, clientId, id, userId, reason]);
    return true;
  });
}

export async function snoozeFollowUp(firmId: string, clientId: string, userId: string,
  id: string, value: unknown): Promise<boolean> {
  const until = validDueDate(value);
  if (!until) throw new ValidationError('choose a snooze date', 'FU-2');
  return withFirm(firmId, async (c) => {
    const changed = await c.query(`UPDATE follow_up_items SET snoozed_until=$4
      WHERE id=$1 AND client_id=$2 AND firm_id=$3 AND status='open'`, [id, clientId, firmId, until]);
    if (changed.rowCount !== 1) return false;
    await c.query(`INSERT INTO follow_up_events (firm_id, client_id, follow_up_id, actor_user_id, event_type, snoozed_until)
      VALUES ($1,$2,$3,$4,'snoozed',$5)`, [firmId, clientId, id, userId, until]);
    return true;
  });
}
