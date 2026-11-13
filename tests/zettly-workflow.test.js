import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncZettlyTask,closeZettlyTask,flushZettlyOutbox,assignWorkflowIdentity} from '../zettly-workflow.js';

const env={DEVWF_ZETTLY_SYNC:'1',DEVWF_MACHINE:'test-device'};
function workflow() {
 return {state:{taskDescription:'Implement English coding guidance',taskType:'bugfix',projectDir:'/repo/workflow',taskStartedAt:'2026-11-04T10:00:00Z',currentPhase:'coding',definitionOfDone:[{id:'dod-1',text:'Policy delivered',status:'open'}],plan:[{id:'plan-1',text:'Verify policy',status:'open'}],zettlyOutbox:[]},saves:[],async save(){this.saves.push(structuredClone(this.state));}};
}
function api() {
 const tasks=new Map();const journals=[];const calls=[];
 return {tasks,journals,calls,async request(method,route,body){
  calls.push({method,route,body});
  if(route==='/todos'&&method==='GET')return {data:[...tasks.values()]};
  if(route==='/todos'&&method==='POST'){const task={...body,id:tasks.size+1,is_completed:false};tasks.set(task.id,task);return {data:structuredClone(task)};}
  if(route.startsWith('/todos/')){const id=Number(route.split('/').pop());const task=tasks.get(id);if(!task)throw Object.assign(new Error('Zettly HTTP 404'),{status:404});if(method==='PATCH')Object.assign(task,body);return {data:structuredClone(task)};}
  if(route.startsWith('/journal/entries')&&method==='GET')return {data:journals};
  if(route==='/journal/entries'&&method==='POST'){const entry={...body,id:journals.length+1};journals.push(entry);return {data:entry};}
  throw new Error('Unexpected mock route');
 }};
}

test('start creates one linked Todo and repeated progress reuses it',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 let result=await syncZettlyTask(state,{env,client});
 assert.equal(result.ok,true);assert.equal(state.state.zettly.todoId,1);assert.equal(client.tasks.size,1);
 const identity=state.state.workflowTaskId;
 state.state.plan[0].status='done';await syncZettlyTask(state,{env,client});
 assert.equal(state.state.workflowTaskId,identity);assert.equal(client.tasks.size,1);
 assert.match(client.tasks.get(1).description,/\[x\] Verify policy/);
 assert.equal(client.tasks.get(1).is_completed,false);
 const snapshot=structuredClone(state.state);
 assignWorkflowIdentity(state.state,snapshot,{description:snapshot.taskDescription});
 assert.equal(state.state.workflowTaskId,identity);
});

test('refined context updates the existing Todo block without creating another Todo',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 await syncZettlyTask(state,{env,client});
 state.state.taskDescription='Fix checkout with expired coupons';
 state.state.refinement={context:'Previous checkout behavior and expired coupon failure.',revision:1,bugContext:{symptom:'Guest checkout failure',reproduction:['Apply expired coupon'],observed:'Generic error',expected:'Coupon-specific error',evidence:'Checkout trace',constraints:'Preserve cart'}};
 await syncZettlyTask(state,{env,client});
 assert.equal(client.tasks.size,1);
 assert.match(client.tasks.get(1).description,/Refined task context/);
 assert.match(client.tasks.get(1).description,/expired coupon failure/);
 assert.match(client.tasks.get(1).description,/Bug investigation/);
 assert.match(client.tasks.get(1).description,/Apply expired coupon/);
 assert.equal(state.state.zettly.todoId,1);
});

test('explicit Todo links preserve user text and checklist metadata',async()=>{
 const state=workflow(),client=api();client.tasks.set(42,{id:42,title:'Existing work',description:'Owner context',is_completed:false,checklist_items:[{id:7,title:'Owner item'}]});
 assignWorkflowIdentity(state.state,null,{zettlyTodoId:42});
 await syncZettlyTask(state,{env,client});
 state.state.currentPhase='testing';await syncZettlyTask(state,{env,client});
 const task=client.tasks.get(42);assert.match(task.description,/Owner context/);assert.equal(task.title,'Existing work');assert.equal(task.checklist_items.length,1);assert.equal(client.tasks.size,1);
});

test('a create response lost after server commit is reconciled without a second POST',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 const original=client.request.bind(client);let lost=true;
 client.request=async(method,route,body)=>{const response=await original(method,route,body);if(method==='POST'&&route==='/todos'&&lost){lost=false;throw Object.assign(new Error('Zettly service unavailable'),{uncertain:true});}return response;};
 assert.equal((await syncZettlyTask(state,{env,client})).ok,false);
 assert.equal(client.tasks.size,1);
 assert.equal((await syncZettlyTask(state,{env,client,force:true})).ok,true);
 assert.equal(client.calls.filter(call=>call.route==='/todos'&&call.method==='POST').length,1);
 assert.ok(state.saves.some(value=>value.zettly?.createAttempted));
});

test('uncertain creation with no matching record remains pending rather than duplicating',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 state.state.zettly.createAttempted=true;
 const result=await syncZettlyTask(state,{env,client,force:true});
 assert.equal(result.ok,false);assert.match(result.note,/uncertain/i);assert.equal(client.tasks.size,0);
});

test('completion updates Todo and writes one linked outcome across retries',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 await syncZettlyTask(state,{env,client});
 state.state.definitionOfDone[0].status='done';state.state.definitionOfDone[0].evidence='Regression test passed';
 await closeZettlyTask(state,'completed',{commitMessage:'fix: enforce English guidance'},{env,client});
 assert.equal(client.tasks.get(1).is_completed,true);assert.equal(client.journals.length,1);assert.equal(client.journals[0].todo_id,1);
 await closeZettlyTask(state,'completed',{commitMessage:'fix: enforce English guidance'},{env,client});
 assert.equal(client.journals.length,1);
});

test('terminal failures survive reset through a durable retry outbox',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 await syncZettlyTask(state,{env,client});
 const request=client.request.bind(client);client.request=async()=>{throw new Error('Zettly service unavailable');};
 const result=await closeZettlyTask(state,'completed',{}, {env,client});
 assert.equal(result.ok,false);assert.equal(state.state.zettlyOutbox.length,1);
 state.state={currentPhase:'idle',taskDescription:'',zettlyOutbox:structuredClone(state.state.zettlyOutbox)};
 client.request=request;await flushZettlyOutbox(state,{env,client});
 assert.equal(state.state.zettlyOutbox.length,0);assert.equal(client.tasks.get(1).is_completed,true);assert.equal(client.journals.length,1);
});

test('cancelled and forced tasks do not falsely complete unfinished Todos',async()=>{
 for(const status of ['cancelled','closed_with_exceptions']){
  const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
  await syncZettlyTask(state,{env,client});await closeZettlyTask(state,status,{reason:'Stopped before verification'},{env,client});
  assert.equal(client.tasks.get(1).is_completed,false);assert.match(client.tasks.get(1).description,new RegExp(status));
 }
});

test('failed or replaced state persistence stops remote creation',async()=>{
 for(const mode of ['rejected','replaced']){
  const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
  state.save=async()=>{
   state.state={currentPhase:'coding',taskDescription:'A different owner task',workflowTaskId:'winner',zettlyOutbox:[]};
   return mode==='rejected'?{verified:false,conflict:{diskTask:'A different owner task'}}:{verified:true};
  };
  await assert.rejects(syncZettlyTask(state,{env,client}),error=>error.code==='STATE_CONFLICT');
  assert.equal(client.tasks.size,0);assert.equal(client.calls.filter(call=>call.method==='POST').length,0);
 }
});

test('explicitly changing the canonical task ID does not inherit a different Todo link',()=>{
 const state=workflow();assignWorkflowIdentity(state.state,null,{taskId:'original-task',zettlyTodoId:42});
 const previous=structuredClone(state.state);
 assignWorkflowIdentity(state.state,previous,{taskId:'distinct-task'});
 assert.equal(state.state.workflowTaskId,'distinct-task');assert.equal(state.state.zettly.todoId,null);
});

test('outcome reconciliation matches the full canonical marker and linked Todo',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{taskId:'task-1'});
 await syncZettlyTask(state,{env,client});
 client.journals.push({id:8,todo_id:1,content:'[Dev Workflow outcome ID: task-10]'});
 client.journals.push({id:9,todo_id:99,content:'[Dev Workflow outcome ID: task-1]'});
 await closeZettlyTask(state,'completed',{}, {env,client});
 assert.equal(client.journals.length,3);
 assert.equal(client.journals[2].todo_id,1);
});

test('a later verified completion supersedes a pending forced closure of the same task',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{taskId:'continued-task'});
 await syncZettlyTask(state,{env,client});
 const request=client.request.bind(client);client.request=async()=>{throw new Error('Offline fixture');};
 await closeZettlyTask(state,'closed_with_exceptions',{reason:'Interrupted'}, {env,client});
 client.request=request;
 state.state.definitionOfDone[0]={...state.state.definitionOfDone[0],status:'done',evidence:'Verified continuation'};
 await closeZettlyTask(state,'completed',{commitMessage:'fix: complete resumed task'}, {env,client});
 assert.equal(client.tasks.get(1).is_completed,true);assert.equal(client.journals.length,1);
 assert.match(client.journals[0].content,/Status: completed/);assert.match(client.journals[0].content,/Verified continuation/);
});

test('a malformed journal success response remains pending rather than claiming an outcome was recorded',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});await syncZettlyTask(state,{env,client});
 const request=client.request.bind(client);
 client.request=async(method,route,body)=>method==='POST'&&route==='/journal/entries'?{data:{}}:request(method,route,body);
 const result=await closeZettlyTask(state,'completed',{}, {env,client});
 assert.equal(result.ok,false);assert.equal(state.state.zettlyOutbox.length,1);assert.equal(state.state.zettlyOutbox[0].journalAttempted,true);
});

test('refreshing a terminal queue preserves remote identity and uncertain journal creation',async()=>{
 const state=workflow(),client=api();assignWorkflowIdentity(state.state,null,{});
 const request=client.request.bind(client);let journalPosts=0;
 client.request=async(method,route,body)=>{
  if(method==='POST'&&route==='/journal/entries'){journalPosts++;throw Object.assign(new Error('Delayed journal acknowledgement'),{uncertain:true});}
  return request(method,route,body);
 };
 await closeZettlyTask(state,'completed',{}, {env,client});
 assert.equal(state.state.zettlyOutbox[0].snapshot.zettly.todoId,1);
 assert.equal(state.state.zettlyOutbox[0].journalAttempted,true);
 await closeZettlyTask(state,'completed',{}, {env,client});
 assert.equal(client.tasks.size,1);assert.equal(journalPosts,1);assert.equal(state.state.zettlyOutbox[0].journalAttempted,true);
});
