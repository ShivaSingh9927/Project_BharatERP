import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { withFirm, closePools } from '../src/db/pool.ts';

let tenant: SeededTenant;
let otherTenant: SeededTenant;
let sameFirmOtherClientId: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  tenant = await seedTenant({ firmName: `Alert mail ${tag}`, clientName: `Client ${tag}`,
    userEmail: `alert-mail-${tag}@example.test`, startYear: 2026,
    pan: 'AAACP1111P', businessType: 'general' });
  otherTenant = await seedTenant({ firmName: `Alert mail other ${tag}`, clientName: `Other ${tag}`,
    userEmail: `alert-mail-other-${tag}@example.test`, startYear: 2026,
    pan: 'AAACQ2222Q', businessType: 'general' });
  sameFirmOtherClientId = (await withFirm(tenant.firmId, async (c) => c.query<{ id: string }>(
    `INSERT INTO clients (firm_id, name, pan, business_type)
     VALUES ($1, $2, 'AAACR3333R', 'general') RETURNING id`,
    [tenant.firmId, `Same firm other client ${tag}`]))).rows[0]!.id;
});

afterAll(async () => { await closePools(); });

describe('Nexus alert email outbox', () => {
  it('does not backfill old alerts and requires a new preference for a new address', async () => {
    const oldAlertId = await withFirm(tenant.firmId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO nexus_alert_events
         (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
       VALUES ($1, $2, 'follow_up', $3, 'follow_up_created', 'routine',
               'Old notice', 'This predates the recipient preference.', $4) RETURNING id`,
      [tenant.firmId, tenant.clientId, randomUUID(), `old-alert-${randomUUID()}`])).rows[0]!.id);
    const preferenceId = await withFirm(tenant.firmId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO nexus_alert_email_preferences (firm_id, client_id, recipient_email, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenant.firmId, tenant.clientId, `late-${randomUUID().slice(0, 8)}@example.test`, tenant.userId])).rows[0]!.id);

    await withFirm(tenant.firmId, async (c) => {
      await c.query(`UPDATE nexus_alert_email_preferences
        SET email_enabled = true, verification_status = 'verified', reviewed_by = $2, reviewed_at = now()
        WHERE id = $1`, [preferenceId, tenant.userId]);
    });
    await expect(withFirm(tenant.firmId, (c) => c.query(
      'UPDATE nexus_alert_email_preferences SET recipient_email = $2 WHERE id = $1',
      [preferenceId, `retarget-${randomUUID().slice(0, 8)}@example.test`]))).rejects.toThrow();

    const historicalRows = await withFirm(tenant.firmId, (c) => c.query(
      'SELECT id FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [oldAlertId, preferenceId]));
    expect(historicalRows.rowCount).toBe(0);

    const newAlertId = await withFirm(tenant.firmId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO nexus_alert_events
         (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
       VALUES ($1, $2, 'follow_up', $3, 'follow_up_created', 'routine',
               'New notice', 'Created after recipient review.', $4) RETURNING id`,
      [tenant.firmId, tenant.clientId, randomUUID(), `new-alert-${randomUUID()}`])).rows[0]!.id);
    const newRows = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [newAlertId, preferenceId]));
    expect(newRows.rows).toEqual([{ delivery_state: 'queued' }]);
  });

  it('never releases pre-opt-in rows and stops queued rows after revocation', async () => {
    const inserted = await withFirm(tenant.firmId, async (c) => {
      const p = await c.query<{ id: string }>(
        `INSERT INTO nexus_alert_email_preferences (firm_id, client_id, recipient_email, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant.firmId, tenant.clientId, `recipient-${randomUUID().slice(0, 8)}@example.test`, tenant.userId]);
      const a = await c.query<{ id: string }>(
        `INSERT INTO nexus_alert_events
           (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
         VALUES ($1, $2, 'follow_up', $3, 'follow_up_created', 'routine',
                 'Review an item', 'A human review is needed.', $4) RETURNING id`,
        [tenant.firmId, tenant.clientId, randomUUID(), `email-outbox-${randomUUID()}`]);
      return { preferenceId: p.rows[0]!.id, alertId: a.rows[0]!.id };
    });

    const initial = await withFirm(tenant.firmId, (c) => c.query<{
      delivery_state: string; attempt_count: number; subject: string; body_text: string;
    }>(`SELECT delivery_state, attempt_count, subject, body_text FROM nexus_alert_email_outbox
         WHERE alert_id = $1 AND preference_id = $2`, [inserted.alertId, inserted.preferenceId]));
    expect(initial.rows).toEqual([{ delivery_state: 'held_disabled', attempt_count: 0,
      subject: 'Review an item', body_text: 'A human review is needed.' }]);
    await expect(withFirm(tenant.firmId, (c) => c.query(
      `INSERT INTO nexus_alert_email_outbox
         (firm_id, client_id, alert_id, preference_id, recipient_email, subject, body_text, dedupe_key, delivery_state)
       VALUES ($1, $2, $3, $4, 'forged@example.test', 'Review an item',
               'A human review is needed.', 'forged-state', 'sent')`,
      [tenant.firmId, tenant.clientId, inserted.alertId, inserted.preferenceId]))).rejects.toThrow();

    await withFirm(tenant.firmId, async (c) => {
      await c.query('UPDATE nexus_alert_email_preferences SET email_enabled = true WHERE id = $1',
        [inserted.preferenceId]);
    });
    const unverified = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [inserted.alertId, inserted.preferenceId]));
    expect(unverified.rows[0]?.delivery_state).toBe('held_disabled');

    await withFirm(tenant.firmId, async (c) => {
      await c.query(`UPDATE nexus_alert_email_preferences
        SET verification_status = 'verified', reviewed_by = $2, reviewed_at = now()
        WHERE id = $1`, [inserted.preferenceId, tenant.userId]);
      // Review and repeated opt-in must not release an alert from before consent.
      await c.query(`UPDATE nexus_alert_email_preferences SET email_enabled = true WHERE id = $1`,
        [inserted.preferenceId]);
    });
    const heldAfterReview = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string; count: string }>(
      `SELECT min(delivery_state) AS delivery_state, count(*)::text AS count
         FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2`,
      [inserted.alertId, inserted.preferenceId]));
    expect(heldAfterReview.rows[0]).toEqual({ delivery_state: 'held_disabled', count: '1' });

    const optedInAlertId = await withFirm(tenant.firmId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO nexus_alert_events
         (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
       VALUES ($1, $2, 'follow_up', $3, 'follow_up_created', 'routine',
               'Opted-in notice', 'Created after opt-in and review.', $4) RETURNING id`,
      [tenant.firmId, tenant.clientId, randomUUID(), `opted-in-alert-${randomUUID()}`])).rows[0]!.id);
    const queued = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [optedInAlertId, inserted.preferenceId]));
    expect(queued.rows).toEqual([{ delivery_state: 'queued' }]);

    await withFirm(tenant.firmId, async (c) => {
      await c.query('UPDATE nexus_alert_email_preferences SET email_enabled = false WHERE id = $1',
        [inserted.preferenceId]);
    });
    const revoked = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [optedInAlertId, inserted.preferenceId]));
    expect(revoked.rows).toEqual([{ delivery_state: 'held_disabled' }]);
    await withFirm(tenant.firmId, async (c) => {
      await c.query('UPDATE nexus_alert_email_preferences SET email_enabled = true WHERE id = $1',
        [inserted.preferenceId]);
    });
    const reenabled = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [optedInAlertId, inserted.preferenceId]));
    expect(reenabled.rows).toEqual([{ delivery_state: 'held_disabled' }]);

    const afterReenableAlertId = await withFirm(tenant.firmId, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO nexus_alert_events
         (firm_id, client_id, source_kind, source_id, alert_type, priority, title, message, dedupe_key)
       VALUES ($1, $2, 'follow_up', $3, 'follow_up_created', 'routine',
               'Re-enabled notice', 'Created after re-enabling.', $4) RETURNING id`,
      [tenant.firmId, tenant.clientId, randomUUID(), `reenabled-alert-${randomUUID()}`])).rows[0]!.id);
    const afterReenable = await withFirm(tenant.firmId, (c) => c.query<{ delivery_state: string }>(
      'SELECT delivery_state FROM nexus_alert_email_outbox WHERE alert_id = $1 AND preference_id = $2',
      [afterReenableAlertId, inserted.preferenceId]));
    expect(afterReenable.rows).toEqual([{ delivery_state: 'queued' }]);
  });

  it('keeps preference and outbox rows inside the firm and client scope', async () => {
    const counts = await withFirm(otherTenant.firmId, async (c) => Promise.all([
      c.query('SELECT id FROM nexus_alert_email_preferences WHERE client_id = $1', [tenant.clientId]),
      c.query('SELECT id FROM nexus_alert_email_outbox WHERE client_id = $1', [tenant.clientId]),
    ]));
    expect(counts.map((result) => result.rowCount)).toEqual([0, 0]);

    await expect(withFirm(tenant.firmId, (c) => c.query(
      `INSERT INTO nexus_alert_email_preferences (firm_id, client_id, recipient_email, created_by)
       VALUES ($1, $2, 'cross-client@example.test', $3)`,
      [tenant.firmId, otherTenant.clientId, tenant.userId]))).rejects.toThrow();

    const visibleToOtherClient = await withFirm(tenant.firmId, (c) => c.query(
      'SELECT id FROM nexus_alert_email_outbox WHERE client_id = $1', [sameFirmOtherClientId]));
    expect(visibleToOtherClient.rowCount).toBe(0);
  });
});
