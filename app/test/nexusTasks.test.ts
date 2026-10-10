import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant,type SeededTenant } from '../src/seed/index.ts';
import { appPool,ownerPool,withFirm,closePools } from '../src/db/pool.ts';
import { appendNexusTaskAttempt,createNexusTask,getNexusTask,listNexusTasks,readNexusTaskRecord,transitionNexusTaskStatus } from '../src/domain/nexusTasks.ts';
import { listFollowUps } from '../src/domain/followUps.ts';
import { ValidationError } from '../src/domain/types.ts';

let tenant:SeededTenant; let other:SeededTenant; let sourceId:string;
const base=(clientId:string,key:string)=>({firmId:tenant.firmId,clientId,requestedByUserId:tenant.userId,purpose:'Review synthetic source references',specialist:'document',
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
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running',expectedStatus:'queued'});
    await expect(appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',
      inputRefs:[{kind:'source_document',id:sourceId}],outcome:'partial',resultSchemaVersion:1,result:{proposal:'advisory'},idempotencyKey:'attempt-out-of-scope'})).rejects.toBeInstanceOf(ValidationError);
    const append=(key:string)=>appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',
      outcome:'partial',resultSchemaVersion:1,result:{proposal:'advisory only'},idempotencyKey:key});
    const concurrent=await Promise.allSettled([append('attempt-a'),append('attempt-b')]);
    expect(concurrent.filter(x=>x.status==='fulfilled').map(x=>x.status==='fulfilled'?x.value.ordinal:0)).toEqual([1]);
    expect(concurrent.filter(x=>x.status==='rejected')).toHaveLength(1);
    expect(await append('attempt-a')).toEqual({ordinal:1,duplicate:true});
    for(const key of ['attempt-c','attempt-d','attempt-e']) {
      await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'retry_ready'});
      await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running'});
      await append(key);
    }
    await expect(append('attempt-f')).rejects.toBeInstanceOf(ValidationError);
    const rows=await withFirm(tenant.firmId,c=>c.query<{ordinal:number}>(`SELECT ordinal FROM nexus_specialist_task_attempts WHERE task_id=$1 ORDER BY ordinal`,[id]));
    expect(rows.rows.map(r=>r.ordinal)).toEqual([1,2,3,4]);
    const task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.status).toBe('needs_human_review'); expect(task?.currentAttempt).toBe(4);
  });

  it('keeps attempt and event history immutable and tenant isolated',async()=>{
    const id=await createNexusTask(base(tenant.clientId,'task-immutable'));
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running'});
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'completed',resultSchemaVersion:1,result:{proposal:'advisory'},idempotencyKey:'attempt-immutable'});
    let task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.events.map((event:{event_type:string})=>event.event_type)).toEqual(['created','status_changed','attempt_recorded','status_changed']);
    expect(task?.events[1]?.detail).toMatchObject({from_status:'queued',to_status:'running'});
    expect(task?.events[3]?.detail).toMatchObject({from_status:'running',to_status:'verifying'});
    // Even a direct status projection write by the application role is audited
    // by the database trigger in the same transaction.
    await withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_tasks SET status='blocked' WHERE id=$1`,[id]));
    task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.events.at(-1)).toMatchObject({event_type:'status_changed',detail:{from_status:'verifying',to_status:'blocked'}});
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_task_attempts SET outcome='failed' WHERE task_id=$1`,[id]))).rejects.toThrow();
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_task_events SET detail='{}'::jsonb WHERE task_id=$1`,[id]))).rejects.toThrow();
    await expect(withFirm(tenant.firmId,c=>c.query(`DELETE FROM nexus_specialist_task_events WHERE task_id=$1`,[id]))).rejects.toThrow();
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_tasks SET status='completed' WHERE id=$1`,[id]))).rejects.toThrow(/invalid Nexus task transition/);
    const hidden=await withFirm(other.firmId,c=>c.query(`SELECT id FROM nexus_specialist_task_attempts WHERE task_id=$1`,[id]));
    expect(hidden.rowCount).toBe(0);
    const noDirectInsert=await appPool.query(`SELECT has_table_privilege(current_user,'nexus_specialist_task_attempts','UPDATE') AS can_update`);
    expect(noDirectInsert.rows[0]?.can_update).toBe(false);
  });

  it('links retries to findings from the latest verifier attempt',async()=>{
    const id=await createNexusTask(base(tenant.clientId,'task-finding-links'));
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running'});
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'partial',resultSchemaVersion:1,result:{proposal:'needs review'},idempotencyKey:'finding-specialist-1'});
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'verifier',outcome:'completed',resultSchemaVersion:1,result:{decision:'retry'},verificationDecision:'retry',verifierFindings:[{summary:'Missing supporting source',severity:'review',claim_ref:'proposal'}],idempotencyKey:'finding-verifier-1'});
    const reviewed=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(reviewed?.status).toBe('retry_ready');
    const findingId=(reviewed?.attempts[1]?.verifier_findings as Array<{finding_id:string}>)[0]!.finding_id;
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'retry_ready'});
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running'});
    await expect(appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'partial',resultSchemaVersion:1,result:{proposal:'retry'},addressesFindingIds:[randomUUID()],idempotencyKey:'finding-retry-bad-ref'})).rejects.toBeInstanceOf(ValidationError);
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'partial',resultSchemaVersion:1,result:{proposal:'retry'},addressesFindingIds:[findingId],idempotencyKey:'finding-retry-1'});
    const final=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(final?.attempts[2]?.addressed_findings).toEqual([findingId]);
  });

  it('enforces task read capabilities, references, and client scope',async()=>{
    const ref={kind:'source_document',id:sourceId};
    const id=await createNexusTask({...base(tenant.clientId,'task-scoped-read'),recordRefs:[ref]});
    const read=await readNexusTaskRecord({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,capability:'source_document.read',recordRef:ref});
    expect(read).toMatchObject({kind:'source_document',id:sourceId,data:{id:sourceId,channel:'upload'}});
    expect(read.data).not.toHaveProperty('original_blob_uri');
    expect(read.data).not.toHaveProperty('sha256');
    await expect(readNexusTaskRecord({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,capability:'purchase_bill.read',recordRef:ref})).rejects.toBeInstanceOf(ValidationError);
    await expect(readNexusTaskRecord({firmId:other.firmId,clientId:other.clientId,taskId:id,capability:'source_document.read',recordRef:ref})).rejects.toBeInstanceOf(ValidationError);
    await expect(createNexusTask({...base(tenant.clientId,'task-wrong-capability'),permittedReads:['bank_statement.read']})).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires verifier acceptance before a task can complete',async()=>{
    const id=await createNexusTask(base(tenant.clientId,'task-verifier-accept'));
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running'});
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'completed',resultSchemaVersion:1,result:{proposal:'supported'},idempotencyKey:'accept-specialist'});
    await expect(withFirm(tenant.firmId,c=>c.query(`UPDATE nexus_specialist_tasks SET status='completed' WHERE id=$1`,[id]))).rejects.toThrow(/requires verifier acceptance/);
    await expect(appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'verifier',outcome:'completed',resultSchemaVersion:1,result:{decision:'accepted'},verificationDecision:'accepted',verifierFindings:[{summary:'Unresolved issue'}],idempotencyKey:'accept-with-finding'})).rejects.toBeInstanceOf(ValidationError);
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'verifier',outcome:'completed',resultSchemaVersion:1,result:{decision:'accepted'},verificationDecision:'accepted',idempotencyKey:'accept-clean'});
    const task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    expect(task?.status).toBe('completed');
    await expect(transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'completed'})).resolves.toMatchObject({status:'completed',duplicate:true});
  });

  it('creates one system-attributed review follow-up on a critical verifier finding',async()=>{
    const id=await createNexusTask(base(tenant.clientId,'task-escalation-followup'));
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,toStatus:'running'});
    await appendNexusTaskAttempt({firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'document',outcome:'partial',resultSchemaVersion:1,result:{proposal:'uncertain'},idempotencyKey:'escalate-specialist'});
    const args={firmId:tenant.firmId,clientId:tenant.clientId,taskId:id,agentRole:'verifier',outcome:'completed',resultSchemaVersion:1,result:{decision:'needs_human_review'},verificationDecision:'needs_human_review',verifierFindings:[{summary:'Conflicting source evidence',severity:'critical'}],idempotencyKey:'escalate-verifier'};
    await appendNexusTaskAttempt(args);
    await appendNexusTaskAttempt(args);
    const task=await getNexusTask(tenant.firmId,tenant.clientId,id);
    const followUps=await listFollowUps(tenant.firmId,tenant.clientId);
    const linked=followUps.filter(item=>item.sourceNexusTaskId===id);
    expect(task?.status).toBe('needs_human_review');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({priority:'high',createdBy:tenant.userId});
    expect(linked[0]?.history[0]).toMatchObject({eventType:'system_created',actorName:'Nexus'});
    const alerts=await withFirm(tenant.firmId,c=>c.query(`SELECT id FROM nexus_alert_events WHERE client_id=$1 AND dedupe_key=$2`,[tenant.clientId,`nexus_task:${id}:needs_human_review`]));
    expect(alerts.rowCount).toBe(1);
  });
});
