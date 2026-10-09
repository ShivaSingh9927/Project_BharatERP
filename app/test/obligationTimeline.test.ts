import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { ownerPool, withFirm, closePools } from '../src/db/pool.ts';
import {
  listObligationTimeline, recordObservedObligation, recordObligationWorkflowEvent,
} from '../src/domain/obligationTimeline.ts';
import { listNexusAlerts } from '../src/domain/alerts.ts';
import { createFollowUp, completeFollowUp } from '../src/domain/followUps.ts';
import { ValidationError } from '../src/domain/types.ts';

let tenant: SeededTenant;
let otherTenant: SeededTenant;
let itemId: string;
let sameFirmOtherClientId: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  tenant = await seedTenant({ firmName: `Timeline ${tag}`, clientName: `Client ${tag}`,
    userEmail: `timeline-${tag}@example.test`, startYear: 2026,
    pan: 'AAACP1111P', businessType: 'general' });
  otherTenant = await seedTenant({ firmName: `Timeline other ${tag}`, clientName: `Other ${tag}`,
    userEmail: `timeline-other-${tag}@example.test`, startYear: 2026,
    pan: 'AAACQ2222Q', businessType: 'general' });
  sameFirmOtherClientId = (await ownerPool.query<{ id: string }>(
    `INSERT INTO clients (firm_id, name, pan, business_type)
     VALUES ($1, $2, 'AAACR3333R', 'general') RETURNING id`,
    [tenant.firmId, `Same firm other client ${tag}`])).rows[0]!.id;
});

afterAll(async () => { await closePools(); });

describe('obligation timeline storage', () => {
  it('records observed identity idempotently without inferring a filing', async () => {
    const args = { firmId: tenant.firmId, clientId: tenant.clientId,
      kind: 'synthetic_return', periodKey: 'FY26-P01',
      actorId: tenant.userId, idempotencyKey: 'synthetic-observation-1',
      occurredAt: new Date('2026-04-01T00:00:00Z'), reason: 'Synthetic evidence suggests work may exist.' };
    itemId = await recordObservedObligation(args);
    expect(await recordObservedObligation(args)).toBe(itemId);
    expect(await recordObservedObligation({ ...args, idempotencyKey: 'synthetic-observation-2' }))
      .toBe(itemId);
    await expect(recordObservedObligation({ ...args, kind: 'different_synthetic_return' }))
      .rejects.toBeInstanceOf(ValidationError);
    const items = await listObligationTimeline(tenant.firmId, tenant.clientId);
    expect(items).toHaveLength(1);
    expect(items[0]?.workflowState).toBe('observed');
    expect(items[0]?.history.map((event) => event.eventType)).toEqual(['observed']);
    const outcomes = await withFirm(tenant.firmId, (c) => c.query(
      'SELECT id FROM obligation_outcome_facts WHERE obligation_id = $1', [itemId]));
    expect(outcomes.rowCount).toBe(0);
  });

  it('keeps workflow history append-only and deduplicates repeated events', async () => {
    const event = { firmId: tenant.firmId, clientId: tenant.clientId, obligationId: itemId,
      eventType: 'blocked', actorId: tenant.userId, idempotencyKey: 'synthetic-block-1',
      occurredAt: new Date('2026-04-02T00:00:00Z'), reason: 'Waiting for a synthetic source.' };
    expect(await recordObligationWorkflowEvent(event)).toBe(true);
    expect(await recordObligationWorkflowEvent(event)).toBe(false);
    const row = (await listObligationTimeline(tenant.firmId, tenant.clientId))[0]!;
    expect(row.workflowState).toBe('blocked');
    expect(row.history.map((entry) => entry.workflowState)).toEqual(['observed', 'blocked']);
    const alerts = await listNexusAlerts(tenant.firmId, tenant.clientId);
    expect(alerts.total).toBe(1);
    expect(alerts.items).toHaveLength(1);
    expect(alerts.items[0]?.sourceKind).toBe('obligation_event');
    expect(alerts.items[0]?.alertType).toBe('obligation_blocked');
    expect(alerts.items[0]?.priority).toBe('high');
    expect(alerts.items[0]?.message).toContain('synthetic_return · FY26-P01');
    expect(alerts.items[0]?.message.toLowerCase()).not.toContain('filed');
    const otherClientAlerts = await listNexusAlerts(otherTenant.firmId, otherTenant.clientId);
    expect(otherClientAlerts.total).toBe(0);
    expect(otherClientAlerts.items).toEqual([]);
  });

  it('creates deterministic in-app notices for follow-up creation and completion', async () => {
    const id = await createFollowUp(tenant.firmId, tenant.clientId, tenant.userId,
      { title: 'Review the source receipt', details: 'Synthetic test fixture' });
    const firstCompletion = await completeFollowUp(tenant.firmId, tenant.clientId, tenant.userId, id);
    const repeatedCompletion = await completeFollowUp(tenant.firmId, tenant.clientId, tenant.userId, id);
    expect(firstCompletion).toBe(true);
    expect(repeatedCompletion).toBe(false);
    const alerts = await listNexusAlerts(tenant.firmId, tenant.clientId);
    const followUpAlerts = alerts.items.filter((alert) => alert.sourceKind === 'follow_up' && alert.sourceId === id);
    expect(followUpAlerts).toHaveLength(2);
    expect(followUpAlerts.map((alert) => alert.alertType).sort()).toEqual(['follow_up_completed', 'follow_up_created']);
    expect(new Set(followUpAlerts.map((alert) => alert.id)).size).toBe(2);
    expect(followUpAlerts.every((alert) => alert.priority === 'routine')).toBe(true);
  });

  it('serializes concurrent transitions and preserves event order', async () => {
    const concurrentItemId = await recordObservedObligation({ firmId: tenant.firmId,
      clientId: tenant.clientId, kind: 'concurrent_synthetic', periodKey: 'FY26-P02',
      actorId: tenant.userId, idempotencyKey: 'synthetic-concurrent-observation' });
    const base = { firmId: tenant.firmId, clientId: tenant.clientId,
      obligationId: concurrentItemId, eventType: 'blocked', actorId: tenant.userId };
    const results = await Promise.allSettled([
      recordObligationWorkflowEvent({ ...base, idempotencyKey: 'synthetic-concurrent-block-a' }),
      recordObligationWorkflowEvent({ ...base, idempotencyKey: 'synthetic-concurrent-block-b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const history = (await listObligationTimeline(tenant.firmId, tenant.clientId))
      .find((item) => item.id === concurrentItemId)!.history;
    expect(history.map((event) => event.workflowState)).toEqual(['observed', 'blocked']);
    const ordinals = await withFirm(tenant.firmId, (c) => c.query<{ event_ordinal: string }>(
      `SELECT event_ordinal FROM obligation_workflow_events
        WHERE obligation_id = $1 ORDER BY event_ordinal`, [concurrentItemId]));
    expect(ordinals.rows.map((row) => Number(row.event_ordinal))).toEqual([1, 2]);
  });

  it('does not allow open or prepared without the future verified-rule path', async () => {
    await expect(recordObligationWorkflowEvent({ firmId: tenant.firmId,
      clientId: tenant.clientId, obligationId: itemId, eventType: 'open',
      idempotencyKey: 'synthetic-open-no-rule' })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordObligationWorkflowEvent({ firmId: tenant.firmId,
      clientId: tenant.clientId, obligationId: itemId, eventType: 'prepared',
      idempotencyKey: 'synthetic-prepared-no-rule' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects foreign client and unsafe filing event claims', async () => {
    await expect(listObligationTimeline(tenant.firmId, otherTenant.clientId))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(recordObligationWorkflowEvent({ firmId: tenant.firmId,
      clientId: tenant.clientId, obligationId: itemId, eventType: 'filed',
      idempotencyKey: 'synthetic-filed-1' })).rejects.toBeInstanceOf(ValidationError);
    await expect(listObligationTimeline(tenant.firmId, sameFirmOtherClientId)).resolves.toEqual([]);
    await expect(recordObligationWorkflowEvent({ firmId: tenant.firmId,
      clientId: sameFirmOtherClientId, obligationId: itemId, eventType: 'blocked',
      idempotencyKey: 'synthetic-cross-client-event' })).rejects.toBeInstanceOf(ValidationError);
    const foreignFirmRows = await withFirm(otherTenant.firmId, (c) => c.query(
      'SELECT id FROM obligation_timeline_items WHERE id = $1', [itemId]));
    expect(foreignFirmRows.rowCount).toBe(0);
  });
});
