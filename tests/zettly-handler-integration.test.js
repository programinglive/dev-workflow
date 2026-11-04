import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleToolCall} from '../tools/handlers.js';
import {withWorkflowState,testUtils,createRequest,createGitMock} from './test-helpers.js';

function mockApi() {
 const tasks=new Map(),journals=[];
 return {tasks,journals,async request(method,route,body){
  if(method==='GET'&&route==='/todos')return {data:[...tasks.values()]};
  if(method==='POST'&&route==='/todos'){const item={id:tasks.size+1,is_completed:false,...body};tasks.set(item.id,item);return {data:structuredClone(item)};}
  if(route.startsWith('/todos/')){const item=tasks.get(Number(route.split('/').pop()));if(method==='PATCH')Object.assign(item,body);return {data:structuredClone(item)};}
  if(method==='GET'&&route.startsWith('/journal/entries'))return {data:journals};
  if(method==='POST'&&route==='/journal/entries'){const item={id:journals.length+1,...body};journals.push(item);return {data:item};}
  throw new Error('Unexpected mock route');
 }};
}
function context(workflowState,client) {return {workflowState,normalizeRequestArgs:args=>({args,error:null}),exec:async()=>({stdout:''}),git:createGitMock(),utils:testUtils,zettlyOptions:{env:{DEVWF_ZETTLY_SYNC:'1'},client}};}
const startArgs={description:'Track English implementation in Zettly',type:'bugfix',definitionOfDone:['Synchronization is verified'],plan:['Verify task lifecycle']};

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
