import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withFirm } from '../db/pool.ts';
import { ValidationError } from './types.ts';
import { validateNexusBlocks, type NexusBlockEnvelope } from '../web/nexusBlocks.ts';

export type NexusCaseState='open'|'working'|'needs_user'|'with_ca'|'blocked'|'completed'|'cancelled';
const transitions:Record<NexusCaseState,ReadonlySet<NexusCaseState>>={
  open:new Set(['working','cancelled']), working:new Set(['needs_user','with_ca','blocked','completed','open','cancelled']),
  needs_user:new Set(['working','blocked','cancelled']), with_ca:new Set(['working','needs_user','blocked','completed','cancelled']),
  blocked:new Set(['working','needs_user','with_ca','cancelled']), completed:new Set(), cancelled:new Set(),
};
const value=(v:unknown,max:number,label:string)=>{
  if(typeof v!=='string'||!v.trim()||v.trim().length>max) throw new ValidationError(`enter a valid ${label}`,'NXC-1');
  return v.trim();
};
async function assertClient(c:PoolClient,clientId:string) {
  if(!(await c.query('SELECT 1 FROM clients WHERE id=$1',[clientId])).rowCount) throw new ValidationError('client is unavailable','NXC-2');
}
async function assertActor(c:PoolClient,firmId:string,clientId:string,userId:string) {
  if(!(await c.query('SELECT 1 FROM users WHERE id=$1 AND firm_id=$2 AND (client_id IS NULL OR client_id=$3)',[userId,firmId,clientId])).rowCount)
    throw new ValidationError('case actor is unavailable for this client','NXC-2');
}

export async function createNexusCase(args:{firmId:string;clientId:string;title:unknown;requestedByUserId:unknown;idempotencyKey:unknown}):Promise<string> {
  const title=value(args.title,240,'case title'), actor=value(args.requestedByUserId,80,'requesting user'), key=value(args.idempotencyKey,200,'idempotency key');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId); await assertActor(c,args.firmId,args.clientId,actor);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-case-key:${args.clientId}:${key}`]);
    const prior=await c.query<{id:string;title:string;requested_by:string}>(`SELECT id,title,requested_by FROM nexus_cases WHERE firm_id=$1 AND client_id=$2 AND idempotency_key=$3`,[args.firmId,args.clientId,key]);
    if(prior.rowCount){const old=prior.rows[0]!; if(old.title!==title||old.requested_by!==actor) throw new ValidationError('idempotency key was already used for another case','NXC-4'); return old.id;}
    const id=randomUUID();
    await c.query(`INSERT INTO nexus_cases(id,firm_id,client_id,title,idempotency_key,requested_by) VALUES($1,$2,$3,$4,$5,$6)`,[id,args.firmId,args.clientId,title,key,actor]);
    await c.query(`INSERT INTO nexus_case_events(firm_id,client_id,case_id,event_ordinal,event_type,to_state,actor_user_id,idempotency_key) VALUES($1,$2,$3,1,'created','open',$4,$5)`,[args.firmId,args.clientId,id,actor,`created:${id}`]);
    return id;
  });
}

const selectCase=`SELECT c.id,c.client_id,c.title,c.requested_by,c.created_at,
  (SELECT e.to_state FROM nexus_case_events e WHERE e.case_id=c.id ORDER BY e.event_ordinal DESC LIMIT 1) AS state
  FROM nexus_cases c`;
export async function listNexusCases(firmId:string,clientId:string,limit=50) {
  const bounded=Math.max(1,Math.min(100,Math.trunc(limit)||50));
  return withFirm(firmId,async c=>{await assertClient(c,clientId); const r=await c.query(`${selectCase} WHERE c.firm_id=$1 AND c.client_id=$2 ORDER BY c.created_at DESC,c.id LIMIT $3`,[firmId,clientId,bounded]); return r.rows;});
}
export async function getNexusCase(firmId:string,clientId:string,caseId:string) {
  return withFirm(firmId,async c=>{
    await assertClient(c,clientId);
    const r=await c.query(`${selectCase} WHERE c.firm_id=$1 AND c.client_id=$2 AND c.id=$3`,[firmId,clientId,caseId]);
    if(!r.rows[0]) return null;
    const events=await c.query(`SELECT event_ordinal,event_type,from_state,to_state,actor_user_id,idempotency_key,recorded_at FROM nexus_case_events WHERE firm_id=$1 AND client_id=$2 AND case_id=$3 ORDER BY event_ordinal`,[firmId,clientId,caseId]);
    return {...r.rows[0],events:events.rows};
  });
}
export async function appendNexusCaseState(args:{firmId:string;clientId:string;caseId:string;toState:unknown;actorUserId:unknown;idempotencyKey:unknown}) {
  const to=value(args.toState,40,'case state') as NexusCaseState;
  if(!(to in transitions)) throw new ValidationError('case state is not allowed','NXC-1');
  const actor=value(args.actorUserId,80,'case actor'),key=value(args.idempotencyKey,200,'idempotency key');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId); await assertActor(c,args.firmId,args.clientId,actor);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-case:${args.caseId}`]);
    const prior=await c.query<{case_id:string;to_state:string;actor_user_id:string}>(`SELECT case_id,to_state,actor_user_id FROM nexus_case_events WHERE firm_id=$1 AND client_id=$2 AND idempotency_key=$3`,[args.firmId,args.clientId,key]);
    if(prior.rowCount){const old=prior.rows[0]!;if(old.case_id!==args.caseId||old.to_state!==to||old.actor_user_id!==actor)throw new ValidationError('idempotency key was already used for another case event','NXC-4');return {state:old.to_state,duplicate:true};}
    const current=await c.query<{state:NexusCaseState}>(`SELECT to_state AS state FROM nexus_case_events WHERE firm_id=$1 AND client_id=$2 AND case_id=$3 ORDER BY event_ordinal DESC LIMIT 1`,[args.firmId,args.clientId,args.caseId]);
    if(!current.rowCount) throw new ValidationError('case is unavailable','NXC-2');
    const from=current.rows[0]!.state;
    if(!transitions[from]?.has(to)) throw new ValidationError(`case cannot transition from ${from} to ${to}`,'NXC-3');
    const ordinal=await c.query<{next:number}>(`SELECT COALESCE(MAX(event_ordinal),0)+1 AS next FROM nexus_case_events WHERE firm_id=$1 AND client_id=$2 AND case_id=$3`,[args.firmId,args.clientId,args.caseId]);
    await c.query(`INSERT INTO nexus_case_events(firm_id,client_id,case_id,event_ordinal,event_type,from_state,to_state,actor_user_id,idempotency_key) VALUES($1,$2,$3,$4,'state_changed',$5,$6,$7,$8)`,[args.firmId,args.clientId,args.caseId,ordinal.rows[0]!.next,from,to,actor,key]);
    return {state:to,duplicate:false};
  });
}

export type NexusCaseMessage = { id:string; message_ordinal:number; actor_type:'user'|'nexus'|'system'; actor_user_id:string|null; body:string; response_blocks:NexusBlockEnvelope|null; request_fingerprint:string|null; idempotency_key:string; recorded_at:Date };
export async function appendNexusCaseMessage(args:{firmId:string;clientId:string;caseId:string;actorType:'user'|'nexus'|'system';actorUserId?:unknown;body:unknown;responseBlocks?:unknown;requestFingerprint?:unknown;idempotencyKey:unknown}) {
  const body=value(args.body,20000,'message'),key=value(args.idempotencyKey,200,'idempotency key');
  const blocks=args.responseBlocks===undefined?null:validateNexusBlocks(args.responseBlocks);
  const fingerprint=args.requestFingerprint===undefined?null:value(args.requestFingerprint,64,'request fingerprint');
  if(fingerprint!==null&&!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ValidationError('request fingerprint is not valid','NXC-1');
  if(!['user','nexus','system'].includes(args.actorType)) throw new ValidationError('message actor is not allowed','NXC-1');
  const actor=args.actorType==='user'?value(args.actorUserId,80,'message actor'):null;
  if(args.actorType!=='user'&&args.actorUserId!==undefined) throw new ValidationError('non-user messages cannot name a user actor','NXC-1');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`nexus-case-message:${args.caseId}`]);
    const prior=await c.query<NexusCaseMessage & {case_id:string}>(`SELECT id,case_id,message_ordinal,actor_type,actor_user_id,body,response_blocks,request_fingerprint,idempotency_key,recorded_at FROM nexus_case_messages WHERE firm_id=$1 AND client_id=$2 AND idempotency_key=$3`,[args.firmId,args.clientId,key]);
    if(prior.rowCount){const old=prior.rows[0]!;
      const priorBlocks=old.response_blocks===null?null:validateNexusBlocks(old.response_blocks);
      if(old.case_id!==args.caseId||old.body!==body||old.actor_type!==args.actorType||old.actor_user_id!==actor||old.request_fingerprint!==fingerprint||JSON.stringify(priorBlocks)!==JSON.stringify(blocks)) throw new ValidationError('idempotency key was already used for another case message','NXC-4');
      return {...old,duplicate:true};}
    if(!await c.query('SELECT 1 FROM nexus_cases WHERE id=$1 AND firm_id=$2 AND client_id=$3',[args.caseId,args.firmId,args.clientId]).then(r=>r.rowCount)) throw new ValidationError('case is unavailable','NXC-2');
    if(actor) await assertActor(c,args.firmId,args.clientId,actor);
    const ord=await c.query<{next:number}>('SELECT COALESCE(MAX(message_ordinal),0)+1 AS next FROM nexus_case_messages WHERE firm_id=$1 AND client_id=$2 AND case_id=$3',[args.firmId,args.clientId,args.caseId]);
    const result=await c.query<NexusCaseMessage>(`INSERT INTO nexus_case_messages(firm_id,client_id,case_id,message_ordinal,actor_type,actor_user_id,body,response_blocks,request_fingerprint,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id,message_ordinal,actor_type,actor_user_id,body,response_blocks,request_fingerprint,idempotency_key,recorded_at`,[args.firmId,args.clientId,args.caseId,ord.rows[0]!.next,args.actorType,actor,body,blocks===null?null:JSON.stringify(blocks),fingerprint,key]);
    return {...result.rows[0]!,duplicate:false};
  });
}

export async function listNexusCaseMessages(firmId:string,clientId:string,caseId:string) {
  return withFirm(firmId,async c=>{await assertClient(c,clientId);const exists=await c.query('SELECT 1 FROM nexus_cases WHERE id=$1 AND firm_id=$2 AND client_id=$3',[caseId,firmId,clientId]);if(!exists.rowCount)return [];
    const r=await c.query<NexusCaseMessage>('SELECT id,message_ordinal,actor_type,actor_user_id,body,response_blocks,request_fingerprint,idempotency_key,recorded_at FROM nexus_case_messages WHERE firm_id=$1 AND client_id=$2 AND case_id=$3 ORDER BY message_ordinal',[firmId,clientId,caseId]);return r.rows.map((row)=>({...row,response_blocks:row.response_blocks===null?null:validateNexusBlocks(row.response_blocks)}));});
}

export async function getNexusCaseMessageByKey(firmId:string,clientId:string,idempotencyKey:unknown) {
  const key=value(idempotencyKey,200,'message key');
  return withFirm(firmId,async c=>{
    await assertClient(c,clientId);
    const result=await c.query<NexusCaseMessage & {case_id:string}>(`SELECT id,case_id,message_ordinal,actor_type,actor_user_id,body,response_blocks,request_fingerprint,idempotency_key,recorded_at FROM nexus_case_messages WHERE firm_id=$1 AND client_id=$2 AND idempotency_key=$3`,[firmId,clientId,key]);
    const row=result.rows[0];
    return row?{...row,response_blocks:row.response_blocks===null?null:validateNexusBlocks(row.response_blocks)}:null;
  });
}

export type NexusSourceKind='bank_transaction'|'specialist_task'|'obligation';
export async function attachNexusCaseSource(args:{firmId:string;clientId:string;caseId:string;sourceKind:NexusSourceKind;sourceId:string;label:unknown;attachedByUserId:unknown;idempotencyKey:unknown}) {
  const label=value(args.label,240,'source label'),actor=value(args.attachedByUserId,80,'source actor'),key=value(args.idempotencyKey,200,'idempotency key');
  if(!['bank_transaction','specialist_task','obligation'].includes(args.sourceKind)||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.sourceId)) throw new ValidationError('source reference is not valid','NXC-1');
  return withFirm(args.firmId,async c=>{
    await assertClient(c,args.clientId);await assertActor(c,args.firmId,args.clientId,actor);
    const prior=await c.query<{id:string;case_id:string;source_kind:NexusSourceKind;source_id:string;label:string;attached_by:string;idempotency_key:string;recorded_at:Date}>(`SELECT id,case_id,source_kind,source_id,label,attached_by,idempotency_key,recorded_at FROM nexus_case_source_refs WHERE firm_id=$1 AND client_id=$2 AND idempotency_key=$3`,[args.firmId,args.clientId,key]);
    if(prior.rowCount){const old=prior.rows[0]!;if(old.case_id!==args.caseId||old.source_kind!==args.sourceKind||old.source_id!==args.sourceId||old.label!==label||old.attached_by!==actor)throw new ValidationError('idempotency key was already used for another source reference','NXC-4');return {...old,duplicate:true};}
    const r=await c.query(`INSERT INTO nexus_case_source_refs(firm_id,client_id,case_id,source_kind,source_id,label,attached_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,case_id,source_kind,source_id,label,attached_by,idempotency_key,recorded_at`,[args.firmId,args.clientId,args.caseId,args.sourceKind,args.sourceId,label,actor,key]);
    return {...r.rows[0]!,duplicate:false};
  });
}
export async function listNexusCaseSources(firmId:string,clientId:string,caseId:string) {
  return withFirm(firmId,async c=>{await assertClient(c,clientId);const exists=await c.query('SELECT 1 FROM nexus_cases WHERE id=$1 AND firm_id=$2 AND client_id=$3',[caseId,firmId,clientId]);if(!exists.rowCount)return [];
    const r=await c.query('SELECT id,source_kind,source_id,label,attached_by,idempotency_key,recorded_at FROM nexus_case_source_refs WHERE firm_id=$1 AND client_id=$2 AND case_id=$3 ORDER BY recorded_at,id',[firmId,clientId,caseId]);return r.rows;});
}
