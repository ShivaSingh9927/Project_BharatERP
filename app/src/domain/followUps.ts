import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';

export interface FollowUpItem {
  id: string;
  title: string;
  details: string;
  sourceQuestion: string | null;
  sourceAnswer: string | null;
  status: 'open' | 'completed';
  createdBy: string;
  completedBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

const clean = (value: unknown, max: number): string => {
  if (typeof value !== 'string') throw new ValidationError('enter valid text', 'FU-1');
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`text must be ${max} characters or fewer`, 'FU-1');
  return text;
};

export async function listFollowUps(
  firmId: string, clientId: string, includeCompleted = false,
): Promise<FollowUpItem[]> {
  return withFirm(firmId, async (c) => {
    const result = await c.query<{
      id: string; title: string; details: string; source_question: string | null;
      source_answer: string | null; status: 'open' | 'completed'; created_by: string;
      completed_by: string | null; created_at: Date; completed_at: Date | null;
    }>(`SELECT id, title, details, source_question, source_answer, status, created_by,
              completed_by, created_at, completed_at
         FROM follow_up_items
        WHERE client_id = $1 AND ($2::boolean OR status = 'open')
        ORDER BY (status = 'open') DESC, created_at DESC LIMIT 200`,
    [clientId, includeCompleted]);
    return result.rows.map((row) => ({
      id: row.id, title: row.title, details: row.details,
      sourceQuestion: row.source_question, sourceAnswer: row.source_answer,
      status: row.status, createdBy: row.created_by, completedBy: row.completed_by,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    }));
  });
}

export async function createFollowUp(
  firmId: string,
  clientId: string,
  userId: string,
  input: { title: unknown; details?: unknown; sourceQuestion?: unknown; sourceAnswer?: unknown },
): Promise<string> {
  const title = clean(input.title, 160);
  if (!title) throw new ValidationError('add a short title', 'FU-1');
  const details = input.details === undefined ? '' : clean(input.details, 2000);
  const sourceQuestion = input.sourceQuestion == null ? null : clean(input.sourceQuestion, 500);
  const sourceAnswer = input.sourceAnswer == null ? null : clean(input.sourceAnswer, 2000);
  return withFirm(firmId, async (c) => {
    const result = await c.query<{ id: string }>(
      `INSERT INTO follow_up_items
         (firm_id, client_id, created_by, title, details, source_question, source_answer)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [firmId, clientId, userId, title, details, sourceQuestion, sourceAnswer]);
    const id = result.rows[0]!.id;
    await c.query(
      `INSERT INTO nexus_alert_events
         (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
       VALUES ($1,$2,'follow_up',$3,'follow_up_created','routine','Follow-up added',$4,$5)
       ON CONFLICT (firm_id, client_id, dedupe_key) DO NOTHING`,
      [firmId, clientId, id, title, `follow_up:${id}:created`]);
    return id;
  });
}

export async function completeFollowUp(
  firmId: string, clientId: string, userId: string, id: string,
): Promise<boolean> {
  return withFirm(firmId, async (c) => {
    const result = await c.query(
      `UPDATE follow_up_items SET status = 'completed', completed_by = $3, completed_at = now()
        WHERE id = $1 AND client_id = $2 AND status = 'open'`, [id, clientId, userId]);
    if (result.rowCount !== 1) return false;
    const followUp = await c.query<{ title: string }>(
      `SELECT title FROM follow_up_items WHERE id=$1 AND client_id=$2`, [id, clientId]);
    if (followUp.rowCount) {
      await c.query(
        `INSERT INTO nexus_alert_events
           (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
         VALUES ($1,$2,'follow_up',$3,'follow_up_completed','routine','Follow-up marked complete',$4,$5)
         ON CONFLICT (firm_id, client_id, dedupe_key) DO NOTHING`,
        [firmId, clientId, id, followUp.rows[0]!.title, `follow_up:${id}:completed`]);
    }
    return true;
  });
}
