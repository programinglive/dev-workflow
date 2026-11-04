import {createHash,randomUUID} from 'node:crypto';
import {sanitize} from './security/sanitizer.js';
import {normalizeProjectPath} from './db/session-key.js';
import {StateConflict} from './db/errors.js';
import {createZettlyClient,resolveZettlyConfig,zettlySyncEnabled} from './zettly-client.js';
import {validateTaskSource,originForTask,buildTaskProvenance} from './task-provenance.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TERMINAL=['completed','cancelled','closed_with_exceptions'];

export function validateZettlyTaskArguments(args={}) {
  const sourceError=validateTaskSource(args.source,args.zettlyTodoId);if(sourceError)return sourceError;
  if(args.taskId!==undefined&&(typeof args.taskId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(args.taskId)))return 'Invalid canonical taskId: use 3–128 letters, digits, dots, underscores, colons or hyphens.';
  if(args.zettlyTodoId!==undefined&&(!Number.isSafeInteger(args.zettlyTodoId)||args.zettlyTodoId<1))return 'Invalid zettlyTodoId: a positive integer is required.';
  return null;
}

export function assignWorkflowIdentity(state,previous,args={}) {
  const same=previous?.taskDescription===state.taskDescription&&normalizeProjectPath(previous?.projectDir||'')===normalizeProjectPath(state.projectDir||'')&&(!args.taskId||args.taskId===previous?.workflowTaskId);
  state.workflowTaskId=args.taskId||(same&&previous.workflowTaskId)||randomUUID();
  state.zettly=(same&&previous.zettly)?structuredClone(previous.zettly):{taskId:state.workflowTaskId,todoId:null};
  state.zettly.taskId=state.workflowTaskId;
  if(args.zettlyTodoId)state.zettly.todoId=Number(args.zettlyTodoId);
  if(args.source?.system==='zettly')state.zettly.todoId=Number(args.source.id);
  if(state.zettlyContext&&Number(state.zettlyContext.todoId)!==Number(state.zettly.todoId))state.zettlyContext=null;
  state.taskOrigin=originForTask(args,same?previous:null);
  if(args.source?.system==='sentry'&&args.verifiedSourceIssue?.issueId===args.source.id)state.zettly.externalLinks={...state.zettly.externalLinks,sentry:structuredClone(args.verifiedSourceIssue)};
}

function ownershipGuard(workflowState) {
  const owner=workflowState.state;
  const taskId=owner.workflowTaskId;
  return ()=>{
    if(workflowState.state!==owner||workflowState.state.workflowTaskId!==taskId||workflowState.lastConflict) {
      throw new StateConflict('Workflow state changed during Zettly synchronization; remote writes were stopped.',{sessionKey:workflowState.sessionId||''});
    }
  };
}
async function persist(workflowState,guard) {
  guard();
  const result=await workflowState.save();
  if(result?.verified===false||result?.conflict)throw new StateConflict('Zettly synchronization intent was not persisted; remote writes were stopped.',{sessionKey:workflowState.sessionId||''});
  guard();
}
function checkedClient(client,guard) {
  return {async request(...args){guard();try{return await client.request(...args);}finally{guard();}}};
}
function isStateFailure(error) {return ['STATE_CONFLICT','STATE_UNAVAILABLE','SECRET_CONTENT_DENIED'].includes(error?.code);}

function ensureIdentity(state) {
  if(!state.workflowTaskId)state.workflowTaskId='workflow-'+hash([state.taskDescription,state.projectDir,state.taskStartedAt||'']).slice(0,32);
  state.zettly||={taskId:state.workflowTaskId,todoId:null};
  state.zettly.taskId=state.workflowTaskId;
}
async function clientFor(options) {
  if(options.client)return options.client;
  const config=await resolveZettlyConfig(options.env||process.env);
  return config?createZettlyClient(config):null;
}
function pending(state,error) {
  state.zettly.pending=true;
  state.zettly.lastError=error.code==='ZETTLY_ACCOUNT_MISMATCH'?'Zettly account does not match the configured owner':error.status?`Zettly HTTP ${error.status}`:error.uncertain?'Zettly creation result is uncertain':'Zettly synchronization unavailable';
  state.zettly.lastAttemptAt=Date.now();
  return {ok:false,note:`Zettly sync pending: ${state.zettly.lastError}. Retry with sync_zettly_task; do not create a duplicate Todo.`};
}
function blockFor(state,status,args={}) {
  const safe=sanitize({task:state.taskDescription,project:state.projectDir,phase:status,plan:state.plan||[],dod:state.definitionOfDone||[],commit:args.commitMessage||state.lastCommitMessage||'',next:args.nextSteps||[],reason:args.reason||''});
  const id=escape(state.workflowTaskId);
  const plan=safe.plan.map(item=>`[${item.status==='done'?'x':' '}] ${item.text}`).join('\n');
  const dod=safe.dod.map(item=>`[${item.status==='done'?'x':item.status==='waived'?'-':' '}] ${item.text}${item.evidence?' — '+item.evidence:''}`).join('\n');
  const links=externalLinkSummary(state);
  return `<!-- dev-workflow:${id}:start --><section data-dev-workflow-id="${id}"><h3>Dev Workflow</h3><p>Task ID: <code>${id}</code></p><p>Project: ${escape(safe.project)}</p><p>Status: ${escape(status)}</p><p>Implementation language: English</p>${links?`<h4>Connected work</h4><pre>${escape(links)}</pre>`:''}<h4>Plan</h4><pre>${escape(plan)}</pre><h4>Definition of done</h4><pre>${escape(dod)}</pre>${safe.commit?`<p>Commit: ${escape(safe.commit)}</p>`:''}${safe.reason?`<p>Reason: ${escape(safe.reason)}</p>`:''}${safe.next.length?`<h4>Next action</h4><pre>${escape(safe.next.join('\n'))}</pre>`:''}</section><!-- dev-workflow:${id}:end -->`;
}
function externalLinkSummary(state) {
  const links=sanitize(state.zettly?.externalLinks||{});
  const provenance=buildTaskProvenance(state);
  return [`Source: ${provenance.taskOrigin.system}${provenance.taskOrigin.id?` ${provenance.taskOrigin.id}`:''}`,links.sentry?`Sentry: ${links.sentry.shortId||links.sentry.issueId} ${links.sentry.url||''}`:'',links.factory?`Factory: ${links.factory.taskKey||links.factory.id} (${links.factory.id})`:''].filter(Boolean).join('\n');
}
function mergeBlock(description,state,block) {
  const id=state.workflowTaskId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const without=String(description||'').replace(new RegExp(`<!-- dev-workflow:${id}:start -->[\\s\\S]*?<!-- dev-workflow:${id}:end -->`,'g'),'').trim();
  return without?without+'\n\n'+block:block;
}
async function syncState(workflowState,state,status,args,options) {
  ensureIdentity(state);
  const guard=ownershipGuard(workflowState);
  const sourceClient=await clientFor(options);
  guard();
  if(!sourceClient){const result=pending(state,new Error('Not configured'));result.note='Zettly sync pending: configure the existing authenticated Zettly client. No Todo was created.';await persist(workflowState,guard);return result;}
  const client=checkedClient(sourceClient,guard);
  if(options.todoId){if(Number(state.zettly.todoId)!==Number(options.todoId))state.zettlyContext=null;state.zettly.todoId=Number(options.todoId);}
  const block=blockFor(state,status,args);
  const payloadHash=hash([block,status]);
  if(!options.force&&Number.isSafeInteger(state.zettly.todoId)&&state.zettly.todoId>0&&state.zettly.lastPayloadHash===payloadHash&&!state.zettly.pending)return {ok:true,note:`Zettly Todo #${state.zettly.todoId} is linked.`};
  try {
    let todo;
    if(state.zettly.todoId) {
      const response=await client.request('GET',`/todos/${state.zettly.todoId}`);todo=response.data;
    } else {
      const response=await client.request('GET','/todos');
      const marker=`data-dev-workflow-id="${escape(state.workflowTaskId)}"`;
      todo=(response.data||[]).find(item=>String(item.description||'').includes(marker));
      if(!todo) {
        if(state.zettly.createAttempted)throw Object.assign(new Error('Creation uncertain'),{uncertain:true});
        state.zettly.createAttempted=true;
        await persist(workflowState,guard);
        let created;
        try {created=await client.request('POST','/todos',{type:'todo',title:String(sanitize(state.taskDescription)).slice(0,255),description:block});}
        catch(error){if(error.status&&error.status<500)state.zettly.createAttempted=false;throw error;}
        todo=created.data;
        if(!Number.isSafeInteger(Number(todo?.id))||Number(todo.id)<1)throw Object.assign(new Error('Missing Todo ID'),{uncertain:true});
      }
      state.zettly.todoId=Number(todo.id);
      await persist(workflowState,guard);
    }
    if(!todo||Number(todo.id)!==Number(state.zettly.todoId))throw new Error('Todo mismatch');
    const description=mergeBlock(todo.description,state,block);
    const body={description,...(status==='completed'?{is_completed:true}:{})};
    if(todo.description!==description||(status==='completed'&&!todo.is_completed))await client.request('PATCH',`/todos/${todo.id}`,body);
    state.zettly.pending=false;state.zettly.lastError='';state.zettly.lastPayloadHash=payloadHash;
    if(todo.user_id)state.zettly.accountId=Number(todo.user_id);
    await persist(workflowState,guard);
    return {ok:true,note:`Zettly Todo #${todo.id} synchronized (${status}).`,todoId:Number(todo.id)};
  } catch(error) {if(isStateFailure(error))throw error;const result=pending(state,error);await persist(workflowState,guard);return result;}
}

export async function syncZettlyTask(workflowState,options={}) {
  if(!zettlySyncEnabled(options.env||process.env))return {ok:true,disabled:true,note:''};
  if(options.todoId!==undefined&&(!Number.isSafeInteger(options.todoId)||options.todoId<1))return {ok:false,note:'Invalid Zettly Todo ID: a positive integer is required.'};
  const state=workflowState.state;
  if(!state.taskDescription)return {ok:true,note:''};
  return syncState(workflowState,state,state.currentPhase||'coding',{},options);
}
function outcomeContent(state,status,args) {
  const safe=sanitize({task:state.taskDescription,project:state.projectDir,commit:args.commitMessage||state.lastCommitMessage||'',dod:state.definitionOfDone||[],files:state.documentationFiles||[],next:args.nextSteps||[],reason:args.reason||''});
  return [`[Dev Workflow outcome ID: ${state.workflowTaskId}; status: ${status}]`,`Status: ${status}`,`Task: ${safe.task}`,`Project: ${safe.project}`,`Commit: ${safe.commit}`,`Documentation: ${safe.files.join(', ')}`,externalLinkSummary(state),...safe.dod.map(item=>`${item.status}: ${item.text}${item.evidence?' — '+item.evidence:''}`),safe.reason?`Reason: ${safe.reason}`:'',safe.next.length?`Next action: ${safe.next.join('; ')}`:''].filter(Boolean).join('\n');
}
async function flushItem(workflowState,item,options) {
  const guard=ownershipGuard(workflowState);
  const result=await syncState(workflowState,item.snapshot,item.status,item.args,options);
  if(!result.ok)return result;
  const client=checkedClient(await clientFor(options),guard);
  const date=item.createdAt.slice(0,10);
  try {
    const marker=`[Dev Workflow outcome ID: ${item.snapshot.workflowTaskId}; status: ${item.status}]`;
    const existing=await client.request('GET',`/journal/entries?date=${date}&kind=outcome`);
    const found=(existing.data||[]).find(entry=>String(entry.content||'').includes(marker)&&Number(entry.todo_id)===Number(item.snapshot.zettly.todoId));
    let journalId=found?.id;
    if(!found) {
      if(item.journalAttempted)throw Object.assign(new Error('Journal creation uncertain'),{uncertain:true});
      item.journalAttempted=true;await persist(workflowState,guard);
      try {
        const response=await client.request('POST','/journal/entries',{entry_date:date,kind:'outcome',source:'mcp',todo_id:item.snapshot.zettly.todoId,content:outcomeContent(item.snapshot,item.status,item.args)});
        if(!Number.isSafeInteger(Number(response.data?.id))||Number(response.data.id)<1||Number(response.data.todo_id)!==Number(item.snapshot.zettly.todoId))throw Object.assign(new Error('Invalid journal acknowledgement'),{uncertain:true});
        journalId=Number(response.data.id);
      }
      catch(error){if(error.status&&error.status<500)item.journalAttempted=false;throw error;}
    }
    return {ok:true,journalId,note:`Zettly Todo #${item.snapshot.zettly.todoId} and linked outcome #${journalId} synchronized (${item.status}).`};
  } catch(error) {if(isStateFailure(error))throw error;const failed=pending(item.snapshot,error);await persist(workflowState,guard);return failed;}
}
export async function closeZettlyTask(workflowState,status,args={},options={}) {
  if(!zettlySyncEnabled(options.env||process.env))return {ok:true,disabled:true,note:''};
  if(!TERMINAL.includes(status)||!workflowState.state.taskDescription)return {ok:true,note:''};
  ensureIdentity(workflowState.state);
  const guard=ownershipGuard(workflowState);
  const queue=workflowState.state.zettlyOutbox||=[];
  let item=queue.find(entry=>entry.snapshot.workflowTaskId===workflowState.state.workflowTaskId);
  const state=workflowState.state;
  const snapshot=structuredClone({taskDescription:state.taskDescription,taskType:state.taskType,projectDir:state.projectDir,taskStartedAt:state.taskStartedAt,workflowTaskId:state.workflowTaskId,zettly:state.zettly,definitionOfDone:state.definitionOfDone||[],plan:state.plan||[],documentationFiles:state.documentationFiles||[],lastCommitMessage:state.lastCommitMessage});
  if(!item){item={snapshot,status,args:structuredClone(args),createdAt:new Date().toISOString()};queue.push(item);}
  else {
    const queuedLink=item.snapshot.zettly||{};
    const freshLink=snapshot.zettly||{};
    const explicitlyRelinked=!!freshLink.todoId&&!!queuedLink.todoId&&freshLink.todoId!==queuedLink.todoId;
    // Terminal synchronization may discover a remote identity before active
    // state has one. Refreshing evidence must not erase that identity or turn
    // an unacknowledged POST into permission to issue another POST.
    if(!freshLink.todoId)snapshot.zettly={...freshLink,...queuedLink};
    const changed=item.status!==status||explicitlyRelinked;
    Object.assign(item,{snapshot,status,args:structuredClone(args)});
    if(changed){item.journalAttempted=false;item.createdAt=new Date().toISOString();}
  }
  await persist(workflowState,guard);
  const result=await flushItem(workflowState,item,options);
  if(result.ok){workflowState.state.zettlyOutbox=queue.filter(entry=>entry!==item);await persist(workflowState,guard);}
  return result;
}
export async function flushZettlyOutbox(workflowState,options={}) {
  if(!zettlySyncEnabled(options.env||process.env))return {ok:true,disabled:true,note:''};
  const guard=ownershipGuard(workflowState);
  const queue=workflowState.state.zettlyOutbox||=[];const notes=[];let ok=true;
  for(const item of [...queue]){
    const result=await flushItem(workflowState,item,options);notes.push(result.note);
    if(result.ok)workflowState.state.zettlyOutbox=workflowState.state.zettlyOutbox.filter(entry=>entry!==item);
    else ok=false;
    await persist(workflowState,guard);
  }
  return {ok,note:notes.filter(Boolean).join('\n')};
}
