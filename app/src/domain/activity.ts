import { withFirm } from '../db/pool.ts';

export type ActivityDirection = 'incoming' | 'outgoing' | 'internal';

export interface ActivityItem {
  id: string;
  kind: string;
  occurredAt: string;
  title: string;
  detail: string;
  status: string;
  direction: ActivityDirection;
  href: string;
}

/**
 * A client-scoped view over durable records from the channels already in the
 * app. The feed is derived rather than copied into another table, so its
 * statuses cannot drift from documents, Nexus answers, or follow-ups.
 */
export async function recentActivity(
  firmId: string, clientId: string, limit = 100,
): Promise<ActivityItem[]> {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return withFirm(firmId, async (c) => {
    const result = await c.query<{
      id: string; kind: string; occurred_at: Date; title: string;
      detail: string; status: string; direction: ActivityDirection; href: string;
    }>(`SELECT id, kind, occurred_at, title, detail, status, direction, href
         FROM (
           SELECT id::text, 'document_received'::text AS kind, received_at AS occurred_at,
                  'Document received'::text AS title, COALESCE(original_name, 'document') AS detail,
                  'received'::text AS status, 'incoming'::text AS direction, '/documents'::text AS href
             FROM source_documents WHERE firm_id = $1 AND client_id = $2
           UNION ALL
           SELECT id::text, 'email_received'::text, received_at,
                  'Email received'::text,
                  sender || ' · ' || COALESCE(NULLIF(subject, ''), '(No subject)'),
                  'assigned'::text, 'incoming'::text, '/nexus'::text
             FROM inbound_email_messages
            WHERE firm_id = $1 AND client_id = $2 AND status = 'assigned'
           UNION ALL
           SELECT id::text, 'document_update'::text, review_updated_at,
                  CASE WHEN status = 'needs_information' THEN 'Information requested'
                       WHEN status = 'processed' THEN 'Document completed'
                       WHEN status = 'dismissed' THEN 'Document dismissed as irrelevant'
                       ELSE 'Document review updated' END,
                  COALESCE(review_note, original_name, 'Document status changed'),
                  status, CASE WHEN status = 'needs_information' THEN 'outgoing' ELSE 'internal' END,
                  '/documents'
             FROM source_documents
            WHERE firm_id = $1 AND client_id = $2 AND review_updated_at IS NOT NULL
           UNION ALL
           SELECT id::text, 'nexus_reply'::text, created_at,
                  CASE WHEN supported THEN 'Bharat Nexus replied' ELSE 'Bharat Nexus needs more information' END,
                  question || E'\n' || left(answer, 300),
                  CASE WHEN supported THEN 'answered' ELSE 'unsupported' END,
                  'outgoing'::text, '/nexus'::text
             FROM assistant_runs WHERE firm_id = $1 AND client_id = $2
           UNION ALL
           SELECT id::text, 'follow_up_created'::text, created_at,
                  'Follow-up added', title, status, 'internal'::text, '/follow-ups'::text
             FROM follow_up_items WHERE firm_id = $1 AND client_id = $2
           UNION ALL
           SELECT r.id::text, 'document_request_answered'::text, r.answered_at,
                  'Founder answered document request'::text,
                  COALESCE(d.original_name, 'Document') || ': ' ||
                    COALESCE(NULLIF(left(r.answer, 300), ''),
                      cardinality(r.attachment_ids)::text || ' attachment(s)'),
                  'answered'::text, 'incoming'::text,
                  '/documents#doc-' || r.document_id::text
             FROM document_information_requests r
             JOIN source_documents d ON d.id = r.document_id
            WHERE r.firm_id = $1 AND r.client_id = $2 AND r.status = 'answered'
           UNION ALL
           SELECT id::text, 'follow_up_completed'::text, completed_at,
                  'Follow-up completed', title, 'completed'::text,
                  'internal'::text, '/follow-ups'::text
             FROM follow_up_items
            WHERE firm_id = $1 AND client_id = $2 AND completed_at IS NOT NULL
         ) AS activity
        ORDER BY occurred_at DESC, id DESC LIMIT $3`, [firmId, clientId, bounded]);
    return result.rows.map((row) => ({
      ...row, occurredAt: row.occurred_at.toISOString(),
    }));
  });
}
