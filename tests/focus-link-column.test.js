import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleFocusTool} from '../focus-workflow.js';

// These tests lock the slice-1 contract: the focus link is a real column on the
// Todo, not an HTML comment appended to its description.

function fixture(todos) {
 let focuses=[{id:7,user_id:1,title:'Finish notifications',description:'Owner context',completed_at:null}];
 let rows=todos;
 const calls=[];
 const state={state:{workflowTaskId:'workflow-1',taskDescription:'Current work',currentPhase:'coding',zettly:{todoId:20}},async save(){return {verified:true};}};
 const client={async request(method,route,body){
  calls.push({method,route,body});
  if(route==='/user')return {id:1,name:'Owner'};
  if(method==='GET'&&route==='/focus')return {data:structuredClone(focuses)};
  if(method==='GET'&&/^\/focus\/\d+\/board$/.test(route)){const fid=Number(route.split('/')[2]);const linked=rows.filter(t=>Number(t.focus_id)===fid||String(t.description||'').includes('<!-- dev-workflow-focus:'+fid+' -->'));return {success:true,data:{todos:structuredClone(linked)}};}
  if(method==='GET'&&route==='/todos?type=todo')return {data:structuredClone(rows)};
  if(method==='GET'&&route==='/todos/20')return {data:structuredClone(rows[0])};
  if(method==='PATCH'&&route==='/todos/20'){rows[0]={...rows[0],...body};return {data:rows[0]};}
  if(method==='POST'&&route==='/focus/7/complete'){focuses[0].completed_at='2026-11-05T00:00:00Z';return {success:true,data:focuses[0]};}
  throw Error('Unexpected route '+method+' '+route);
 }};
 return {state,calls,client,options:{client,env:{},expectedUserId:1},getTodos:()=>rows};
}
const data=r=>JSON.parse(r.content[0].text);

const baseTodo=()=>({id:20,user_id:1,title:'Current work',description:'Existing owner description',is_completed:false});

test('linking writes the focus_id column',async()=>{
 const f=fixture([baseTodo()]);
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(r.isError,undefined);
 assert.equal(f.getTodos()[0].focus_id,7);
});

test('linking never appends a description marker',async()=>{
 const f=fixture([baseTodo()]);
 await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.doesNotMatch(f.getTodos()[0].description,/dev-workflow-focus/);
 assert.equal(f.getTodos()[0].description,'Existing owner description');
});

test('a todo already linked to another focus is refused',async()=>{
 const f=fixture([{...baseTodo(),focus_id:99}]);
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(data(r).error,'FOCUS_TASK_ALREADY_LINKED');
 assert.ok(!f.calls.some(c=>c.method==='PATCH'));
});

test('a legacy description marker still protects the original scope',async()=>{
 const todo={...baseTodo(),description:'Existing owner description\n<!-- dev-workflow-focus:99 -->'};
 const f=fixture([todo]);
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(data(r).error,'FOCUS_TASK_ALREADY_LINKED');
});

test('an already linked todo is not written again',async()=>{
 const f=fixture([{...baseTodo(),focus_id:7}]);
 const r=await handleFocusTool('link_task_to_focus',{focusId:7},f.state,f.options);
 assert.equal(r.isError,undefined);
 assert.ok(!f.calls.some(c=>c.method==='PATCH'));
});

test('completion counts a todo linked only through the column',async()=>{
 const f=fixture([{...baseTodo(),focus_id:7,is_completed:true}]);
 f.state.state.taskDescription=null;f.state.state.currentPhase='idle';
 const r=await handleFocusTool('complete_focus',{focusId:7,evidence:'Tests and deployed version were verified'},f.state,f.options);
 assert.equal(data(r).completed,true);
 assert.deepEqual(data(r).linkedTaskIds,[20]);
});

test('completion still counts a todo linked only through a legacy marker',async()=>{
 const todo={...baseTodo(),description:'Work\n<!-- dev-workflow-focus:7 -->',is_completed:true};
 const f=fixture([todo]);
 f.state.state.taskDescription=null;f.state.state.currentPhase='idle';
 const r=await handleFocusTool('complete_focus',{focusId:7,evidence:'Tests and deployed version were verified'},f.state,f.options);
 assert.equal(data(r).completed,true);
});
