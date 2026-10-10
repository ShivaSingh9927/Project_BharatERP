import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';

export type NexusSpecialist = 'document' | 'banking' | 'gst' | 'tds' | 'verifier';
export type NexusTaskStatus = 'queued' | 'running' | 'verifying' | 'retry_ready' | 'completed'
  | 'blocked' | 'failed' | 'needs_human_review' | 'cancelled';
export type NexusVerificationDecision = 'accepted' | 'retry' | 'needs_human_review';
export type NexusRecordRef = { kind: 'source_document' | 'obligation' | 'bank_statement' | 'purchase_bill'; id: string };
const specialists = new Set<NexusSpecialist>(['document', 'banking', 'gst', 'tds', 'verifier']);
const taskTransitions: Record<NexusTaskStatus, ReadonlySet<NexusTaskStatus>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['verifying', 'retry_ready', 'blocked', 'failed', 'needs_human_review', 'cancelled']),
  verifying: new Set(['completed', 'retry_ready', 'blocked', 'failed', 'needs_human_review', 'cancelled']),
  retry_ready: new Set(['running', 'needs_human_review', 'cancelled']),
  blocked: new Set(['retry_ready', 'needs_human_review', 'cancelled']),
  failed: new Set(['retry_ready', 'needs_human_review', 'cancelled']),
  needs_human_review: new Set(['cancelled']),
  completed: new Set(),
  cancelled: new Set(),
};
// These names are inert declarations today; a future worker must map them to
// read-only domain functions and must never interpret browser text as a tool.
const readCapabilities = new Set([
  'source_document.read', 'bank_statement.read', 'obligation.read', 'purchase_bill.read',
]);
const specialistCapabilities: Record<NexusSpecialist, ReadonlySet<string>> = {
  document: new Set(['source_document.read', 'purchase_bill.read']),
  banking: new Set(['bank_statement.read', 'obligation.read']),
  gst: new Set(['obligation.read', 'purchase_bill.read']),
  tds: new Set(['obligation.read', 'purchase_bill.read', 'bank_statement.read']),
  verifier: readCapabilities,
};
const kindCapability: Record<NexusRecordRef['kind'], string> = {
  source_document: 'source_document.read', bank_statement: 'bank_statement.read',
  obligation: 'obligation.read', purchase_bill: 'purchase_bill.read',
};
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
 checkpoint,result_schema_version,result,current_attempt,max_attempts,idempotency_key,requested_by,created_at,updated_at
 FROM nexus_specialist_tasks`;
type DbTask = { id:string; client_id:string; purpose:string; specialist:NexusSpecialist; status:NexusTaskStatus;
 envelope_schema_version:number; envelope:Record<string,unknown>; checkpoint:Record<string,unknown>|null;
 result_schema_version:number|null; result:Record<string,unknown>|null; current_attempt:number; max_attempts:number;
 idempotency_key:string; requested_by:string|null; created_at:Date; updated_at:Date };
function mapTask(row: DbTask) { return { id:row.id, clientId:row.client_id, purpose:row.purpose, specialist:row.specialist,
 status:row.status, envelopeSchemaVersion:row.envelope_schema_version, envelope:row.envelope, checkpoint:row.checkpoint,
 resultSchemaVersion:row.result_schema_version, result:row.result, currentAttempt:row.current_attempt, maxAttempts:row.max_attempts,
 idempotencyKey:row.idempotency_key, requestedByUserId:row.requested_by,
 createdAt:row.created_at.toISOString(), updatedAt:row.updated_at.toISOString() }; }

export async function createNexusTask(args: { firmId:string; clientId:string; purpose:unknown; specialist:unknown;
 requestedByUserId:unknown;
 permittedReads:unknown; recordRefs:unknown; ruleVersionRefs?:unknown; checkpoint?:unknown; deadlineAt?:string|null;
 idempotencyKey:unknown }): Promise<string> {
  const purpose=text(args.purpose,1000,'purpose'), idempotencyKey=text(args.idempotencyKey,200,'idempotency key');
  const requestedByUserId=text(args.requestedByUserId,80,'requesting user');
  if (typeof args.specialist !== 'string' || !specialists.has(args.specialist as NexusSpecialist)) throw new ValidationError('specialist is not allowed','NXT-1');
  if (!Array.isArray(args.permittedReads) || args.permittedReads.length > readCapabilities.size
    || args.permittedReads.some((x)=>typeof x!=='string'||!readCapabilities.has(x.trim())
      ||!specialistCapabilities[args.specialist as NexusSpecialist].has(x.trim()))) {
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
    const requester=await c.query(`SELECT 1 FROM users WHERE id=$1 AND firm_id=$2 AND (client_id IS NULL OR client_id=$3)`,[requestedByUserId,args.firmId,args.clientId]);
    if(!requester.rowCount) throw new ValidationError('requesting user is unavailable for this client','NXT-2');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-task-key:${args.clientId}:${idempotencyKey}`]);
    const prior=await c.query<{id:string;purpose:string;specialist:string;requested_by:string|null;envelope:Record<string,unknown>}>(`SELECT id,purpose,specialist,requested_by,envelope FROM nexus_specialist_tasks WHERE client_id=$1 AND idempotency_key=$2`,[args.clientId,idempotencyKey]);
    if (prior.rowCount) {
      const old=prior.rows[0]!;
      if(old.purpose!==purpose||old.specialist!==args.specialist||old.requested_by!==requestedByUserId
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
    await c.query(`INSERT INTO nexus_specialist_tasks(id,firm_id,client_id,purpose,specialist,envelope,checkpoint,idempotency_key,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,args.firmId,args.clientId,purpose,args.specialist,JSON.stringify(envelope),checkpoint?JSON.stringify(checkpoint):null,idempotencyKey,requestedByUserId]);
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
      c.query(`SELECT id,ordinal,agent_role,model_version,input_refs,outcome,result_schema_version,result,verifier_findings,addressed_findings,verification_decision,error_category,started_at,ended_at,recorded_at FROM nexus_specialist_task_attempts WHERE task_id=$1 ORDER BY ordinal`,[taskId]),
      c.query(`SELECT id,event_ordinal,event_type,attempt_id,detail,recorded_at FROM nexus_specialist_task_events WHERE task_id=$1 ORDER BY event_ordinal`,[taskId]),
    ]);
    return {...mapTask(r.rows[0]),attempts:attempts.rows,events:events.rows};
  });
}
export async function listNexusTasks(firmId:string,clientId:string,limit=50) {
  const bounded=Math.max(1,Math.min(100,Math.trunc(limit)||50));
  return withFirm(firmId,async c=>{ await assertClient(c,clientId); const r=await c.query<DbTask>(`${taskSelect} WHERE client_id=$1 ORDER BY created_at DESC,id LIMIT $2`,[clientId,bounded]); return r.rows.map(mapTask); });
}

async function createEscalationFollowUp(c:PoolClient,firmId:string,clientId:string,taskId:string):Promise<void> {
  const task=await c.query<{purpose:string;requested_by:string|null}>(`SELECT purpose,requested_by FROM nexus_specialist_tasks WHERE id=$1 AND firm_id=$2 AND client_id=$3 AND status='needs_human_review'`,[taskId,firmId,clientId]);
  const source=task.rows[0];
  if(!source?.requested_by) return; // Legacy prototype task; it has no initiating user to assign the review to.
  const title='Nexus task needs your review';
  const details=`A Nexus review reached a human decision gate. Task: ${taskId}. Purpose: ${source.purpose}`.slice(0,2000);
  const inserted=await c.query<{id:string}>(`INSERT INTO follow_up_items
    (firm_id,client_id,created_by,title,details,priority,source_nexus_task_id)
    VALUES($1,$2,$3,$4,$5,'high',$6) ON CONFLICT (source_nexus_task_id) DO NOTHING RETURNING id`,
    [firmId,clientId,source.requested_by,title,details,taskId]);
  if(!inserted.rowCount) return;
  const followUpId=inserted.rows[0]!.id;
  await c.query(`INSERT INTO follow_up_events(firm_id,client_id,follow_up_id,actor_type,actor_user_id,event_type)
    VALUES($1,$2,$3,'system',NULL,'system_created')`,[firmId,clientId,followUpId]);
  await c.query(`INSERT INTO nexus_alert_events
    (firm_id,client_id,source_kind,source_id,alert_type,priority,title,message,dedupe_key)
    VALUES($1,$2,'follow_up',$3,'follow_up_created','high',$4,$5,$6)
    ON CONFLICT (firm_id,client_id,dedupe_key) DO NOTHING`,
    [firmId,clientId,followUpId,title,'A Nexus task reached a human review gate. Open the review desk to inspect it.',`nexus_task:${taskId}:needs_human_review`]);
}

/** Read one referenced record through the task's server-authored capability
 * allowlist. Source files and raw document contents are never returned here. */
export async function readNexusTaskRecord(args:{firmId:string;clientId:string;taskId:string;
  capability:unknown;recordRef:unknown}):Promise<{kind:NexusRecordRef['kind'];id:string;data:Record<string,unknown>}> {
  const capability=text(args.capability,80,'read capability');
  if(!readCapabilities.has(capability)) throw new ValidationError('read capability is not allowed','NXT-1');
  const [ref]=refs([args.recordRef]);
  if(kindCapability[ref!.kind]!==capability) throw new ValidationError('capability does not match the record type','NXT-1');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId);
    const task=await c.query<{envelope:Record<string,unknown>}>(`SELECT envelope FROM nexus_specialist_tasks WHERE id=$1 AND client_id=$2`,[args.taskId,args.clientId]);
    if(!task.rowCount) throw new ValidationError('task is unavailable','NXT-2');
    const envelope=task.rows[0]!.envelope;
    const permitted=envelope.permitted_reads;
    const allowedRefs=envelope.record_refs;
    if(!Array.isArray(permitted)||!permitted.includes(capability)
      ||!Array.isArray(allowedRefs)||!allowedRefs.some((x)=>x&&typeof x==='object'
        &&(x as Record<string,unknown>).kind===ref!.kind&&(x as Record<string,unknown>).id===ref!.id)) {
      throw new ValidationError('record is outside the task read scope','NXT-1');
    }
    let data:Record<string,unknown>|undefined;
    if(ref!.kind==='source_document') {
      const r=await c.query<Record<string,unknown>>(`SELECT id,channel,received_at,mime_type,file_size,page_count,status
        FROM source_documents WHERE id=$1 AND client_id=$2`,[ref!.id,args.clientId]); data=r.rows[0];
    } else if(ref!.kind==='bank_statement') {
      const r=await c.query<Record<string,unknown>>(`SELECT id,period_from,period_to,row_count,parse_status,parser_version,uploaded_at
        FROM bank_statements WHERE id=$1 AND client_id=$2`,[ref!.id,args.clientId]); data=r.rows[0];
    } else if(ref!.kind==='obligation') {
      const r=await c.query<Record<string,unknown>>(`SELECT i.id,i.obligation_kind,i.period_key,i.created_at,
        (SELECT e.workflow_state FROM obligation_workflow_events e WHERE e.obligation_id=i.id ORDER BY e.event_ordinal DESC LIMIT 1) AS latest_workflow_state
        FROM obligation_timeline_items i WHERE i.id=$1 AND i.client_id=$2`,[ref!.id,args.clientId]); data=r.rows[0];
    } else {
      const r=await c.query<Record<string,unknown>>(`SELECT voucher_id AS id,supplier_legal_name,bill_number,bill_date,
        taxable_value,total_cgst,total_sgst,total_igst,total_cess,grand_total,itc_eligibility,gstr2b_status,approval_status
        FROM purchase_bills WHERE voucher_id=$1 AND client_id=$2`,[ref!.id,args.clientId]); data=r.rows[0];
    }
    if(!data) throw new ValidationError('referenced record is unavailable','NXT-2');
    return {kind:ref!.kind,id:ref!.id,data};
  });
}

/** Move a durable task through the bounded runner lifecycle. Database trigger
 * 059 enforces the same transition graph for direct application-role updates. */
export async function transitionNexusTaskStatus(args:{firmId:string;clientId:string;taskId:string;
  toStatus:unknown;expectedStatus?:unknown}):Promise<{status:NexusTaskStatus;duplicate:boolean}> {
  const toStatus=text(args.toStatus,40,'task status') as NexusTaskStatus;
  if(!Object.hasOwn(taskTransitions,toStatus)) throw new ValidationError('task status is not allowed','NXT-1');
  const expected=args.expectedStatus==null?null:text(args.expectedStatus,40,'expected task status') as NexusTaskStatus;
  if(expected!==null&&!Object.hasOwn(taskTransitions,expected)) throw new ValidationError('expected task status is not allowed','NXT-1');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-task:${args.taskId}`]);
    const current=await c.query<{status:NexusTaskStatus}>(`SELECT status FROM nexus_specialist_tasks WHERE id=$1 AND client_id=$2`,[args.taskId,args.clientId]);
    if(!current.rowCount) throw new ValidationError('task is unavailable','NXT-2');
    const from=current.rows[0]!.status;
    if(from===toStatus) return {status:toStatus,duplicate:true};
    if(expected!==null&&from!==expected) throw new ValidationError('task status changed; reload before continuing','NXT-5');
    if(!taskTransitions[from].has(toStatus)) throw new ValidationError(`task cannot move from ${from} to ${toStatus}`,'NXT-5');
    await c.query(`UPDATE nexus_specialist_tasks SET status=$1,updated_at=now() WHERE id=$2 AND client_id=$3`,[toStatus,args.taskId,args.clientId]);
    if(toStatus==='needs_human_review') await createEscalationFollowUp(c,args.firmId,args.clientId,args.taskId);
    return {status:toStatus,duplicate:false};
  });
}

export async function appendNexusTaskAttempt(args:{firmId:string;clientId:string;taskId:string;agentRole:unknown;modelVersion?:unknown;
 inputRefs?:unknown;outcome:unknown;resultSchemaVersion:number;result:unknown;verifierFindings?:unknown;addressesFindingIds?:unknown;
 verificationDecision?:unknown;errorCategory?:unknown;
 startedAt?:Date;endedAt?:Date;idempotencyKey:unknown}):Promise<{ordinal:number;duplicate:boolean}> {
  const key=text(args.idempotencyKey,200,'idempotency key'), role=text(args.agentRole,40,'agent role');
  if(!specialists.has(role as NexusSpecialist)) throw new ValidationError('agent role is not allowed','NXT-1');
  if(!['completed','partial','blocked','failed'].includes(String(args.outcome))) throw new ValidationError('attempt outcome is not allowed','NXT-1');
  const result=object(args.result,'result');
  if(!Number.isInteger(args.resultSchemaVersion)||args.resultSchemaVersion<1) throw new ValidationError('enter a valid result schema version','NXT-1');
  const inputRefs=refs(args.inputRefs ?? []), rawFindings=args.verifierFindings ?? [], addressed=args.addressesFindingIds ?? [];
  if(!Array.isArray(rawFindings)||rawFindings.length>100) throw new ValidationError('enter valid verifier findings','NXT-1');
  if(!Array.isArray(addressed)||addressed.length>100||addressed.some(x=>typeof x!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(x))) {
    throw new ValidationError('enter valid verifier finding references','NXT-1');
  }
  if(role==='verifier'&&addressed.length) throw new ValidationError('verifier attempts cannot address findings','NXT-1');
  if(role!=='verifier'&&rawFindings.length) throw new ValidationError('only verifier attempts may create findings','NXT-1');
  const decision=args.verificationDecision;
  if(role==='verifier'&&!['accepted','retry','needs_human_review'].includes(String(decision))) throw new ValidationError('verifier decision is required','NXT-1');
  if(role!=='verifier'&&decision!==undefined) throw new ValidationError('only verifier attempts may set a verification decision','NXT-1');
  const findings=rawFindings.map(raw=>{
    const finding=object(raw,'verifier finding');
    const summary=text(finding.summary,1000,'finding summary');
    const severity=finding.severity??'review';
    if(!['review','critical'].includes(String(severity))) throw new ValidationError('finding severity is not allowed','NXT-1');
    const claimRef=finding.claim_ref==null?null:text(finding.claim_ref,200,'claim reference');
    return {finding_id:randomUUID(),summary,severity,claim_ref:claimRef};
  });
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
    const expectedRunStatus=role==='verifier'?'verifying':'running';
    if(task.rows[0]!.status!==expectedRunStatus) throw new ValidationError(`task must be ${expectedRunStatus} before this attempt`,'NXT-5');
    if(addressed.length){
      const latestVerifier=await c.query<{verifier_findings:unknown}>(`SELECT verifier_findings FROM nexus_specialist_task_attempts WHERE task_id=$1 AND agent_role='verifier' ORDER BY ordinal DESC LIMIT 1`,[args.taskId]);
      if(!latestVerifier.rowCount) throw new ValidationError('there are no verifier findings to address','NXT-5');
      const findings=latestVerifier.rows[0]!.verifier_findings;
      const known=Array.isArray(findings)?new Set(findings.map((x)=>x&&typeof x==='object'?(x as Record<string,unknown>).finding_id:null)):new Set();
      if(addressed.some(id=>!known.has(id))) throw new ValidationError('retry references a finding outside the latest verifier review','NXT-5');
    }
    const attemptSequence=await c.query<{n:number}>(`SELECT COALESCE(max(ordinal),0)+1 AS n FROM nexus_specialist_task_attempts WHERE task_id=$1`,[args.taskId]);
    const ordinal=attemptSequence.rows[0]!.n;
    const specialistAttempt=task.rows[0]!.current_attempt+(role==='verifier'?0:1);
    if(role!=='verifier'&&specialistAttempt>task.rows[0]!.max_attempts) throw new ValidationError('specialist retry budget is exhausted','NXT-3');
    if(role==='verifier') {
      const verifierCount=await c.query<{n:number}>(`SELECT count(*)::integer AS n FROM nexus_specialist_task_attempts WHERE task_id=$1 AND agent_role='verifier'`,[args.taskId]);
      if(verifierCount.rows[0]!.n>=task.rows[0]!.max_attempts) throw new ValidationError('verifier attempt budget is exhausted','NXT-3');
    }
    if(role==='verifier') {
      const critical=findings.some(f=>f.severity==='critical');
      if(decision==='accepted'&&findings.length) throw new ValidationError('a verifier cannot accept with unresolved findings','NXT-5');
      if(decision==='retry'&&(!findings.length||critical||!['completed','partial'].includes(String(args.outcome)))) throw new ValidationError('retry requires a usable review and non-critical actionable findings','NXT-5');
      if(decision==='accepted'&&args.outcome!=='completed') throw new ValidationError('accepted verification must complete successfully','NXT-5');
    }
    const attempt=await c.query<{id:string}>(`INSERT INTO nexus_specialist_task_attempts(firm_id,client_id,task_id,ordinal,agent_role,model_version,input_refs,outcome,result_schema_version,result,verifier_findings,addressed_findings,verification_decision,error_category,started_at,ended_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,[
      args.firmId,args.clientId,args.taskId,ordinal,role,args.modelVersion==null?null:text(args.modelVersion,160,'model version'),JSON.stringify(inputRefs),args.outcome,args.resultSchemaVersion,JSON.stringify(result),JSON.stringify(findings),JSON.stringify(addressed),role==='verifier'?decision:null,args.errorCategory==null?null:text(args.errorCategory,80,'error category'),startedAt,endedAt,key]);
    const attemptId=attempt.rows[0]!.id;
    const count=await c.query<{n:number}>(`SELECT COALESCE(max(event_ordinal),0)+1 AS n FROM nexus_specialist_task_events WHERE task_id=$1`,[args.taskId]);
    await c.query(`INSERT INTO nexus_specialist_task_events(firm_id,client_id,task_id,event_ordinal,event_type,attempt_id,detail,idempotency_key)
      VALUES($1,$2,$3,$4,'attempt_recorded',$5,$6,$7)`,[args.firmId,args.clientId,args.taskId,count.rows[0]!.n,attemptId,JSON.stringify({ordinal,outcome:args.outcome}),`attempt:${attemptId}`]);
    const nextStatus: NexusTaskStatus=role==='verifier'
      ?decision==='accepted'&&args.outcome==='completed'?'completed'
        :decision==='retry'&&task.rows[0]!.current_attempt<task.rows[0]!.max_attempts?'retry_ready':'needs_human_review'
      :specialistAttempt===task.rows[0]!.max_attempts&&args.outcome!=='completed'?'needs_human_review'
      :args.outcome==='completed'||args.outcome==='partial'?'verifying'
      :args.outcome==='blocked'?'blocked':'failed';
    const checkpoint=(args.result as Record<string,unknown>).checkpoint;
    await c.query(`UPDATE nexus_specialist_tasks SET current_attempt=$1,status=$2,checkpoint=COALESCE($3,checkpoint),result_schema_version=$4,result=$5,updated_at=now() WHERE id=$6 AND client_id=$7`,
      [specialistAttempt,nextStatus,checkpoint&&typeof checkpoint==='object'?JSON.stringify(checkpoint):null,args.resultSchemaVersion,JSON.stringify(result),args.taskId,args.clientId]);
    if(nextStatus==='needs_human_review') await createEscalationFollowUp(c,args.firmId,args.clientId,args.taskId);
    return {ordinal,duplicate:false};
  });
}
