import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant, type SeededTenant } from '../src/seed/index.ts';
import { ownerPool, closePools } from '../src/db/pool.ts';
import { createFollowUp, listFollowUps, listFollowUpAssignees } from '../src/domain/followUps.ts';
import { ValidationError } from '../src/domain/types.ts';

let tenant: SeededTenant;
let otherFirm: SeededTenant;
let sameFirmOtherClient: string;

beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  tenant = await seedTenant({ firmName: `Followup ${tag}`, clientName: `Client ${tag}`,
    userEmail: `followup-${tag}@example.test`, startYear: 2026, pan: 'AAACT1111T', businessType: 'general' });
  otherFirm = await seedTenant({ firmName: `Followup other ${tag}`, clientName: `Other ${tag}`,
    userEmail: `followup-other-${tag}@example.test`, startYear: 2026, pan: 'AAACU2222U', businessType: 'general' });
  sameFirmOtherClient = (await ownerPool.query<{ id: string }>(
    `INSERT INTO clients (firm_id,name,pan,business_type) VALUES ($1,$2,'AAACV3333V','general') RETURNING id`,
    [tenant.firmId, `Other client ${tag}`])).rows[0]!.id;
  await ownerPool.query(`INSERT INTO users (firm_id,client_id,email,display_name,role)
    VALUES ($1,$2,$3,'Client scoped reviewer','owner')`,
    [tenant.firmId, sameFirmOtherClient, `scoped-${tag}@example.test`]);
});

afterAll(async () => { await closePools(); });

describe('follow-up routing metadata', () => {
  it('stores and reads assignment, due date, and priority inside the selected client', async () => {
    const assignees = await listFollowUpAssignees(tenant.firmId, tenant.clientId);
    expect(assignees.map((person) => person.id)).toContain(tenant.userId);
    expect(assignees.some((person) => person.displayName === 'Client scoped reviewer')).toBe(false);
    const id = await createFollowUp(tenant.firmId, tenant.clientId, tenant.userId, {
      title: 'Review missing statement', assigneeUserId: tenant.userId,
      dueDate: '2026-10-25', priority: 'high',
    });
    const item = (await listFollowUps(tenant.firmId, tenant.clientId)).find((row) => row.id === id);
    expect(item).toMatchObject({ assigneeUserId: tenant.userId,
      assigneeName: assignees.find((person) => person.id === tenant.userId)?.displayName,
      dueDate: '2026-10-25', priority: 'high', status: 'open' });
    await expect(listFollowUps(otherFirm.firmId, otherFirm.clientId)).resolves.toEqual([]);
  });

  it('rejects malformed dates, unsupported priority, and an assignee scoped to another client or firm', async () => {
    await expect(createFollowUp(tenant.firmId, tenant.clientId, tenant.userId,
      { title: 'Bad date', dueDate: '2026-02-30' })).rejects.toBeInstanceOf(ValidationError);
    await expect(createFollowUp(tenant.firmId, tenant.clientId, tenant.userId,
      { title: 'Bad priority', priority: 'urgent' })).rejects.toBeInstanceOf(ValidationError);
    const scopedUser = (await ownerPool.query<{ id: string }>(
      'SELECT id FROM users WHERE firm_id=$1 AND client_id=$2', [tenant.firmId, sameFirmOtherClient])).rows[0]!.id;
    await expect(createFollowUp(tenant.firmId, tenant.clientId, tenant.userId,
      { title: 'Wrong client', assigneeUserId: scopedUser })).rejects.toBeInstanceOf(ValidationError);
    await expect(createFollowUp(tenant.firmId, tenant.clientId, tenant.userId,
      { title: 'Wrong firm', assigneeUserId: otherFirm.userId })).rejects.toBeInstanceOf(ValidationError);
  });
});
