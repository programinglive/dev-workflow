/**
 * @zettly-code DWF-SENTRY-HANDLER-001
 * @purpose Handle external Zettly & Sentry MCP tools (status, issue reads, inventory snapshots, canonical linking, and native Sentry issue resolution).
 * @invariant Never create duplicate Zettly Todos when linking or resolving Sentry issues; auto-resolve linked Sentry issues on task completion without blocking terminal task closure if Sentry is unreachable.
 */
import {textResponse} from './shared.js';
import {isToolAllowedInProfile} from '../../src/tool-profiles.js';
import {readSentryConfig,createSentryClient} from '../../sentry-client.js';
import {resolveZettlyConfig,createZettlyClient} from '../../zettly-client.js';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {sanitize} from '../../security/sanitizer.js';
import {readZettlyTaskContext} from '../../zettly-context.js';
import {drawingMatchesWorkflow} from '../../zettly-drawing.js';
import {collectActiveSessionClaims,findMatchingActiveClaim,toIssueActiveClaim} from '../../claim-view.js';

const failed=message=>({...textResponse(message),isError:true});
const json=value=>textResponse(JSON.stringify(value));
const issueId=value=>typeof value==='string'&&/^\d{1,30}$/.test(value);
const SENTRY_STATUSES=new Set(['resolved','unresolved','ignored']);
async function clients(options) {
 const env=options.env||process.env;
 const result={};
 if(Object.hasOwn(options,'zettly'))result.zettly=options.zettly;
 else{const config=await resolveZettlyConfig(env);result.zettly=config?{...createZettlyClient(config),expectedUserId:config.expectedUserId}:null;}
 if(Object.hasOwn(options,'sentry'))result.sentry=options.sentry;
 else{const config=readSentryConfig(env);result.sentry=config?{...createSentryClient(config),organization:config.organization}:null;}
 return result;
}
async function probe(client,check) {
 if(!client)return {status:'not_configured'};
 try{await check(client);return {status:'connected'};}
 catch(error){return {status:'unavailable',...(Number.isInteger(error.status)?{httpStatus:error.status}:{})};}
}

export async function handleIntegrationTool(name,args={},workflowState,options={}) {
 try{
  // Validate mutation input before any integration lookup: a missing confirm
  // must never be hidden by an unavailable Sentry connection.
  if(name==='set_sentry_issue_status'){
   if(args.confirm!==true)return failed('Changing a Sentry issue status is a mutation: pass confirm: true with a written reason.');
   const reason=String(args.reason||'').trim();
   if(reason.length<5)return failed('Provide a reason of at least 5 characters explaining why the Sentry issue status changes.');
   const requested=String(args.status||'').trim();
   const target=requested==='resolve'?'resolved':requested==='unresolve'?'unresolved':requested==='ignore'?'ignored':'';
   if(!SENTRY_STATUSES.has(target))return failed("Invalid status: use 'resolve', 'unresolve', or 'ignore'.");
   if(!issueId(String(args.issue||args.issueId||'')))return failed('Provide a numeric Sentry issue id.');
  }
  const api=await clients(options);
  if(name==='get_zettly_task_context'){
    if(!api.zettly)return failed('Zettly owner credentials are not configured.');
    const todoId=args.todoId??workflowState?.state?.zettly?.todoId;
    const state=workflowState?.state,identity=state?.workflowTaskId;
    const attach=Number(todoId)===Number(state?.zettly?.todoId)&&args.attach!==false;
    if(args.attach===true&&!attach)return failed('Context can only be attached to the same canonical Todo as the active workflow task.');
    const context=await readZettlyTaskContext(api.zettly,{todoId,depth:args.depth,maxNodes:args.maxNodes});
    if(attach){
     const guard=()=>{if(workflowState.state!==state||state.workflowTaskId!==identity||Number(state.zettly?.todoId)!==Number(todoId)||workflowState.lastConflict)throw Error('Task ownership or canonical Todo changed');};
     guard();const previous=state.zettlyContext;state.zettlyContext=context;
     try{const result=await workflowState.save();guard();if(result?.verified===false||result?.conflict)throw Error('Context persistence unverified');}
     catch(error){if(workflowState.state===state&&state.zettlyContext===context)state.zettlyContext=state.workflowTaskId===identity&&Number(state.zettly?.todoId)===Number(todoId)?previous:null;throw error;}
    }
    return json(context);
  }
  if(name==='get_integration_status'){
    const [zettly,sentry]=await Promise.all([
     probe(api.zettly,async client=>{const response=await client.request('GET','/user');const user=response.data||response;if(!Number.isSafeInteger(Number(user.id))||Number(user.id)<1||(client.expectedUserId&&Number(user.id)!==Number(client.expectedUserId)))throw Error('Owner mismatch');}),
     probe(api.sentry,client=>client.listIssues({limit:1}))
    ]);
    return json({zettly,sentry,backgroundWorker:'not_managed_by_this_mcp'});
  }
  if(name==='link_zettly_drawing'){
    const state=workflowState?.state;
    if(!state?.workflowTaskId||!Number.isSafeInteger(state.zettly?.todoId)||state.zettly.todoId<1)return failed('Start a workflow with a canonical Zettly Todo before linking Draw.');
    if(!Number.isSafeInteger(args.drawingId)||args.drawingId<1)return failed('Provide a valid positive drawing ID.');
    if(!api.zettly)return failed('Zettly owner connection is unavailable. No drawing link was changed.');
    const taskIdentity=state.workflowTaskId;
    const guard=()=>{if(workflowState.state!==state||state.workflowTaskId!==taskIdentity||workflowState.lastConflict)throw Error('Task ownership changed');};
    const response=await api.zettly.request('GET',`/drawings/${args.drawingId}`);guard();
    const drawing=response.drawing||response.data?.drawing||response.data;
    if(Number(drawing?.id)!==args.drawingId||!drawingMatchesWorkflow(drawing,state))return failed('The drawing does not match this canonical workflow and Todo. No link was changed.');
    const previous=state.zettly.externalLinks;
    const drawingCode=drawing.document.document.store['document:document'].meta.mermaidCode;
    state.zettly.externalLinks={...previous,drawing:{id:args.drawingId,revision:drawingCode===state.mermaidCode?createHash('sha256').update(String(state.mermaidCode||'')).digest('hex'):'',url:`https://zettly.programinglive.com/draw/${args.drawingId}`}};
    try{const saved=await workflowState.save();guard();if(saved?.verified===false||saved?.conflict)throw Error('Drawing link persistence was not verified');}
    catch(error){if(workflowState.state===state){if(previous===undefined)delete state.zettly.externalLinks;else state.zettly.externalLinks=previous;}throw error;}
    return textResponse(`Verified Zettly Draw #${args.drawingId} linked to Todo #${state.zettly.todoId}.`);
  }
  if(!api.sentry)return failed('Sentry is not configured. Set SENTRY_ORG and SENTRY_ACCESS_TOKEN in the private launcher environment, or select a private file with DEVWF_SENTRY_CONFIG.');
  const ownSessionKey=(typeof workflowState?._sessionKey==='function'?workflowState._sessionKey()?.key:'')||workflowState?.sessionId||'';
  const annotateSentryIssue=async(rawIssue,activeClaims)=>{
    if(!rawIssue||typeof rawIssue!=='object')return rawIssue;
    const match=findMatchingActiveClaim({sentryIssueId:String(rawIssue.id||''),shortId:String(rawIssue.shortId||'')},activeClaims,{ownSessionKey});
    return {...rawIssue,activeClaim:toIssueActiveClaim(match)};
  };
  if(name==='list_sentry_issues'){
    const rawResult=api.sentry.listIssuePage?await api.sentry.listIssuePage(args):await api.sentry.listIssues(args);
    const activeClaims=await collectActiveSessionClaims({ownSessionKey,stateFile:workflowState?.stateFile||'',env:options.env||process.env,fetchImpl:options.fetchImpl||fetch,timeoutMs:1500});
    if(Array.isArray(rawResult)){
      const annotated=await Promise.all(rawResult.map(item=>annotateSentryIssue(item,activeClaims)));
      return json(annotated);
    }
    if(rawResult&&Array.isArray(rawResult.issues)){
      const annotated=await Promise.all(rawResult.issues.map(item=>annotateSentryIssue(item,activeClaims)));
      return json({...rawResult,issues:annotated});
    }
    return json(rawResult);
  }
  if(name==='inventory_sentry_issues'){
    if(!workflowState?.stateFile)return failed('A device-local workflow state file is required to save an inventory snapshot.');
    const inventory=await api.sentry.inventoryIssues(args);
    const activeClaims=await collectActiveSessionClaims({ownSessionKey,stateFile:workflowState?.stateFile||'',env:options.env||process.env,fetchImpl:options.fetchImpl||fetch,timeoutMs:1500});
    if(Array.isArray(inventory.issues)){
      inventory.issues=await Promise.all(inventory.issues.map(item=>annotateSentryIssue(item,activeClaims)));
    }
    const directory=path.join(path.dirname(workflowState.stateFile),'sentry-inventory');
    await mkdir(directory,{recursive:true,mode:0o700});
    const snapshotPath=path.join(directory,'inventory-'+randomUUID()+'.json');
    await writeFile(snapshotPath,JSON.stringify(sanitize(inventory),null,2)+'\n',{mode:0o600,flag:'wx'});
    const claimedIssues=(inventory.issues||[]).filter(i=>i?.activeClaim?.claimed).map(i=>({id:i.id,shortId:i.shortId,activeClaim:i.activeClaim}));
    return json({organization:inventory.organization,complete:inventory.complete,scope:inventory.scope,projectCount:inventory.projects.length,issueCount:inventory.issues.length,totalHits:inventory.totalHits,projects:inventory.projects,nextCursor:inventory.nextCursor,projectCursor:inventory.projectCursor,inconsistencies:inventory.inconsistencies,claimedIssueCount:claimedIssues.length,claimedIssues,snapshotPath});
  }
  if(name==='set_sentry_issue_status'){
   if(args.confirm!==true)return failed('Changing a Sentry issue status is a mutation: pass confirm: true with a written reason.');
   const reason=String(args.reason||'').trim();
   if(reason.length<5)return failed('Provide a reason of at least 5 characters explaining why the Sentry issue status changes.');
   const requested=String(args.status||'').trim();
   const targetStatus=requested==='resolve'?'resolved':requested==='unresolve'?'unresolved':requested==='ignore'?'ignored':'';
   if(!SENTRY_STATUSES.has(targetStatus))return failed("Invalid status: use 'resolve', 'unresolve', or 'ignore'.");
   const candidateId=String(args.issue||args.issueId||'');
   const targetId=issueId(candidateId)?candidateId:'';
   if(!targetId)return failed('Provide a numeric Sentry issue id.');
   if(typeof api.sentry.resolveIssue!=='function')return failed('Sentry client does not support issue status updates.');
   const updated=await api.sentry.resolveIssue(targetId,{status:targetStatus});
   if(String(updated.id)!==targetId)throw Error('Source identity changed');
   const status=updated.status||targetStatus;
   const linked=workflowState?.state?.zettly?.externalLinks?.sentry;
   if(linked?.issueId===targetId&&workflowState?.state?.zettly){
    const previous=workflowState.state.zettly.externalLinks;
    workflowState.state.zettly.externalLinks={...previous,sentry:{...linked,status,resolvedAt:status==='resolved'?new Date().toISOString():null}};
    try{const saved=await workflowState.save();if(saved?.verified===false||saved?.conflict)throw Error('Task link persistence was not verified');}
    catch{if(workflowState.state?.zettly)workflowState.state.zettly.externalLinks=previous;}
   }
   return textResponse(`Sentry issue ${updated.shortId||targetId} (${targetId}) status changed to '${status}' (confirmed). Reason: ${reason}`);
  }
  if(!issueId(args.issueId))return failed('Provide a numeric Sentry issueId.');
  if(name==='get_sentry_issue'){
    const rawIssue=await api.sentry.getIssue(args.issueId);
    const activeClaims=await collectActiveSessionClaims({ownSessionKey,stateFile:workflowState?.stateFile||'',env:options.env||process.env,fetchImpl:options.fetchImpl||fetch,timeoutMs:1500});
    return json(await annotateSentryIssue(rawIssue,activeClaims));
  }
  if(name!=='link_sentry_issue')return failed('Unknown integration tool.');
  const state=workflowState?.state;
  const requestedAction=args.action??'link';
  if(requestedAction==='resolve'||requestedAction==='unresolve'||requestedAction==='ignore'){
   if(typeof api.sentry.resolveIssue!=='function')return failed('Sentry client does not support issue status updates.');
   const targetStatus=requestedAction==='resolve'?(args.status&&SENTRY_STATUSES.has(args.status)?args.status:'resolved'):requestedAction==='unresolve'?'unresolved':'ignored';
   const updated=await api.sentry.resolveIssue(args.issueId,{status:targetStatus});
   if(updated.id!==args.issueId)throw Error('Source identity changed');
   let linkedTodoNote='';
   if(state?.workflowTaskId&&Number.isSafeInteger(state.zettly?.todoId)&&state.zettly.todoId>0){
    const existingSentry=state.zettly.externalLinks?.sentry;
    if(!existingSentry||existingSentry.issueId===updated.id){
     const previous=state.zettly.externalLinks;
     state.zettly.externalLinks={...previous,sentry:{organization:String(api.sentry.organization||existingSentry?.organization||'').slice(0,100),issueId:updated.id,shortId:String(updated.shortId||existingSentry?.shortId||'').slice(0,100),url:updated.permalink||existingSentry?.url||'',status:updated.status||targetStatus,resolvedAt:targetStatus==='resolved'?new Date().toISOString():null}};
     try{const saved=await workflowState.save();if(saved?.verified===false||saved?.conflict)throw Error('Task link persistence was not verified');linkedTodoNote=` Linked to Zettly Todo #${state.zettly.todoId}.`;}
     catch{if(previous===undefined)delete state.zettly.externalLinks;else state.zettly.externalLinks=previous;}
    }
   }
   return textResponse(`⚠️ Deprecated: 'link_sentry_issue' action '${requestedAction}' is an alias; use 'set_sentry_issue_status' for Sentry mutations. Sentry issue ${updated.shortId||updated.id} (${updated.id}) status updated to '${updated.status||targetStatus}'.${linkedTodoNote}`);
  }
  if(requestedAction!=='link')return failed("Invalid action for link_sentry_issue: use 'link', 'resolve', 'unresolve', or 'ignore'.");
  if(!state?.workflowTaskId||!state.taskDescription||!Number.isSafeInteger(state.zettly?.todoId)||state.zettly.todoId<1)return failed('Start or resume a canonical workflow task with a linked Zettly Todo before linking an issue.');
  const taskIdentity=state.workflowTaskId;
  const guard=()=>{if(workflowState.state!==state||state.workflowTaskId!==taskIdentity||workflowState.lastConflict)throw Error('Task ownership changed');};
  const source=await api.sentry.getIssue(args.issueId);guard();
  if(source.id!==args.issueId)throw Error('Source identity changed');
  const previous=state.zettly.externalLinks;
  state.zettly.externalLinks={...previous,sentry:{organization:String(api.sentry.organization||'').slice(0,100),issueId:source.id,shortId:String(source.shortId||'').slice(0,100),url:source.permalink||'',status:source.status||'unresolved'}};
  try{
   guard();const result=await workflowState.save();guard();
   if(result?.verified===false||result?.conflict)throw Error('Task link persistence was not verified');
  }catch(error){if(workflowState.state===state){if(previous===undefined)delete state.zettly.externalLinks;else state.zettly.externalLinks=previous;}throw error;}
  return textResponse(`Verified Sentry issue ${source.shortId||source.id} linked to the existing Zettly Todo #${state.zettly.todoId}. No new task was created.`);
  }catch(error){return failed(`Integration request failed${Number.isInteger(error.status)?` (HTTP ${error.status})`:''}. Check the configured account, source IDs, service availability and workflow ownership before retrying. No provider error body was returned.`);}
}

export async function autoResolveLinkedSentryIssue(workflowState,options={},enabled=false) {
  const state=workflowState?.state;
  const linkedSentry=state?.zettly?.externalLinks?.sentry;
  const originSentryId=state?.taskOrigin?.system==='sentry'&&issueId(String(state?.taskOrigin?.id||''))?String(state.taskOrigin.id):'';
  const targetId=issueId(String(linkedSentry?.issueId||''))?String(linkedSentry.issueId):originSentryId;
  if(!targetId)return {attempted:false,ok:true,changed:false,note:'Sentry: no issue status changed.'};
  const label=linkedSentry?.shortId||state?.taskOrigin?.label||targetId;
  if(!enabled)return {attempted:false,ok:true,changed:false,issueId:targetId,shortId:label,note:`Sentry issue ${label} (${targetId}) was not modified: auto-resolve is disabled.`};
  try{
   const api=await clients(options);
   if(!api.sentry||typeof api.sentry.resolveIssue!=='function')return {attempted:false,ok:false,changed:false,issueId:targetId,shortId:label,note:`Sentry issue ${label} (${targetId}) was not resolved because Sentry credentials are not configured.`};
   const resolved=await api.sentry.resolveIssue(targetId,{status:'resolved'});
   if(state?.zettly){
    state.zettly.externalLinks={...state.zettly.externalLinks,sentry:{...(linkedSentry||{}),organization:String(api.sentry.organization||linkedSentry?.organization||'').slice(0,100),issueId:resolved.id,shortId:String(resolved.shortId||label).slice(0,100),url:resolved.permalink||linkedSentry?.url||'',status:resolved.status||'resolved',resolvedAt:new Date().toISOString()}};
   }
   const status=resolved.status||'resolved';
   return {attempted:true,ok:true,changed:true,issueId:resolved.id,shortId:resolved.shortId||label,status,result:'resolved',note:`Sentry issue ${resolved.shortId||label} (${resolved.id}) status changed to '${status}' (auto-resolve requested).`};
  }catch(error){
   return {attempted:true,ok:false,changed:false,issueId:targetId,shortId:label,note:`Sentry issue ${label} (${targetId}) could not be auto-resolved${Number.isInteger(error?.status)?` (HTTP ${error.status})`:''}; use 'set_sentry_issue_status' { issue: "${targetId}", status: "resolve", reason, confirm: true }.`};
  }
}

export async function prepareTaskSource(args,options={}) {
  if(args.source?.system!=='sentry')return {args};
  if(!issueId(args.source.id))return {response:failed('Provide a numeric Sentry source ID.')};
  try{
   const api=await clients(options);
   if(!api.sentry)return {response:failed('Configure Sentry before starting a task from a Sentry issue.')};
   const source=await api.sentry.getIssue(args.source.id);
   if(source.id!==args.source.id)throw Error('Source identity mismatch');
   return {args:{...args,source:{system:'sentry',id:source.id,url:source.permalink,label:source.shortId||source.id},verifiedSourceIssue:{issueId:source.id,shortId:source.shortId||'',url:source.permalink||'',organization:api.sentry.organization||''}}};
  }catch(error){return {response:failed(`The Sentry source could not be verified${Number.isInteger(error.status)?` (HTTP ${error.status})`:''}. The existing workflow task was not changed.`)};}
}

const PREEMPTION_ENV_KEYS = Object.freeze({
  enabled: "DEVWF_PREEMPTION_ENABLED",
  project: "DEVWF_PREEMPTION_SENTRY_PROJECT",
  query: "DEVWF_PREEMPTION_QUERY",
  markers: "DEVWF_PREEMPTION_PROJECT_DIR_MARKERS",
});

let preemptionCache={checkedAt:0,issues:[]};
export function resetSentryPreemptionCache(){preemptionCache={checkedAt:0,issues:[]};}

/**
 * Config-driven preemption gate. It is OFF unless the operator explicitly
 * enables it and supplies the Sentry project, query and directory markers.
 * An enabled but incomplete configuration fails closed instead of silently
 * turning the gate off.
 */
export function resolvePreemptionConfig(env=process.env){
  const enabled=String(env?.[PREEMPTION_ENV_KEYS.enabled]||'').trim().toLowerCase()==='1';
  if(!enabled)return {ok:true,enabled:false,project:'',query:'',markers:[]};
  const project=String(env?.[PREEMPTION_ENV_KEYS.project]||'').trim();
  const query=String(env?.[PREEMPTION_ENV_KEYS.query]||'').trim();
  const markers=String(env?.[PREEMPTION_ENV_KEYS.markers]||'').split(',')
   .map((item)=>item.trim().replace(/\\/g,'/').replace(/\/+$/,''))
   .filter(Boolean);
  const missing=[];
  if(!project)missing.push(PREEMPTION_ENV_KEYS.project);
  if(!query)missing.push(PREEMPTION_ENV_KEYS.query);
  if(markers.length===0)missing.push(PREEMPTION_ENV_KEYS.markers);
  if(missing.length)return {ok:false,enabled:true,project,query,markers,reason:`Preemption is enabled but missing required configuration: ${missing.join(', ')}.`};
  return {ok:true,enabled:true,project,query,markers};
}

export function isPreemptionProjectDir(projectDir='',config=resolvePreemptionConfig()){
  const norm=String(projectDir||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  if(!norm)return false;
  return config.markers.some((marker)=>norm.includes(marker.toLowerCase()));
}

export async function checkSentryPreemption({projectDir='',allowPreemptionOverride=false,allowPreemptionOverrideAlias=false,legacyOverride=false,mode='start_task',options={}}={}){
  const env=options.env||process.env;
  const config=resolvePreemptionConfig(env);
  const useLegacyOverride=legacyOverride===true||allowPreemptionOverrideAlias===true;
  const deprecationWarning=useLegacyOverride
   ? `The legacy override flag is deprecated; use 'allowPreemptionOverride' instead.`
   : undefined;
  const clear={preempted:false,issues:[],alertText:'',response:null,deprecationWarning};
  if(!config.enabled)return clear;
  if(!config.ok){
   return {...clear,preempted:true,response:failed(`⚠️ ${config.reason} Task NOT started; no state was changed.`)};
  }
  if(allowPreemptionOverride===true||useLegacyOverride===true||isPreemptionProjectDir(projectDir,config))return clear;

  const isTestEnv=env.NODE_TEST_CONTEXT!==undefined||env.NODE_ENV==='test';
  if(isTestEnv&&!Object.hasOwn(options,'sentry'))return clear;
  const useCache=!Object.hasOwn(options,'sentry')&&Date.now()-preemptionCache.checkedAt<45000;
  let issues=[];
  if(useCache){
   issues=preemptionCache.issues;
  }else{
   try{
    const api=await clients(options);
    if(!api.sentry)return {...clear,preempted:true,response:failed(`⚠️ Preemption is configured but Sentry is unavailable; fail-closed. Task NOT started.`)};
    const queryFn=api.sentry.listIssuePage?()=>api.sentry.listIssuePage({query:config.query,limit:10,statsPeriod:'90d'}).then(r=>r.issues||[]):()=>api.sentry.listIssues({query:config.query,limit:10,statsPeriod:'90d'});
    const rows=await Promise.race([queryFn(),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),2500))]);
    issues=(Array.isArray(rows)?rows:[]).filter(item=>!item?.project?.slug||item.project.slug===config.project);
    if(!Object.hasOwn(options,'sentry'))preemptionCache={checkedAt:Date.now(),issues};
   }catch{
    return {...clear,preempted:true,response:failed(`⚠️ Preemption is configured but the Sentry query failed or timed out; fail-closed. Task NOT started.`)};
   }
  }
  if(!issues.length)return clear;
  const activeClaims=await collectActiveSessionClaims({ownSessionKey:options.ownSessionKey||'',stateFile:options.stateFile||'',env,fetchImpl:options.fetchImpl||fetch,timeoutMs:1500});
  if(activeClaims.length>0){
   issues=issues.filter(item=>!findMatchingActiveClaim({sentryIssueId:String(item?.id||''),shortId:String(item?.shortId||'')},activeClaims));
  }
  if(!issues.length)return clear;
  const list=issues.slice(0,5).map(i=>`  • ${i.shortId||i.id} (ID: ${i.id}, events: ${i.count||'1'}): ${i.title}${i.permalink?` — ${i.permalink}`:''}`).join('\n');
  const alertText=
   `🚨 SENTRY PREEMPTION ALERT (${issues.length} unresolved issue(s) on project ${config.project}):\n` +
   `${list}\n` +
   (isToolAllowedInProfile("checkpoint_task")
    ? `Action required: project ${config.project} overrides all other work. Checkpoint current work ('checkpoint_task') and start a bugfix task for ${config.project} with source: { system: "sentry", id: "${issues[0].id}" }.`
    : `Action required: project ${config.project} overrides all other work. Close or drop the current task first (checkpointing is not available in the active profile), then start a bugfix task for ${config.project} with source: { system: "sentry", id: "${issues[0].id}" }.`);
  if(mode==='start_task'){
   return {
    preempted:true,
    issues,
    alertText,
    deprecationWarning,
    response:failed(
     `🚨 SENTRY PREEMPTION GATE — Task refused for "${projectDir||'(unconfigured project)'}".\n\n` +
     `Project ${config.project} is Priority #1 whenever it has unresolved Sentry issues (${issues.length} active):\n` +
     `${list}\n\n` +
     `Required next action:\n` +
     `  1. Call 'start_task' for project ${config.project} with source: { system: "sentry", id: "${issues[0].id}" }\n` +
     `  2. Fix, test, deploy, and call 'complete_task'\n` +
     `  (Emergency override: pass allowPreemptionOverride: true on start_task)`
    ),
   };
  }
  return {preempted:true,issues,alertText,response:null,deprecationWarning};
}
