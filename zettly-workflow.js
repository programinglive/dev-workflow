/**
 * @zettly-code DWF-TOOL-PROFILES-018
 * @purpose Report a pending Zettly sync without naming a retry tool the active profile hides.
 */
import {createHash,randomUUID} from 'node:crypto';
import {isToolAllowedInProfile} from './src/tool-profiles.js';
import {sanitize} from './security/sanitizer.js';
import {normalizeProjectPath} from './db/session-key.js';
import {StateConflict} from './db/errors.js';
import {createZettlyClient,resolveZettlyConfig,zettlySyncEnabled} from './zettly-client.js';
import {validateTaskSource,originForTask,buildTaskProvenance} from './task-provenance.js';
import {renderAiSessions} from './ai-sessions.js';
import {renderCheckpointElement} from './tools/handler-modules/checkpoint-block.js';
import {deriveTags,ensureTags} from './zettly-tags.js';

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
  if(!same&&previous?.taskDescription){
    state.parentTask={
      id:previous.workflowTaskId||'',
      description:previous.taskDescription,
      title:previous.taskDescription,
      todoId:previous.zettly?.todoId||null
    };
  }else if(same&&previous?.parentTask){
    state.parentTask=structuredClone(previous.parentTask);
  }else{
    state.parentTask=null;
  }
  state.zettly=(same&&previous.zettly)?structuredClone(previous.zettly):{taskId:state.workflowTaskId,todoId:null};
  state.zettly.taskId=state.workflowTaskId;
  if(args.zettlyTodoId)state.zettly.todoId=Number(args.zettlyTodoId);
  if(args.source?.system==='zettly')state.zettly.todoId=Number(args.source.id);
  if(state.zettlyContext&&Number(state.zettlyContext.todoId)!==Number(state.zettly.todoId))state.zettlyContext=null;
  state.focus=args._verifiedFocus?structuredClone(args._verifiedFocus):same&&previous?.focus&&Number(previous.focus.todoId)===Number(state.zettly.todoId)?structuredClone(previous.focus):null;
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
  return {ok:false,note:`Zettly sync pending: ${state.zettly.lastError}. ` +
    (isToolAllowedInProfile('sync_zettly_task')
      ? `Retry with sync_zettly_task; do not create a duplicate Todo.`
      : `Do not create a duplicate Todo.`)};
}
function blockFor(state,status,args={}) {
  const safe=sanitize({task:state.taskDescription,project:state.projectDir,phase:status,plan:state.plan||[],dod:state.definitionOfDone||[],commit:args.commitMessage||state.lastCommitMessage||'',next:args.nextSteps||[],reason:args.reason||''});
  const id=escape(state.workflowTaskId);
  const plan=safe.plan.map(item=>`[${item.status==='done'?'x':' '}] ${item.text}`).join('\n');
  const dod=safe.dod.map(item=>`[${item.status==='done'?'x':item.status==='waived'?'-':' '}] ${item.text}${item.evidence?' — '+item.evidence:''}`).join('\n');
  const refinement=sanitize(state.refinement||{});
  const bug=refinement.bugContext?`Symptom: ${refinement.bugContext.symptom}\nReproduction: ${refinement.bugContext.reproduction.join(' -> ')}\nObserved: ${refinement.bugContext.observed}\nExpected: ${refinement.bugContext.expected}\nEvidence: ${refinement.bugContext.evidence}\nConstraints: ${refinement.bugContext.constraints}`:'';
  const links=externalLinkSummary(state);
  const sessions=renderAiSessions(state);
  // The checkpoint element travels inside the same block so mergeBlock keeps it.
  // Its fields (machine, baseSha, commits, handover) are what another machine
  // needs; the human-readable Plan/DoD above stay for people reading Zettly.
  const checkpoint=renderCheckpointElement(state.workflowTaskId,{
    machine:state.machine??null,
    checkpointedAt:state.checkpoint?.checkpointedAt??null,
    summary:state.checkpoint?.summary??'',
    baseSha:state.checkpoint?.baseSha??null,
    commits:state.checkpoint?.commits??[],
    handover:state.checkpoint?.handover??null,
  });
  return `<!-- dev-workflow:${id}:start --><section data-dev-workflow-id="${id}"><h3>Dev Workflow</h3><p>Task ID: <code>${id}</code></p><p>Project: ${escape(safe.project)}</p><p>Status: ${escape(status)}</p><p>Implementation language: English</p>${links?`<h4>Connected work</h4><pre>${escape(links)}</pre>`:''}${sessions.length?`<h4>AI sessions</h4><pre>${escape(sessions.join('\n'))}</pre>`:''}${refinement.context?`<h4>Refined task context</h4><pre>${escape(refinement.context)}</pre>`:''}${bug?`<h4>Bug investigation</h4><pre>${escape(bug)}</pre>`:''}<h4>Plan</h4><pre>${escape(plan)}</pre><h4>Definition of done</h4><pre>${escape(dod)}</pre>${safe.commit?`<p>Commit: ${escape(safe.commit)}</p>`:''}${safe.reason?`<p>Reason: ${escape(safe.reason)}</p>`:''}${safe.next.length?`<h4>Next action</h4><pre>${escape(safe.next.join('\n'))}</pre>`:''}${checkpoint}</section><!-- dev-workflow:${id}:end -->`;
}
function externalLinkSummary(state) {
  const links=sanitize(state.zettly?.externalLinks||{});
  const provenance=buildTaskProvenance(state);
  return [`Source: ${provenance.taskOrigin.system}${provenance.taskOrigin.id?` ${provenance.taskOrigin.id}`:''}`,links.sentry?`Sentry: ${links.sentry.shortId||links.sentry.issueId} ${links.sentry.url||''}`:'',links.drawing?`Zettly Draw: ${links.drawing.url||`https://zettly.programinglive.com/draw/${links.drawing.id}`}`:''].filter(Boolean).join('\n');
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
        try {
          const tagNames=deriveTags({taskDescription:state.taskDescription,taskType:state.taskType,projectDir:state.projectDir,taskOrigin:buildTaskProvenance(state)});
          const tagIds=await ensureTags({client,names:tagNames});
          created=await client.request('POST','/todos',{type:'todo',title:String(sanitize(state.taskDescription)).slice(0,255),description:block,...(state.focus?.id?{focus_id:Number(state.focus.id)}:{}),...(tagIds.length?{tag_ids:tagIds}:{})});
        }
        catch(error){if(error.status&&error.status<500)state.zettly.createAttempted=false;throw error;}
        todo=created.data;
        if(!Number.isSafeInteger(Number(todo?.id))||Number(todo.id)<1)throw Object.assign(new Error('Missing Todo ID'),{uncertain:true});
      }
      state.zettly.todoId=Number(todo.id);
      await persist(workflowState,guard);
    }
    if(!todo||Number(todo.id)!==Number(state.zettly.todoId))throw new Error('Todo mismatch');
    const description=mergeBlock(todo.description,state,block);
    const isTerminal=TERMINAL.includes(status);
    const allDodProven=Array.isArray(state.definitionOfDone)&&state.definitionOfDone.length>0&&state.definitionOfDone.every(item=>item.status==='done'||item.status==='waived');
    const shouldComplete=status==='completed'||(status==='closed_with_exceptions'&&allDodProven);
    const body={description,...(shouldComplete?{is_completed:true}:{})};
    if(todo.description!==description||(shouldComplete&&!todo.is_completed))await client.request('PATCH',`/todos/${todo.id}`,body);
    if(!isTerminal&&state.focus?.id&&!state.zettly.priorityPromoted&&options.env?.NODE_TEST_CONTEXT===undefined&&!options.client){
      state.zettly.priorityPromoted=true;
      const isUrgent=state.taskType==='bugfix'||/\b(urgent|p0|hotfix|incident|security|critical|blocker|broken|outage)\b/i.test(String(state.currentTask||''));
      try{await client.request('PATCH',`/todos/${todo.id}`,{importance:'important',priority:isUrgent?'urgent':'not_urgent'});}catch{}
      try{await client.request('PATCH',`/todos/${todo.id}/queue-state`,{queue_state:'backlog',reason:'Active dev-workflow task auto-triaged (Pareto 80/20)'});}catch{}
      try{await client.request('POST','/priority/main-work',{target_type:'focus',target_id:Number(state.focus.id),reason:'Active dev-workflow focus (Pareto 80/20)'});}catch{}
      try{await client.request('POST','/priority/plan/items',{todo_id:Number(todo.id),reason:'Active dev-workflow task committed for today (Pareto 80/20)',allow_over_capacity:true});}catch{}
    }
    state.zettly.pending=false;state.zettly.lastError='';state.zettly.lastPayloadHash=payloadHash;
    if(todo.user_id)state.zettly.accountId=Number(todo.user_id);
    await persist(workflowState,guard);
    return {ok:true,note:`Zettly Todo #${todo.id} synchronized (${status}).`,todoId:Number(todo.id)};
  } catch(error) {if(isStateFailure(error))throw error;const result=pending(state,error);await persist(workflowState,guard);return result;}
}

export async function syncZettlyTask(workflowState,options={}) {
  // An explicitly injected client already chose its transport; only the
  // self-resolving path is gated by the sync flag and the test context.
  if(!options.client&&!zettlySyncEnabled(options.env||process.env))return {ok:true,disabled:true,note:''};
  if(options.todoId!==undefined&&(!Number.isSafeInteger(options.todoId)||options.todoId<1))return {ok:false,note:'Invalid Zettly Todo ID: a positive integer is required.'};
  const state=workflowState.state;
  if(!state.taskDescription)return {ok:true,note:''};
  return syncState(workflowState,state,state.currentPhase||'coding',{},options);
}
function outcomeContent(state,status,args) {
  const safe=sanitize({task:state.taskDescription,project:state.projectDir,commit:args.commitMessage||state.lastCommitMessage||'',dod:state.definitionOfDone||[],files:state.documentationFiles||[],next:args.nextSteps||[],reason:args.reason||''});
  const sessions=renderAiSessions(state);
  return [`[Dev Workflow outcome ID: ${state.workflowTaskId}; status: ${status}]`,`Status: ${status}`,`Task: ${safe.task}`,`Project: ${safe.project}`,`Commit: ${safe.commit}`,`Documentation: ${safe.files.join(', ')}`,externalLinkSummary(state),...sessions.map(line=>`AI session: ${line}`),...safe.dod.map(item=>`${item.status}: ${item.text}${item.evidence?' — '+item.evidence:''}`),safe.reason?`Reason: ${safe.reason}`:'',safe.next.length?`Next action: ${safe.next.join('; ')}`:''].filter(Boolean).join('\n');
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
