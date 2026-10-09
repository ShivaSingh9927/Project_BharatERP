import { withFirm } from '../db/pool.ts';

export interface NexusAlert {
  id: string;
  sourceKind: 'follow_up' | 'obligation_event';
  sourceId: string;
  alertType: 'follow_up_created' | 'follow_up_completed' | 'obligation_blocked' | 'obligation_needs_human_review';
  priority: 'routine' | 'high';
  title: string;
  message: string;
  createdAt: string;
}

export async function listNexusAlerts(
  firmId: string, clientId: string,
): Promise<{ items: NexusAlert[]; total: number }> {
  return withFirm(firmId, async (c) => {
    const count = await c.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM nexus_alert_events WHERE client_id = $1', [clientId]);
    const result = await c.query<{
      id: string; source_kind: NexusAlert['sourceKind']; source_id: string;
      alert_type: NexusAlert['alertType']; priority: NexusAlert['priority'];
      title: string; message: string; created_at: Date;
    }>(`SELECT id, source_kind, source_id, alert_type, priority, title, message, created_at
         FROM nexus_alert_events WHERE client_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 10`, [clientId]);
    return { total: count.rows[0]?.total ?? 0, items: result.rows.map((row) => ({ id: row.id, sourceKind: row.source_kind,
      sourceId: row.source_id, alertType: row.alert_type, priority: row.priority,
      title: row.title, message: row.message, createdAt: row.created_at.toISOString() })) };
  });
}
