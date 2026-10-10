import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant,type SeededTenant } from '../src/seed/index.ts';
import { appPool,ownerPool,withFirm,closePools } from '../src/db/pool.ts';
import { appendNexusTaskAttempt,createNexusTask,getNexusTask,listNexusTasks } from '../src/domain/nexusTasks.ts';
import { ValidationError } from '../src/domain/types.ts';

let tenant:SeededTenant; let other:SeededTenant; let sourceId:string;
const base=(clientId:string,key:string)=>({firmId:tenant.firmId,clientId,purpose:'Review synthetic source references',specialist:'document',
  permittedReads:['source_document.read'],recordRefs:[],idempotencyKey:key});
beforeAll(async()=>{
  const tag=randomUUID().slice(0,8);
  tenant=await seedTenant({firmName:`Nexus task ${tag}`,clientName:`Task client ${tag}`,userEmail:`task-${tag}@example.test`,startYear:2026,pan:'AAACP1111P',businessType:'general'});
  other=await seedTenant({firmName:`Nexus other ${tag}`,clientName:`Other client ${tag}`,userEmail:`task-other-${tag}@example.test`,startYear:2026,pan:'AAACQ2222Q',businessType:'general'});
  sourceId=(await ownerPool.query<{id:string}>(`INSERT INTO source_documents(firm_id,client_id,channel,original_blob_uri,sha256) VALUES($1,$2,'upload','synthetic://source','synthetic-hash') RETURNING id`,[tenant.firmId,tenant.clientId])).rows[0]!.id;
});
afterAll(async()=>closePools());

describe('Nexus specialist task records',()=>{
  it('creates a scoped versioned envelope idempotently and validates record references',async()=>{
    const args={...base(tenant.clientId,'task-create-idem'),recordRefs:[{kind:'source_document',id:sourceId}]};
    await expect(createNexusTask({...args,idempotencyKey:'task-write-cap',permittedReads:['source_document.write']})).rejects.toBeInstanceOf(ValidationError);
    await expect(createNexusTask({...args,idempotencyKey:'task-unknown-cap',permittedReads:['arbitrary.execute']})).rejects.toBeInstanceOf(ValidationError);
    const id=await createNexusTask(args); expect(await createNexusTask(args)).toBe(id);
    await expect(createNexusTask({...args,purpose:'different purpose'})).rejects.toBeInstanceOf(ValidationError);
    const task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.envelope).toMatchObject({schema_version:1,task_id:id,firm_id:tenant.firmId,client_id:tenant.clientId,attempt_ordinal:1});
    expect((await listNexusTasks(tenant.firmId,tenant.clientId)).map(x=>x.id)).toContain(id);
    expect(await listNexusTasks(other.firmId,other.clientId)).toEqual([]);
    await expect(createNexusTask({...base(tenant.clientId,'task-bad-ref'),recordRefs:[{kind:'source_document',id:randomUUID()}]})).rejects.toBeInstanceOf(ValidationError);
    await expect(getNexusTask(other.firmId,other.clientId,id)).resolves.toBeNull();
  });

  it('serializes concurrent appends, deduplicates keys, and enforces the four-attempt budget',async()=>{
    const id=await createNexusTask(base(tenant.clientId,'task-concurrency'));
    await expect(appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',
      inputRefs:[{kind:'source_document',id:sourceId}],outcome:'partial',resultSchemaVersion:1,result:{proposal:'advisory'},idempotencyKey:'attempt-out-of-scope'})).rejects.toBeInstanceOf(ValidationError);
    const append=(key:string)=>appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',
      outcome:'partial',resultSchemaVersion:1,result:{proposal:'advisory only'},idempotencyKey:key});
    const concurrent=await Promise.all([append('attempt-a'),append('attempt-b')]);
    expect(concurrent.map(x=>x.ordinal).sort()).toEqual([1,2]);
    expect(await append('attempt-a')).toEqual({ordinal:1,duplicate:true});
    await append('attempt-c'); await append('attempt-d');
    await expect(append('attempt-e')).rejects.toBeInstanceOf(ValidationError);
    const rows=await withFirm(tenant.firmId,c=>c.query<{ordinal:number}>(`SELECT ordinal FROM nexus_specialist_task_attempts WHERE task_id=$1 ORDER BY ordinal`,[id]));
    expect(rows.rows.map(r=>r.ordinal)).toEqual([1,2,3,4]);
    const task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.status).toBe('needs_human_review'); expect(task?.currentAttempt).toBe(4);
  });

  it('keeps attempt and event history immutable and tenant isolated',async()=>{
    const id=await createNexusTask(base(tenant.clientId,'task-immutable'));
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'completed',resultSchemaVersion:1,result:{proposal:'advisory'},idempotencyKey:'attempt-immutable'});
    let task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.events.map((event:{event_type:string})=>event.event_type)).toEqual(['created','attempt_recorded','status_changed']);
    expect(task?.events[2]?.detail).toMatchObject({from_status:'queued',to_status:'verifying'});
    // Even a direct status projection write by the application role is audited
    // by the database trigger in the same transaction.
    await withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_tasks SET status='blocked' WHERE id=$1`,[id]));
    task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.events.at(-1)).toMatchObject({event_type:'status_changed',detail:{from_status:'verifying',to_status:'blocked'}});
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_task_attempts SET outcome='failed' WHERE task_id=$1`,[id]))).rejects.toThrow();
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_task_events SET detail='{}'::jsonb WHERE task_id=$1`,[id]))).rejects.toThrow();
    await expect(withFirm(tenant.firmId,c=>c.query(`DELETE FROM nexus_specialist_task_events WHERE task_id=$1`,[id]))).rejects.toThrow();
    const hidden=await withFirm(other.firmId,c=>c.query(`SELECT id FROM nexus_specialist_task_attempts WHERE task_id=$1`,[id]));
    expect(hidden.rowCount).toBe(0);
    const noDirectInsert=await appPool.query(`SELECT has_table_privilege(current_user,'nexus_specialist_task_attempts','UPDATE') AS can_update`);
    expect(noDirectInsert.rows[0]?.can_update).toBe(false);
  });
});
