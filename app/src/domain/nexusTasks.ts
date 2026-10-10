import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';

export type NexusSpecialist = 'document' | 'banking' | 'gst' | 'tds' | 'verifier';
export type NexusTaskStatus = 'queued' | 'running' | 'verifying' | 'retry_ready' | 'completed'
  | 'blocked' | 'failed' | 'needs_human_review' | 'cancelled';
export type NexusRecordRef = { kind: 'source_document' | 'obligation' | 'bank_statement' | 'purchase_bill'; id: string };
const specialists = new Set<NexusSpecialist>(['document', 'banking', 'gst', 'tds', 'verifier']);
// These names are inert declarations today; a future worker must map them to
// read-only domain functions and must never interpret browser text as a tool.
const readCapabilities = new Set([
  'source_document.read', 'bank_statement.read', 'obligation.read', 'purchase_bill.read',
]);
const refTables: Record<NexusRecordRef['kind'], { table: string; alias: string }> = {
  source_document: { table: 'source_documents', alias: 'd' },
  obligation: { table: 'obligation_timeline_items', alias: 'd' },
  bank_statement: { table: 'bank_statements', alias: 'd' },
  purchase_bill: { table: 'purchase_bills', alias: 'd' },
};
const text = (v: unknown, max: number, label: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) {
    throw new ValidationError(`enter a valid ${label}`, 'NXT-1');
  }
  return v.trim();
};
function object(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`enter a valid ${label}`, 'NXT-1');
  return v as Record<string, unknown>;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function refs(v: unknown): NexusRecordRef[] {
  if (!Array.isArray(v) || v.length > 100) throw new ValidationError('enter valid record references', 'NXT-1');
  return v.map((raw) => {
    const item = object(raw, 'record reference');
    if (typeof item.kind !== 'string' || !(item.kind in refTables)) throw new ValidationError('record reference kind is not allowed', 'NXT-1');
    const id = text(item.id, 80, 'record reference');
    return { kind: item.kind as NexusRecordRef['kind'], id };
  });
}
async function assertClient(c: PoolClient, clientId: string): Promise<void> {
  const r = await c.query('SELECT 1 FROM clients WHERE id=$1', [clientId]);
  if (!r.rowCount) throw new ValidationError('client is unavailable', 'NXT-2');
}
async function assertRefs(c: PoolClient, clientId: string, recordRefs: NexusRecordRef[]): Promise<void> {
  for (const ref of recordRefs) {
    const { table, alias } = refTables[ref.kind];
    const found = await c.query(`SELECT 1 FROM ${table} ${alias} WHERE ${alias}.id=$1 AND ${alias}.client_id=$2`, [ref.id, clientId]);
    if (!found.rowCount) throw new ValidationError('record reference is unavailable', 'NXT-2');
  }
}
const taskSelect = `SELECT id,client_id,purpose,specialist,status,envelope_schema_version,envelope,
 checkpoint,result_schema_version,result,current_attempt,max_attempts,idempotency_key,created_at,updated_at
 FROM nexus_specialist_tasks`;
type DbTask = { id:string; client_id:string; purpose:string; specialist:NexusSpecialist; status:NexusTaskStatus;
 envelope_schema_version:number; envelope:Record<string,unknown>; checkpoint:Record<string,unknown>|null;
 result_schema_version:number|null; result:Record<string,unknown>|null; current_attempt:number; max_attempts:number;
 idempotency_key:string; created_at:Date; updated_at:Date };
function mapTask(row: DbTask) { return { id:row.id, clientId:row.client_id, purpose:row.purpose, specialist:row.specialist,
 status:row.status, envelopeSchemaVersion:row.envelope_schema_version, envelope:row.envelope, checkpoint:row.checkpoint,
 resultSchemaVersion:row.result_schema_version, result:row.result, currentAttempt:row.current_attempt, maxAttempts:row.max_attempts,
 idempotencyKey:row.idempotency_key, createdAt:row.created_at.toISOString(), updatedAt:row.updated_at.toISOString() }; }

export async function createNexusTask(args: { firmId:string; clientId:string; purpose:unknown; specialist:unknown;
 permittedReads:unknown; recordRefs:unknown; ruleVersionRefs?:unknown; checkpoint?:unknown; deadlineAt?:string|null;
 idempotencyKey:unknown }): Promise<string> {
  const purpose=text(args.purpose,1000,'purpose'), idempotencyKey=text(args.idempotencyKey,200,'idempotency key');
  if (typeof args.specialist !== 'string' || !specialists.has(args.specialist as NexusSpecialist)) throw new ValidationError('specialist is not allowed','NXT-1');
  if (!Array.isArray(args.permittedReads) || args.permittedReads.length > readCapabilities.size
    || args.permittedReads.some((x)=>typeof x!=='string'||!readCapabilities.has(x.trim()))) {
    throw new ValidationError('read capability is not allowed','NXT-1');
  }
  const permittedReads=args.permittedReads.map(x=>(x as string).trim());
  const recordRefs=refs(args.recordRefs), ruleRefs=args.ruleVersionRefs ?? [];
  if (!Array.isArray(ruleRefs) || ruleRefs.length > 50 || ruleRefs.some((x)=>typeof x!=='string'||x.length>120)) throw new ValidationError('enter valid rule references','NXT-1');
  const checkpoint=args.checkpoint == null ? null : object(args.checkpoint,'checkpoint');
  if (checkpoint && JSON.stringify(checkpoint).length > 8000) throw new ValidationError('checkpoint is too large','NXT-1');
  const deadline=args.deadlineAt ?? null;
  if (deadline !== null && (typeof deadline!=='string'||Number.isNaN(Date.parse(deadline)))) throw new ValidationError('enter a valid deadline','NXT-1');
  return withFirm(args.firmId, async c => {
    await assertClient(c,args.clientId); await assertRefs(c,args.clientId,recordRefs);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-task-key:${args.clientId}:${idempotencyKey}`]);
    const prior=await c.query<{id:string;purpose:string;specialist:string;envelope:Record<string,unknown>}>(`SELECT id,purpose,specialist,envelope FROM nexus_specialist_tasks WHERE client_id=$1 AND idempotency_key=$2`,[args.clientId,idempotencyKey]);
    if (prior.rowCount) {
      const old=prior.rows[0]!;
      if(old.purpose!==purpose||old.specialist!==args.specialist
        ||stable(old.envelope.permitted_reads)!==stable(permittedReads)
        ||stable(old.envelope.record_refs)!==stable(recordRefs)
        ||stable(old.envelope.rule_version_refs)!==stable(ruleRefs)
        ||stable(old.envelope.checkpoint)!==stable(checkpoint)
        ||(old.envelope.deadline_at??null)!==deadline) throw new ValidationError('idempotency key was already used for another task','NXT-4');
      return prior.rows[0]!.id;
    }
    const id=randomUUID();
    const envelope={schema_version:1,task_id:id,firm_id:args.firmId,client_id:args.clientId,purpose,specialist:args.specialist,
      permitted_reads:permittedReads,record_refs:recordRefs,rule_version_refs:ruleRefs,checkpoint,deadline_at:deadline,attempt_ordinal:1,retry_findings:[]};
    await c.query(`INSERT INTO nexus_specialist_tasks(id,firm_id,client_id,purpose,specialist,envelope,checkpoint,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,args.firmId,args.clientId,purpose,args.specialist,JSON.stringify(envelope),checkpoint?JSON.stringify(checkpoint):null,idempotencyKey]);
    await c.query(`INSERT INTO nexus_specialist_task_events(firm_id,client_id,task_id,event_ordinal,event_type,idempotency_key)
      VALUES($1,$2,$3,1,'created',$4)`,[args.firmId,args.clientId,id,`created:${id}`]);
    return id;
  });
}

export async function getNexusTask(firmId:string,clientId:string,taskId:string) {
  return withFirm(firmId,async c=>{
    await assertClient(c,clientId);
    const r=await c.query<DbTask>(`${taskSelect} WHERE id=$1 AND client_id=$2`,[taskId,clientId]);
    if(!r.rows[0]) return null;
    const [attempts,events]=await Promise.all([
      c.query(`SELECT id,ordinal,agent_role,model_version,input_refs,outcome,result_schema_version,result,verifier_findings,error_category,started_at,ended_at,recorded_at FROM nexus_specialist_task_attempts WHERE task_id=$1 ORDER BY ordinal`,[taskId]),
      c.query(`SELECT id,event_ordinal,event_type,attempt_id,detail,recorded_at FROM nexus_specialist_task_events WHERE task_id=$1 ORDER BY event_ordinal`,[taskId]),
    ]);
    return {...mapTask(r.rows[0]),attempts:attempts.rows,events:events.rows};
  });
}
export async function listNexusTasks(firmId:string,clientId:string,limit=50) {
  const bounded=Math.max(1,Math.min(100,Math.trunc(limit)||50));
  return withFirm(firmId,async c=>{ await assertClient(c,clientId); const r=await c.query<DbTask>(`${taskSelect} WHERE client_id=$1 ORDER BY created_at DESC,id LIMIT $2`,[clientId,bounded]); return r.rows.map(mapTask); });
}

export async function appendNexusTaskAttempt(args:{firmId:string;clientId:string;taskId:string;agentRole:unknown;modelVersion?:unknown;
 inputRefs?:unknown;outcome:unknown;resultSchemaVersion:number;result:unknown;verifierFindings?:unknown;errorCategory?:unknown;
 startedAt?:Date;endedAt?:Date;idempotencyKey:unknown}):Promise<{ordinal:number;duplicate:boolean}> {
  const key=text(args.idempotencyKey,200,'idempotency key'), role=text(args.agentRole,40,'agent role');
  if(!specialists.has(role as NexusSpecialist)) throw new ValidationError('agent role is not allowed','NXT-1');
  if(!['completed','partial','blocked','failed'].includes(String(args.outcome))) throw new ValidationError('attempt outcome is not allowed','NXT-1');
  const result=object(args.result,'result');
  if(!Number.isInteger(args.resultSchemaVersion)||args.resultSchemaVersion<1) throw new ValidationError('enter a valid result schema version','NXT-1');
  const inputRefs=refs(args.inputRefs ?? []), findings=args.verifierFindings ?? [];
  if(!Array.isArray(findings)||findings.length>100) throw new ValidationError('enter valid verifier findings','NXT-1');
  const startedAt=args.startedAt??new Date(),endedAt=args.endedAt??new Date();
  if(!(startedAt instanceof Date)||!(endedAt instanceof Date)||Number.isNaN(startedAt.getTime())||Number.isNaN(endedAt.getTime())||endedAt<startedAt) throw new ValidationError('enter valid attempt times','NXT-1');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId); await assertRefs(c,args.clientId,inputRefs);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-task:${args.taskId}`]);
    const task=await c.query<{current_attempt:number;max_attempts:number;status:string;specialist:string;envelope:Record<string,unknown>}>(`SELECT current_attempt,max_attempts,status,specialist,envelope FROM nexus_specialist_tasks WHERE id=$1 AND client_id=$2`,[args.taskId,args.clientId]);
    if(!task.rowCount) throw new ValidationError('task is unavailable','NXT-2');
    if(task.rows[0]!.specialist!==role&&role!=='verifier') throw new ValidationError('attempt role does not match task specialist','NXT-1');
    const allowedRefs=task.rows[0]!.envelope.record_refs as NexusRecordRef[];
    if(inputRefs.some(ref=>!allowedRefs.some(allowed=>allowed.kind===ref.kind&&allowed.id===ref.id))) throw new ValidationError('attempt input is outside the task envelope','NXT-1');
    const duplicate=await c.query<{ordinal:number;task_id:string;outcome:string}>(`SELECT ordinal,task_id,outcome FROM nexus_specialist_task_attempts WHERE client_id=$1 AND idempotency_key=$2`,[args.clientId,key]);
    if(duplicate.rowCount){ if(duplicate.rows[0]!.task_id!==args.taskId||duplicate.rows[0]!.outcome!==args.outcome) throw new ValidationError('idempotency key was already used for another attempt','NXT-4'); return {ordinal:duplicate.rows[0]!.ordinal,duplicate:true}; }
    const ordinal=task.rows[0]!.current_attempt+1;
    if(ordinal>task.rows[0]!.max_attempts) throw new ValidationError('task attempt budget is exhausted','NXT-3');
    const attempt=await c.query<{id:string}>(`INSERT INTO nexus_specialist_task_attempts(firm_id,client_id,task_id,ordinal,agent_role,model_version,input_refs,outcome,result_schema_version,result,verifier_findings,error_category,started_at,ended_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[
      args.firmId,args.clientId,args.taskId,ordinal,role,args.modelVersion==null?null:text(args.modelVersion,160,'model version'),JSON.stringify(inputRefs),args.outcome,args.resultSchemaVersion,JSON.stringify(result),JSON.stringify(findings),args.errorCategory==null?null:text(args.errorCategory,80,'error category'),startedAt,endedAt,key]);
    const attemptId=attempt.rows[0]!.id;
    const count=await c.query<{n:number}>(`SELECT COALESCE(max(event_ordinal),0)+1 AS n FROM nexus_specialist_task_events WHERE task_id=$1`,[args.taskId]);
    await c.query(`INSERT INTO nexus_specialist_task_events(firm_id,client_id,task_id,event_ordinal,event_type,attempt_id,detail,idempotency_key)
      VALUES($1,$2,$3,$4,'attempt_recorded',$5,$6,$7)`,[args.firmId,args.clientId,args.taskId,count.rows[0]!.n,attemptId,JSON.stringify({ordinal,outcome:args.outcome}),`attempt:${attemptId}`]);
    const nextStatus: NexusTaskStatus=ordinal===4&&args.outcome!=='completed'?'needs_human_review':args.outcome==='completed'?'verifying':args.outcome==='partial'||args.outcome==='blocked'?'retry_ready':'failed';
    const checkpoint=(args.result as Record<string,unknown>).checkpoint;
    await c.query(`UPDATE nexus_specialist_tasks SET current_attempt=$1,status=$2,checkpoint=COALESCE($3,checkpoint),result_schema_version=$4,result=$5,updated_at=now() WHERE id=$6 AND client_id=$7`,
      [ordinal,nextStatus,checkpoint&&typeof checkpoint==='object'?JSON.stringify(checkpoint):null,args.resultSchemaVersion,JSON.stringify(result),args.taskId,args.clientId]);
    return {ordinal,duplicate:false};
  });
}
