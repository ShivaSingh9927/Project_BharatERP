import { describe, expect, it } from 'vitest';
import { renderAttention, renderShell } from '../src/web/views.ts';
import type { FollowUpItem } from '../src/domain/followUps.ts';
import type { ObligationTimelineItem } from '../src/domain/obligationTimeline.ts';
import type { NexusAlert } from '../src/domain/alerts.ts';

describe('client attention page', () => {
  it('shows open work, reviewable obligation states, and recent completions without action controls', () => {
    const followUps: FollowUpItem[] = [
      { id: 'fu-open', title: 'Review missing statement', details: 'Check source pages', sourceQuestion: 'Where is it?',
        sourceAnswer: 'Nexus noted a missing statement.', status: 'open', createdBy: 'user', completedBy: null,
        createdAt: '2026-10-08T10:00:00.000Z', completedAt: null },
      { id: 'fu-done', title: 'Check supplier name', details: '', sourceQuestion: null, sourceAnswer: null,
        status: 'completed', createdBy: 'user', completedBy: 'user',
        createdAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-07T10:00:00.000Z' },
    ];
    const obligation = (id: string, state: ObligationTimelineItem['workflowState']): ObligationTimelineItem => ({
      id, clientId: 'client-1', registrationId: null, kind: 'GST review', periodKey: 'FY26-Q2',
      identityKey: id, ownerUserId: null, createdAt: '2026-10-01T00:00:00.000Z', workflowState: state,
      history: [{ id: `event-${id}`, eventType: state, workflowState: state,
        occurredAt: '2026-10-01T00:00:00.000Z', recordedAt: '2026-10-01T00:00:00.000Z',
        actorType: 'user', actorId: null, reason: '<needs evidence>', evidenceRefs: [], idempotencyKey: id }],
    });
    const alerts: NexusAlert[] = [{ id: 'alert-1', sourceKind: 'follow_up', sourceId: 'fu-open',
      alertType: 'follow_up_created', priority: 'routine', title: 'Follow-up added',
      message: 'Review missing statement', createdAt: '2026-10-08T10:01:00.000Z' },
    { id: 'alert-2', sourceKind: 'obligation_event', sourceId: 'event-blocked',
      alertType: 'obligation_blocked', priority: 'high', title: 'Obligation blocked',
      message: 'GST review · FY26-Q2 needs a blocker review', createdAt: '2026-10-08T10:02:00.000Z' }];
    const html = renderAttention(followUps, [obligation('obs', 'observed'), obligation('open', 'open'),
      obligation('blocked', 'blocked'), obligation('review', 'needs_human_review'),
      obligation('prepared', 'prepared'), obligation('submitted', 'submitted_unverified'),
      obligation('paid', 'paid_unverified'), obligation('closed', 'closed'), obligation('superseded', 'superseded')], alerts);
    expect(html).toContain('Open follow-ups · 1');
    expect(html).toContain('Review missing statement');
    expect(html).toContain('/follow-ups#followup-fu-open');
    expect(html).toContain('Observed · applicability or status not established');
    expect(html).toContain('Open · work remains');
    expect(html).toContain('Blocked · review the recorded blocker');
    expect(html).toContain('Needs human review');
    expect(html).toContain('Prepared · not filed or paid');
    expect(html).toContain('Submitted · unverified');
    expect(html).toContain('Payment reported · unverified');
    expect(html).not.toContain('closed ·');
    expect(html).not.toContain('superseded ·');
    expect(html).toContain('Recorded workflow history · 1');
    expect(html).toContain('Recent in-app alerts · 2');
    expect(html).toContain('/follow-ups#followup-fu-open');
    expect(html).toContain('/attention#attention-obligation-blocked');
    expect(html).toContain('Review source →');
    expect(html).not.toContain('needs evidence');
    expect(html).not.toContain('&lt;needs evidence&gt;');
    expect(html).toContain('Check supplier name');
    expect(html).not.toContain('Mark complete');
    expect(html).not.toContain('fetch(');
    expect(html).toContain('does not infer deadlines, filing, or payment');
    const shell = renderShell({ session: { clientName: 'ABC Traders', role: 'owner', boundClientId: 'client-1' },
      accounts: [], active: 'attention', body: html });
    expect(shell).toContain('href="/attention"');
    expect(html).not.toContain('<h1>Attention</h1>');
  });

  it('does not link an alert to a closed obligation hidden from the review list', () => {
    const closed: ObligationTimelineItem = {
      id: 'obligation-closed', clientId: 'client-1', registrationId: null, kind: 'GST review',
      periodKey: 'FY26-Q2', identityKey: 'closed', ownerUserId: null,
      createdAt: '2026-10-01T00:00:00.000Z', workflowState: 'closed',
      history: [{ id: 'event-closed', eventType: 'blocked', workflowState: 'blocked',
        occurredAt: '2026-10-01T00:00:00.000Z', recordedAt: '2026-10-01T00:00:00.000Z',
        actorType: 'user', actorId: null, reason: '', evidenceRefs: [], idempotencyKey: 'closed' },
      { id: 'event-closed-final', eventType: 'closed', workflowState: 'closed',
        occurredAt: '2026-10-02T00:00:00.000Z', recordedAt: '2026-10-02T00:00:00.000Z',
        actorType: 'user', actorId: null, reason: '', evidenceRefs: [], idempotencyKey: 'closed-final' }],
    };
    const alert: NexusAlert = { id: 'alert-stale', sourceKind: 'obligation_event', sourceId: 'event-closed',
      alertType: 'obligation_blocked', priority: 'high', title: 'Obligation blocked',
      message: 'GST review · FY26-Q2 needs a blocker review', createdAt: '2026-10-01T00:00:00.000Z' };
    const html = renderAttention([], [closed], [alert]);
    expect(html).not.toContain('/attention#attention-obligation-obligation-closed');
    expect(html).not.toContain('Review source →');
    expect(html).toContain('Source item is not shown in the current review list.');
  });

  it('shows only ten recent alerts and reports the total count', () => {
    const alerts: NexusAlert[] = Array.from({ length: 10 }, (_, index) => ({
      id: `alert-${index}`, sourceKind: 'follow_up', sourceId: `fu-${index}`,
      alertType: 'follow_up_created', priority: 'routine', title: `Alert ${index}`,
      message: 'An item needs review', createdAt: '2026-10-01T00:00:00.000Z',
    }));
    const html = renderAttention([], [], alerts, 14);
    expect(html).toContain('Recent in-app alerts · 14 total (showing 10)');
    expect(html).toContain('Alert 9');
    expect(html).not.toContain('Alert 10');
  });
});
