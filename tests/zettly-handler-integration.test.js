import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleToolCall} from '../tools/handlers.js';
import {withWorkflowState,testUtils,createRequest,createGitMock} from './test-helpers.js';

function mockApi() {
 const tasks=new Map(),journals=[];
 return {tasks,journals,async request(method,route,body){
  if(method==='GET'&&route==='/todos')return {data:[...tasks.values()]};
  if(method==='GET'&&route.startsWith('/todos?type='))return {data:[...tasks.values()].filter(task=>task.type===route.split('=').pop())};
  if(method==='POST'&&route==='/todos'){const item={id:tasks.size+1,is_completed:false,...body};tasks.set(item.id,item);return {data:structuredClone(item)};}
  if(route.startsWith('/todos/')){const item=tasks.get(Number(route.split('/').pop()));if(method==='PATCH')Object.assign(item,body);return {data:structuredClone(item)};}
  if(method==='GET'&&route.startsWith('/journal/entries'))return {data:journals};
  if(method==='POST'&&route==='/journal/entries'){const item={id:journals.length+1,...body};journals.push(item);return {data:item};}
  throw new Error('Unexpected mock route');
 }};
}
function context(workflowState,client) {return {workflowState,normalizeRequestArgs:args=>({args,error:null}),exec:async()=>({stdout:''}),git:createGitMock(),utils:testUtils,zettlyOptions:{env:{DEVWF_ZETTLY_SYNC:'1'},client}};}
const startArgs={description:'Track English implementation in Zettly',type:'bugfix',definitionOfDone:['Synchronization is verified'],plan:['Verify task lifecycle']};

test('focus tools dispatch structured JSON and guarded start links the persisted canonical task',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),original=client.request;
  client.request=async(method,route,body)=>{
   if(route==='/user')return {id:1,name:'Owner'};
   if(route==='/focus')return {data:[{id:7,user_id:1,title:'Complete the current feature',description:'One focus',completed_at:null}]};
   const value=await original(method,route,body);
   if(method==='POST'&&route==='/todos'){client.tasks.get(value.data.id).user_id=1;value.data.user_id=1;}
   return value;
  };
  const ctx=context(state,client);
  const current=await handleToolCall({...ctx,request:createRequest('get_current_focus',{})});
  assert.equal(JSON.parse(current.content[0].text).focus.id,7);
  const started=await handleToolCall({...ctx,request:createRequest('start_task',{...startArgs,focusId:7,requireFocus:true})});
  assert.ok(!started.isError,started.content[0].text);
  assert.equal(state.state.focus.id,7);assert.equal(state.state.focus.todoId,1);
  assert.match(client.tasks.get(1).description,/dev-workflow-focus:7/);
  await state.load();assert.equal(state.state.focus.id,7);
  state.reset();assert.equal(state.state.focus,null);
 });
});

test('required missing focus preserves the current task and makes no task writes',async()=>{
 await withWorkflowState(async state=>{
  state.state.taskDescription='Preserve this current task';state.state.workflowTaskId='preserved-task';
  const calls=[];const client={async request(method,route){calls.push({method,route});return route==='/user'?{id:1}:{data:[]};}};
  const r=await handleToolCall({...context(state,client),request:createRequest('start_task',{...startArgs,requireFocus:true})});
  assert.equal(r.isError,true);assert.equal(state.state.taskDescription,'Preserve this current task');assert.ok(calls.every(c=>c.method==='GET'));
 });
});

test('rejected Factory claim preserves the previous task focus and makes no remote link writes',async()=>{
 const previousUrl=process.env.FACTORY_URL,previousApi=process.env.FACTORY_API_URL;
 delete process.env.FACTORY_URL;delete process.env.FACTORY_API_URL;
 try {await withWorkflowState(async state=>{
  state.state.workflowTaskId='old-task';state.state.taskDescription='Previous work';state.state.currentPhase='coding';state.state.zettly={todoId:20};state.state.focus={id:7,todoId:20,ownerId:1,title:'Keep this focus'};
  const calls=[];const client={async request(method,route,body){calls.push({method,route,body});if(route==='/user')return {id:1};if(route==='/focus')return {data:[{id:7,user_id:1,title:'Keep this focus',completed_at:null}]};if(route==='/todos/20')return {data:{id:20,user_id:1,description:'Original work'}};return {data:{id:20}};}};
  const response=await handleToolCall({...context(state,client),zettlyOptions:{env:{DEVWF_ZETTLY_SYNC:'0'},client},request:createRequest('claim_factory_task',{recordId:'missing',focusId:7})});
  assert.equal(state.state.focus.todoId,20);assert.equal(state.state.taskDescription,'Previous work');assert.ok(calls.every(c=>c.method==='GET'));
  assert.equal(response.isError,true);
 });}finally{if(previousUrl===undefined)delete process.env.FACTORY_URL;else process.env.FACTORY_URL=previousUrl;if(previousApi===undefined)delete process.env.FACTORY_API_URL;else process.env.FACTORY_API_URL=previousApi;}
});

test('handlers create and persist one Todo, synchronize progress, and complete one linked outcome',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),ctx=context(state,client);
  await handleToolCall({...ctx,request:createRequest('start_task',startArgs)});
  assert.equal(client.tasks.size,1);assert.equal(state.state.zettly.todoId,1);
  const taskId=state.state.workflowTaskId;
  await state.load();assert.equal(state.state.workflowTaskId,taskId);assert.equal(state.state.zettly.todoId,1);
  await handleToolCall({...ctx,request:createRequest('mark_plan_step',{id:'plan-1'})});
  assert.match(client.tasks.get(1).description,/\[x\] Verify task lifecycle/);
  const rejected=await handleToolCall({...ctx,request:createRequest('complete_task',{commitMessage:'fix: track English work'})});
  assert.match(rejected.content[0].text,/⚠/);assert.equal(client.tasks.get(1).is_completed,false);assert.equal(client.journals.length,0);
  await handleToolCall({...ctx,request:createRequest('mark_dod_item',{id:'dod-1',evidence:'Handler integration regression passed'})});
  const done=await handleToolCall({...ctx,request:createRequest('complete_task',{commitMessage:'fix: track English work'})});
  assert.match(done.content[0].text,/Zettly Todo #1/);assert.equal(client.tasks.get(1).is_completed,true);assert.equal(client.journals.length,1);assert.equal(state.state.currentPhase,'idle');
  await state.load();assert.equal(state.state.zettlyOutbox.length,0);
 });
});

test('rejected starts have no remote side effects and forced closure retains an unfinished Todo',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),ctx=context(state,client);
  await handleToolCall({...ctx,request:createRequest('start_task',{...startArgs,definitionOfDone:[]})});
  assert.equal(client.tasks.size,0);
  await handleToolCall({...ctx,request:createRequest('start_task',startArgs)});
  await handleToolCall({...ctx,request:createRequest('force_complete_task',{reason:'Owner stopped work before verification'})});
  assert.equal(client.tasks.get(1).is_completed,false);assert.match(client.tasks.get(1).description,/closed_with_exceptions/);assert.equal(client.journals.length,1);
 });
});

test('pending terminal synchronization is retained by the real state reset and reload',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),ctx=context(state,client);
  await handleToolCall({...ctx,request:createRequest('start_task',startArgs)});
  const request=client.request.bind(client);client.request=async()=>{throw new Error('Offline fixture');};
  await handleToolCall({...ctx,request:createRequest('drop_task',{reason:'Diagnostic cancellation'})});
  assert.equal(state.state.taskDescription,'');assert.equal(state.state.zettlyOutbox.length,1);
  await state.load();assert.equal(state.state.zettlyOutbox.length,1);
  client.request=request;
  await handleToolCall({...ctx,request:createRequest('sync_zettly_task',{})});
  assert.equal(state.state.zettlyOutbox.length,0);assert.equal(client.journals.length,1);assert.equal(client.tasks.get(1).is_completed,false);
 });
});

test('invalid canonical IDs are rejected before replacing an existing task',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),ctx=context(state,client);
  await handleToolCall({...ctx,request:createRequest('start_task',startArgs)});
  const identity=state.state.workflowTaskId;
  const response=await handleToolCall({...ctx,request:createRequest('start_task',{...startArgs,description:'Different request',taskId:'<invalid marker>'})});
  assert.match(response.content[0].text,/invalid|Invalid/);
  assert.equal(state.state.workflowTaskId,identity);assert.equal(client.tasks.size,1);
 });
});
test('starting from an existing Zettly task reads its linked note context and retains the source',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),ctx=context(state,client);
  client.tasks.set(42,{id:42,type:'todo',title:'Source task',is_completed:false,description:'Owner decision',related_todos:[{id:43}]});
  client.tasks.set(43,{id:43,type:'note',title:'Prior architecture decision',is_completed:false,description:'Keep connector credentials device-local.',related_todos:[]});
  const result=await handleToolCall({...ctx,request:createRequest('start_task',{...startArgs,zettlyTodoId:42})});
  assert.equal(state.state.taskOrigin.system,'zettly');assert.equal(state.state.taskOrigin.id,'42');assert.equal(state.state.zettly.todoId,42);assert.equal(client.tasks.size,2);
  assert.match(result.content[0].text,/Prior architecture decision/);assert.equal(state.state.zettlyContext.nodes.length,2);
  await state.load();assert.equal(state.state.zettlyContext.nodes.length,2);assert.equal(state.state.taskOrigin.system,'zettly');
 });
});
test('a verified Sentry source survives automatic Zettly tracking and a failed source read preserves the task',async()=>{
 await withWorkflowState(async state=>{
  const client=mockApi(),ctx=context(state,client);
  ctx.integrationOptions={env:{},zettly:null,factory:null,sentry:{organization:'example',async getIssue(){return {id:'123',shortId:'APP-1',permalink:'https://example.sentry.io/issues/123/'};}}};
  const result=await handleToolCall({...ctx,request:createRequest('start_task',{...startArgs,source:{system:'sentry',id:'123'}})});
  assert.ok(!result.isError);assert.equal(state.state.taskOrigin.system,'sentry');assert.equal(state.state.taskOrigin.id,'123');assert.equal(state.state.zettly.todoId,1);assert.equal(state.state.zettly.externalLinks.sentry.issueId,'123');
  const before=structuredClone(state.state);
  ctx.integrationOptions.sentry.getIssue=async()=>{throw Object.assign(Error('private-provider-body'),{status:403});};
  const rejected=await handleToolCall({...ctx,request:createRequest('start_task',{...startArgs,source:{system:'sentry',id:'999'}})});
  assert.equal(rejected.isError,true);assert.deepEqual(state.state,before);assert.equal(client.tasks.size,1);
 });
});
