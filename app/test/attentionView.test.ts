import { describe, expect, it } from 'vitest';
import { renderAttention, renderShell } from '../src/web/views.ts';
import type { FollowUpItem } from '../src/domain/followUps.ts';
import type { ObligationTimelineItem } from '../src/domain/obligationTimeline.ts';

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
    const html = renderAttention(followUps, [obligation('obs', 'observed'), obligation('open', 'open'),
      obligation('blocked', 'blocked'), obligation('review', 'needs_human_review'),
      obligation('prepared', 'prepared'), obligation('submitted', 'submitted_unverified'),
      obligation('paid', 'paid_unverified'), obligation('closed', 'closed'), obligation('superseded', 'superseded')]);
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
});
