import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedTenant,type SeededTenant } from '../src/seed/index.ts';
import { closePools,ownerPool } from '../src/db/pool.ts';
import { createNexusTask,getNexusTask,setNexusTaskAiEnabled } from '../src/domain/nexusTasks.ts';
import { runNexusTask } from '../src/domain/nexusTaskRunner.ts';
import type { LlmClient } from '../src/parse/llmTable.ts';

let tenant:SeededTenant; let sourceId:string;
beforeAll(async()=>{
  const tag=randomUUID().slice(0,8);
  tenant=await seedTenant({firmName:`Nexus runner ${tag}`,clientName:`Runner client ${tag}`,userEmail:`runner-${tag}@example.test`,startYear:2026,pan:'AAACP3333P',businessType:'general'});
  sourceId=(await ownerPool.query<{id:string}>(`INSERT INTO source_documents(firm_id,client_id,channel,original_blob_uri,sha256) VALUES($1,$2,'upload','synthetic://runner','runner-hash') RETURNING id`,[tenant.firmId,tenant.clientId])).rows[0]!.id;
});
afterAll(async()=>closePools());

describe('Nexus task runner',()=>{
  it('requires separate firm consent, then records specialist and verifier decisions',async()=>{
    const taskId=await createNexusTask({firmId:tenant.firmId,clientId:tenant.clientId,requestedByUserId:tenant.userId,
      purpose:'Summarize the received document metadata',specialist:'document',permittedReads:['source_document.read'],
      recordRefs:[{kind:'source_document',id:sourceId}],idempotencyKey:`runner-${randomUUID()}`});
    let calls=0;
    const llm:LlmClient={provider:'test',model:'fixture-v1',async complete(system,user){
      calls++;
      if(system.includes('independent Nexus verifier')) return JSON.stringify({decision:'accepted',summary:'Claims match the scoped metadata.',findings:[]});
      return JSON.stringify({schema_version:1,status:'completed',summary:'The document was received by upload.',
        claims:[{claim:'The channel is upload.',evidence:[{kind:'source_document',id:sourceId,quote:'"channel":"upload"'}]}],
        assumptions:[],questions:[],next_human_action:'Review the original document.',addresses_findings:[],checkpoint:null});
    }};
    await expect(runNexusTask({firmId:tenant.firmId,clientId:tenant.clientId,taskId,llm})).rejects.toThrow(/Enable Nexus specialist tasks/);
    expect(calls).toBe(0);
    await setNexusTaskAiEnabled(tenant.firmId,tenant.userId,true,'test','fixture-v1');
    await expect(runNexusTask({firmId:tenant.firmId,clientId:tenant.clientId,taskId,llm})).resolves.toMatchObject({status:'completed',specialistRuns:1,totalAttempts:2});
    expect(calls).toBe(2);
    const saved=await getNexusTask(tenant.firmId,tenant.clientId,taskId);
    expect(saved?.attempts.map((attempt:{agent_role:string})=>attempt.agent_role)).toEqual(['document','verifier']);
    expect(saved?.attempts[1]).toMatchObject({verification_decision:'accepted',verifier_findings:[]});
  });

  it('does not let a second invocation join a task already running',async()=>{
    await setNexusTaskAiEnabled(tenant.firmId,tenant.userId,true,'test','fixture-v1');
    const taskId=await createNexusTask({firmId:tenant.firmId,clientId:tenant.clientId,requestedByUserId:tenant.userId,
      purpose:'Do not execute twice',specialist:'document',permittedReads:['source_document.read'],
      recordRefs:[{kind:'source_document',id:sourceId}],idempotencyKey:`runner-running-${randomUUID()}`});
    const { transitionNexusTaskStatus }=await import('../src/domain/nexusTasks.ts');
    await transitionNexusTaskStatus({firmId:tenant.firmId,clientId:tenant.clientId,taskId,toStatus:'running',expectedStatus:'queued'});
    let calls=0;
    const llm:LlmClient={provider:'test',model:'fixture-v1',async complete(){calls++;return '{}';}};
    await expect(runNexusTask({firmId:tenant.firmId,clientId:tenant.clientId,taskId,llm})).rejects.toThrow(/cannot start/);
    expect(calls).toBe(0);
  });
});
