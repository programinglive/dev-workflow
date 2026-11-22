import {resolveZettlyConfig,createZettlyClient} from './zettly-client.js';
import {sanitize} from './security/sanitizer.js';
import {handoffGuard} from './tools/handler-modules/checkpoint-handlers.js';

const positive=value=>Number.isSafeInteger(value)&&value>0;
const text=(value,max=2500)=>typeof value==='string'?value.slice(0,max):'';
const fail=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const result=value=>({content:[{type:'text',text:JSON.stringify(sanitize(value))}]});
const focusMarker=id=>`<!-- dev-workflow-focus:${id} -->`;

async function context(args,options) {
 const config=options.client?null:await resolveZettlyConfig(options.env||process.env);
 const client=options.client||(config?createZettlyClient(config):null);
 if(!client)throw fail('FOCUS_NOT_CONFIGURED','Configure the managed Zettly owner before using focus tools.');
 const response=await client.request('GET','/user');
 const user=response.data||response;
 if(!positive(Number(user.id)))throw fail('FOCUS_INVALID_OWNER','Zettly did not return a valid owner.');
 const expected=args.expectedOwnerId??options.expectedUserId??config?.expectedUserId;
 if(expected!==undefined&&(!positive(expected)||Number(user.id)!==expected))throw fail('FOCUS_OWNER_MISMATCH','The configured MCP owner differs from the expected focus owner. Align accounts before writing.',{ownerId:Number(user.id),expectedOwnerId:expected});
 const owner={id:Number(user.id),name:text(user.name,120),email:text(user.email,180)};
 return {client,owner,base:config?.base||'https://zettly.programinglive.com'};
}

async function activeFocus(ctx) {
 const response=await ctx.client.request('GET','/focus');
 const rows=response.data;
 if(!Array.isArray(rows)||rows.length>1000)throw fail('FOCUS_INCOMPLETE','Focus collection is malformed or exceeds the bounded scan.');
 for(const row of rows)if(!positive(Number(row.id))||Number(row.user_id)!==ctx.owner.id||typeof row.title!=='string'||!Object.hasOwn(row,'completed_at')||(row.completed_at!==null&&(typeof row.completed_at!=='string'||!Number.isFinite(Date.parse(row.completed_at)))))throw fail('FOCUS_INVALID_DATA','Focus data has missing identity or belongs to another owner.');
 const active=rows.filter(row=>row.completed_at===null&&(row.status===undefined||row.status===null||row.status==='active'));
 return active;
}

async function activeFoci(ctx){return activeFocus(ctx);}

function projection(focus,ctx) {
 return focus?{id:Number(focus.id),ownerId:ctx.owner.id,title:text(focus.title,255),description:text(focus.description),url:ctx.base+'/dashboard'}:null;
}

function selected(foci,id) {
 const list=Array.isArray(foci)?foci:(foci?[foci]:[]);
 if(!list.length)throw fail('FOCUS_REQUIRED','Set one focus before starting or linking work.');
 if(!positive(id))throw fail('FOCUS_REQUIRED','Choose which active focus this work belongs to.');
 const match=list.find(focus=>Number(focus.id)===Number(id));
 if(!match)throw fail('FOCUS_CHANGED','The requested focus is not one of the active focuses.',{focusIds:list.slice(0,10).map(f=>f.id)});
 return match;
}

async function linkedTasks(ctx,id) {
 // The global Todo endpoint has no filter or pagination. On accounts with more
 // than 1000 Todos the bounded scan below is the only thing standing between an
 // unsafe completion and an incomplete answer. Zettly already exposes a
 // server-side filtered, owner-checked board per focus, so use it as the
 // authoritative source and keep the old scan only for servers that lack it.
 let rows;
 try {
  const response=await ctx.client.request('GET',`/focus/${id}/board`);
  if(response?.success===false)throw fail('FOCUS_TASK_SCAN_INCOMPLETE','The focus board was not accepted by Zettly.');
  const payload=response?.data;
  if(!payload||typeof payload!=='object'||!Array.isArray(payload.todos))throw fail('FOCUS_TASK_SCAN_INCOMPLETE','The focus board Todo collection is malformed.');
  rows=payload.todos;
 }catch(error){
  if(error?.status!==404&&error?.status!==405)throw error;
  const response=await ctx.client.request('GET','/todos?type=todo');
  rows=response.data;
 }
 if(!Array.isArray(rows)||rows.length>1000)throw fail('FOCUS_TASK_SCAN_INCOMPLETE','Cannot prove focus completion from an incomplete Todo collection.');
 const ids=new Set();
 for(const row of rows){if(!positive(Number(row.id))||Number(row.user_id)!==ctx.owner.id||typeof row.is_completed!=='boolean'||ids.has(Number(row.id)))throw fail('FOCUS_TASK_SCAN_INCOMPLETE','Todo identity or completion status is unavailable.');ids.add(Number(row.id));}
 return rows.filter(row=>Number(row.focus_id)===Number(id)||String(row.description||'').includes(focusMarker(id)));
}

export async function prepareTaskFocus(args,options={}) {
 const prepared={...args};delete prepared._verifiedFocus;
 const required=args.requireFocus===true||options.env?.DEVWF_REQUIRE_FOCUS==='1';
 if(!args.focusId&&!required)return {args:prepared};
 try {
  const ctx=await context(args,options);
  const all=await activeFoci(ctx);
  if(!args.focusId&&all.length>1)throw fail('FOCUS_AMBIGUOUS','Several focuses are active; pass focusId explicitly to choose which one this task belongs to.',{focusIds:all.slice(0,10).map(f=>f.id),focuses:all.slice(0,10).map(f=>projection(f,ctx))});
  const focus=selected(all,args.focusId||Number(all[0]?.id));
  return {args:{...prepared,_verifiedFocus:projection(focus,ctx)}};
 }catch(error){return {response:focusError(error)};}
}

export async function inspectFocusCompletionStatus(focusId,options={}) {
 const id=Number(focusId);
 if(!positive(id))return {checked:false};
 try {
  const ctx=await context({},options);
  const all=await activeFoci(ctx);
  const focus=all.find(item=>Number(item.id)===id);
  if(!focus)return {checked:true,focusId:id,title:'',active:false,total:0,completed:0,open:0,readyToClose:false};
  const tasks=await linkedTasks(ctx,id);
  const total=tasks.length;
  const completed=tasks.filter(task=>task.is_completed===true).length;
  const open=total-completed;
  return {checked:true,focusId:id,title:text(focus.title,255),active:true,total,completed,open,readyToClose:total>0&&open===0};
 }catch{
  return {checked:false};
 }
}

export function formatFocusClosureGuidance(status) {
 if(!status||status.checked!==true||!status.active)return '';
 const label=status.title?`Focus #${status.focusId} ("${status.title}")`:`Focus #${status.focusId}`;
 if(status.readyToClose){
  return (
   `\n\n🎯 Focus Ready to Close: ${label} now has 0 open tasks (${status.completed}/${status.total} completed).\n` +
   `   Call 'complete_focus' { focusId: ${status.focusId}, evidence: "<concrete verification evidence>" } before telling the user everything is finished, so this focus does not remain open on the Today dashboard with "Needs Next Action".\n` +
   `   (Keep it active only if you are immediately adding follow-up tasks to this focus.)`
  );
 }
 if(status.open>0){
  return `\n\n📌 ${label} still has ${status.open} open task(s) (${status.completed}/${status.total} completed); keeping focus active.`;
 }
 return '';
}

function focusError(error) {
 const known=typeof error.code==='string'&&/^FOCUS_[A-Z_]+$/.test(error.code);
 return {...result({error:known?error.code:'FOCUS_UNAVAILABLE',message:known?error.message:'The focus operation could not be verified. Read current focus before retrying.',...(known&&error.ownerId?{ownerId:error.ownerId,expectedOwnerId:error.expectedOwnerId}:{}),...(known&&error.focusIds?{focusIds:error.focusIds}:{}),...(known&&error.focuses?{activeFoci:error.focuses}:{})}),isError:true};
}

export async function handleFocusTool(name,args={},workflowState,options={}) {
 try {
  // A task handed over to another machine must not be silently worked on here.
  // get_current_focus is read-only, so the guard only reports the marker; it
  // does not clear it. Clearing requires the explicit acknowledge_handover.
  if(name==='get_current_focus'){
   const handoff=handoffGuard(workflowState?.state||{});
   if(handoff.handedOver){
    return result({
     owner:null,
     focus:null,
     status:'handed_over',
     handoff:{from:handoff.from,to:handoff.to,reason:handoff.reason,at:handoff.at},
     instruction:`This task was handed over to ${handoff.to}. Do not continue work here; if this machine should resume locally, call 'acknowledge_handover' first.`,
    });
   }
  }
  const ctx=await context(args,options);
  let all=await activeFoci(ctx);
  if(name==='get_current_focus'){
   const target=args.focusId?selected(all,args.focusId):all[0];
   return result({owner:ctx.owner,focus:projection(target,ctx),activeFoci:all.slice(0,50).map(f=>projection(f,ctx)),activeFocusCount:all.length,status:all.length?'active':'none',instruction:all.length>1?`Several focuses are active (${all.map(f=>f.id).join(', ')}). Pass the intended focusId explicitly so work is not attached to the wrong container.`:(all.length?'Keep work within this focus. Complete linked tasks and record evidence before closing it.':'Set a focus before starting work.')});
  }
  if(name==='set_focus') {
   const title=text(args.title,255).trim();
   if(!title||typeof args.title!=='string'||args.title.length>255)throw fail('FOCUS_INVALID_TITLE','Provide a focus title of 1–255 characters.');
   const sameFocus=all.find(item=>item.title===title);
   if(sameFocus)return result({owner:ctx.owner,focus:projection(sameFocus,ctx),activeFoci:all.slice(0,50).map(f=>projection(f,ctx)),activeFocusCount:all.length,reused:true});
   const created=await ctx.client.request('POST','/focus',{title,description:text(args.description,4000)});
   const id=Number(created.data?.id);
   all=await activeFoci(ctx);
   const createdFocus=selected(all,id);
   return result({owner:ctx.owner,focus:projection(createdFocus,ctx),activeFoci:all.slice(0,50).map(f=>projection(f,ctx)),activeFocusCount:all.length,created:true});
  }
  selected(all,args.focusId);
  if(name==='link_task_to_focus') {
   const state=workflowState?.state;
   const taskId=state?.workflowTaskId,todoId=Number(state?.zettly?.todoId);
   if(!taskId||!state.taskDescription||!positive(todoId))throw fail('FOCUS_TASK_REQUIRED','Start or resume a canonical workflow task before linking focus.');
   if(state.focus?.todoId===todoId&&state.focus.id!==args.focusId)throw fail('FOCUS_TASK_ALREADY_LINKED','The active task already belongs to another focus.');
   const unchanged=()=>workflowState.state===state&&state.workflowTaskId===taskId&&Number(state.zettly?.todoId)===todoId;
   const response=await ctx.client.request('GET','/todos/'+todoId);
   const todo=response.data||response;
   if(!unchanged())throw fail('FOCUS_TASK_CHANGED','The canonical task changed during focus verification.');
   if(Number(todo.id)!==todoId||Number(todo.user_id)!==ctx.owner.id)throw fail('FOCUS_TASK_OWNER_MISMATCH','The canonical Todo is not owned by the focus owner.');
   const description=typeof todo.description==='string'?todo.description:'';
   // A legacy marker is still honoured on read so a device that has not been
   // rolled out yet cannot silently lose its scope.
   const previous=description.match(/<!-- dev-workflow-focus:(\d+) -->/g)||[];
   if(previous.some(marker=>marker!==focusMarker(args.focusId)))throw fail('FOCUS_TASK_ALREADY_LINKED','This task is linked to another focus. Preserve its original scope.');
   const existingFocusId=todo.focus_id==null?null:Number(todo.focus_id);
   if(existingFocusId!==null&&existingFocusId!==Number(args.focusId))throw fail('FOCUS_TASK_ALREADY_LINKED','This task is linked to another focus. Preserve its original scope.');
   selected(await activeFoci(ctx),args.focusId);
   if(!unchanged())throw fail('FOCUS_TASK_CHANGED','The canonical task changed before focus linking.');
   if(existingFocusId===null) {
    // Write the real relation. The description marker was only ever a
    // stand-in for this column and is no longer written.
    const saved=await ctx.client.request('PATCH','/todos/'+todoId,{focus_id:Number(args.focusId)});
    if(Number(saved.data?.id)!==todoId)throw fail('FOCUS_LINK_UNVERIFIED','The Todo focus link could not be verified.');
    const readBack=await ctx.client.request('GET','/todos/'+todoId);
    if(Number(readBack.data?.id)!==todoId||Number(readBack.data?.user_id)!==ctx.owner.id||Number(readBack.data?.focus_id)!==Number(args.focusId))throw fail('FOCUS_LINK_UNVERIFIED','The saved focus link was not present on readback.');
   }
   selected(await activeFoci(ctx),args.focusId);
   if(!unchanged())throw fail('FOCUS_TASK_CHANGED','The canonical task changed after the remote focus link was saved. Read both records before retrying.');
   const old=state.focus;
   const attachment={...projection(selected(all,args.focusId),ctx),todoId};state.focus=attachment;
   try {
    const saved=await workflowState.save();
    if(saved?.verified===false||!unchanged())throw fail('FOCUS_STATE_UNVERIFIED','The remote focus link exists but local task attachment was not verified.');
   }catch(error){if(workflowState.state===state&&state.focus===attachment){if(!unchanged()||old===undefined)delete state.focus;else state.focus=old;}throw error;}
   return result({owner:ctx.owner,focus:attachment,todoId,workflowTaskId:taskId,linked:true});
  }
  if(name==='complete_focus') {
   const evidence=text(args.evidence,1000).trim();
   if(evidence.length<10||typeof args.evidence!=='string'||args.evidence.length>1000)throw fail('FOCUS_EVIDENCE_REQUIRED','Provide concrete completion evidence, up to 1,000 characters.');
   const local=workflowState?.state;
   if(local?.taskDescription&&local.currentPhase!=='idle'&&(!local.focus?.id||Number(local.focus.id)===Number(args.focusId)))throw fail('FOCUS_WORKFLOW_OPEN','Complete the active workflow task before closing its focus.');
   const tasks=await linkedTasks(ctx,args.focusId);
   if(!tasks.length)throw fail('FOCUS_NO_LINKED_TASKS','Link and complete actual work before closing this focus.');
   if(tasks.some(t=>!t.is_completed))throw fail('FOCUS_OPEN_TASKS','Linked tasks are still open; finish them before closing the focus.');
   selected(await activeFoci(ctx),args.focusId);
   const rechecked=await linkedTasks(ctx,args.focusId);
   if(rechecked.length!==tasks.length||rechecked.some(t=>!t.is_completed))throw fail('FOCUS_TASKS_CHANGED','Focus tasks changed during completion checks.');
   const closed=await ctx.client.request('POST','/focus/'+args.focusId+'/complete',{reason:evidence});
   if(closed.success===false||Number(closed.data?.id)!==args.focusId||Number(closed.data?.user_id)!==ctx.owner.id||typeof closed.data?.completed_at!=='string'||!Number.isFinite(Date.parse(closed.data.completed_at)))throw fail('FOCUS_COMPLETION_UNVERIFIED','Focus completion was not accepted with a verified completed record.');
   const remaining=await activeFoci(ctx);
   if(remaining.some(item=>Number(item.id)===Number(args.focusId)))throw fail('FOCUS_COMPLETION_UNVERIFIED','The focus still appears active after completion.');
   const after=await linkedTasks(ctx,args.focusId);
   if(after.some(t=>!t.is_completed)||after.length!==rechecked.length)throw fail('FOCUS_COMPLETION_CONFLICT','Focus completion raced with task changes. Inspect the records before setting another focus.');
   return result({owner:ctx.owner,focusId:args.focusId,completed:true,linkedTaskIds:after.map(t=>t.id),evidence,nextAction:'Set the next focus only after reviewing this recorded outcome.'});
  }
  throw fail('FOCUS_UNKNOWN_TOOL','Unknown focus operation.');
 }catch(error){return focusError(error);}
}

export const focusToolDefinitions=[
 {name:'get_current_focus',description:'Read the configured Zettly owner and active focuses. Multiple focuses can be active concurrently; inspect activeFoci list or pass focusId to view a specific container. Never assume browser and MCP accounts match. No writes.',inputSchema:{type:'object',properties:{focusId:{type:'integer',minimum:1,description:'Optional specific focus ID to view as primary focus; if omitted, returns all active foci in activeFoci and the default active focus.'},expectedOwnerId:{type:'integer',minimum:1}},additionalProperties:false}},
 {name:'set_focus',description:'Create a new active Zettly focus or reuse an existing active focus by title. Multiple focuses can be active concurrently. Never mutates or replaces other active focuses. Read back after creation.',inputSchema:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:255},description:{type:'string',maxLength:4000},expectedOwnerId:{type:'integer',minimum:1}},required:['title'],additionalProperties:false}},
 {name:'link_task_to_focus',description:'Link the active canonical workflow Todo to the selected active focus by focusId, preserving source identity and owner text. Rejects relinking to another focus.',inputSchema:{type:'object',properties:{focusId:{type:'integer',minimum:1,description:'Target active focus ID to link this task to.'},expectedOwnerId:{type:'integer',minimum:1}},required:['focusId'],additionalProperties:false}},
 {name:'complete_focus',description:'Complete a specific active focus by focusId only after the local workflow (if linked to this focus) and all linked Todos are finished and concrete evidence is supplied. Does not affect other active focuses.',inputSchema:{type:'object',properties:{focusId:{type:'integer',minimum:1,description:'Target active focus ID to complete.'},evidence:{type:'string',minLength:10,maxLength:1000,description:'Concrete verification evidence proving focus completion.'},expectedOwnerId:{type:'integer',minimum:1}},required:['focusId','evidence'],additionalProperties:false}}
];
