import {textResponse} from './shared.js';
import {readSentryConfig,createSentryClient} from '../../sentry-client.js';
import {resolveZettlyConfig,createZettlyClient} from '../../zettly-client.js';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {sanitize} from '../../security/sanitizer.js';
import {readZettlyTaskContext} from '../../zettly-context.js';
import {drawingMatchesWorkflow} from '../../zettly-drawing.js';

const failed=message=>({...textResponse(message),isError:true});
const json=value=>textResponse(JSON.stringify(value));
const issueId=value=>typeof value==='string'&&/^\d{1,30}$/.test(value);
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
  if(name==='list_sentry_issues')return json(api.sentry.listIssuePage?await api.sentry.listIssuePage(args):await api.sentry.listIssues(args));
  if(name==='inventory_sentry_issues'){
    if(!workflowState?.stateFile)return failed('A device-local workflow state file is required to save an inventory snapshot.');
    const inventory=await api.sentry.inventoryIssues(args);
    const directory=path.join(path.dirname(workflowState.stateFile),'sentry-inventory');
    await mkdir(directory,{recursive:true,mode:0o700});
    const snapshotPath=path.join(directory,'inventory-'+randomUUID()+'.json');
    await writeFile(snapshotPath,JSON.stringify(sanitize(inventory),null,2)+'\n',{mode:0o600,flag:'wx'});
    return json({organization:inventory.organization,complete:inventory.complete,scope:inventory.scope,projectCount:inventory.projects.length,issueCount:inventory.issues.length,totalHits:inventory.totalHits,projects:inventory.projects,nextCursor:inventory.nextCursor,projectCursor:inventory.projectCursor,inconsistencies:inventory.inconsistencies,snapshotPath});
  }
  if(!issueId(args.issueId))return failed('Provide a numeric Sentry issueId.');
  if(name==='get_sentry_issue')return json(await api.sentry.getIssue(args.issueId));
  if(name!=='link_sentry_issue')return failed('Unknown integration tool.');
  const state=workflowState?.state;
  if(!state?.workflowTaskId||!state.taskDescription||!Number.isSafeInteger(state.zettly?.todoId)||state.zettly.todoId<1)return failed('Start or resume a canonical workflow task with a linked Zettly Todo before linking an issue.');
  const taskIdentity=state.workflowTaskId;
  const guard=()=>{if(workflowState.state!==state||state.workflowTaskId!==taskIdentity||workflowState.lastConflict)throw Error('Task ownership changed');};
  const source=await api.sentry.getIssue(args.issueId);guard();
  if(source.id!==args.issueId)throw Error('Source identity changed');
  const previous=state.zettly.externalLinks;
  state.zettly.externalLinks={sentry:{organization:String(api.sentry.organization||'').slice(0,100),issueId:source.id,shortId:String(source.shortId||'').slice(0,100),url:source.permalink||''}};
  try{
   guard();const result=await workflowState.save();guard();
   if(result?.verified===false||result?.conflict)throw Error('Task link persistence was not verified');
  }catch(error){if(workflowState.state===state){if(previous===undefined)delete state.zettly.externalLinks;else state.zettly.externalLinks=previous;}throw error;}
  return textResponse(`Verified Sentry issue ${source.shortId||source.id} linked to the existing Zettly Todo #${state.zettly.todoId}. No new task was created.`);
 }catch(error){return failed(`Integration request failed${Number.isInteger(error.status)?` (HTTP ${error.status})`:''}. Check the configured account, source IDs, service availability and workflow ownership before retrying. No provider error body was returned.`);}
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
