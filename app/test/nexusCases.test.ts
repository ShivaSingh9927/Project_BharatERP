import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant,type SeededTenant } from '../src/seed/index.ts';
import { withFirm,closePools } from '../src/db/pool.ts';
import { appendNexusCaseMessage,appendNexusCaseState,attachNexusCaseSource,createNexusCase,getNexusCase,getNexusCaseMessageByKey,listNexusCaseMessages,listNexusCaseSources,listNexusCases } from '../src/domain/nexusCases.ts';
import { createNexusTask } from '../src/domain/nexusTasks.ts';
import { ValidationError } from '../src/domain/types.ts';

let tenant:SeededTenant; let other:SeededTenant;
const make=(clientId:string,key:string,title='Review bank activity')=>({firmId:tenant.firmId,clientId,title,requestedByUserId:tenant.userId,idempotencyKey:key});
beforeAll(async()=>{
  const tag=randomUUID().slice(0,8);
  tenant=await seedTenant({firmName:`Nexus cases ${tag}`,clientName:`Case client ${tag}`,userEmail:`case-${tag}@example.test`,startYear:2026,pan:'AAACP1111P',businessType:'general'});
  other=await seedTenant({firmName:`Nexus cases other ${tag}`,clientName:`Other case ${tag}`,userEmail:`case-other-${tag}@example.test`,startYear:2026,pan:'AAACQ2222Q',businessType:'general'});
});
afterAll(async()=>closePools());

describe('Nexus durable cases',()=>{
  it('creates idempotently, lists and reads only the selected tenant, with no ledger writes',async()=>{
    const before=await withFirm(tenant.firmId,c=>c.query<{count:string}>('SELECT count(*)::text AS count FROM ledger_entries WHERE client_id=$1',[tenant.clientId]));
    const args=make(tenant.clientId,'case-create');
    const id=await createNexusCase(args);
    expect(await createNexusCase(args)).toBe(id);
    await expect(createNexusCase({...args,title:'Different request'})).rejects.toBeInstanceOf(ValidationError);
    expect((await getNexusCase(tenant.firmId,tenant.clientId,id))?.state).toBe('open');
    expect((await listNexusCases(tenant.firmId,tenant.clientId)).map(row=>row.id)).toContain(id);
    expect(await getNexusCase(other.firmId,other.clientId,id)).toBeNull();
    expect(await listNexusCases(other.firmId,other.clientId)).toEqual([]);
    const after=await withFirm(tenant.firmId,c=>c.query<{count:string}>('SELECT count(*)::text AS count FROM ledger_entries WHERE client_id=$1',[tenant.clientId]));
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('validates and serializes state events, deduplicates retries, and keeps history append-only',async()=>{
    const id=await createNexusCase(make(tenant.clientId,'case-state'));
    const event={firmId:tenant.firmId,clientId:tenant.clientId,caseId:id,actorUserId:tenant.userId,toState:'working',idempotencyKey:'case-working'};
    await expect(appendNexusCaseState({...event,toState:'completed'})).rejects.toThrow(/cannot transition/);
    await expect(appendNexusCaseState({...event,toState:'bogus'})).rejects.toBeInstanceOf(ValidationError);
    await expect(appendNexusCaseState(event)).resolves.toEqual({state:'working',duplicate:false});
    await expect(appendNexusCaseState(event)).resolves.toEqual({state:'working',duplicate:true});
    await expect(appendNexusCaseState({...event,toState:'blocked',idempotencyKey:'case-working'})).rejects.toBeInstanceOf(ValidationError);
    await appendNexusCaseState({...event,toState:'needs_user',idempotencyKey:'case-needs-user'});
    const item=await getNexusCase(tenant.firmId,tenant.clientId,id);
    expect(item?.state).toBe('needs_user');
    expect(item?.events.map((row:{event_type:string})=>row.event_type)).toEqual(['created','state_changed','state_changed']);
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_case_events SET to_state='blocked' WHERE case_id=$1`,[id]))).rejects.toThrow(/append-only|permission denied/);
    await expect(withFirm(tenant.firmId,c=>c.query(`DELETE FROM nexus_case_events WHERE case_id=$1`,[id]))).rejects.toThrow(/append-only|permission denied/);
    const hidden=await withFirm(other.firmId,c=>c.query(`SELECT id FROM nexus_case_events WHERE case_id=$1`,[id]));
    expect(hidden.rowCount).toBe(0);
  });

  it('persists append-only attributed messages idempotently and rejects cross-client reads',async()=>{
    const id=await createNexusCase(make(tenant.clientId,'case-messages'));
    const blocks={schema_version:1,generated_at:'2026-10-10T00:00:00.000Z',blocks:[{id:'summary',type:'paragraph',text:'Two lines reviewed.',provenance:{as_of:'2026-10-10T00:00:00.000Z',sources:[{kind:'bank_statement',id:randomUUID(),label:'Statement'}],coverage:{scope:'HDFC · October',completeness:'complete',limitations:[]}}}]};
    const fingerprint='a'.repeat(64);
    const args={firmId:tenant.firmId,clientId:tenant.clientId,caseId:id,actorType:'nexus' as const,body:'Two lines reviewed.',responseBlocks:blocks,requestFingerprint:fingerprint,idempotencyKey:'message-1'};
    const first=await appendNexusCaseMessage(args);
    expect((await appendNexusCaseMessage(args)).duplicate).toBe(true);
    await expect(appendNexusCaseMessage({...args,body:'different'})).rejects.toBeInstanceOf(ValidationError);
    await expect(appendNexusCaseMessage({...args,responseBlocks:{schema_version:1},idempotencyKey:'invalid-blocks'})).rejects.toThrow();
    const messages=await listNexusCaseMessages(tenant.firmId,tenant.clientId,id);
    expect(messages.map(m=>m.id)).toEqual([first.id]);
    expect(messages[0]?.response_blocks?.blocks[0]?.type).toBe('paragraph');
    const saved=await getNexusCaseMessageByKey(tenant.firmId,tenant.clientId,'message-1');
    expect(saved).toMatchObject({case_id:id,request_fingerprint:fingerprint,response_blocks:blocks});
    await expect(appendNexusCaseMessage({...args,requestFingerprint:'b'.repeat(64)})).rejects.toThrow(/idempotency key/);
    expect(await listNexusCaseMessages(other.firmId,other.clientId,id)).toEqual([]);
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_case_messages SET body='rewritten' WHERE id=$1`,[first.id]))).rejects.toThrow(/append-only|permission denied/);
    await expect(withFirm(tenant.firmId,c=>c.query(`DELETE FROM nexus_case_messages WHERE id=$1`,[first.id]))).rejects.toThrow(/append-only|permission denied/);
  });

  it('attaches only validated same-client source records and deduplicates links',async()=>{
    const id=await createNexusCase(make(tenant.clientId,'case-sources'));
    const taskId=await createNexusTask({firmId:tenant.firmId,clientId:tenant.clientId,requestedByUserId:tenant.userId,purpose:'Synthetic case evidence',specialist:'document',permittedReads:['source_document.read'],recordRefs:[],idempotencyKey:'case-source-task'});
    const args={firmId:tenant.firmId,clientId:tenant.clientId,caseId:id,sourceKind:'specialist_task' as const,sourceId:taskId,label:'Document review task',attachedByUserId:tenant.userId,idempotencyKey:'case-source-1'};
    const link=await attachNexusCaseSource(args);
    expect((await attachNexusCaseSource(args)).duplicate).toBe(true);
    expect(await listNexusCaseSources(tenant.firmId,tenant.clientId,id)).toMatchObject([{id:link.id,source_kind:'specialist_task',source_id:taskId}]);
    await expect(attachNexusCaseSource({...args,sourceId:randomUUID(),idempotencyKey:'case-source-invalid'})).rejects.toThrow();
    await expect(attachNexusCaseSource({...args,sourceKind:'unknown' as never,idempotencyKey:'case-source-kind'})).rejects.toBeInstanceOf(ValidationError);
    await expect(attachNexusCaseSource({...args,firmId:other.firmId,clientId:other.clientId,attachedByUserId:other.userId,idempotencyKey:'case-source-cross-firm'})).rejects.toThrow();
    expect(await listNexusCaseSources(other.firmId,other.clientId,id)).toEqual([]);
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_case_source_refs SET label='rewrite' WHERE id=$1`,[link.id]))).rejects.toThrow(/append-only|permission denied/);
  });
});
